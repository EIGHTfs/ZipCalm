// tar 系列的**写入侧**：收集条目（与 zip 同规则）+ 流式写出（可选压缩层）
//
// 一个实现服务 tar / tar.gz / tar.zst —— 三种格式的归档层完全相同，差别只在压缩层。
// 边界（INV-15）：只读源文件、只写 ctx.tempPath，不删源、不预检、不排队。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import * as tar from 'tar';

import { ERROR_CODES, apiError } from '../../../../lib/errors.js';
import { createThrottledReporter } from '../../../../lib/throttle.js';
import { pipelineWith } from '../streams.js';
import { createCompressStream } from './compression.js';

/** 求多个目录的公共祖先（用于一次 Pack 覆盖所有源；名字取相对它的路径） */
export function commonAncestor(dirs) {
  if (dirs.length === 0) return path.sep;
  let parts = path.resolve(dirs[0]).split(path.sep);
  for (const dir of dirs.slice(1)) {
    const other = path.resolve(dir).split(path.sep);
    let index = 0;
    while (index < parts.length && index < other.length && parts[index] === other[index]) index += 1;
    parts = parts.slice(0, index);
  }
  const base = parts.join(path.sep);
  return base === '' ? path.sep : base;
}

/**
 * 收集条目（与 zip 同规则：目录保留顶层名、不跟随符号链接），并算出一个公共祖先作为 `cwd`。
 *
 * 关于包内名字：node-tar v7 的流式写入是 `Pack({cwd}) + add(相对路径)`，没有 v6 那种"任意指定包内名"的入口。
 * 所以做法是 `cwd = 各源父目录的公共祖先`、名字取相对路径 —— 常规用法（同一目录下的多个源）下名字与
 * zip 侧完全一致（`源名/子路径/文件`）；若调用方把**不同父目录**的源混在一个任务里，
 * 包内名字会带上必要的中间目录（避免冲突），这是本格式已知的命名边界。
 */
export async function collectEntries(ctx) {
  const items = [];
  const sourceParents = [];
  const sourceStats = new Map();
  let skippedSymlinks = 0;

  for (const source of ctx.sources) {
    const sourceName = source.name || path.basename(source.absPath);
    sourceParents.push(path.dirname(source.absPath));
    const result = await collectSource(source, sourceName, skippedSymlinks);
    skippedSymlinks = result.skippedSymlinks;
    items.push(...result.items);
    sourceStats.set(sourceName, { count: result.items.length, bytes: result.bytes });
  }

  const base = commonAncestor(sourceParents);
  for (const item of items) {
    item.name = path.relative(base, item.absPath).split(path.sep).join('/');
  }

  return {
    items,
    base,
    sourceStats,
    totalBytes: items.reduce((sum, item) => sum + item.size, 0),
    totalFiles: items.length,
    skippedSymlinks,
  };
}

/** 单个源 → 条目列表（文件直接用；目录递归；符号链接跳过并计数） */
async function collectSource(source, sourceName, skipped) {
  let skippedSymlinks = skipped;
  const items = [];

  if (source.kind === 'file') {
    const stat = await fsp.lstat(source.absPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw apiError(ERROR_CODES.PATH_NOT_FOUND, '源文件在扫描后已不可用', { source: sourceName });
    }
    items.push({ absPath: source.absPath, size: stat.size, sourceName });
    return { items, bytes: stat.size, skippedSymlinks };
  }

  let bytes = 0;
  const walk = async (dirAbs, prefix) => {
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      const childAbs = path.join(dirAbs, dirent.name);
      if (dirent.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(childAbs, `${prefix}/${dirent.name}`);
      } else if (dirent.isFile()) {
        const stat = await fsp.lstat(childAbs);
        items.push({ absPath: childAbs, size: stat.size, sourceName });
        bytes += stat.size;
      }
    }
  };
  await walk(source.absPath, sourceName);
  return { items, bytes, skippedSymlinks };
}

/**
 * 写入归档：单个 `Pack({ cwd })` 一次性写全部条目 → 套压缩层 → 输出到 tempPath。
 *
 * 进度粒度说明（诚实交代）：node-tar v7 的流式写入不暴露"逐条写完"的回调，所以这里**按源**上报
 * （`currentFile` 为源名，`processedBytes/processedFiles` 是精确累计值）。zip 侧是逐条事件，粒度更细。
 */
export async function writeTarStream(ctx, collected, stats) {
  const report = createThrottledReporter(ctx.onProgress || (() => {}), { intervalMs: 100 });
  const startedAt = Date.now();
  const { items, base, sourceStats, totalBytes, totalFiles } = collected;

  const output = fs.createWriteStream(ctx.tempPath);
  const pack = new tar.Pack({ cwd: base, portable: true, gzip: false });
  const compressor = createCompressStream(stats.compression, stats.level);
  const done = pipelineWith([pack, compressor || new PassThrough(), output], stats.signal);

  try {
    for (const item of items) {
      if (stats.signal && stats.signal.aborted) throw apiError(ERROR_CODES.ABORTED, '任务已取消');
      pack.add(item.name);
    }
    pack.end();
    reportBySource(sourceStats, { report, totalBytes, totalFiles });
    await done;
  } catch (error) {
    await discardTemp(ctx.tempPath);
    if (error && (error.name === 'AbortError' || (stats.signal && stats.signal.aborted))) {
      throw apiError(ERROR_CODES.ABORTED, '任务已取消');
    }
    throw error;
  }

  const bytesOut = fs.existsSync(ctx.tempPath) ? (await fsp.stat(ctx.tempPath)).size : 0;
  return {
    outputPath: ctx.tempPath,
    entries: totalFiles,
    bytesIn: totalBytes,
    bytesOut,
    durationMs: Date.now() - startedAt,
    skippedSymlinks: collected.skippedSymlinks,
  };
}

/** 按源汇总进度（每个源记一次，避免"进度瞬间 100%"的假象） */
function reportBySource(sourceStats, { report, totalBytes, totalFiles }) {
  let processedBytes = 0;
  let processedFiles = 0;
  for (const [sourceName, stat] of sourceStats) {
    processedBytes += stat.bytes;
    processedFiles += stat.count;
    report({ processedBytes, totalBytes, processedFiles, totalFiles, currentFile: sourceName });
  }
}

/** 失败/取消时清掉半成品（清理失败不掩盖原始错误） */
async function discardTemp(tempPath) {
  try {
    if (fs.existsSync(tempPath)) await fsp.unlink(tempPath);
  } catch {
    /* 见上 */
  }
}
