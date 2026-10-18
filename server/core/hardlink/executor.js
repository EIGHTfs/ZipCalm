// 硬链接去重 · 执行器（docs/15 §三.执行：替换顺序是安全核心）
//
// 替换顺序（每个副本，三步，绝不能"先删后建"）：
//   1. rename(副本, 副本 + '.hl-tmp-<随机>')   // 旧副本挪走，原名腾出
//   2. link(主文件, 副本)                       // 硬链接占住原名
//   3. unlink(临时名)                           // 删掉旧副本
// 最坏情况只留一个 .hl-tmp-* 临时文件，**数据始终有一份可达**（崩溃在任意一步都不会丢）。
//
// 错误捕获（docs/15）：EXDEV（跨 fs）/ EEXIST（目标已存在）/ EPERM（权限）/ ENOSPC。
// 失败单条隔离（不整批崩），全部落日志 storage/logs/hardlink-<yyyymmdd>.jsonl。
//
// 主文件选择：scan 结果里的 master（组内第一个）——execute 只信任 scan 产出的分组，
// 且执行前逐对复核「主副内容仍一致」（文件可能自扫描后被改动：复核走全量哈希，
// 失败该组跳过——判定信息过期绝不硬链）。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { fullHash } from './scanner.js';

/** 单条执行日志（jsonl 一行） */
async function recordLog(ctx, entry) {
  const now = new Date();
  const name = `hardlink-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.jsonl`;
  const file = path.join(ctx.logDir, name);
  try {
    await fsp.mkdir(ctx.logDir, { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify({ at: Date.now(), ...entry })}\n`, 'utf8');
  } catch (error) {
    ctx.logger.error('硬链接日志写入失败', { error: error.message });
  }
}

/** 执行前复核：主副全量哈希仍一致（扫描到执行之间文件可能变化） */
async function verifyPairStillIdentical(masterAbs, duplicateAbs) {
  const [masterHash, duplicateHash] = await Promise.all([fullHash(masterAbs), fullHash(duplicateAbs)]);
  return masterHash === duplicateHash;
}

/** 对单个副本执行三步替换；抛错由调用方按单条隔离 */
async function replaceWithLink(masterAbs, duplicateAbs) {
  const tmpPath = `${duplicateAbs}.hl-tmp-${crypto.randomBytes(4).toString('hex')}`;
  // 1. 旧副本挪走（原名腾出）
  await fsp.rename(duplicateAbs, tmpPath);
  try {
    // 2. 硬链接占住原名（此刻起原名与主文件同一份数据）
    await fsp.link(masterAbs, duplicateAbs);
  } catch (error) {
    // 链接失败：把旧副本挪回原位（回滚第 1 步），数据无损
    await fsp.rename(tmpPath, duplicateAbs).catch(() => {});
    throw error;
  }
  // 3. 删掉旧副本（此刻安全：原名已由链接保证可达）
  await fsp.unlink(tmpPath);
}

/**
 * 执行硬链接去重。
 * @param {object} ctx {logDir, logger, dryRunGuard}
 * @param {Array<{size, master: string(absPath), duplicates: string[](absPath)}> } groups 已复核的分组（absPath 坐标系，调用方负责白名单）
 * @param {object} options {confirmed: boolean} 必须显式 true
 * @returns {Promise<{executed: number, failed: Array<{duplicate, code}>, skippedGroups: Array<{master, reason}>, savedBytes: number}>}
 */
export async function executeHardlinkGroups(ctx, groups, options = {}) {
  if (options.confirmed !== true) {
    const error = new Error('执行需要显式确认（confirmed=true）');
    error.code = 'INVALID_STATE';
    throw error;
  }

  const execReport = { executed: 0, failed: [], skippedGroups: [], savedBytes: 0 };

  for (const group of groups || []) {
    const { master, duplicates, size } = group;
    // 执行前逐对复核：扫描后文件可能已改动，判定信息过期绝不硬链
    let allStillIdentical = true;
    for (const duplicate of duplicates) {
      const identical = await verifyPairStillIdentical(master, duplicate).catch(() => false);
      if (!identical) {
        allStillIdentical = false;
        execReport.skippedGroups.push({ master, reason: 'content_changed_since_scan' });
        await recordLog(ctx, { action: 'skipped', master, duplicate, reason: 'content_changed_since_scan' });
        break;
      }
    }
    if (!allStillIdentical) continue;

    for (const duplicate of duplicates) {
      try {
        await replaceWithLink(master, duplicate);
        execReport.executed += 1;
        execReport.savedBytes += size;
        await recordLog(ctx, { action: 'linked', master, duplicate, sizeBytes: size, result: 'ok' });
        ctx.logger.info('硬链接替换完成', { master, duplicate });
      } catch (error) {
        const code = error && error.code ? error.code : 'INTERNAL_ERROR';
        execReport.failed.push({ duplicate, code });
        await recordLog(ctx, { action: 'failed', master, duplicate, result: 'failed', errorCode: code });
        ctx.logger.error('硬链接替换失败', { master, duplicate, code });
      }
    }
  }

  return execReport;
}
