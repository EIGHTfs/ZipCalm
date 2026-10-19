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
import { detect as detectSystemTrash, rmdirDir, unlinkFile } from '../fs/systemTrash.js';

const VALID_MODES = new Set(['log-only', 'trash']);

/**
 * 回收站后端（delete.trashBackend）：
 * - auto（默认）：探测到群晖 synorecycle 就用系统回收站，否则项目 storage/trash
 * - system：强制系统回收站；**不可用/失败一律回退项目 trash，不报错**
 * - project：强制项目 trash
 * - none：不启用回收站 —— 删除会被拒绝并记 failed（绝不退化成真删）
 */
const VALID_BACKENDS = new Set(['auto', 'system', 'project', 'none']);

/**
 * 解析出实际要用的后端（system/project/none）。
 * 优先级：**环境变量 ZIPCALM_TRASH_BACKEND > 配置 delete.trashBackend > auto**。
 * 为什么环境变量最高：它是进程级临时覆盖，用来让测试/演练固定到项目 trash，
 * 而不必去改用户的 config（改配置会影响真实使用）。非法值回落配置值，不报错。
 */
function resolveBackend(configured, systemAvailable, envOverride) {
  let wanted = VALID_BACKENDS.has(configured) ? configured : 'auto';
  if (typeof envOverride === 'string' && envOverride.length > 0) {
    if (VALID_BACKENDS.has(envOverride)) wanted = envOverride;
  }
  if (wanted === 'none') return 'none';
  if (wanted === 'project') return 'project';
  if (wanted === 'system') return systemAvailable ? 'system' : 'project';
  return systemAvailable ? 'system' : 'project';
}

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
function logBaseOf(ctx, input, target, ts, batchId, mode = ctx.mode) {
  return {
    ts,
    batchId,
    taskId: input.taskId,
    kind: input.kind,
    reason: input.reason,
    mode,
    source: target.userPath,
    sizeBytes: Number.isFinite(target.size) ? target.size : null,
  };
}

/** 跨分区删除的暂存目录名（创建在**源文件同级**，保证 rename 不跨分区） */
const CROSS_DEVICE_STAGING_DIR = '.zipcalm-cross-device';

/** log-only：只记账、不动文件（关键安全行为） */
async function skipInLogOnly(ctx, input, target, deleteRecord, base) {
  deleteRecord.skipped.push({ path: target.userPath, reason: 'log-only' });
  await recordLog(ctx, { ...base, action: 'skipped-log-only' });
  ctx.logger.info('删除动作被 log-only 模式拦下（文件未动）', { taskId: input.taskId, source: target.userPath });
}

/**
 * EXDEV 回退（跨分区）：copyFile → size 校验 → 原件 rename 进**源分区内**的暂存目录。
 * **全程零 unlink**——复制校验失败时只清理本次新建的不完整副本，原件原地不动，绝不走直接删除。
 *
 * 为什么原件也要再挪一步而不是 copy 后留在原地：trash 语义是"原件已入回收站可恢复"，
 * 若 copy 成功但原件留在源目录，任务 delete.status=deleted 与磁盘状态不一致（文件还在）。
 * 暂存目录与源同分区，恢复时直接从那里取回。
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
  // 暂存目录必须在**源所在分区**：放在 trashDir 下的话，对"根在别的分区"的场景（如多根切到 /volumeN）
  // 这一 rename 仍然是 EXDEV，会表现为"回收站里躺着一份副本、原件还在原地、删除记为失败"（实测踩过）。
  const stagingDir = path.join(path.dirname(target.absPath), CROSS_DEVICE_STAGING_DIR);
  await fsp.mkdir(stagingDir, { recursive: true });
  const stagedName = `${Date.now()}-${path.basename(destination)}`;
  await fsp.rename(target.absPath, path.join(stagingDir, stagedName));
  ctx.logger.info('跨分区删除走 copy+verify 回退，原件已移入 .cross-device 暂存', {
    source: target.userPath,
    staged: stagedName,
  });
}

/**
 * 系统回收站（群晖 #recycle）：只报告结果，**失败不在这里兜底** —— 由调用方回退项目 trash。
 * 目录用 rmdirDir、文件用 unlinkFile；先用 unlinkFile 试，返回 is_directory 再换 rmdirDir
 * （fs/delete 的 targets 不一定带 kind，用模块自己的类型判定更可靠）。
 */
async function moveToSystemRecycle(ctx, input, target, deleteRecord, base, batchId) {
  let recycled = await unlinkFile(target.absPath);
  if (!recycled.ok && recycled.reason === 'is_directory') {
    recycled = await rmdirDir(target.absPath);
  }
  if (!recycled.ok) return recycled;

  // 群晖模式下 batchId 只进日志，不建目录（回收站由 DSM 管理）
  deleteRecord.deleted.push({ path: target.userPath, backend: 'system-recycle', batchId });
  await recordLog(ctx, { ...base, action: 'recycled', backend: 'system-recycle', batchId });
  ctx.logger.info('原文件已移入群晖系统回收站', { taskId: input.taskId, source: target.userPath, batchId });
  return { ok: true };
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
    deleteRecord.deleted.push({ path: target.userPath, trashPath: trashRel, backend: 'project-trash', batchId });
    await recordLog(ctx, { ...base, action: 'trashed', backend: 'project-trash', trashPath: trashRel });
    ctx.logger.info('原文件已移入回收站', { taskId: input.taskId, source: target.userPath, trashPath: trashRel });
  } catch (error) {
    const code = toApiError(error).code;
    deleteRecord.failed.push({ path: target.userPath, code });
    await recordLog(ctx, { ...base, action: 'failed', backend: 'project-trash', error: code });
    ctx.logger.error('删除失败', { taskId: input.taskId, source: target.userPath, code });
  }
}

/**
 * 执行删除（或 log-only 记账）。
 * @param {object} ctx 服务上下文（mode/logger/logDir/trashDir/projectRoot/rootAbs）
 * @param {{taskId: string, kind: 'compress'|'extract', reason: string, targets: Array<{userPath: string, absPath: string, kind: string, size?: number}>}} input
 */
async function deleteTargets(ctx, input) {
  // 按调用覆盖 mode（缺省沿用服务配置）：
  // 压缩后自动删除默认走 log-only（安全默认，需要用户可回到"只记账"）；
  // 但**用户手动删除**（fs/delete）语义不同 —— 他明确点了删除，log-only 会表现为"点了没反应"，
  // 所以那条路径显式传 mode:'trash'（仍然进回收站可恢复，不是永真删除）。
  const mode = input.mode && VALID_MODES.has(input.mode) ? input.mode : ctx.mode;
  // INV-06 复核基准：默认用服务级根；多根下由调用方传"这次操作所属的根"
  const rootAbs = input.rootAbs || ctx.rootAbs;
  const batchId = crypto.randomUUID();
  const ts = new Date().toISOString();
  const logFile = path.join(ctx.logDir, logFileName(new Date()));
  const deleteRecord = {
    batchId,
    mode,
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
  if (rootAbs) {
    verifiedTargets = [];
    for (const target of input.targets) {
      try {
        const { absPath: derived } = resolveWithinRoot(rootAbs, target.userPath);
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
    const base = logBaseOf(ctx, input, target, ts, batchId, mode);
    if (mode === 'log-only') {
      await skipInLogOnly(ctx, input, target, deleteRecord, base);
      continue;
    }
    if (ctx.backend === 'none') {
      // 明确关掉了回收站：拒绝删除并记账 —— 宁可"没删掉"，也绝不退化成真删
      deleteRecord.failed.push({ path: target.userPath, code: 'TRASH_DISABLED' });
      await recordLog(ctx, { ...base, action: 'failed', backend: 'none', error: 'TRASH_DISABLED' });
      ctx.logger.error('回收站后端为 none，删除被拒绝（未动文件）', { taskId: input.taskId, source: target.userPath });
      continue;
    }
    if (ctx.backend === 'system') {
      const recycled = await moveToSystemRecycle(ctx, input, target, deleteRecord, base, batchId);
      if (recycled.ok) continue;
      // 回退：系统回收站失败（权限/共享名/命令异常）→ 项目 trash，**绝不直接删**
      ctx.logger.warn('系统回收站不可用，回退项目回收站', {
        taskId: input.taskId, source: target.userPath, reason: recycled.reason, detail: recycled.detail,
      });
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

  const configuredBackend = options.config && options.config.delete ? options.config.delete.trashBackend : undefined;
  const systemAvailable = detectSystemTrash().available;
  if (configuredBackend !== undefined && !VALID_BACKENDS.has(configuredBackend)) {
    options.logger.warn('delete.trashBackend 非法，已回落 auto', { configured: String(configuredBackend) });
  }
  const envBackend = process.env.ZIPCALM_TRASH_BACKEND;
  if (typeof envBackend === 'string' && envBackend.length > 0 && VALID_BACKENDS.has(envBackend) && envBackend !== configuredBackend) {
    options.logger.warn('delete.trashBackend 被环境变量覆盖（进程级临时生效）', { env: envBackend, configured: String(configuredBackend) });
  }
  const backend = resolveBackend(configuredBackend, systemAvailable, envBackend);

  const ctx = {
    mode,
    backend,
    logger: options.logger,
    logDir: options.logDir,
    trashDir: options.trashDir,
    projectRoot: options.projectRoot,
    // 存储根（INV-06：入口白名单复核与 absPath 自推导的基准）；未传时跳过复核保持向后兼容
    rootAbs: options.rootAbs,
  };

  return {
    mode,
    /** 实际生效的回收站后端（system / project / none），验收与日志用 */
    backend,
    deleteTargets: (input) => deleteTargets(ctx, input),
    logFileName,
    /** 便于测试/验收直接读当天的删除日志路径 */
    currentLogFile: () => path.join(ctx.logDir, logFileName(new Date())),
  };
}
