// 归档条目安全判定与写出（**所有格式包共用一套**，M4）
//
// 为什么必须共用：zip-slip 防护是 M2 验收过的关键安全代码（拒绝 `..` / 绝对路径 / 盘符 / NUL / symlink 逃逸）。
// 每个格式各写一份 = 迟早漂移出漏洞；tar 与 zip 的差异只在"条目从哪来"，判定与写出完全一致。
//
// 判定复用 core/fs/safePath.js 的 normalizeUserPath（与 pathGuard 同一套语义），
// 再叠加归档特有的盘符检查与"目标目录 + 分隔符"前缀校验。
//
// 写盘顺序铁律：**先把所有条目判定完，再开始写** —— 恶意归档不会产生"写到一半才发现"的副作用。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipelineWith } from './streams.js';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { pathExists } from '../../../lib/fs-probe.js';
import { createThrottledReporter } from '../../../lib/throttle.js';
import { normalizeUserPath } from '../../../core/fs/safePath.js';

const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

/** 仅返回 basename：错误 details 里绝不出现本机绝对路径 */
export function safeName(target) {
  return typeof target === 'string' ? path.basename(target) : null;
}

/**
 * 归档条目名 → 目标目录内的绝对路径；任何逃逸企图直接抛错（zip-slip 核心）。
 * @returns {{targetPath: string, segments: string[], isRoot: boolean}}
 */
export function resolveEntryTarget(targetDir, entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw apiError(ERROR_CODES.INVALID_PATH, '归档条目名为空', { entry: entryName });
  }
  const unified = entryName.replace(/\\/g, '/');
  // 盘符（Windows 绝对路径形态，如 C:/evil）：API 语义里不可能合法
  if (/^[A-Za-z]:/.test(unified)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档条目含盘符（zip-slip）', { entry: entryName });
  }
  // 绝对路径：一律拒绝（总是相对目标目录展开）
  if (unified.startsWith('/')) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档条目为绝对路径（zip-slip）', { entry: entryName });
  }

  let normalized;
  try {
    normalized = normalizeUserPath(unified, {
      maxPathLength: MAX_PATH_LENGTH,
      maxPathSegmentLength: MAX_SEGMENT_LENGTH,
    });
  } catch (error) {
    // normalizeUserPath 抛的是契约错误（.. / 编码 .. / NUL / 超长）：原样抛，只补条目名便于定位
    if (error && error.details) error.details.entry = entryName;
    throw error;
  }

  const root = path.resolve(targetDir);
  const target = path.resolve(root, ...normalized.segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档条目逃逸目标目录（zip-slip）', { entry: entryName });
  }
  return { targetPath: target, segments: normalized.segments, isRoot: target === root };
}

/** 符号链接条目：M4 策略同样是**一律拒绝**（比"仅拒绝指向目标外的链接"更保守） */
export function rejectSymlink(entryName) {
  throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档包含符号链接条目，已拒绝解压', { entry: entryName });
}

/**
 * 写盘前的条目预检：zip-slip 判定 + 覆盖判定（INV-08）。
 * @param {Array<{name: string, isDir: boolean, size: number, link?: boolean, open?: Function}>} entries
 * @param {string} targetDir 目标目录（绝对路径）
 * @param {boolean} overwrite 是否允许覆盖已有同名文件
 */
export async function planTargets(entries, targetDir, overwrite) {
  const plan = [];
  let totalBytes = 0;
  let totalFiles = 0;

  for (const entry of entries) {
    if (entry.link) rejectSymlink(entry.name);
    const unified = String(entry.name || '').replace(/\\/g, '/');
    const nameForCheck = unified.replace(/\/+$/, '');
    const resolved = resolveEntryTarget(targetDir, nameForCheck);
    const isDir = Boolean(entry.isDir) || unified.endsWith('/');
    const size = isDir ? 0 : Number(entry.size || 0);

    plan.push({
      entry,
      isDir,
      targetPath: resolved.targetPath,
      displayName: entry.name,
      size,
      open: entry.open,
    });
    if (!isDir) {
      totalBytes += size;
      totalFiles += 1;
    }
  }

  if (!overwrite) {
    for (const plannedEntry of plan) {
      if (plannedEntry.isDir) continue;
      if (await pathExists(plannedEntry.targetPath)) {
        throw apiError(ERROR_CODES.TARGET_EXISTS, '目标目录已存在同名文件（overwrite=false）', { entry: plannedEntry.displayName });
      }
    }
  }

  return { plan, totalBytes, totalFiles };
}

/**
 * 按计划写盘：目录先建、文件走流式管道；失败/取消清理半成品（契约 §3.4.1 第 4 条）。
 * @param {{plan: Array, totalBytes: number, totalFiles: number}} planned planTargets 的返回
 */
export async function writePlan(planned, targetDir, options = {}) {
  const { signal } = options;
  const report = createThrottledReporter(options.onProgress || (() => {}), { intervalMs: 100 });
  let processedBytes = 0;
  let processedFiles = 0;
  let entries = 0;

  await fsp.mkdir(targetDir, { recursive: true });

  for (const plannedEntry of planned.plan) {
    if (signal && signal.aborted) throw apiError(ERROR_CODES.ABORTED, '任务已取消');

    if (plannedEntry.isDir) {
      await fsp.mkdir(plannedEntry.targetPath, { recursive: true });
      entries += 1;
      continue;
    }

    await fsp.mkdir(path.dirname(plannedEntry.targetPath), { recursive: true });
    try {
      // 注意：signal 为空时绝不能传 undefined（pipeline 会把它当 stage 校验并抛错）
      await pipelineWith([plannedEntry.open(), fs.createWriteStream(plannedEntry.targetPath)], signal);
    } catch (error) {
      try {
        // force: true = 不存在也不算错（因此不需要先探一次是否存在）
        await fsp.rm(plannedEntry.targetPath, { force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      if (error && (error.name === 'AbortError' || (signal && signal.aborted))) {
        throw apiError(ERROR_CODES.ABORTED, '任务已取消');
      }
      throw error;
    }

    entries += 1;
    processedFiles += 1;
    processedBytes += plannedEntry.size;
    report({
      processedBytes,
      totalBytes: planned.totalBytes,
      processedFiles,
      totalFiles: planned.totalFiles,
      currentFile: plannedEntry.displayName,
    });
  }

  return { entries, bytesOut: processedBytes };
}
