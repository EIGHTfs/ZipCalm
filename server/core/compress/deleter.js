// 删除服务（压缩删原文件 / 解压删压缩包 **共用同一实现**）
//
// 契约（docs/M0/数据模型.md §八 delete.mode）：
// - `log-only`（**默认**）：只写删除日志、**不真删** —— 开发期用来核对"校验通过 → 触发删除"的时机，
//   同时保证"配置写错也绝不会真删数据"（安全默认）；
// - `trash`：移动到 storage/trash/<batchId>/ 并保留相对目录结构（可恢复），同时写日志；
// - 未知值 → 告警并回落 `log-only`。
//
// 重要：本模块**不做校验**。调用方（orchestrator）必须先通过 verify（INV-01）才允许调用它。
// 日志：storage/logs/delete-YYYYMMDD.jsonl（每行一条，可追溯，M5 验收要求"删除有日志"）。
//
// 结构：状态集中在 ctx，动作拆成模块级小函数（记账 / log-only 拦下 / 移入回收站），
// deleteTargets 只负责遍历与汇总。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { toApiError, apiError, ERROR_CODES } from '../../lib/errors.js';
import { resolveWithinRoot } from '../fs/safePath.js';

const VALID_MODES = new Set(['log-only', 'trash']);

/** 删除日志文件名（按**本地日期**分文件；测试脚本拼这个名字时也要用本地日期） */
function logFileName(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `delete-${y}${m}${d}.jsonl`;
}

/** 追加一条 JSONL 删除记录；日志失败不影响主流程 */
async function recordLog(ctx, entry) {
  const file = path.join(ctx.logDir, logFileName(new Date()));
  try {
    await fsp.mkdir(ctx.logDir, { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    ctx.logger.error('删除日志写入失败', { error: error.message });
  }
  return file;
}

/** 每条目标共用的日志字段（各分支再补 action 与结果字段） */
function logBaseOf(ctx, input, target, ts, batchId) {
  return {
    ts,
    batchId,
    taskId: input.taskId,
    kind: input.kind,
    reason: input.reason,
    mode: ctx.mode,
    source: target.userPath,
    sizeBytes: Number.isFinite(target.size) ? target.size : null,
  };
}

/** log-only：只记账、不动文件（关键安全行为） */
async function skipInLogOnly(ctx, input, target, deleteRecord, base) {
  deleteRecord.skipped.push({ path: target.userPath, reason: 'log-only' });
  await recordLog(ctx, { ...base, action: 'skipped-log-only' });
  ctx.logger.info('删除动作被 log-only 模式拦下（文件未动）', { taskId: input.taskId, source: target.userPath });
}

/**
 * EXDEV 回退（跨分区）：copyFile → size 校验 → 原件 rename 进回收站的 `.cross-device/`
 * 暂存位（同分区，秒级）。**全程零 unlink**——复制校验失败时只清理本次新建的不完整副本，
 * 原件原地不动，绝不走直接删除。
 *
 * 为什么原件也要再挪一步而不是 copy 后留在原地：trash 语义是"原件已入回收站可恢复"，
 * 若 copy 成功但原件留在源目录，任务 delete.status=deleted 与磁盘状态不一致（文件还在）。
 * `.cross-device/` 暂存位与 batchId 同区，恢复路径一致。
 */
async function moveCrossDevice(ctx, target, destination) {
  const sourceStat = await fsp.stat(target.absPath);
  await fsp.copyFile(target.absPath, destination);
  const copiedStat = await fsp.stat(destination);
  if (Number(copiedStat.size) !== Number(sourceStat.size)) {
    // 校验失败：destination 是本次新建的副本，可安全移除；原件不动
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw Object.assign(new Error('跨分区复制校验失败（size 不一致）'), { code: 'INTERNAL_ERROR' });
  }
  const stagingDir = path.join(ctx.trashDir, '.cross-device');
  await fsp.mkdir(stagingDir, { recursive: true });
  const stagedName = `${Date.now()}-${path.basename(destination)}`;
  await fsp.rename(target.absPath, path.join(stagingDir, stagedName));
  ctx.logger.info('跨分区删除走 copy+verify 回退，原件已移入 .cross-device 暂存', {
    source: target.userPath,
    staged: stagedName,
  });
}

/** trash：移动到回收站（保留相对结构，可恢复；跨分区走 copy+verify 回退，零 unlink） */
async function moveToTrash(ctx, input, target, deleteRecord, base, batchId) {
  try {
    const segments = String(target.userPath || '').split('/').filter(Boolean);
    const destination = path.join(ctx.trashDir, batchId, ...segments);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fsp.rename(target.absPath, destination);
    } catch (error) {
      if (error && error.code === 'EXDEV') {
        await moveCrossDevice(ctx, target, destination);
      } else {
        throw error;
      }
    }
    const trashRel = ['trash', batchId, ...segments].join('/');
    deleteRecord.deleted.push({ path: target.userPath, trashPath: trashRel });
    await recordLog(ctx, { ...base, action: 'trashed', trashPath: trashRel });
    ctx.logger.info('原文件已移入回收站', { taskId: input.taskId, source: target.userPath, trashPath: trashRel });
  } catch (error) {
    const code = toApiError(error).code;
    deleteRecord.failed.push({ path: target.userPath, code });
    await recordLog(ctx, { ...base, action: 'failed', error: code });
    ctx.logger.error('删除失败', { taskId: input.taskId, source: target.userPath, code });
  }
}

/**
 * 执行删除（或 log-only 记账）。
 * @param {object} ctx 服务上下文（mode/logger/logDir/trashDir/projectRoot/rootAbs）
 * @param {{taskId: string, kind: 'compress'|'extract', reason: string, targets: Array<{userPath: string, absPath: string, kind: string, size?: number}>}} input
 */
async function deleteTargets(ctx, input) {
  const batchId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const logFile = path.join(ctx.logDir, logFileName(new Date()));
  const deleteRecord = {
    batchId,
    mode: ctx.mode,
    requested: input.targets.length,
    deleted: [],
    skipped: [],
    failed: [],
    logFile: path.relative(ctx.projectRoot || process.cwd(), logFile).split(path.sep).join('/'),
  };

  // INV-06：deleter 是独立模块，不信任调用方传入的 absPath——入口对每个 userPath 重跑
  // 白名单校验并**自行推导** absPath；与调用方传入值交叉断言，不一致按单条失败隔离
  // （单条不整批崩，其余条目照删，避免一个坏 target 阻断整批）。
  let verifiedTargets = input.targets;
  if (ctx.rootAbs) {
    verifiedTargets = [];
    for (const target of input.targets) {
      try {
        const { absPath: derived } = resolveWithinRoot(ctx.rootAbs, target.userPath);
        if (target.absPath && derived !== target.absPath) {
          throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, 'absPath 与 userPath 推导结果不一致', {
            userPath: target.userPath,
            callerAbsPath: target.absPath,
          });
        }
        verifiedTargets.push({ ...target, absPath: derived });
      } catch (error) {
        const code = toApiError(error).code;
        deleteRecord.failed.push({ path: target.userPath, code });
        ctx.logger.error('删除目标未通过白名单校验，该条目被隔离', { taskId: input.taskId, source: target.userPath, code });
      }
    }
  }

  for (const target of verifiedTargets) {
    const base = logBaseOf(ctx, input, target, ts, batchId);
    if (ctx.mode === 'log-only') {
      await skipInLogOnly(ctx, input, target, deleteRecord, base);
      continue;
    }
    await moveToTrash(ctx, input, target, deleteRecord, base, batchId);
  }

  return deleteRecord;
}

export function createDeleteService(options) {
  const configuredMode = options.config && options.config.delete ? options.config.delete.mode : undefined;
  const mode = VALID_MODES.has(configuredMode) ? configuredMode : 'log-only';
  if (!VALID_MODES.has(configuredMode)) {
    options.logger.warn('delete.mode 非法，已回落 log-only（安全默认）', { configured: String(configuredMode) });
  }

  const ctx = {
    mode,
    logger: options.logger,
    logDir: options.logDir,
    trashDir: options.trashDir,
    projectRoot: options.projectRoot,
    // 存储根（INV-06：入口白名单复核与 absPath 自推导的基准）；未传时跳过复核保持向后兼容
    rootAbs: options.rootAbs,
  };

  return {
    mode,
    deleteTargets: (input) => deleteTargets(ctx, input),
    logFileName,
    /** 便于测试/验收直接读当天的删除日志路径 */
    currentLogFile: () => path.join(ctx.logDir, logFileName(new Date())),
  };
}
