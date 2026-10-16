// 任务管理器（M3：落盘 + 恢复 + 串行队列 + 事件发布）
//
// 契约：docs/M0/数据模型.md §二（任务对象）/ §三（状态机）/ §四（进度）/ §五（队列）/ §六（落盘）
//
// 本模块负责：
// - 任务对象生命周期（创建 → 入队 → 执行 → 终态），字段严格对齐 §2.1；
// - **串行队列**：全局同时最多 1 个 running，FIFO 按 createdAt（§五）；
// - **落盘**：创建/状态变化立即原子落盘，进度变更 500ms 节流（§4.2、INV-10）；
// - **启动恢复**：非终态任务一律迁 interrupted + `error.code=INTERRUPTED`（§六.4）；
// - **事件发布**：状态/phase 变化立即发布，进度 ≤10 次/秒（SSE 与磁盘是两条线，§4.2）；
// - 二次确认删除的门闩（M2 已有）+ 重试=新任务（新 UUID + `retryOf`，§3.2）。
//
// 与执行器的边界：管理器不知道"怎么压"，执行器不知道"怎么存"。
// 绝对路径（absPath 等）只存在于 record.internal 与 tasks.json，**绝不进 API 响应**；
// 执行与订阅耦合为零：零订阅者时任务照常跑、照常落盘（INV-02/INV-04）。
//
// 结构：所有可变状态放在 `ctx`（tasks / queue / 节流时间戳 / 活动任务 id），
// 具体动作都是**模块级小函数**（每个只做一件事），工厂函数只把动作绑到 ctx 上。

import crypto from 'node:crypto';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted', 'interrupted']);
/** 终态中要留在 tasks.json 的（可重试）；done/aborted 写历史后移除（§六.2） */
const PERSISTED_TERMINAL_STATUSES = new Set(['failed', 'interrupted']);
/** 允许取消的 phase（§3.2 迁移表守卫条件） */
const CANCELLABLE_PHASES = new Set(['precheck', 'scanning', 'compressing', 'extracting', 'verifying']);
const PROGRESS_PUBLISH_INTERVAL_MS = 100;
const SPEED_WINDOW_MS = 5000;

function now() {
  return Date.now();
}

function buildContext(deps) {
  return {
    logger: deps.logger,
    store: deps.store,
    events: deps.events,
    bootId: crypto.randomUUID(),
    /** Map<id, record>：record = {info（契约任务）、internal（绝对路径等）、runner、abortController、…} */
    tasks: new Map(),
    /** FIFO 队列（只存 id；按 createdAt 升序，§五） */
    queue: [],
    activeId: null,
    pumpScheduled: false,
    /** 进度样本（内存，不落盘）：用于 speedBps / etaSeconds */
    speedSamples: new Map(),
    /** 进度发布节流：Map<id, number> */
    lastPublishAt: new Map(),
  };
}

// ===== 任务对象构造（纯函数） =====

function emptyProgress() {
  return {
    percent: 0,
    processedBytes: 0,
    totalBytes: 0,
    processedFiles: 0,
    totalFiles: 0,
    currentFile: null,
    packagesDone: 0,
    packagesTotal: 1,
    speedBps: 0,
    etaSeconds: null,
    updatedAt: now(),
  };
}

function emptyDeleteState() {
  return {
    requested: true,
    confirmed: false,
    confirmedAt: null,
    status: 'pending',
    targets: [],
    trashBatch: null,
    deletedAt: null,
    logRef: null,
    error: null,
  };
}

/** 源条目 → 契约字段（sizeBytes/entryCount 是"扫描后回填"字段，§2.2）
 *  注意：`absPath` 是**进程内部字段**（运行时与落盘需要，API 视图由 publicTask 剥离）。
 */
function toSource(raw) {
  const size = Number.isFinite(raw.sizeBytes) ? raw.sizeBytes : (Number.isFinite(raw.size) ? raw.size : null);
  const count = Number.isInteger(raw.entryCount)
    ? raw.entryCount
    : (Number.isInteger(raw.fileCount) ? raw.fileCount : (raw.kind === 'file' ? 1 : null));
  return {
    path: raw.path || raw.userPath || '/',
    name: raw.name || '/',
    kind: raw.kind || 'file',
    sizeBytes: size,
    entryCount: count,
    absPath: raw.absPath || null,
  };
}

/** 对外源条目（剥掉 absPath 等内部字段；API 响应里绝不出现绝对路径） */
function toPublicSource(source) {
  const { absPath, userPath, size, fileCount, ...rest } = source;
  return rest;
}

/** 是否需要删除子状态：压缩侧 keepOriginal=false / 解压侧 deleteArchiveAfterExtract=true */
function needsDeleteState(input) {
  if (input.kind === 'extract') return Boolean(input.options && input.options.deleteArchiveAfterExtract);
  return Boolean(input.options && input.options.keepOriginal === false);
}

/** 完整任务视图（剥离 internal；契约 §2.4 的"完整 Task"）—— 也可用于任意 info 快照 */
function publicTask(info) {
  return {
    ...info,
    sources: info.sources.map(toPublicSource),
    options: { ...info.options },
    progress: { ...info.progress },
    result: info.result ? { ...info.result, packages: info.result.packages.map((pkg) => ({ ...pkg })) } : null,
    delete: info.delete ? { ...info.delete, targets: info.delete.targets.map((target) => ({ ...target })) } : null,
    error: info.error ? { ...info.error } : null,
  };
}

function toApiTask(record) {
  return publicTask(record.info);
}

/** 任务摘要（列表项与 SSE 增量用，§2.4）：只保留列表/任务条需要的字段 */
function toSummary(record) {
  const { info } = record;
  return {
    id: info.id,
    kind: info.kind,
    status: info.status,
    phase: info.phase,
    mode: info.mode,
    format: info.format,
    sources: info.sources.map((source) => ({ path: source.path, name: source.name, kind: source.kind })),
    options: { keepOriginal: info.options.keepOriginal === true },
    progress: { ...info.progress },
    result: info.result ? { savedBytes: info.result.savedBytes, ratio: info.result.ratio } : null,
    delete: info.delete ? { status: info.delete.status, requested: info.delete.requested } : null,
    error: info.error ? { code: info.error.code, message: info.error.message } : null,
    createdAt: info.createdAt,
    startedAt: info.startedAt,
    finishedAt: info.finishedAt,
    updatedAt: info.updatedAt,
    retryOf: info.retryOf,
  };
}

// ===== 落盘 / 发布 =====

/** 当前需要落盘的任务集合（非终态 + failed/interrupted） */
function persistedTasks(ctx) {
  const list = [];
  for (const record of ctx.tasks.values()) {
    const { status } = record.info;
    if (!TERMINAL_STATUSES.has(status) || PERSISTED_TERMINAL_STATUSES.has(status)) {
      list.push({
        info: toApiTask(record),
        // internal 里额外带上源的绝对路径（重启后重试要用；API 视图已剥离）
        internal: { ...record.internal, sourceAbsPaths: record.info.sources.map((source) => source.absPath || null) },
      });
    }
  }
  list.sort((a, b) => a.info.createdAt - b.info.createdAt);
  return list;
}

/** 状态/phase/终态变化：立即原子落盘（不等节流，INV-10） */
async function persistNow(ctx) {
  await ctx.store.saveNow(persistedTasks(ctx));
}

/** 进度类变更：500ms 节流落盘（§4.2） */
function persistThrottled(ctx) {
  ctx.store.scheduleSave(persistedTasks(ctx));
}

/** 发布任务事件（摘要）；进度类受 100ms 节流，状态/phase 类立即发 */
function publishTask(ctx, record, options = {}) {
  const id = record.info.id;
  if (options.immediate !== true) {
    const last = ctx.lastPublishAt.get(id) || 0;
    if (now() - last < PROGRESS_PUBLISH_INTERVAL_MS) return;
  }
  ctx.lastPublishAt.set(id, now());
  ctx.events.publish('task', { task: toSummary(record) });
}

// ===== 创建 / 读取 =====

/** 创建任务；**返回前必须已落盘**（契约 §六.1「创建即落盘」，返回后才写会让"创建即落盘"形同虚设） */
async function createTask(ctx, input) {
  const id = crypto.randomUUID();
  const info = {
    id,
    kind: input.kind,
    status: 'queued',
    phase: 'precheck',
    mode: input.mode || null,
    format: input.format || null,
    sources: (input.sources || []).map(toSource),
    options: {
      level: Number.isInteger(input.options && input.options.level) ? input.options.level : 6,
      keepOriginal: input.options ? input.options.keepOriginal !== false : true,
      deleteConfirmed: Boolean(input.options && input.options.deleteConfirmed),
      deleteArchiveAfterExtract: Boolean(input.options && input.options.deleteArchiveAfterExtract),
      outputDir: (input.options && input.options.outputDir) || null,
      parallel: false,
    },
    // 解压任务对外可见的两个路径字段（都是 API 用户路径）
    archivePath: input.archivePath || null,
    targetDir: input.targetDir || null,
    progress: emptyProgress(),
    result: null,
    delete: needsDeleteState(input) ? emptyDeleteState() : null,
    error: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    updatedAt: now(),
    retryOf: input.retryOf || null,
    bootId: ctx.bootId,
  };

  const record = {
    info,
    // 绝对路径等进程内部字段：**绝不进 API 响应**，但要落盘（重启后重试/诊断需要）
    internal: { ...(input.internal || {}) },
    runner: null,
    abortController: new AbortController(),
    confirmResolver: null,
    confirmPromise: null,
  };
  ctx.tasks.set(id, record);
  ctx.logger.info('task created', { taskId: id, kind: info.kind, retryOf: info.retryOf });
  // 创建即落盘（§六.1，**等写完再返回**）+ 立即广播（已连接的客户端立刻看到新任务）
  await persistNow(ctx);
  publishTask(ctx, record, { immediate: true });
  return toApiTask(record);
}

function requireRecord(ctx, id) {
  const record = ctx.tasks.get(id);
  if (!record) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
  return record;
}

function getTask(ctx, id) {
  const record = ctx.tasks.get(id);
  if (record) return toApiTask(record);
  // 已进历史的任务：从历史缓存里还原（终态任务不再驻留内存）
  const entry = ctx.store.getHistoryEntry(id);
  return entry ? { ...entry } : null;
}

function listTasks(ctx, filter = {}) {
  const limit = Number.isInteger(filter.limit) ? filter.limit : 50;
  const items = [...ctx.tasks.values()]
    .filter((record) => (filter.status ? filter.status.includes(record.info.status) : true))
    .map(toSummary)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  return {
    items,
    queue: { active: ctx.activeId, waiting: ctx.queue.length, parallel: false },
    history: ctx.store.listHistory({ limit: 20, status: filter.status || null }),
    seq: ctx.events.currentSeq(),
  };
}

/** SSE 首帧快照（INV-05：连接即发当前状态，不依赖增量补齐） */
function snapshotOf(ctx) {
  return {
    tasks: [...ctx.tasks.values()]
      .filter((record) => !['done', 'aborted'].includes(record.info.status))
      .map((record) => toApiTask(record))
      .sort((a, b) => a.createdAt - b.createdAt),
    queue: { active: ctx.activeId, waiting: ctx.queue.length, parallel: false },
    bootId: ctx.bootId,
  };
}

// ===== 队列与执行 =====

/** 入队：runner 负责最终 finalize；异常由 pump 兜底转 failed */
function enqueueTask(ctx, id, runner) {
  const record = requireRecord(ctx, id);
  record.runner = runner;
  ctx.queue.push(id);
  void pump(ctx);
}

/** 取队首（FIFO：按 createdAt 升序，防并发创建导致顺序错乱） */
function takeNext(ctx) {
  if (ctx.queue.length === 0) return null;
  ctx.queue.sort((a, b) => (ctx.tasks.get(a)?.info.createdAt || 0) - (ctx.tasks.get(b)?.info.createdAt || 0));
  return ctx.queue.shift();
}

/** 开始执行一个任务（状态置 running 并立即落盘） */
async function beginRun(ctx, record) {
  record.info.status = 'running';
  record.info.startedAt = record.info.startedAt || now();
  record.info.updatedAt = now();
  ctx.logger.info('task started', { taskId: record.info.id, kind: record.info.kind });
  publishTask(ctx, record, { immediate: true });
  await persistNow(ctx);
}

/** 执行器抛错：ABORTED → aborted（无 error）；其余 → failed（带契约错误码） */
function handleTaskError(ctx, id, error, record) {
  const code = (error && error.code) || ERROR_CODES.INTERNAL_ERROR;
  const aborted = code === ERROR_CODES.ABORTED || record.abortController.signal.aborted;
  finalizeTask(ctx, id, aborted ? 'aborted' : 'failed', {
    error: aborted
      ? null
      : {
          code,
          message: (error && error.message) || '任务失败',
          details: (error && error.details) || null,
          at: now(),
        },
  });
  if (!aborted) ctx.logger.error('task failed', { taskId: id, code });
}

/** 单执行器循环：同一时刻最多一个 running（§五 串行） */
async function pump(ctx) {
  if (ctx.activeId || ctx.pumpScheduled) return;
  ctx.pumpScheduled = true;
  await Promise.resolve();
  ctx.pumpScheduled = false;

  const nextId = takeNext(ctx);
  if (!nextId) return;
  const record = ctx.tasks.get(nextId);
  if (!record || record.info.status !== 'queued') {
    void pump(ctx);
    return;
  }

  ctx.activeId = nextId;
  await beginRun(ctx, record);
  try {
    await record.runner(record);
    if (!TERMINAL_STATUSES.has(record.info.status)) finalizeTask(ctx, nextId, 'done');
  } catch (error) {
    if (!TERMINAL_STATUSES.has(record.info.status)) handleTaskError(ctx, nextId, error, record);
  } finally {
    ctx.activeId = null;
    void pump(ctx);
  }
}

// ===== 状态与进度 =====

function setPhase(ctx, id, phase) {
  const record = ctx.tasks.get(id);
  if (!record) return;
  record.info.phase = phase;
  record.info.updatedAt = now();
  publishTask(ctx, record, { immediate: true });
  void persistNow(ctx);
}

/** 滑动窗口速率（最近 5s）+ ETA：样本不足时给 0 / null（不编数） */
function computeSpeed(ctx, record, processedBytes) {
  const samples = ctx.speedSamples.get(record.info.id) || [];
  samples.push({ t: now(), bytes: processedBytes });
  while (samples.length > 0 && now() - samples[0].t > SPEED_WINDOW_MS) samples.shift();
  ctx.speedSamples.set(record.info.id, samples);
  if (samples.length < 2) return { speedBps: 0, etaSeconds: null };

  const span = (samples[samples.length - 1].t - samples[0].t) / 1000;
  if (span <= 0) return { speedBps: 0, etaSeconds: null };
  const delta = samples[samples.length - 1].bytes - samples[0].bytes;
  const speedBps = Math.max(0, Math.round(delta / span));
  const { totalBytes } = record.info.progress;
  if (!speedBps || !Number.isFinite(totalBytes) || totalBytes <= 0) return { speedBps, etaSeconds: null };
  return { speedBps, etaSeconds: Math.round(Math.max(0, totalBytes - processedBytes) / speedBps) };
}

function updateProgress(ctx, id, patch) {
  const record = ctx.tasks.get(id);
  if (!record) return;
  const progress = record.info.progress;
  if (Number.isFinite(patch.processedBytes)) progress.processedBytes = patch.processedBytes;
  if (Number.isFinite(patch.totalBytes)) progress.totalBytes = patch.totalBytes;
  if (Number.isFinite(patch.processedFiles)) progress.processedFiles = patch.processedFiles;
  if (Number.isFinite(patch.totalFiles)) progress.totalFiles = patch.totalFiles;
  if (Number.isFinite(patch.packagesDone)) progress.packagesDone = patch.packagesDone;
  if (Number.isFinite(patch.packagesTotal)) progress.packagesTotal = patch.packagesTotal;
  if (patch.currentFile !== undefined) progress.currentFile = patch.currentFile;

  if (progress.totalBytes > 0) {
    progress.percent = Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 1000) / 10);
  } else if (progress.totalFiles > 0) {
    progress.percent = Math.min(100, Math.round((progress.processedFiles / progress.totalFiles) * 1000) / 10);
  }

  const speed = computeSpeed(ctx, record, progress.processedBytes);
  progress.speedBps = speed.speedBps;
  progress.etaSeconds = speed.etaSeconds;
  progress.updatedAt = now();
  record.info.updatedAt = progress.updatedAt;

  publishTask(ctx, record);
  persistThrottled(ctx);
}

// ===== 终态 =====

/** 终态进度语义（§4.3）：done→100%；aborted→0/null；failed/interrupted 保留最后真实值 */
function applyTerminalProgress(info, status) {
  if (status === 'done') info.progress.percent = 100;
  else if (status === 'aborted') {
    info.progress.percent = 0;
    info.progress.currentFile = null;
  }
  info.progress.updatedAt = now();
}

function finalizeTask(ctx, id, status, extra = {}) {
  const record = ctx.tasks.get(id);
  if (!record) return null;
  const info = record.info;
  if (TERMINAL_STATUSES.has(info.status)) return toApiTask(record);

  info.status = status;
  info.finishedAt = now();
  info.updatedAt = info.finishedAt;
  info.error = status === 'failed' || status === 'interrupted' ? (extra.error || info.error) : null;
  if (extra.result) info.result = extra.result;
  if (extra.delete) info.delete = { ...(info.delete || emptyDeleteState()), ...extra.delete };
  applyTerminalProgress(info, status);

  if (record.confirmResolver) {
    record.confirmResolver.reject(apiError(ERROR_CODES.ABORTED, '任务已结束'));
    record.confirmResolver = null;
  }
  ctx.speedSamples.delete(id);
  ctx.lastPublishAt.delete(id);
  ctx.logger.info('task finalized', { taskId: id, status });

  // 终态事件必须立即发布（不能被进度节流吞掉）
  ctx.events.publish('task', { task: toSummary(record) });
  // 历史追加 + 立即落盘（done/aborted 从 tasks.json 移除）
  void ctx.store.appendHistory(toApiTask(record));
  void persistNow(ctx);
  return toApiTask(record);
}

function cancelTask(ctx, id) {
  const record = requireRecord(ctx, id);
  const { info } = record;
  if (TERMINAL_STATUSES.has(info.status)) {
    throw apiError(ERROR_CODES.TASK_NOT_CANCELLABLE, '任务已结束，无法取消', { status: info.status });
  }
  if (!['queued', 'running'].includes(info.status)) {
    throw apiError(ERROR_CODES.TASK_NOT_CANCELLABLE, '当前状态不可取消', { status: info.status });
  }
  if (info.status === 'running' && !CANCELLABLE_PHASES.has(info.phase)) {
    throw apiError(ERROR_CODES.INVALID_STATE, '该阶段不允许取消', { phase: info.phase });
  }

  if (info.status === 'queued') {
    // 排队中的任务没有执行器可响应 abort：由队列自身立即结算为 aborted（§3.2 queued → cancelling → aborted）
    const index = ctx.queue.indexOf(id);
    if (index >= 0) ctx.queue.splice(index, 1);
    ctx.logger.info('排队任务取消，直接结算为 aborted', { taskId: id });
    return finalizeTask(ctx, id, 'aborted');
  }

  info.status = 'cancelling';
  info.updatedAt = now();
  record.abortController.abort();
  if (record.confirmResolver) {
    record.confirmResolver.reject(apiError(ERROR_CODES.ABORTED, '任务已取消'));
    record.confirmResolver = null;
  }
  ctx.logger.info('task cancelling', { taskId: id, phase: info.phase });
  publishTask(ctx, record, { immediate: true });
  void persistNow(ctx);
  return toApiTask(record);
}

/** 终态任务的历史记录（转成 record 形状，供 retry 复用） */
function historyRecord(ctx, id) {
  const entry = ctx.store.getHistoryEntry(id);
  return entry ? { info: entry, internal: {} } : null;
}

/** 重试 = 新任务（新 UUID + retryOf 指向原任务；原任务保持终态不变，§3.2） */
async function retryTask(ctx, id) {
  const source = ctx.tasks.get(id) || historyRecord(ctx, id);
  if (!source) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
  const info = source.info;
  if (!['failed', 'interrupted'].includes(info.status)) {
    throw apiError(ERROR_CODES.INVALID_STATE, '只有失败或中断的任务可以重试', { status: info.status });
  }

  const created = await createTask(ctx, {
    kind: info.kind,
    mode: info.mode,
    format: info.format,
    sources: (info.sources || []).map((sourceItem, index) => ({
      path: sourceItem.path,
      name: sourceItem.name,
      kind: sourceItem.kind,
      sizeBytes: sourceItem.sizeBytes,
      entryCount: sourceItem.entryCount,
      // 重试要能真正跑起来：绝对路径必须一起带上（来自原件或落盘记录）
      absPath: sourceItem.absPath || (source.internal && source.internal.sourceAbsPaths
        ? source.internal.sourceAbsPaths[index]
        : null),
    })),
    archivePath: info.archivePath,
    targetDir: info.targetDir,
    options: { ...info.options, deleteConfirmed: false },
    retryOf: info.id,
    internal: source.internal ? { ...source.internal } : {},
  });
  ctx.logger.info('task retried', { from: id, to: created.id });
  return created;
}

// ===== 二次确认删除门闩（M2 已有，保持签名） =====

function waitConfirm(ctx, id) {
  const record = requireRecord(ctx, id);
  if (!record.confirmPromise) {
    record.confirmPromise = new Promise((resolve, reject) => {
      record.confirmResolver = { resolve, reject };
    });
  }
  return record.confirmPromise;
}

function resolveConfirm(ctx, id, payload = {}) {
  const record = requireRecord(ctx, id);
  if (record.info.phase !== 'waiting_confirm') {
    throw apiError(ERROR_CODES.INVALID_STATE, '当前不是待确认状态', { phase: record.info.phase });
  }
  const resolver = record.confirmResolver;
  record.confirmResolver = null;
  record.confirmPromise = null;
  if (payload.confirmed === false) {
    if (resolver) resolver.resolve({ confirmed: false, at: now() });
    return toApiTask(record);
  }
  if (resolver) {
    resolver.resolve({
      confirmed: true,
      at: now(),
      expectedFiles: payload.expectedFiles,
      expectedBytes: payload.expectedBytes,
    });
  }
  return toApiTask(record);
}

function markWaitingConfirm(ctx, id) {
  const record = requireRecord(ctx, id);
  record.info.phase = 'waiting_confirm';
  // 该阶段任务整体仍是 running，但进度显示 100%（§3.3）
  record.info.progress.percent = 100;
  record.info.updatedAt = now();
  publishTask(ctx, record, { immediate: true });
  void persistNow(ctx);
  return toApiTask(record);
}

// ===== 启动恢复（§六.4 / INV-10） =====

/** 把一条落盘记录还原成内存 record（含源的绝对路径） */
function restoreRecord(entry) {
  const info = entry.info || entry;
  const internal = entry.internal || {};
  const sourceAbsPaths = Array.isArray(internal.sourceAbsPaths) ? internal.sourceAbsPaths : [];
  info.sources = (info.sources || []).map((source, index) => ({
    ...source,
    absPath: source.absPath || sourceAbsPaths[index] || null,
  }));
  return {
    info,
    internal: { ...internal },
    runner: null,
    abortController: new AbortController(),
    confirmResolver: null,
    confirmPromise: null,
  };
}

/** 非终态 → interrupted（details.reason=SERVER_RESTART）；`.part` 不碰、不自动续跑 */
async function markInterrupted(ctx, info) {
  info.status = 'interrupted';
  info.finishedAt = now();
  info.updatedAt = info.finishedAt;
  info.error = {
    code: ERROR_CODES.INTERRUPTED,
    message: '服务重启导致任务中断（.part 已保留，可重试）',
    details: { reason: 'SERVER_RESTART' },
    at: info.finishedAt,
  };
  info.progress = { ...emptyProgress(), ...info.progress, updatedAt: info.updatedAt };
  // 历史只写"对外视图"：此时 info.sources 已还原 absPath，绝不能原样落历史（否则泄漏到 API）
  await ctx.store.appendHistory(publicTask(info));
  ctx.logger.warn('任务恢复为 interrupted', { taskId: info.id, previousBootId: info.bootId });
}

async function recoverTasks(ctx) {
  const persisted = await ctx.store.loadTasks();
  let recovered = 0;
  for (const entry of persisted) {
    const record = restoreRecord(entry);
    if (!TERMINAL_STATUSES.has(record.info.status)) {
      recovered += 1;
      await markInterrupted(ctx, record.info);
    }
    ctx.tasks.set(record.info.id, record);
  }
  await persistNow(ctx);
  return { loaded: persisted.length, recovered };
}

/**
 * 创建任务管理器：建 ctx 并把各动作绑上去（对外只暴露方法，不暴露内部状态）。
 * @param {{logger: object, store: object, events: object}} deps
 */
export function createTaskManager(deps) {
  const ctx = buildContext(deps);
  return {
    bootId: ctx.bootId,
    recover: () => recoverTasks(ctx),
    create: (input) => createTask(ctx, input),
    get: (id) => getTask(ctx, id),
    list: (filter) => listTasks(ctx, filter),
    snapshot: () => snapshotOf(ctx),
    enqueue: (id, runner) => enqueueTask(ctx, id, runner),
    setPhase: (id, phase) => setPhase(ctx, id, phase),
    updateProgress: (id, patch) => updateProgress(ctx, id, patch),
    finalize: (id, status, extra) => finalizeTask(ctx, id, status, extra),
    cancel: (id) => cancelTask(ctx, id),
    retry: (id) => retryTask(ctx, id),
    waitConfirm: (id) => waitConfirm(ctx, id),
    resolveConfirm: (id, payload) => resolveConfirm(ctx, id, payload),
    markWaitingConfirm: (id) => markWaitingConfirm(ctx, id),
    requireTask: (id) => requireRecord(ctx, id),
    getAbortSignal: (id) => requireRecord(ctx, id).abortController.signal,
    toSummary,
    toApiTask,
    flush: () => ctx.store.flush(),
    stats: () => ({
      total: ctx.tasks.size,
      active: ctx.activeId,
      waiting: ctx.queue.length,
      subscribers: ctx.events.subscriberCount(),
      seq: ctx.events.currentSeq(),
    }),
  };
}
