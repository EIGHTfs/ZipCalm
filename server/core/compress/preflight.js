// 压缩/解压预检（M2 最小版：权限 + 2 倍空间 + 目标可写）
//
// 契约：INV-07「剩余空间 ≥ 待压文件 × preflightFactor（默认 2）」、INV-08「绝不覆盖」。
// M6 才做黑名单与滚动预检的完整逻辑；M2 只做「够不够空间 + 权限够不够」这两件最关键的事，
// 并且**先拦后做**：预检失败不建任务（docs/06 §三）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';

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

/**
 * 压缩预检。
 * @param {{config: object, rootAbs: string}} deps
 * @param {{sources: Array<{path: string, absPath: string, name: string, kind: string}>, format: string, mode: string, outputDir: string}} input
 */
export async function compressPreflight(deps, input) {
  const { config } = deps;
  const factor = config.compress.preflightFactor;
  const items = [];

  let totalBytes = 0;
  for (const source of input.sources) {
    let stat;
    try {
      stat = await fsp.lstat(source.absPath);
    } catch (error) {
      items.push({
        path: source.path,
        name: source.name,
        kind: source.kind,
        size: 0,
        exists: false,
        readable: false,
        error: error.code === 'ENOENT' ? ERROR_CODES.PATH_NOT_FOUND : ERROR_CODES.PERMISSION_DENIED,
      });
      continue;
    }

    let readable = true;
    try {
      await fsp.access(source.absPath, fs.constants.R_OK);
    } catch {
      readable = false;
    }

    const isDir = stat.isDirectory();
    let size = isDir ? 0 : stat.size;
    let fileCount = isDir ? 0 : 1;
    if (isDir) {
      const stats = await directoryStats(source.absPath);
      size = stats.bytes;
      fileCount = stats.files;
    }

    totalBytes += size;
    items.push({
      path: source.path,
      name: source.name,
      kind: isDir ? 'dir' : 'file',
      size,
      fileCount,
      exists: true,
      readable,
    });
  }

  const outputDir = input.outputDir;
  const outputExists = fs.existsSync(outputDir);
  const outputWritable = outputExists ? await isWritable(outputDir) : false;
  const freeBytes = await freeBytesOf(outputExists ? outputDir : path.dirname(outputDir));
  const estimatedOutputBytes = Math.ceil(totalBytes * 0.6);
  const requiredBytes = totalBytes * factor;

  let blockedReason = null;
  const unreadable = items.filter((item) => item.exists && !item.readable);
  const missing = items.filter((item) => !item.exists);

  if (missing.length > 0) blockedReason = { code: ERROR_CODES.PATH_NOT_FOUND, message: '有源条目不存在' };
  else if (unreadable.length > 0) blockedReason = { code: ERROR_CODES.PERMISSION_DENIED, message: '有源条目不可读' };
  // 输出目录必须已存在：我们不会替用户"静默创建目录"（那是副作用）；不存在 → PATH_NOT_FOUND（诚实错误码）
  else if (!outputExists) blockedReason = { code: ERROR_CODES.PATH_NOT_FOUND, message: '输出目录不存在' };
  else if (!outputWritable) blockedReason = { code: ERROR_CODES.PERMISSION_DENIED, message: '输出目录不可写' };
  else if (freeBytes !== null && freeBytes < requiredBytes) {
    blockedReason = {
      code: ERROR_CODES.DISK_FULL,
      message: `空间不足：需要 ${requiredBytes} 字节（待压 × ${factor}），剩余 ${freeBytes} 字节`,
    };
  }

  return {
    canProceed: blockedReason === null,
    blockedReason,
    mode: input.mode,
    format: input.format,
    totalBytes,
    estimatedOutputBytes,
    requiredBytes,
    freeBytes,
    preflightFactor: factor,
    items,
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
  const { config, plugin } = deps;
  const factor = config.compress.preflightFactor;

  // 入参完整性：内部绝对路径由编排器从 record.internal 传进来，缺了就说明调用方写错了
  // （必须显式报错，不能靠"stat 失败"兜底，否则会伪装成权限问题）
  if (!input || typeof input.archiveAbsPath !== 'string' || !input.archiveAbsPath) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '解压预检缺少归档绝对路径（内部错误）');
  }
  if (!input || typeof input.targetAbsDir !== 'string' || !input.targetAbsDir) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '解压预检缺少目标目录绝对路径（内部错误）');
  }

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

  // 用 list() 校验归档可解析，并取解压后总量（不解析 → ARCHIVE_CORRUPTED）
  const listing = await plugin.list(input.archiveAbsPath);
  const totalBytes = listing.entries.filter((entry) => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0);

  // 目标目录**可能尚不存在**（解压时才创建）：存在则检查它本身，否则检查其父目录。
  // 注意必须用**绝对路径**（input.targetAbsDir）做文件系统检查——早期版本误用了 API 用户路径，
  // 结果把 "/m2-test/out" 当成了文件系统根下的 /m2-test/out，误报 PERMISSION_DENIED（真实踩过）。
  const targetExists = fs.existsSync(input.targetAbsDir);
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
