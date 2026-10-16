// zip 格式包（M2：archiver 写 / unzipper 读）
//
// 契约：docs/M0/插件契约.md §3.4 create / §3.4.1 extract / §3.5 list / §3.6 test / §3.2 available / §3.3 estimate
//
// 两个库各司其职（Lead 拍板方案 A）：
// - **archiver**：只负责生成（流式写入 zip）；
// - **unzipper**：负责读取（列条目 / CRC 校验 / 解压）。
//   archiver 没有读取能力，硬用一个库去凑是行不通的。
//
// 安全（解压侧头号风险 = zip-slip）：
// 写盘**之前**先枚举全部条目名 → 用与 pathGuard 同一套判定（core/fs/safePath.js 的 normalizeUserPath）
// 规范化并校验 → 拒绝 `..`、绝对路径、盘符、NUL、symlink 条目 → 全部通过后才开始写。
// 这样恶意归档不会产生任何"写到一半才发现"的副作用。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import archiver from 'archiver';
import unzipper from 'unzipper';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { createThrottledReporter } from '../../../lib/throttle.js';
// 与 pathGuard 同一套路径判定（契约 §3.4.1 第 1 条明确要求）：纯函数，不碰磁盘
import { normalizeUserPath } from '../../../core/fs/safePath.js';

const FORMAT_ID = 'zip';
const MAX_PATH_LENGTH = 4096;
const MAX_SEGMENT_LENGTH = 255;

// ===== 元数据（静态，注册表启动时不等待任何异步探测）=====

const meta = {
  id: FORMAT_ID,
  name: 'ZIP',
  ext: '.zip',
  extAliases: [],
  mime: 'application/zip',
  levelRange: [0, 9],
  defaultLevel: 6,
};

// ===== available =====

async function available() {
  try {
    // 两个库都是纯 JS，只要能取到入口就可用（不需要外部二进制）。
    // 注意 unzipper 的导出形状：`Open` 是**对象**（含 file/url/buffer 等方法），不是函数——
    // 早期写成 `typeof unzipper.Open === 'function'` 会误判为不可用（真实踩过）。
    return typeof archiver === 'function' && typeof unzipper?.Open?.file === 'function';
  } catch {
    return false;
  }
}

async function unavailableReason() {
  const ok = await available();
  return ok ? null : 'zip 依赖（archiver / unzipper）未正确安装';
}

// ===== estimate =====

async function estimate(inputBytes, options = {}) {
  const bytes = Number.isFinite(inputBytes) && inputBytes > 0 ? inputBytes : 0;
  // 已压缩格式（jpg/mp4/zip…）比值接近 1；其余给常见经验值。
  // M2 只做"够算预检分母"的粗估，精确化在 M6。
  const names = Array.isArray(options.sample && options.sample.names) ? options.sample.names : [];
  const compressedExt = /\.(jpe?g|png|gif|webp|heic|mp4|mkv|mov|mp3|flac|zip|7z|rar|gz|bz2|xz|docx|xlsx|pptx)$/i;
  const compressedRatio = names.length > 0 && names.every((name) => compressedExt.test(name)) ? 0.98 : 0.6;
  return {
    estimatedBytes: Math.ceil(bytes * compressedRatio),
    ratio: compressedRatio,
    basis: 'heuristic',
    confidence: 'low',
  };
}

// ===== 公共工具 =====

/** 仅返回 basename，绝不把绝对路径放进错误 details（避免泄漏本机目录结构） */
function safeName(target) {
  return typeof target === 'string' ? path.basename(target) : null;
}

/** 打开归档；文件不存在 → PATH_NOT_FOUND，解析失败 → ARCHIVE_CORRUPTED（都不透传本机路径） */
async function openArchive(archivePath) {
  try {
    return await unzipper.Open.file(archivePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw apiError(ERROR_CODES.PATH_NOT_FOUND, '压缩包不存在', { archive: safeName(archivePath) });
    }
    throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包无法解析（可能已损坏）', {
      archive: safeName(archivePath),
      reason: (error && (error.code || error.message)) || 'parse-failed',
    });
  }
}

/** 条目是否目录 */
function isDirectoryEntry(entry) {
  return entry.type === 'Directory';
}

/**
 * 是否符号链接条目（zip 用 external attributes 高位存 unix mode）。
 * M2 策略：**任何 symlink 条目一律拒绝**（比"仅拒绝指向目标外的链接"更保守，
 * 因为 symlink 的可见性还依赖解压工具行为，拒绝最省心）。
 */
function isSymlinkEntry(entry) {
  try {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    return (mode & 0o170000) === 0o120000;
  } catch {
    return false;
  }
}

function entryToItem(entry) {
  const isDir = isDirectoryEntry(entry);
  return {
    name: entry.path,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : Number(entry.uncompressedSize || 0),
    compressedSize: Number(entry.compressedSize || 0),
  };
}

/**
 * zip-slip 核心：把归档条目名解析成目标目录内的绝对路径；任何逃逸企图直接抛错。
 * 复用 core/fs/safePath.js 的 normalizeUserPath（与 pathGuard 同一套判定：拆段拒绝 ..、拒绝编码后的 ..、
 * 拒绝 NUL、按字节限长），再叠加归档特有的盘符检查与最终前缀校验。
 */
function resolveEntryTarget(targetDir, entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw apiError(ERROR_CODES.INVALID_PATH, '归档条目名为空', { entry: entryName });
  }
  const unified = entryName.replace(/\\/g, '/');
  // 盘符（Windows 绝对路径形态，如 C:/evil 或 C:\evil）：API 语义里不可能合法
  if (/^[A-Za-z]:/.test(unified)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档条目含盘符（zip-slip）', { entry: entryName });
  }
  // 绝对路径：同样拒绝（我们总是相对目标目录展开）
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
    // normalizeUserPath 抛的是契约错误（.. / 编码 .. / NUL / 超长），原样抛即可，
    // 只把条目名补进 details，便于前端定位是哪个条目有问题
    if (error && error.details) error.details.entry = entryName;
    throw error;
  }

  const root = path.resolve(targetDir);
  const target = path.resolve(root, ...normalized.segments);
  // 最终前缀校验必须带分隔符（防 /data-evil 被 /data 放行）
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档条目逃逸目标目录（zip-slip）', { entry: entryName });
  }
  return { targetPath: target, segments: normalized.segments, isRoot: target === root };
}

/** 递归收集待归档条目（不跟随符号链接，避免把链接指向的外部内容打进去） */
async function collectEntries(ctx) {
  const items = [];
  let skippedSymlinks = 0;

  for (const source of ctx.sources) {
    const sourceName = source.name || path.basename(source.absPath);

    if (source.kind === 'file') {
      const stat = await fsp.lstat(source.absPath).catch(() => null);
      if (!stat || !stat.isFile()) {
        throw apiError(ERROR_CODES.PATH_NOT_FOUND, '源文件在扫描后已不可用', { source: sourceName });
      }
      items.push({ absPath: source.absPath, entryName: sourceName, size: stat.size });
      continue;
    }

    // 目录：保留目录名作为顶层，递归其子文件
    const walk = async (dirAbs, prefix) => {
      const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      for (const dirent of dirents) {
        const childAbs = path.join(dirAbs, dirent.name);
        const childEntry = `${prefix}/${dirent.name}`;
        if (dirent.isSymbolicLink()) {
          skippedSymlinks += 1;
          continue;
        }
        if (dirent.isDirectory()) {
          await walk(childAbs, childEntry);
        } else if (dirent.isFile()) {
          const stat = await fsp.lstat(childAbs);
          items.push({ absPath: childAbs, entryName: childEntry, size: stat.size });
        }
      }
    };
    await walk(source.absPath, sourceName);
  }

  return { items, skippedSymlinks };
}

// ===== create（压缩）=====

async function create(ctx) {
  if (!(await available())) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zip 格式当前不可用');
  }
  // 契约第 7 条：绝不覆盖（.part 与最终产物都不许已存在）
  if (fs.existsSync(ctx.tempPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '临时产物已存在', { file: safeName(ctx.tempPath) });
  }
  if (fs.existsSync(ctx.outputPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '目标压缩包已存在（绝不覆盖）', { file: safeName(ctx.outputPath) });
  }

  const { items, skippedSymlinks } = await collectEntries(ctx);
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  const sizeByEntry = new Map(items.map((item) => [item.entryName, item.size]));

  const level = Number.isInteger(ctx.options && ctx.options.level)
    ? ctx.options.level
    : meta.defaultLevel;
  const signal = ctx.options && ctx.options.signal;

  const startedAt = Date.now();
  const report = createThrottledReporter(ctx.onProgress || (() => {}), { intervalMs: 100 });

  let processedBytes = 0;
  let processedFiles = 0;
  let currentFile = null;

  return await new Promise((resolve, reject) => {
    let settled = false;
    let outputClosed = false;
    let archiveFinished = false;

    const output = fs.createWriteStream(ctx.tempPath);
    const archive = archiver('zip', { zlib: { level } });

    const cleanupTemp = () => {
      try {
        if (fs.existsSync(ctx.tempPath)) fs.unlinkSync(ctx.tempPath);
      } catch {
        // 清理失败不掩盖原始错误
      }
    };

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const maybeResolve = () => {
      // 契约第 5 条：必须等到输出流 close（finalize 完成 ≠ 文件写完）
      if (outputClosed && archiveFinished) {
        finish(() =>
          resolve({
            outputPath: ctx.tempPath,
            entries: items.length,
            bytesIn: processedBytes,
            bytesOut: archive.pointer(),
            durationMs: Date.now() - startedAt,
            skippedSymlinks,
          }),
        );
      }
    };

    const onAbort = () => {
      finish(() => {
        try {
          archive.abort();
        } catch {
          /* ignore */
        }
        cleanupTemp();
        reject(apiError(ERROR_CODES.ABORTED, '任务已取消'));
      });
    };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // 进度：archiver 每写完一个条目发 'entry'（事件驱动，不是定时采样）
    archive.on('entry', (entry) => {
      const name = entry && entry.name ? entry.name : '';
      const size = sizeByEntry.get(name) || 0;
      processedBytes += size;
      processedFiles += 1;
      currentFile = name;
      report({
        processedBytes,
        totalBytes,
        processedFiles,
        totalFiles: items.length,
        currentFile: name,
      });
    });

    archive.on('warning', (error) => {
      if (error && error.code === 'ENOENT') return; // 条目消失：跳过而不是整个失败
      finish(() => {
        cleanupTemp();
        reject(apiError(ERROR_CODES.INTERNAL_ERROR, `打包告警：${error.message}`, { cause: error.code || 'warning' }));
      });
    });

    archive.on('error', (error) => {
      finish(() => {
        cleanupTemp();
        // ENOSPC 等系统错误交给 errors.js 的映射（DISK_FULL / QUOTA_EXCEEDED …）
        reject(error);
      });
    });

    output.on('error', (error) => {
      finish(() => {
        cleanupTemp();
        reject(error);
      });
    });

    output.on('close', () => {
      outputClosed = true;
      maybeResolve();
    });

    archive.pipe(output);

    // 逐个加入（archiver 内部串行处理，内存恒定）
    for (const item of items) {
      archive.file(item.absPath, { name: item.entryName });
    }
    if (items.length === 0) {
      // 空目录/无文件：archiver 会产出空 zip，这是合法的（但 M6 黑名单会尽量避免）
      report({ processedBytes: 0, totalBytes: 0, processedFiles: 0, totalFiles: 0, currentFile: null });
    }

    archive.finalize().then(
      () => {
        archiveFinished = true;
        maybeResolve();
      },
      (error) => {
        finish(() => {
          cleanupTemp();
          reject(error);
        });
      },
    );
  });
}

// ===== list / test =====

async function list(archivePath) {
  const directory = await openArchive(archivePath);
  const entries = directory.files.map(entryToItem);
  return { entries, count: entries.length, truncated: false };
}

async function test(archivePath, options = {}) {
  const directory = await openArchive(archivePath);
  const failures = [];
  let checked = 0;
  // 优先 CRC（真实校验）；Node 没有 zlib.crc32 时退化为"读通全部条目"（契约 §3.6 允许两种策略）
  const canCrc = typeof zlib.crc32 === 'function';
  const strategy = canCrc ? 'crc' : 'read-all';

  for (const entry of directory.files) {
    if (isDirectoryEntry(entry)) continue;
    try {
      const buffer = await entry.buffer(); // 完整 inflate：既是 CRC 的数据来源，也是"读得通"的证明
      if (buffer.length !== Number(entry.uncompressedSize || 0)) {
        failures.push({ entry: entry.path, reason: `解压后大小不符（期望 ${entry.uncompressedSize}，实际 ${buffer.length}）` });
      } else if (canCrc && typeof entry.crc32 === 'number') {
        const actual = zlib.crc32(buffer) >>> 0;
        const expected = entry.crc32 >>> 0;
        if (actual !== expected) {
          failures.push({ entry: entry.path, reason: `CRC 不匹配（期望 ${expected}，实际 ${actual}）` });
        }
      }
      checked += 1;
    } catch (error) {
      failures.push({ entry: entry.path, reason: `读取失败：${(error && error.message) || 'unknown'}` });
    }
  }

  return { ok: failures.length === 0, checked, failures, strategy };
}

// ===== extract（解压）=====

async function extract(ctx) {
  if (!(await available())) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zip 格式当前不可用');
  }

  const directory = await openArchive(ctx.archivePath);
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);
  const signal = ctx.options && ctx.options.signal;
  const startedAt = Date.now();

  // ===== ① zip-slip 预扫描（写盘之前；这是本文件最关键的一段）=====
  const plan = [];
  let totalBytes = 0;
  let totalFiles = 0;

  for (const entry of directory.files) {
    if (isSymlinkEntry(entry)) {
      throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '归档包含符号链接条目，已拒绝解压', { entry: entry.path });
    }

    const unified = String(entry.path || '').replace(/\\/g, '/');
    // 目录条目（以 / 结尾的写法）统一成相对段后再判定
    const nameForCheck = unified.replace(/\/+$/, '');
    const resolved = resolveEntryTarget(targetDir, nameForCheck);
    const isDir = isDirectoryEntry(entry) || unified.endsWith('/');

    plan.push({
      entry,
      isDir,
      targetPath: resolved.targetPath,
      displayName: entry.path,
      size: isDir ? 0 : Number(entry.uncompressedSize || 0),
    });
    if (!isDir) {
      totalBytes += Number(entry.uncompressedSize || 0);
      totalFiles += 1;
    }
  }

  // ===== ② 覆盖检查（同样在写盘之前；契约第 7 条：绝不覆盖）=====
  if (!overwrite) {
    for (const item of plan) {
      if (item.isDir) continue;
      if (fs.existsSync(item.targetPath)) {
        throw apiError(ERROR_CODES.TARGET_EXISTS, '目标目录已存在同名文件（overwrite=false）', {
          entry: item.displayName,
        });
      }
    }
  }

  const report = createThrottledReporter(ctx.onProgress || (() => {}), { intervalMs: 100 });
  let processedBytes = 0;
  let processedFiles = 0;
  let entries = 0;

  await fsp.mkdir(targetDir, { recursive: true });

  // ===== ③ 执行（此时已知所有条目都是安全的）=====
  for (const item of plan) {
    if (signal && signal.aborted) {
      throw apiError(ERROR_CODES.ABORTED, '任务已取消');
    }

    if (item.isDir) {
      await fsp.mkdir(item.targetPath, { recursive: true });
      entries += 1;
      continue;
    }

    await fsp.mkdir(path.dirname(item.targetPath), { recursive: true });

    try {
      await pipeline(
        item.entry.stream(),
        fs.createWriteStream(item.targetPath),
        signal ? { signal } : undefined,
      );
    } catch (error) {
      // 半成品清理（契约 §3.4.1 第 4 条：abort 后停止写入并清理；失败同理）
      try {
        if (fs.existsSync(item.targetPath)) await fsp.unlink(item.targetPath);
      } catch {
        /* ignore */
      }
      if (error && (error.name === 'AbortError' || (signal && signal.aborted))) {
        throw apiError(ERROR_CODES.ABORTED, '任务已取消');
      }
      throw error;
    }

    entries += 1;
    processedFiles += 1;
    processedBytes += item.size;
    report({
      processedBytes,
      totalBytes,
      processedFiles,
      totalFiles,
      currentFile: item.displayName,
    });
  }

  return {
    targetDir,
    entries,
    bytesOut: processedBytes,
    durationMs: Date.now() - startedAt,
  };
}

export default {
  ...meta,
  available,
  unavailableReason,
  estimate,
  create,
  extract,
  list,
  test,
};
