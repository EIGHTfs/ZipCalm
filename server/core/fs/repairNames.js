// 修复"已解压目录"里的乱码文件名（POST /fs/repair-names 的实现）
//
// 场景：文件早就解压完了（可能是旧版本 unrar 解的），磁盘上是 U+FFFE + 私有区转义的怪名字。
// 这时不可能重解压，只能就地改名 —— 本模块负责扫描、预览、并按需真改。
//
// 纪律：
//   - **dryRun 默认 true**：不显式传 false 就只出清单（项目对"文件移动/批量重命名"的硬要求）
//   - **绝不覆盖**：目标已存在 → 记 conflicts，不动的文件一个都不动
//   - **从深到浅改名**：先改子目录里的文件，再改目录本身（否则父目录改名后子路径全失效）
//   - **跳过符号链接**：不跟随、不改名（链接目标可能根本不在本根内）
//   - **有损名不猜**：带 `?` 且无 U+FFFE 标记的名字进 unrecoverable，不做 GBK 猜测
//   - 深度/条数上限：这是网络盘（CIFS），不能让一次请求跑飞

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { hasEscapeMarker, repairName } from '../../plugins/formats/_shared/nameRepair.js';
import { resolveRequestPath } from './safePath.js';

const DEFAULT_MAX_DEPTH = 6;
const MAX_DEPTH_LIMIT = 12;
const DEFAULT_MAX_ENTRIES = 5000;
const MAX_ENTRIES_LIMIT = 20000;
/** 报告里每类最多列多少条（数量永远是精确的，列表是截断的） */
const REPORT_LIMIT = 50;

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 递归收集条目（不跟随符号链接），带深度上限与条数上限 */
async function collectEntries(rootAbs, maxDepth, maxEntries) {
  const collected = [];
  let truncated = false;
  const walk = async (dirAbs, prefix, depth) => {
    if (depth > maxDepth || truncated) return;
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (collected.length >= maxEntries) {
        truncated = true;
        return;
      }
      // 符号链接一律跳过：不跟随、不改名
      if (dirent.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, dirent.name);
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      collected.push({ abs, relative, isDir: dirent.isDirectory(), depth: relative.split('/').length });
      if (dirent.isDirectory()) await walk(abs, relative, depth + 1);
    }
  };
  await walk(rootAbs, '', 1);
  return { collected, truncated };
}

/** 判定单个条目该"还原 / 有损 / 不动" */
function classifyEntry(entry) {
  const baseName = path.posix.basename(entry.relative);
  const verdict = repairName(baseName);
  if (verdict.repaired) {
    const parentRelative = path.posix.dirname(entry.relative);
    const toRelative = parentRelative === '.' ? verdict.name : `${parentRelative}/${verdict.name}`;
    return { kind: 'candidate', to: toRelative, hex: verdict.hex, reason: verdict.reason };
  }
  // 没有转义标记但带 `?` → 引擎当时输出了有损问号，原始字节已丢，救不回来（不猜 GBK）
  if (!hasEscapeMarker(baseName) && baseName.includes('?')) {
    return { kind: 'unrecoverable', reason: 'lossy' };
  }
  if (verdict.reason) return { kind: 'unrecoverable', reason: verdict.reason };
  return { kind: 'skip', reason: null };
}

/**
 * 扫描（并按需执行）目录内的乱码名还原。
 * @param {{rootAbs: string}} ctx
 * @param {{path: string, dryRun?: boolean, maxDepth?: number, maxEntries?: number}} body
 */
export async function repairNamesInDirectory(ctx, body) {
  if (typeof body.path !== 'string' || body.path.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必填');
  }
  const dryRun = body.dryRun !== false; // 默认 true：不显式传 false 就不动文件
  const maxDepth = clampInt(body.maxDepth, DEFAULT_MAX_DEPTH, 1, MAX_DEPTH_LIMIT);
  const maxEntries = clampInt(body.maxEntries, DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES_LIMIT);

  const { userPath, realPath } = await resolveRequestPath(ctx, body.path);
  const stat = await fsp.lstat(realPath).catch(() => null);
  if (!stat) throw apiError(ERROR_CODES.PATH_NOT_FOUND, '目录不存在', { path: userPath });
  if (!stat.isDirectory()) throw apiError(ERROR_CODES.VALIDATION_FAILED, '只支持对目录做批量修复', { path: userPath });

  const { collected, truncated } = await collectEntries(realPath, maxDepth, maxEntries);
  // 从深到浅：先改子项，再改父目录（父目录改名会自动带走已改好的子项）
  collected.sort((a, b) => b.depth - a.depth);

  const candidates = [];
  const unrecoverable = [];
  const conflicts = [];

  for (const entry of collected) {
    const verdict = classifyEntry(entry);
    if (verdict.kind === 'unrecoverable') {
      unrecoverable.push({ path: entry.relative, reason: verdict.reason });
      continue;
    }
    if (verdict.kind !== 'candidate') continue;

    const targetAbs = path.join(realPath, ...verdict.to.split('/'));
    // 绝不覆盖：目标已存在 → 记冲突并跳过
    const exists = await fsp.lstat(targetAbs).catch(() => null);
    if (exists) {
      conflicts.push({ from: entry.relative, to: verdict.to, reason: 'target-exists' });
      continue;
    }
    candidates.push({ entry, to: verdict.to, hex: verdict.hex, targetAbs });
  }

  let renamed = 0;
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        await fsp.mkdir(path.dirname(candidate.targetAbs), { recursive: true });
        await fsp.rename(candidate.entry.abs, candidate.targetAbs);
        renamed += 1;
      } catch {
        // 改名失败（权限/竞态）：计入冲突，不影响其他条目
        conflicts.push({ from: candidate.entry.relative, to: candidate.to, reason: 'rename-failed' });
      }
    }
  }

  return {
    path: userPath,
    dryRun,
    maxDepth,
    scanned: collected.length,
    truncated,
    candidates: candidates.slice(0, REPORT_LIMIT).map((item) => ({ from: item.entry.relative, to: item.to, hex: item.hex })),
    unrecoverable: unrecoverable.slice(0, REPORT_LIMIT),
    conflicts: conflicts.slice(0, REPORT_LIMIT),
    counts: {
      candidates: candidates.length,
      unrecoverable: unrecoverable.length,
      conflicts: conflicts.length,
      renamed,
    },
    renamed,
  };
}
