// 启动对账（M5-F09 / 数据模型 §六.4、P-08/P-10）
//
// 职责：进程启动、任务状态加载后，对「删除链路」留下的中间状态做一次对账扫描：
//
// 1. **trash 孤儿批次**（P-08）：rename 进回收站与写 JSONL 日志是两步、非原子——
//    进程在两步之间死掉会出现「文件已在 trash/ 但日志无该 batchId」。本扫描发现
//    孤儿批次后补写 `action: 'reconciled-crash'` 日志行，消除不可对账状态。
//    文件本身是安全的（在回收站里），不移动、不删除、不还原。
//
// 2. **deleting 中断恢复**（P-10）：deleting 是执行相位，中途 kill 后任务被 M3 恢复
//    逻辑标为 interrupted，但 delete.status 可能停在 'deleting'、部分文件已进 trash、
//    部分还在原位。对账后置 `delete.status='failed'`（契约枚举内，语义=删除未完成），
//    details 记 batchId 指引与 trash 现状；不做自动续删（半删状态下继续删需要重新过
//    全部删除前防线，重试才是安全路径——重试会创建新任务重新走完整删除链）。
//
// 设计约束：**只读 trash 与 tasks 快照 + 追加日志 + 修改内存任务字段**，绝不移动/删除
// 任何文件（对账不是清理）；所有结论落日志，人工可复核。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { toUserPath } from '../fs/safePath.js';

/** 列出 trash 下的批次目录（排除 .cross-device 暂存位等非批次条目） */
async function listTrashBatches(trashDir) {
  try {
    const entries = await fsp.readdir(trashDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  } catch {
    return []; // trash 目录不存在 = 无批次
  }
}

/** 读取全部删除日志里出现过的 batchId 集合（日志按天分文件，全量扫） */
async function collectLoggedBatchIds(logDir) {
  const ids = new Set();
  let files;
  try {
    files = await fsp.readdir(logDir);
  } catch {
    return ids;
  }
  for (const file of files) {
    if (!file.startsWith('delete-') || !file.endsWith('.jsonl')) continue;
    const text = await fsp.readFile(path.join(logDir, file), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.batchId) ids.add(entry.batchId);
      } catch {
        // 单行损坏不阻断整体对账（append-only 日志的常态容忍）
      }
    }
  }
  return ids;
}

/**
 * 对账入口：返回 { orphanBatches: string[], reconciledDeletes: number }。
 * @param {{trashDir: string, logDir: string, rootAbs: string, logger: object}} deps
 * @param {Array<{info: {id, status, delete?}}> } tasks 当前任务快照（recoverTasks 落盘前的内存态）
 */
export async function reconcileAfterBoot(deps, tasks) {
  const { trashDir, logDir, rootAbs, logger } = deps;
  const reconcileReport = { orphanBatches: [], reconciledDeletes: 0 };

  // 1) trash 孤儿批次：有目录、无日志 → 补记
  const loggedIds = await collectLoggedBatchIds(logDir);
  for (const batchId of await listTrashBatches(trashDir)) {
    if (loggedIds.has(batchId)) continue;
    reconcileReport.orphanBatches.push(batchId);
    try {
      // 把批次内的文件清单写进补记日志（人工复核用，只列相对路径不复制内容）
      const files = [];
      const walk = async (dirAbs) => {
        for (const entry of await fsp.readdir(dirAbs, { withFileTypes: true })) {
          const abs = path.join(dirAbs, entry.name);
          if (entry.isDirectory()) await walk(abs);
          else files.push(toUserPath(rootAbs, abs));
        }
      };
      await walk(path.join(trashDir, batchId));
      const file = path.join(logDir, `delete-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.jsonl`);
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.appendFile(file, `${JSON.stringify({
        action: 'reconciled-crash',
        batchId,
        at: Date.now(),
        files: files.slice(0, 50),
        fileCount: files.length,
        note: '进程在 rename 进回收站与写日志之间中断，启动对账补记（文件安全在回收站）',
      })}\n`, 'utf8');
      logger.warn('发现 trash 孤儿批次（日志缺失），已补记 reconciled-crash', { batchId, fileCount: files.length });
    } catch (error) {
      logger.error('trash 孤儿批次补记失败（不阻断启动）', { batchId, error: error.message });
    }
  }

  // 2) deleting 中断的 delete.status 对账（任务此刻已被标 interrupted）
  for (const record of tasks) {
    const { info } = record;
    if (!info.delete || info.delete.status !== 'deleting') continue;
    info.delete.status = 'failed';
    info.delete.error = {
      code: 'INTERNAL_ERROR',
      message: '删除阶段被服务重启中断，启动对账后标记为失败；原文件要么已进回收站（可从 trash 恢复）要么仍在原位，重试任务将重新走完整删除链',
      at: Date.now(),
      details: { trashBatch: info.delete.batchId || info.delete.trashBatch || null },
    };
    reconcileReport.reconciledDeletes += 1;
    logger.warn('deleting 中断任务已对账为 delete.status=failed', { taskId: info.id, trashBatch: info.delete.batchId || null });
  }

  return reconcileReport;
}
