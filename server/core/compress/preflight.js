// 压缩/解压预检（M2 最小版：权限 + 2 倍空间 + 目标可写）
//
// 契约：INV-07「剩余空间 ≥ 待压文件 × preflightFactor（默认 2）」、INV-08「绝不覆盖」。
// M6 才做黑名单与滚动预检的完整逻辑；M2 只做「够不够空间 + 权限够不够」这两件最关键的事，
// 并且**先拦后做**：预检失败不建任务（docs/06 §三）。
//
// 结构：每个预检拆成"收集事实 → 判定拦截原因 → 组装响应"三步，避免一个函数里混着 I/O、
// 判定与响应拼装（那种函数既难测也改不动）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { matchEntry } from './blacklist.js';
import { collectFilesUnder } from './sourceWalk.js';
import { pathExists } from '../../lib/fs-probe.js';

/** 压缩估算的粗比值（M2 只用于给前端一个量级；真实压缩比由格式包 estimate 决定） */
const ESTIMATED_OUTPUT_RATIO = 0.6;

/** 读取目录所在文件系统的可用字节（statfs 在 Node 18.15+ / 22 可用） */
async function freeBytesOf(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null; // 拿不到就不拦（宁可放过也不误杀），但会在响应里体现 freeBytes=null
  }
}

async function isWritable(dir) {
  try {
    await fsp.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 单个源 → 预检条目（不存在 / 不可读都在这里定下来，后续判定只看条目） */
async function sourceItemOf(source) {
  let fileStat;
  try {
    fileStat = await fsp.lstat(source.absPath);
  } catch (error) {
    return {
      path: source.path,
      name: source.name,
      kind: source.kind,
      size: 0,
      exists: false,
      readable: false,
      error: error.code === 'ENOENT' ? ERROR_CODES.PATH_NOT_FOUND : ERROR_CODES.PERMISSION_DENIED,
    };
  }

  let readable = true;
  try {
    await fsp.access(source.absPath, fs.constants.R_OK);
  } catch {
    readable = false;
  }

  const isDir = fileStat.isDirectory();
  let size = isDir ? 0 : fileStat.size;
  let fileCount = isDir ? 0 : 1;
  if (isDir) {
    const nested = await directoryStats(source.absPath);
    size = nested.bytes;
    fileCount = nested.files;
  }

  return {
    path: source.path,
    name: source.name,
    kind: isDir ? 'dir' : 'file',
    size,
    fileCount,
    exists: true,
    readable,
  };
}

async function collectSourceItems(sources) {
  const items = [];
  for (const source of sources) items.push(await sourceItemOf(source));
  return items;
}

/**
 * 给每个源标注"是否会被整体跳过"，并汇总被跳过的文件清单。
 *
 * 为什么跳过项要从"待压字节"里扣掉：它们根本不会进包（不耗压缩 CPU、不占产物空间），
 * 若仍按 totalBytes 做 2 倍空间判定，会出现"明明只剩几个文本文件，却因为目录里有 100GB 视频被拒"。
 *
 * @param {Array} items collectSourceItems 的结果
 * @param {Array} sources 与 items 同序的源（要 absPath）
 * @param {Array} layers resolveLayers 的结果（空数组 = 黑名单关闭）
 * @returns {Promise<{items: Array, skipped: Array<{path: string, pattern: string, layer: string}>, skippedBytes: number}>}
 */
async function annotateWithBlacklist(items, sources, layers) {
  const skipped = [];
  let skippedBytes = 0;
  const annotated = [];

  for (let index = 0; index < items.length; index += 1) {
    const one = await annotateOneSource(items[index], sources[index], layers);
    annotated.push(one.item);
    skipped.push(...one.skipped);
    skippedBytes += one.skippedBytes;
  }

  return { items: annotated, skipped, skippedBytes };
}

/**
 * 单个源的标注：返回标注后的条目、命中清单与命中字节数。
 * 抽出来是为了让 annotateWithBlacklist 只做"遍历 + 汇总"（圈复杂度压在阈值内）。
 */
async function annotateOneSource(sourceItem, sourceRef, layers) {
  const item = { ...sourceItem, willSkip: false, skipReason: null, keptFiles: Number(sourceItem.fileCount) || 0 };
  if (!sourceItem.exists || !sourceRef || layers.length === 0) return { item, skipped: [], skippedBytes: 0 };

  const files = await collectFilesUnder(sourceRef.absPath);
  const skipped = [];
  let keptFiles = 0;
  let skippedBytes = 0;
  for (const file of files) {
    const hit = matchEntry(layers, { name: file.name, segments: file.segments });
    if (!hit) {
      keptFiles += 1;
      continue;
    }
    skipped.push({ path: joinUserPath(sourceItem.path, file.relative), pattern: hit.pattern, layer: hit.layer });
    skippedBytes += Number(file.size) || 0;
  }
  item.keptFiles = keptFiles;
  // 整个源都被跳过（且确实有文件）：前端据此提示"该目录没有可压缩文件"，single 模式据此不建空包
  if (files.length > 0 && keptFiles === 0) {
    item.willSkip = true;
    item.skipReason = 'blacklisted';
  }
  return { item, skipped, skippedBytes };
}

/** 用户路径拼接（POSIX 风格；relative 为空表示源本身就是文件） */
function joinUserPath(base, relative) {
  if (!relative) return base;
  const prefix = base === '/' ? '' : String(base).replace(/\/$/, '');
  return `${prefix}/${relative}`;
}

/** 压缩预检的拦截判定（顺序即优先级：不存在 > 不可读 > 目录不存在 > 不可写 > 空间不足） */
function compressBlockedReason({ items, outputExists, outputWritable, freeBytes, requiredBytes, factor, totalBytes, keptBytes }) {
  const missing = items.filter((item) => !item.exists);
  const unreadable = items.filter((item) => item.exists && !item.readable);

  if (missing.length > 0) return { code: ERROR_CODES.PATH_NOT_FOUND, message: '有源条目不存在' };
  if (unreadable.length > 0) return { code: ERROR_CODES.PERMISSION_DENIED, message: '有源条目不可读' };
  // 输出目录必须已存在：我们不会替用户"静默创建目录"（那是副作用）；不存在 → PATH_NOT_FOUND（诚实错误码）
  if (!outputExists) return { code: ERROR_CODES.PATH_NOT_FOUND, message: '输出目录不存在' };
  if (!outputWritable) return { code: ERROR_CODES.PERMISSION_DENIED, message: '输出目录不可写' };
  // 全部命中黑名单：没有可压的东西（契约错误码 ALL_SOURCES_SKIPPED，422）
  if (totalBytes > 0 && keptBytes === 0) {
    return { code: ERROR_CODES.ALL_SOURCES_SKIPPED, message: '没有可压缩的文件：全部命中黑名单（可在设置里调整或关闭黑名单）' };
  }
  if (freeBytes !== null && freeBytes < requiredBytes) {
    return {
      code: ERROR_CODES.DISK_FULL,
      message: `空间不足：需要 ${requiredBytes} 字节（待压 × ${factor}），剩余 ${freeBytes} 字节`,
    };
  }
  return null;
}

/**
 * 压缩预检。
 * @param {{config: object, rootAbs: string}} deps
 * @param {{sources: Array<{path: string, absPath: string, name: string, kind: string}>, format: string, mode: string, outputDir: string}} input
 */
export async function compressPreflight(deps, input) {
  const factor = deps.config.compress.preflightFactor;
  const rawItems = await collectSourceItems(input.sources);
  // 黑名单层由调用方解析（路由里一次性解析，预检与打包共用同一份判定语义）
  const layers = Array.isArray(deps.blacklistLayers) ? deps.blacklistLayers : [];
  const { items, skipped, skippedBytes } = await annotateWithBlacklist(rawItems, input.sources, layers);

  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  // 「待压字节」= 全部源 − 黑名单跳过：跳过项不进包，不该占用 2 倍空间额度
  const keptBytes = Math.max(0, totalBytes - skippedBytes);

  const outputDir = input.outputDir;
  const outputExists = await pathExists(outputDir);
  const outputWritable = outputExists ? await isWritable(outputDir) : false;
  const freeBytes = await freeBytesOf(outputExists ? outputDir : path.dirname(outputDir));
  const requiredBytes = keptBytes * factor;

  const blockedReason = compressBlockedReason({
    items,
    outputExists,
    outputWritable,
    freeBytes,
    requiredBytes,
    factor,
    totalBytes,
    keptBytes,
  });

  return {
    canProceed: blockedReason === null,
    blockedReason,
    mode: input.mode,
    format: input.format,
    totalBytes,
    estimatedOutputBytes: Math.ceil(keptBytes * ESTIMATED_OUTPUT_RATIO),
    requiredBytes,
    freeBytes,
    preflightFactor: factor,
    items,
    // 契约 §compress/preflight：skipped[] = { path, pattern, layer }（对外只有用户路径）
    skipped,
    packages: [],
  };
}

/** 递归统计目录（字节数 + 文件数；异步、不跟随符号链接）—— 进度分母用 */
async function directoryStats(dirAbs) {
  let bytes = 0;
  let files = 0;
  let dirents;
  try {
    dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const dirent of dirents) {
    const child = path.join(dirAbs, dirent.name);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      const nested = await directoryStats(child);
      bytes += nested.bytes;
      files += nested.files;
    } else if (dirent.isFile()) {
      try {
        bytes += (await fsp.lstat(child)).size;
        files += 1;
      } catch {
        /* 竞态删除：忽略 */
      }
    }
  }
  return { bytes, files };
}

/**
 * 解压预检：归档可读 + 目标目录可写 + 空间够（解压后总量 × factor）。
 * @param {{config: object, plugin: object}} deps
 */
export async function extractPreflight(deps, input) {
  assertExtractInput(input);
  await assertArchiveReadable(input);

  // 用 list() 校验归档可解析，并取解压后总量（不解析 → ARCHIVE_CORRUPTED）
  const listing = await deps.plugin.list(input.archiveAbsPath);
  const totalBytes = listing.entries
    .filter((entry) => entry.type === 'file')
    .reduce((sum, entry) => sum + entry.size, 0);

  const factor = deps.config.compress.preflightFactor;
  const targetExists = await pathExists(input.targetAbsDir);
  // 目标目录**可能尚不存在**（解压时才创建）：存在则检查它本身，否则检查其父目录。
  // 注意必须用**绝对路径**（input.targetAbsDir）做文件系统检查——早期版本误用了 API 用户路径，
  // 结果把 "/m2-test/out" 当成了文件系统根下的 /m2-test/out，误报 PERMISSION_DENIED（真实踩过）。
  const checkDir = targetExists ? input.targetAbsDir : path.dirname(input.targetAbsDir);
  const targetWritable = await isWritable(checkDir);
  const freeBytes = await freeBytesOf(checkDir);
  const requiredBytes = totalBytes * factor;

  let blockedReason = null;
  if (!targetWritable) blockedReason = { code: ERROR_CODES.PERMISSION_DENIED, message: '目标目录不可写' };
  else if (freeBytes !== null && freeBytes < requiredBytes) {
    blockedReason = {
      code: ERROR_CODES.DISK_FULL,
      message: `空间不足：需要 ${requiredBytes} 字节（解压后 × ${factor}），剩余 ${freeBytes} 字节`,
    };
  }

  return {
    canProceed: blockedReason === null,
    blockedReason,
    archive: input.archivePath,
    targetDir: input.targetDir,
    targetExists,
    entries: listing.entries.length,
    totalBytes,
    requiredBytes,
    freeBytes,
    preflightFactor: factor,
  };
}

/** 入参完整性：内部绝对路径由编排器从 record.internal 传进来，缺了就说明调用方写错了
 *  （必须显式报错，不能靠"stat 失败"兜底，否则会伪装成权限问题） */
function assertExtractInput(input) {
  if (!input || typeof input.archiveAbsPath !== 'string' || !input.archiveAbsPath) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '解压预检缺少归档绝对路径（内部错误）');
  }
  if (typeof input.targetAbsDir !== 'string' || !input.targetAbsDir) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '解压预检缺少目标目录绝对路径（内部错误）');
  }
}

/** 归档必须存在且是普通文件；文件系统错误翻译成契约错误码 */
async function assertArchiveReadable(input) {
  let archiveStat;
  try {
    archiveStat = await fsp.stat(input.archiveAbsPath);
  } catch (error) {
    if (!error || !error.code) throw error; // 非文件系统错误：交给上层按 INTERNAL_ERROR 处理
    throw apiError(
      error.code === 'ENOENT' ? ERROR_CODES.PATH_NOT_FOUND : ERROR_CODES.PERMISSION_DENIED,
      '压缩包不可读',
      { archive: path.basename(input.archivePath || input.archiveAbsPath) },
    );
  }
  if (!archiveStat.isFile()) {
    throw apiError(ERROR_CODES.NOT_A_DIRECTORY, '目标不是文件', { archive: path.basename(input.archivePath) });
  }
}
