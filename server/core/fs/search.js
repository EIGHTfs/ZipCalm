// 文件名搜索（docs/16 批次②的需求①）：只在**当前根内**按文件名做子串匹配
//
// 为什么不做全文索引：这是「找某个文件在哪」的诉求，不是内容检索；索引要持久化、要失效策略、
// 要吃内存，对一个 NAS 文件管理器属于 YAGNI。这里用**有界遍历**：深度/结果数/耗时三重上限，
// 超了就把 truncated 置真并返回已有结果 —— 宁可给部分结果，也不能让一次搜索把服务拖住。
//
// 安全：不跟随符号链接（越界链接一律不进入）；跳过黑名单目录（如 @eaDir，避免翻元数据目录）。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/** 搜索边界（写死，不做成配置：这是"防止一次搜索拖垮服务"的保护，不是业务策略） */
export const SEARCH_LIMITS = Object.freeze({
  maxDepth: 6,
  maxResults: 500,
  timeoutMs: 3000,
  /** 单目录最多读多少项，避免超大目录把一次 readdir 拖很久 */
  maxEntriesPerDir: 5000,
});

/** 目录名是否属于"不搜"的（黑名单目录规则 + 点开头系统目录） */
function isSkippedDir(name, layers) {
  if (name.startsWith('.')) return true;
  if (!Array.isArray(layers) || layers.length === 0) return false;
  // 复用黑名单的目录名匹配（@eaDir 这类），但只对目录名，不误伤普通文件
  return layers.some((layer) => (layer.patterns || []).some((pattern) => pattern === name));
}

/**
 * 在 rootAbs 内按文件名子串搜索。
 * @param {{rootAbs: string, userPath?: string}} ctx 当前根与搜索起点（用户路径，缺省根）
 * @param {string} query 关键字（非空；大小写不敏感）
 * @param {{limit?: number, layers?: Array}} [options]
 * @returns {Promise<{items: Array, truncated: boolean, scannedDirs: number, elapsedMs: number}>}
 */
export async function searchFiles(ctx, query, options = {}) {
  const keyword = String(query || '').trim().toLowerCase();
  if (keyword.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'q 不能为空');
  }
  const limit = Math.min(SEARCH_LIMITS.maxResults, Math.max(1, Number(options.limit) || 100));
  const rootAbs = ctx.rootAbs;
  const startAbs = options.startAbs || rootAbs;
  const startedAt = Date.now();
  const items = [];
  let scannedDirs = 0;
  let truncated = false;

  /** 时间预算耗尽就停（哪怕还没扫完） */
  const budgetExceeded = () => Date.now() - startedAt > SEARCH_LIMITS.timeoutMs;

  async function walk(dirAbs, depth) {
    if (truncated || budgetExceeded() || items.length >= limit) {
      truncated = true;
      return;
    }
    scannedDirs += 1;
    let dirents;
    try {
      dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return; // 不可读的子树直接跳过（不打断整次搜索）
    }
    if (dirents.length > SEARCH_LIMITS.maxEntriesPerDir) {
      dirents = dirents.slice(0, SEARCH_LIMITS.maxEntriesPerDir);
      truncated = true;
    }
    for (const dirent of dirents) {
      if (truncated || budgetExceeded() || items.length >= limit) {
        truncated = true;
        return;
      }
      if (dirent.isSymbolicLink()) continue; // 不跟随：越界链接不该被搜索"带进来"
      const childAbs = path.join(dirAbs, dirent.name);
      if (dirent.isDirectory()) {
        // 目录也参与匹配（用户搜"照片在哪"时，目录名往往就是答案），但匹配后仍继续往下走
        if (dirent.name.toLowerCase().includes(keyword)) {
          items.push(await describeEntry(childAbs, rootAbs, 'dir'));
        }
        if (depth + 1 > SEARCH_LIMITS.maxDepth) continue;
        if (isSkippedDir(dirent.name, options.layers)) continue;
        await walk(childAbs, depth + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (!dirent.name.toLowerCase().includes(keyword)) continue;
      items.push(await describeEntry(childAbs, rootAbs, 'file'));
    }
  }

  await walk(startAbs, 0);
  return { items, truncated, scannedDirs, elapsedMs: Date.now() - startedAt };
}

/** 单个命中项：只回传用户路径，**不带 absPath**（契约红线） */
async function describeEntry(absPath, rootAbs, entryType) {
  const stat = await fsp.lstat(absPath).catch(() => null);
  const userPath = `/${path.relative(rootAbs, absPath).split(path.sep).join('/')}`;
  return {
    path: userPath,
    name: path.basename(absPath),
    type: entryType,
    size: stat ? stat.size : 0,
    mtime: stat ? Math.trunc(stat.mtimeMs) : 0,
  };
}
