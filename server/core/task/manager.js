// 任务管理器（M2 雏形：内存 + 串行队列；落盘在 M3）
//
// 契约（docs/M0/数据模型.md §三/§五）：状态机 queued→running→(cancelling)→终态；
// 串行执行（同一时刻最多 1 个 running）；进度是"状态"不是"消息"（可随时查询）。
//
// M2 的刻意简化：
// - 任务与历史都只在内存（M3 落盘）；
// - SSE 未实现（M3），前端用轮询 GET /tasks/{id}；
// - 但**状态机、取消（AbortSignal）、进度结构、终态语义**全部按契约实现，
//   这样 M3 落盘时只是"把同一份结构写文件"，不需要改调用方。

import crypto from 'node:crypto';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

const TERMINAL_STATUSES = new Set(['done', 'failed', 'aborted', 'interrupted']);

export function createTaskManager(options = {}) {
  const logger = options.logger || { info() {}, warn() {}, error() {} };
  const historyLimit = Number.isInteger(options.historyLimit) ? options.historyLimit : 100;

  /** Map<id, record>：record 含 info（对外）+ runner/abort/waiters（内部） */
  const tasks = new Map();
  const queue = [];
  const history = [];
  let activeId = null;

  function now() {
    return Date.now();
  }

  function emptyProgress() {
    return {
      percent: 0,
      processedBytes: 0,
      totalBytes: 0,
      processedFiles: 0,
      totalFiles: 0,
      currentFile: null,
      updatedAt: now(),
    };
  }

  function create(input) {
    const id = crypto.randomUUID();
    const info = {
      id,
      kind: input.kind, // 'compress' | 'extract'
      status: 'queued',
      phase: 'precheck',
      mode: input.mode || null,
      format: input.format || null,
      sources: input.sources || [],
      archivePath: input.archivePath || null,
      targetDir: input.targetDir || null,
      options: input.options || {},
      progress: emptyProgress(),
      result: null,
      delete: input.options && (input.options.keepOriginal === false || input.options.deleteArchiveAfterExtract === true)
        ? { requested: true, confirmed: false, status: 'pending', targets: [], mode: null, logFile: null, deletedAt: null, error: null }
        : null,
      error: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      updatedAt: now(),
      retryOf: null,
    };

    const record = {
      info,
      // 进程内部字段（绝对路径等）：**绝不进 API 响应**，只给编排器用。
      // 早期版本把这些字段直接写在 info 上，结果被 create() 的字段白名单丢掉 → 编排器拿到 undefined
      // → stat(undefined) 抛 TypeError 被错映射成 PERMISSION_DENIED（真实踩过的坑）。
      internal: { ...(input.internal || {}) },
      abortController: new AbortController(),
      runner: null,
      confirmResolver: null,
      confirmPromise: null,
    };
    tasks.set(id, record);
    logger.info('task created', { taskId: id, kind: info.kind });
    return info;
  }

  /** 对外快照（去掉内部字段；数组/对象做浅拷贝，避免调用方改动内存态） */
  function snapshot(info) {
    return {
      ...info,
      // 对外视图：剥离进程内部字段 —— absPath 是绝对路径，绝不进 API 响应
      // （契约 docs/M0/API规范.md §一：对外路径一律「相对存储根的 POSIX 路径」）
      sources: info.sources.map(({ absPath, ...pub }) => ({ ...pub })),
      options: { ...info.options },
      progress: { ...info.progress },
      delete: info.delete ? { ...info.delete, targets: info.delete.targets.map((target) => ({ ...target })) } : null,
      error: info.error ? { ...info.error } : null,
    };
  }

  function get(id) {
    const record = tasks.get(id);
    return record ? snapshot(record.info) : null;
  }

  function requireTask(id) {
    const record = tasks.get(id);
    if (!record) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
    return record;
  }

  function list(filter = {}) {
    const items = [...tasks.values()].map((record) => snapshot(record.info));
    const filtered = filter.status ? items.filter((item) => filter.status.includes(item.status)) : items;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return {
      items: filtered.slice(0, filter.limit || 50),
      queue: {
        active: activeId,
        waiting: queue.length,
        parallel: false,
      },
      history: history.slice(-20).reverse(),
    };
  }

  function setPhase(id, phase) {
    const record = tasks.get(id);
    if (!record) return;
    record.info.phase = phase;
    record.info.updatedAt = now();
  }

  function updateProgress(id, patch) {
    const record = tasks.get(id);
    if (!record) return;
    const progress = record.info.progress;
    if (Number.isFinite(patch.processedBytes)) progress.processedBytes = patch.processedBytes;
    if (Number.isFinite(patch.totalBytes)) progress.totalBytes = patch.totalBytes;
    if (Number.isFinite(patch.processedFiles)) progress.processedFiles = patch.processedFiles;
    if (Number.isFinite(patch.totalFiles)) progress.totalFiles = patch.totalFiles;
    if (patch.currentFile !== undefined) progress.currentFile = patch.currentFile;

    if (progress.totalBytes > 0) {
      progress.percent = Math.min(100, Math.round((progress.processedBytes / progress.totalBytes) * 1000) / 10);
    } else if (progress.totalFiles > 0) {
      progress.percent = Math.min(100, Math.round((progress.processedFiles / progress.totalFiles) * 1000) / 10);
    }
    progress.updatedAt = now();
    record.info.updatedAt = progress.updatedAt;
  }

  /** 入队：runner 负责调用 finalize（异常由 pump 兜底转 failed） */
  function enqueue(id, runner) {
    const record = requireTask(id);
    record.runner = runner;
    queue.push(id);
    pump();
  }

  async function pump() {
    if (activeId) return;
    const nextId = queue.shift();
    if (!nextId) return;

    const record = tasks.get(nextId);
    if (!record) {
      pump();
      return;
    }

    activeId = nextId;
    record.info.status = 'running';
    record.info.startedAt = now();
    record.info.updatedAt = record.info.startedAt;
    logger.info('task started', { taskId: nextId, kind: record.info.kind });

    try {
      await record.runner(record);
      // runner 正常返回但没置终态时兜底为 done（不该发生，防呆）
      if (!TERMINAL_STATUSES.has(record.info.status)) {
        finalize(nextId, 'done');
      }
    } catch (error) {
      if (!TERMINAL_STATUSES.has(record.info.status)) {
        const code = (error && error.code) || ERROR_CODES.INTERNAL_ERROR;
        const aborted = code === ERROR_CODES.ABORTED || record.abortController.signal.aborted;
        finalize(nextId, aborted ? 'aborted' : 'failed', {
          error: aborted
            ? null
            : {
                code,
                message: (error && error.message) || '任务失败',
                details: (error && error.details) || null,
                at: now(),
              },
        });
        if (!aborted) {
          logger.error('task failed', { taskId: nextId, code, error: (error && error.message) || null });
        }
      }
    } finally {
      activeId = null;
      pump();
    }
  }

  function finalize(id, status, extra = {}) {
    const record = tasks.get(id);
    if (!record) return null;
    const info = record.info;
    if (TERMINAL_STATUSES.has(info.status)) return snapshot(info);

    info.status = status;
    info.finishedAt = now();
    info.updatedAt = info.finishedAt;
    if (status === 'done') {
      info.progress.percent = 100;
      info.progress.updatedAt = info.finishedAt;
    }
    if (extra.error) info.error = extra.error;
    if (extra.result) info.result = extra.result;
    if (extra.delete) info.delete = { ...(info.delete || {}), ...extra.delete };

    // 终态进历史（M2 内存历史；M3 换成 task-history.jsonl）
    history.push({
      id: info.id,
      kind: info.kind,
      status: info.status,
      finishedAt: info.finishedAt,
      error: info.error ? info.error.code : null,
    });
    while (history.length > historyLimit) history.shift();

    logger.info('task finalized', { taskId: id, status, phase: info.phase });
    return snapshot(info);
  }

  function cancel(id) {
    const record = requireTask(id);
    const info = record.info;
    if (TERMINAL_STATUSES.has(info.status)) {
      throw apiError(ERROR_CODES.TASK_NOT_CANCELLABLE, '任务已结束，无法取消', { status: info.status });
    }
    if (!['queued', 'running'].includes(info.status)) {
      throw apiError(ERROR_CODES.TASK_NOT_CANCELLABLE, '当前状态不可取消', { status: info.status });
    }
    if (!['precheck', 'scanning', 'compressing', 'extracting', 'verifying'].includes(info.phase)) {
      throw apiError(ERROR_CODES.INVALID_STATE, '该阶段不允许取消', { phase: info.phase });
    }

    info.status = 'cancelling';
    info.updatedAt = now();
    record.abortController.abort();
    // 若正在等待"确认删除"，取消同样要唤醒它，否则任务会永远挂在 waiting_confirm
    if (record.confirmResolver) {
      record.confirmResolver.reject(apiError(ERROR_CODES.ABORTED, '任务已取消'));
      record.confirmResolver = null;
    }
    logger.info('task cancelling', { taskId: id, phase: info.phase });
    return snapshot(info);
  }

  /**
   * 等待用户二次确认（deleting 之前的门闩）。
   * @returns {Promise<{confirmed:boolean, at:number}>}
   */
  function waitConfirm(id) {
    const record = requireTask(id);
    if (!record.confirmPromise) {
      record.confirmPromise = new Promise((resolve, reject) => {
        record.confirmResolver = { resolve, reject };
      });
    }
    return record.confirmPromise;
  }

  /** 用户确认（或放弃）删除 */
  function resolveConfirm(id, payload = {}) {
    const record = requireTask(id);
    if (record.info.phase !== 'waiting_confirm') {
      throw apiError(ERROR_CODES.INVALID_STATE, '当前不是待确认状态', { phase: record.info.phase });
    }
    const resolver = record.confirmResolver;
    record.confirmResolver = null;
    record.confirmPromise = null;
    if (payload.confirmed === false) {
      if (resolver) resolver.resolve({ confirmed: false, at: now() });
      return snapshot(record.info);
    }
    if (resolver) resolver.resolve({ confirmed: true, at: now(), expectedFiles: payload.expectedFiles, expectedBytes: payload.expectedBytes });
    return snapshot(record.info);
  }

  function markWaitingConfirm(id) {
    const record = requireTask(id);
    record.info.phase = 'waiting_confirm';
    record.info.updatedAt = now();
    return snapshot(record.info);
  }

  return {
    create,
    get,
    list,
    enqueue,
    setPhase,
    updateProgress,
    finalize,
    cancel,
    waitConfirm,
    resolveConfirm,
    markWaitingConfirm,
    requireTask,
    getAbortSignal: (id) => requireTask(id).abortController.signal,
    stats: () => ({ total: tasks.size, active: activeId, waiting: queue.length }),
  };
}
