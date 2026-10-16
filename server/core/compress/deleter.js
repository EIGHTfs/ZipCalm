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

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { toApiError } from '../../lib/errors.js';

const VALID_MODES = new Set(['log-only', 'trash']);

function logFileName(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `delete-${y}${m}${d}.jsonl`;
}

export function createDeleteService(options) {
  const { config, logger, logDir, trashDir } = options;

  const configuredMode = config && config.delete ? config.delete.mode : undefined;
  const mode = VALID_MODES.has(configuredMode) ? configuredMode : 'log-only';
  if (!VALID_MODES.has(configuredMode)) {
    logger.warn('delete.mode 非法，已回落 log-only（安全默认）', { configured: String(configuredMode) });
  }

  /** 追加一条 JSONL 删除记录；日志失败不影响主流程 */
  async function recordLog(entry) {
    const file = path.join(logDir, logFileName(new Date()));
    try {
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      logger.error('删除日志写入失败', { error: error.message });
    }
    return file;
  }

  /**
   * 执行删除（或 log-only 记账）。
   * @param {{taskId: string, kind: 'compress'|'extract', reason: string, targets: Array<{userPath: string, absPath: string, kind: string, size?: number}>}} input
   */
  async function deleteTargets(input) {
    const batchId = crypto.randomUUID();
    const ts = new Date().toISOString();
    const logFile = path.join(logDir, logFileName(new Date()));
    const result = {
      batchId,
      mode,
      requested: input.targets.length,
      deleted: [],
      skipped: [],
      failed: [],
      logFile: path.relative(options.projectRoot || process.cwd(), logFile).split(path.sep).join('/'),
    };

    for (const target of input.targets) {
      const base = {
        ts,
        batchId,
        taskId: input.taskId,
        kind: input.kind,
        reason: input.reason,
        mode,
        source: target.userPath,
        sizeBytes: Number.isFinite(target.size) ? target.size : null,
      };

      if (mode === 'log-only') {
        // 关键安全行为：只记账、不动文件
        result.skipped.push({ path: target.userPath, reason: 'log-only' });
        await recordLog({ ...base, action: 'skipped-log-only' });
        logger.info('删除动作被 log-only 模式拦下（文件未动）', { taskId: input.taskId, source: target.userPath });
        continue;
      }

      // trash 模式：移动到回收站（保留相对结构，可恢复）
      try {
        const segments = String(target.userPath || '').split('/').filter(Boolean);
        const destination = path.join(trashDir, batchId, ...segments);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        await fsp.rename(target.absPath, destination);
        const trashRel = ['trash', batchId, ...segments].join('/');
        result.deleted.push({ path: target.userPath, trashPath: trashRel });
        await recordLog({ ...base, action: 'trashed', trashPath: trashRel });
        logger.info('原文件已移入回收站', { taskId: input.taskId, source: target.userPath, trashPath: trashRel });
      } catch (error) {
        const code = toApiError(error).code;
        result.failed.push({ path: target.userPath, code });
        await recordLog({ ...base, action: 'failed', error: code });
        logger.error('删除失败', { taskId: input.taskId, source: target.userPath, code });
      }
    }

    return result;
  }

  return {
    mode,
    deleteTargets,
    logFileName,
    /** 便于测试/验收直接读当天的删除日志路径 */
    currentLogFile: () => path.join(logDir, logFileName(new Date())),
  };
}
