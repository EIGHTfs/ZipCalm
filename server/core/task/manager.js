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
import { reconcileAfterBoot } from './recovery.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted', 'interrupted']);
/** 终态中要留在 tasks.json 的（可重试）；done/aborted 写历史后移除（§六.2） */
const PERSISTED_TERMINAL_STATUSES = new Set(['failed', 'interrupted']);
/** 允许取消的 phase（§3.2 迁移表守卫条件） */
/** 允许取消的 phase（§3.2 迁移表守卫条件；契约 v2 已把 waiting_confirm 纳入——取消=放弃删除） */
const CANCELLABLE_PHASES = new Set(['precheck', 'scanning', 'compressing', 'extracting', 'verifying', 'waiting_confirm']);
/** waiting_confirm 默认超时（数据模型 §八：默认 1800000=30 分钟，0=不限） */
const DEFAULT_CONFIRM_TIMEOUT_MS = 1800000;
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
    // PW-1：任务落盘前的能力参数脱敏器（由 capRegistry 提供通用实现；单测未注入时跳过）
    sanitizeOptionsForPersist: typeof deps.sanitizeOptionsForPersist === 'function' ? deps.sanitizeOptionsForPersist : null,
    bootId: crypto.randomUUID(),
    /**
     * 保留策略参数（来自配置，不写死；数据模型 §六 规则 6）：
     * `failed`/`interrupted` 保留最近 max 条或 days 天，任一先到即清理。
     */
    retention: {
      max: Number.isInteger(deps.retention && deps.retention.max) ? deps.retention.max : 100,
      days: Number.isFinite(deps.retention && deps.retention.days) ? deps.retention.days : 7,
    },
    /**
     * waiting_confirm 最长等待（数据模型 §八 / §3.3 硬要求 1）。
     * 0 = 不超时；非法值回落默认 30 分钟（与 schema 告警口径一致）。
     * 超时按放弃删除结算——超时绝不等于确认。
     */
    confirmTimeoutMs: Number.isInteger(deps.confirmTimeoutMs) && deps.confirmTimeoutMs >= 0
      ? deps.confirmTimeoutMs
      : (deps.confirmTimeoutMs === 0 ? 0 : DEFAULT_CONFIRM_TIMEOUT_MS),
    /**
     * 启动对账所需路径（M5-F09：trash 孤儿补记 + deleting 中断收敛）。
     * 未提供时对账跳过（单测/最小装配不受影响）。
     */
    recoveryPaths: deps.trashDir && deps.logDir && deps.rootAbs
      ? { trashDir: deps.trashDir, logDir: deps.logDir, rootAbs: deps.rootAbs }
      : null,
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

/** 取字节数：优先 sizeBytes，兼容旧的 size 字段；都没有则 null（表示"尚未扫描"） */
function pickSizeBytes(raw) {
  if (Number.isFinite(raw.sizeBytes)) return raw.sizeBytes;
  if (Number.isFinite(raw.size)) return raw.size;
  return null;
}

/** 取条目数：优先 entryCount，兼容 fileCount；单个文件恒为 1，目录未扫描则 null */
function pickEntryCount(raw) {
  if (Number.isInteger(raw.entryCount)) return raw.entryCount;
  if (Number.isInteger(raw.fileCount)) return raw.fileCount;
  return raw.kind === 'file' ? 1 : null;
}

/** 源条目 → 契约字段（sizeBytes/entryCount 是"扫描后回填"字段，§2.2）
 *  注意：`absPath` 是**进程内部字段**（运行时与落盘需要，API 视图由 publicTask 剥离）。
 */
function toSource(raw) {
  return {
    path: raw.path || raw.userPath || '/',
    name: raw.name || '/',
    kind: raw.kind || 'file',
    sizeBytes: pickSizeBytes(raw),
    entryCount: pickEntryCount(raw),
    absPath: raw.absPath || null,
  };
}

/** 对外源条目（剥掉 absPath 等内部字段；API 响应里绝不出现绝对路径） */
function toPublicSource(source) {
  const { absPath, userPath, size, fileCount, ...rest } = source;
  return rest;
}

/**
 * 对外删除目标条目：**白名单式**只保留契约形状（docs/M0/数据模型.md §2.2：{path, kind, sizeBytes}）。
 *
 * 红线（契约 v2 §2.2）：absPath 等内部字段只允许存在于**传参链路**（如 stageDelete 的 input.targets），
 * 绝不进 API。当前上游 buildDeleteTargets（orchestrator）已映射好契约形状，这里不漏；
 * 白名单是**防御纵深**——将来任何调用方绕过映射直接塞进 targets，也会在此被剥离，
 * 而不是靠"上游恰好映射对了"。
 */
function toPublicDeleteTarget(target) {
  return {
    path: target.path,
    kind: target.kind,
    sizeBytes: Number.isFinite(target.sizeBytes) ? target.sizeBytes : null,
  };
}

/** 是否需要删除子状态：压缩侧 keepOriginal=false / 解压侧 deleteArchiveAfterExtract=true */
function needsDeleteState(input) {
  if (input.kind === 'extract') return Boolean(input.options && input.options.deleteArchiveAfterExtract);
  return Boolean(input.options && input.options.keepOriginal === false);
}

/**
 * API 视图用的能力参数脱敏器。由压缩层在装配完成后注入（见 __setCapabilitySanitizer）。
 *
 * 为什么 API 出口也要脱敏：正常路径上 stageCapabilityVerify 会把脱敏值写回 options，
 * 但 failed/interrupted 等提前退出的任务走不到那一步 —— 若这里直接透传 info.options，
 * 明文密码就会出现在响应里（PW-1）。所以出口统一过一遍，不依赖执行阶段。
 */
let apiOptionsSanitizer = null;

/** 完整任务视图（剥离 internal；契约 §2.4 的"完整 Task"）—— 也可用于任意 info 快照 */
function publicTask(info) {
  const rawOptions = { ...info.options };
  return {
    ...info,
    sources: info.sources.map(toPublicSource),
    options: apiOptionsSanitizer ? apiOptionsSanitizer(rawOptions) : rawOptions,
    progress: { ...info.progress },
    result: info.result ? { ...info.result, packages: info.result.packages.map((pkg) => ({ ...pkg })) } : null,
    delete: info.delete ? { ...info.delete, targets: info.delete.targets.map(toPublicDeleteTarget) } : null,
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

/**
 * 剔除 internal 里「只该活在进程内存」的能力参数（PW-1）。
 *
 * capabilityParams 存的是明文密码，用于压缩后自测（cap.verify）与删除前复核；
 * 它一旦落盘，options 侧的脱敏就失去意义。重启后需要密码的场景（重试）由用户重新输入。
 */
function withoutCapabilityParams(internal) {
  if (!internal || typeof internal !== 'object') return internal || {};
  const { capabilityParams: _dropped, ...rest } = internal;
  return rest;
}

/** 当前需要落盘的任务集合（非终态 + failed/interrupted） */
function persistedTasks(ctx) {
  const list = [];
  for (const record of ctx.tasks.values()) {
    const { status } = record.info;
    if (!TERMINAL_STATUSES.has(status) || PERSISTED_TERMINAL_STATUSES.has(status)) {
      // PW-1：落盘前通用脱敏——capabilities 里的 secret 字段（明文密码）永不落 tasks.json
      const infoForPersist = ctx.sanitizeOptionsForPersist
        ? { ...record.info, options: ctx.sanitizeOptionsForPersist(record.info.options) }
        : record.info;
      list.push({
        info: { ...toApiTask({ ...record, info: infoForPersist }), options: infoForPersist.options },
        // internal 里额外带上源的绝对路径（重启后重试要用；API 视图已剥离）。
        // PW-1：capabilityParams 存的是**明文密码**（只该活在进程内存），绝不能落盘——
        // 否则 options 那边脱敏了、internal 这边又漏一遍，等于白做。
        internal: {
          ...withoutCapabilityParams(record.internal),
          sourceAbsPaths: record.info.sources.map((source) => source.absPath || null),
        },
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

/** 压缩级别缺省值（未指定时用格式默认档；这里只兜底，真实校验在格式包） */
const DEFAULT_COMPRESS_LEVEL = 6;

/** 黑名单意图（M6）：随任务落盘，打包阶段按同一份意图重新解析用户层 */
function normalizeBlacklist(raw) {
  const blacklist = raw || {};
  return {
    enabled: blacklist.enabled !== false,
    extraPatterns: Array.isArray(blacklist.extraPatterns)
      ? blacklist.extraPatterns.filter((pattern) => typeof pattern === 'string')
      : [],
  };
}

/** 归一化 options：缺省值集中一处，避免创建路径里塞满三元表达式 */
function normalizeOptions(raw) {
  const options = raw || {};
  return {
    level: Number.isInteger(options.level) ? options.level : DEFAULT_COMPRESS_LEVEL,
    keepOriginal: options.keepOriginal !== false,
    deleteConfirmed: Boolean(options.deleteConfirmed),
    deleteArchiveAfterExtract: Boolean(options.deleteArchiveAfterExtract),
    outputDir: options.outputDir || null,
    parallel: false,
    // 能力参数（docs/19 §六）：原样透传（明文只在内存存活到压缩完成），
    // 落盘时 store.js 会用能力插件的 redact() 剔除明文——这里不认识具体能力。
    ...(options.capabilities && typeof options.capabilities === 'object'
      ? { capabilities: options.capabilities }
      : {}),
    // P4：解压加密包的密码（明文仅内存；落盘脱敏走 PW-1 通道）
    ...(typeof options.password === 'string' && options.password.length > 0
      ? { password: options.password }
      : {}),
    // 只有调用方显式给了 blacklist 才写入（解压任务不该凭空多出这个字段）
    ...(options.blacklist ? { blacklist: normalizeBlacklist(options.blacklist) } : {}),
  };
}

/** 组装任务 info（纯数据、无副作用；落盘与广播由调用方负责） */
function buildTaskInfo(ctx, input, id) {
  return {
    id,
    kind: input.kind,
    status: 'queued',
    phase: 'precheck',
    mode: input.mode || null,
    format: input.format || null,
    sources: (input.sources || []).map(toSource),
    options: normalizeOptions(input.options),
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
}

/** 组装运行时 record：绝对路径等进程内部字段放这里（**绝不进 API 响应**，但要落盘） */
function buildTaskRecord(info, input) {
  return {
    info,
    internal: { ...(input.internal || {}) },
    runner: null,
    abortController: new AbortController(),
    confirmResolver: null,
    confirmPromise: null,
    confirmTimer: null,
  };
}

/** 创建任务；**返回前必须已落盘**（契约 §六.1「创建即落盘」，返回后才写会让"创建即落盘"形同虚设） */
async function createTask(ctx, input) {
  const id = crypto.randomUUID();
  const record = buildTaskRecord(buildTaskInfo(ctx, input, id), input);

  ctx.tasks.set(id, record);
  ctx.logger.info('task created', { taskId: id, kind: record.info.kind, retryOf: record.info.retryOf });
  // 创建即落盘（§六.1，**等写完再返回**）+ 立即广播（已连接的客户端立刻看到新任务）
  await persistNow(ctx);
  publishTask(ctx, record, { immediate: true });
  return toApiTask(record);
}

/** 任务不存在时的统一文案（三处抛错共用同一句，避免文案漂移） */
const TASK_NOT_FOUND_MESSAGE = '任务不存在';

function requireRecord(ctx, id) {
  const record = ctx.tasks.get(id);
  if (!record) throw apiError(ERROR_CODES.TASK_NOT_FOUND, TASK_NOT_FOUND_MESSAGE, { taskId: id });
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

/** 失败任务的契约错误对象（aborted 时不带 error，返回 null 由调用方决定） */
function taskErrorPayload(error, code) {
  return {
    code,
    message: (error && error.message) || '任务失败',
    details: (error && error.details) || null,
    at: now(),
  };
}

/** 执行器抛错：ABORTED → aborted（无 error）；其余 → failed（带契约错误码） */
function handleTaskError(ctx, id, error, record) {
  const code = (error && error.code) || ERROR_CODES.INTERNAL_ERROR;
  const aborted = code === ERROR_CODES.ABORTED || record.abortController.signal.aborted;
  finalizeTask(ctx, id, aborted ? 'aborted' : 'failed', {
    error: aborted ? null : taskErrorPayload(error, code),
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
    // waiting_confirm 期间 activeId 已被让位给后续任务（见 markWaitingConfirm）；
    // 此处只在仍是自己时才清空，避免误清新任务的 activeId。
    if (ctx.activeId === nextId) ctx.activeId = null;
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

/**
 * 等待执行槽位（deleting 独占性，P-03 让位机制的回收侧）。
 *
 * 背景：markWaitingConfirm 让位后 activeId 可能属于后续任务 B；A 被确认后进入 deleting——
 * 这是真正的执行相位（rename/移入回收站），**必须与 B 的压缩（读源）互斥**，否则 source
 * 重叠时 B 正在读的文件会被 A 移走（ENOENT / 残缺包）。删除不可逆，该窗口必须封死。
 *
 * 语义：A 的 runner 在进入 deleting 前调用本函数，直到 activeId 空闲（或又是自己）才返回；
 * orchestrator 拿到槽位后立即 setPhase('deleting') 并执行删除。确认 HTTP 请求**不挂起**
 * （确认只做 gate resolve；等待发生在 runner 内部，与方案 2 的差异点）。
 *
 * 前提（已知边界，将来排查从这里看起）：本函数是无上限轮询（50ms 间隔），**依赖
 * activeId 一定会被释放**——pump 的 finally 保证正常/异常路径都清 activeId，但若某个
 * runner 卡死在非异步阻塞上（activeId 永不释放），本函数会永久轮询且不响应取消。
 * 该形态属于「runner 卡死」这一前置缺陷的放大，本函数不做超时兜底（谁卡死谁负责）。
 */
function waitForExecutionSlot(ctx, id) {
  return new Promise((resolve) => {
    const acquire = () => {
      if (ctx.activeId === null || ctx.activeId === id) {
        ctx.activeId = id;
        resolve();
        return;
      }
      setTimeout(acquire, 50);
    };
    acquire();
  });
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

/** 进度里的数值字段：只在调用方给了有限数时才覆盖（undefined/NaN 一律忽略） */
const PROGRESS_NUMBER_FIELDS = [
  'processedBytes',
  'totalBytes',
  'processedFiles',
  'totalFiles',
  'packagesDone',
  'packagesTotal',
];

function applyProgressNumbers(progress, patch) {
  for (const field of PROGRESS_NUMBER_FIELDS) {
    if (Number.isFinite(patch[field])) progress[field] = patch[field];
  }
}

/** 百分比（一位小数）：优先按字节算，没有总字节就按文件数算，都缺则保持原值 */
function computePercent(progress) {
  if (progress.totalBytes > 0) {
    return Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 1000) / 10);
  }
  if (progress.totalFiles > 0) {
    return Math.min(100, Math.round((progress.processedFiles / progress.totalFiles) * 1000) / 10);
  }
  return progress.percent;
}

function updateProgress(ctx, id, patch) {
  const record = ctx.tasks.get(id);
  if (!record) return;
  const progress = record.info.progress;
  applyProgressNumbers(progress, patch);
  if (patch.currentFile !== undefined) progress.currentFile = patch.currentFile;
  progress.percent = computePercent(progress);

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
    clearConfirmState(record);
  } else if (record.confirmTimer) {
    clearConfirmState(record);
  }
  ctx.speedSamples.delete(id);
  ctx.lastPublishAt.delete(id);
  ctx.logger.info('task finalized', { taskId: id, status });

  // 终态事件必须立即发布（不能被进度节流吞掉）
  ctx.events.publish('task', { task: toSummary(record) });
  // 历史追加 + 立即落盘（done/aborted 从 tasks.json 移除）
  void ctx.store.appendHistory(toApiTask(record));
  void persistNow(ctx);
  // 每完成一个任务后按保留策略清一次（兜底，防 failed/interrupted 无上限增长）
  void pruneRetention(ctx);
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

  // waiting_confirm 的取消 = 放弃删除（契约 §3.2：不回滚压缩结果，delete.status='skipped'，
  // reason=user_cancelled，任务终态 done）。resolveConfirm 走「放弃」分支唤醒 runner，
  // 由 orchestrator 正常收尾为 done——不经 abort（abort 会把任务错误地打成 aborted）。
  if (info.phase === 'waiting_confirm') {
    ctx.logger.info('waiting_confirm 任务取消 = 放弃删除', { taskId: id });
    return resolveConfirm(ctx, id, { confirmed: false, reason: 'user_cancelled' });
  }

  info.status = 'cancelling';
  info.updatedAt = now();
  record.abortController.abort();
  if (record.confirmResolver) {
    record.confirmResolver.reject(apiError(ERROR_CODES.ABORTED, '任务已取消'));
    clearConfirmState(record);
  } else if (record.confirmTimer) {
    clearConfirmState(record);
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

/**
 * 等待二次确认（M2 门闩 + 契约 §3.3 硬要求 1/3：等待有界且不阻塞队列）。
 *
 * 超时语义（confirmTimeoutMs，0=不限）：到点按**放弃删除**结算（gate.confirmed=false +
 * reason=confirm_timeout）——超时绝不等于确认。定时器在确认/放弃/超时任一出口清理，
 * 不留泄漏（runner 返回后队列立即恢复，后续任务不再被挂起）。
 */
function waitConfirm(ctx, id) {
  const record = requireRecord(ctx, id);
  if (!record.confirmPromise) {
    record.confirmPromise = new Promise((resolve, reject) => {
      record.confirmResolver = { resolve, reject };
      const timeoutMs = ctx.confirmTimeoutMs;
      if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
        record.confirmTimer = setTimeout(() => {
          if (record.confirmResolver !== null) {
            record.confirmResolver = null;
            record.confirmPromise = null;
            ctx.logger.warn('二次确认超时，按放弃删除结算（超时不等于确认）', { taskId: id, timeoutMs });
            resolve({ confirmed: false, at: now(), reason: 'confirm_timeout' });
          }
        }, timeoutMs);
      }
    });
  }
  return record.confirmPromise;
}

/** 清理确认门闩的挂起状态（定时器 + resolver），防定时器泄漏与迟到结算 */
function clearConfirmState(record) {
  if (record.confirmTimer) {
    clearTimeout(record.confirmTimer);
    record.confirmTimer = null;
  }
  record.confirmResolver = null;
  record.confirmPromise = null;
}

function resolveConfirm(ctx, id, payload = {}) {
  const record = requireRecord(ctx, id);
  if (record.info.phase !== 'waiting_confirm') {
    throw apiError(ERROR_CODES.INVALID_STATE, '当前不是待确认状态', { phase: record.info.phase });
  }
  const resolver = record.confirmResolver;
  clearConfirmState(record);
  if (payload.confirmed === false) {
    if (resolver) resolver.resolve({ confirmed: false, at: now(), reason: payload.reason || 'user_cancelled' });
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
  // 契约 §3.3 硬要求 3「不得阻塞串行队列」：确认等待期间**让位**——释放 activeId，
  // 队列里的下一个任务照常被 pump 执行。runner 仍挂在 waitConfirm 上，确认/取消/超时
  // 唤醒后直接走 finalize 收尾（不再依赖 activeId）。串行语义不破坏：waiting_confirm
  // 不是执行相位，是业务等待相位。
  if (ctx.activeId === id) ctx.activeId = null;
  publishTask(ctx, record, { immediate: true });
  void persistNow(ctx);
  return toApiTask(record);
}

// ===== 保留策略（数据模型 §六 规则 6/7/8） =====

/** 保留策略只针对"为可重试而保留的终态"；非终态是活任务，任何情况下都不参与 */
const RETENTION_STATUSES = ['failed', 'interrupted'];

function retentionCandidates(ctx) {
  return [...ctx.tasks.values()].filter((record) => RETENTION_STATUSES.includes(record.info.status));
}

/**
 * 纯函数：挑出应清理的记录 —— **最近 max 条之外** 或 **早于 days 天**（任一先到即清）。
 * 按完成时间（缺省用 updatedAt/createdAt）从新到旧排序后判断，便于单测。
 */
function selectExpired(records, options) {
  const cutoff = options.nowTs - options.days * 24 * 60 * 60 * 1000;
  const finishedAtOf = (record) => record.info.finishedAt || record.info.updatedAt || record.info.createdAt;
  const sorted = [...records].sort((a, b) => finishedAtOf(b) - finishedAtOf(a));
  const expired = [];
  sorted.forEach((record, index) => {
    if (index >= options.max || finishedAtOf(record) < cutoff) expired.push(record);
  });
  return expired;
}

/** 执行清理（时机：启动 + 每完成一个任务后）；清理后立即原子落盘 */
async function pruneRetention(ctx) {
  const candidates = retentionCandidates(ctx);
  if (candidates.length === 0) return { examined: 0, removed: 0, kept: 0 };

  const expired = selectExpired(candidates, { ...ctx.retention, nowTs: now() });
  for (const record of expired) ctx.tasks.delete(record.info.id);
  if (expired.length > 0) {
    await persistNow(ctx);
    ctx.logger.info('任务保留策略已清理活动记录（历史不受影响）', {
      removed: expired.length,
      kept: candidates.length - expired.length,
      max: ctx.retention.max,
      days: ctx.retention.days,
    });
  }
  return { examined: candidates.length, removed: expired.length, kept: candidates.length - expired.length };
}

/**
 * `DELETE /tasks/{id}`：只删**活动记录**（tasks.json），**绝不动 task-history.jsonl**（append-only 审计日志）。
 * 仅终态可删；非终态要先取消。
 */
function removeTask(ctx, id) {
  const record = ctx.tasks.get(id);
  if (!record) {
    const history = ctx.store.getHistoryEntry(id);
    if (!history) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
    // 该任务已进历史、活动记录早已移出：删除请求等价于"已无活动记录"
    return Promise.resolve({ id, removed: false, fromHistory: true, status: history.status });
  }
  if (!TERMINAL_STATUSES.has(record.info.status)) {
    throw apiError(ERROR_CODES.INVALID_STATE, '任务尚未结束，请先取消再删除记录', { status: record.info.status });
  }

  ctx.tasks.delete(id);
  // 让其他已连接客户端重新对齐（没有 deleted 事件类型，用快照最稳）
  ctx.events.publish('snapshot', snapshotOf(ctx));
  ctx.logger.info('任务活动记录已删除（历史保留）', { taskId: id, status: record.info.status });
  // 等落盘完成再返回：调用方拿到 200 时 tasks.json 里必须已经没有这条（可立即核对）
  return persistNow(ctx).then(() => ({ id, removed: true, fromHistory: false, status: record.info.status }));
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
    confirmTimer: null,
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
  // M5-F09 启动对账：trash 孤儿批次补记 + deleting 中断的 delete.status 收敛。
  // 依赖注入缺失（单测/旧装配）时跳过，不阻断恢复主流程。
  let reconciliation = null;
  if (ctx.recoveryPaths) {
    reconciliation = await reconcileAfterBoot(
      { ...ctx.recoveryPaths, logger: ctx.logger },
      [...ctx.tasks.values()],
    );
  }
  await persistNow(ctx);
  // 启动时按保留策略清一次（非终态刚被迁为 interrupted，属于候选；活任务不受影响）
  const pruned = await pruneRetention(ctx);
  return { loaded: persisted.length, recovered, pruned, reconciliation };
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
    remove: (id) => removeTask(ctx, id),
    prune: () => pruneRetention(ctx),
    retention: () => ({ ...ctx.retention }),
    waitConfirm: (id) => waitConfirm(ctx, id),
    resolveConfirm: (id, payload) => resolveConfirm(ctx, id, payload),
    markWaitingConfirm: (id) => markWaitingConfirm(ctx, id),
    waitForExecutionSlot: (id) => waitForExecutionSlot(ctx, id),
    requireTask: (id) => requireRecord(ctx, id),
    getAbortSignal: (id) => requireRecord(ctx, id).abortController.signal,
    toSummary,
    toApiTask,
    flush: () => ctx.store.flush(),
    /** PW-1：压缩层创建 capRegistry 后补挂脱敏器（manager 先于能力层装配）。
     *  同时挂到落盘路径（ctx）与 API 出口（模块级），两条路都不能漏。 */
    __setCapabilitySanitizer: (fn) => {
      if (typeof fn !== 'function') return;
      ctx.sanitizeOptionsForPersist = fn;
      apiOptionsSanitizer = fn;
    },
    stats: () => ({
      total: ctx.tasks.size,
      active: ctx.activeId,
      waiting: ctx.queue.length,
      subscribers: ctx.events.subscriberCount(),
      seq: ctx.events.currentSeq(),
    }),
  };
}
