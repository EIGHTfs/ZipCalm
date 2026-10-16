// zip 格式包（M2：archiver 写 / unzipper 读）
//
// 契约：docs/M0/插件契约.md §3.4 create / §3.4.1 extract / §3.5 list / §3.6 test / §3.2 available / §3.3 estimate
//
// 两个库各司其职（读写分离）：
// - **archiver**：只负责生成（流式写入 zip）；
// - **unzipper**：负责读取（列条目 / CRC 校验 / 解压）。
//   archiver 没有读取能力，硬用一个库去凑是行不通的。
//
// 安全（解压侧头号风险 = zip-slip）：
// 写盘**之前**先枚举全部条目名 → 用与 pathGuard 同一套判定（core/fs/safePath.js 的 normalizeUserPath）
// 规范化并校验 → 拒绝 `..`、绝对路径、盘符、NUL、symlink 条目 → 全部通过后才开始写。
// 这样恶意归档不会产生任何"写到一半才发现"的副作用。
//
// 结构：create / extract 各自拆成「前置检查 → 收集计划 → 执行 → 汇总」四段小函数，
// 每个函数只做一件事，便于单独审读与测试。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import archiver from 'archiver';
import unzipper from 'unzipper';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { createThrottledReporter } from '../../../lib/throttle.js';
// 条目安全判定与写出**各格式共用一套**（zip-slip 防护不各写一份，见 _shared/entrySafety.js）
import { planTargets, writePlan } from '../_shared/entrySafety.js';

const FORMAT_ID = 'zip';

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
 * 读取侧「条目 → 通用条目」适配：open() 给出可读流，link 标记符号链接。
 * 安全判定与写出统一交给 `_shared/entrySafety.js`（与 tar 系列共用同一套 zip-slip 判定）。
 */
function toSharedEntries(directory) {
  return directory.files.map((entry) => ({
    name: entry.path,
    isDir: isDirectoryEntry(entry),
    size: Number(entry.uncompressedSize || 0),
    link: isSymlinkEntry(entry),
    open: () => entry.stream(),
  }));
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

/** create 前置检查：库可用 + 绝不覆盖（.part 与最终产物都不许已存在，契约第 7 条） */
async function assertCreatable(ctx) {
  if (!(await available())) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zip 格式当前不可用');
  }
  if (fs.existsSync(ctx.tempPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '临时产物已存在', { file: safeName(ctx.tempPath) });
  }
  if (fs.existsSync(ctx.outputPath)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '目标压缩包已存在（绝不覆盖）', { file: safeName(ctx.outputPath) });
  }
}

/** 汇总待压总量，并建"条目名 → 大小"索引（进度需要按条目累加字节） */
function summarizeEntries(items) {
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
  return { totalBytes, sizeByEntry: new Map(items.map((item) => [item.entryName, item.size])) };
}

/** 决定压缩级别（未指定就用格式默认值） */
function resolveLevel(options) {
  return Number.isInteger(options && options.level) ? options.level : meta.defaultLevel;
}

/** 建立"归档 → 输出流"管道（archiver 写、file stream 落盘） */
function openArchivePipeline(tempPath, level) {
  const output = fs.createWriteStream(tempPath);
  const archive = archiver('zip', { zlib: { level } });
  archive.pipe(output);
  return { output, archive };
}

/** 删除半成品临时文件（清理失败不掩盖原始错误） */
function removeTempFile(tempPath) {
  try {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  } catch {
    // 清理失败不掩盖原始错误
  }
}

/** 只允许结算一次（成功/失败/取消只会有一个生效） */
function createSettler(state) {
  return (fn) => {
    if (state.settled) return;
    state.settled = true;
    fn();
  };
}

/** 取消：中止归档 + 清理半成品 + 抛 ABORTED */
function abortCreate(archive, tempPath, finish, reject) {
  finish(() => {
    try {
      archive.abort();
    } catch {
      /* ignore */
    }
    removeTempFile(tempPath);
    reject(apiError(ERROR_CODES.ABORTED, '任务已取消'));
  });
}

/** 失败收尾：清理半成品后 reject（ENOSPC 等交给 errors.js 的映射） */
function attachCreateFailureHandlers({ archive, output, tempPath, finish, reject }) {
  const fail = (error) => finish(() => {
    removeTempFile(tempPath);
    reject(error);
  });

  archive.on('warning', (error) => {
    if (error && error.code === 'ENOENT') return; // 条目消失：跳过而不是整个失败
    fail(apiError(ERROR_CODES.INTERNAL_ERROR, `打包告警：${error.message}`, { cause: error.code || 'warning' }));
  });
  archive.on('error', fail);
  output.on('error', fail);
}

/** 条目进度：archiver 每写完一个条目发 'entry'（事件驱动，不是定时采样） */
function attachEntryProgress(archive, { items, report, counters, sizeByEntry, totalBytes }) {
  archive.on('entry', (entry) => {
    const name = entry && entry.name ? entry.name : '';
    counters.processedBytes += sizeByEntry.get(name) || 0;
    counters.processedFiles += 1;
    report({
      processedBytes: counters.processedBytes,
      totalBytes,
      processedFiles: counters.processedFiles,
      totalFiles: items.length,
      currentFile: name,
    });
  });
}

/** 把待压条目塞进归档；空集合也要上报一次（避免进度停在 0 让人以为卡住） */
function appendEntriesToArchive(archive, items, report) {
  for (const item of items) {
    archive.file(item.absPath, { name: item.entryName });
  }
  if (items.length === 0) {
    report({ processedBytes: 0, totalBytes: 0, processedFiles: 0, totalFiles: 0, currentFile: null });
  }
}

/**
 * 流式写入归档：archiver 逐条目写、进度事件驱动、取消即清理 .part。
 * 完成条件是**输出流 close**（finalize 返回 ≠ 文件已写完，契约第 5 条），
 * 所以这里同时跟踪 outputClosed 与 archiveFinished 两个标志，二者齐备才算成功。
 */
function runCreateStream(ctx, items, summary, stats) {
  const { totalBytes, sizeByEntry } = summary;
  const report = createThrottledReporter(ctx.onProgress || (() => {}), { intervalMs: 100 });
  const counters = { processedBytes: 0, processedFiles: 0 };

  return new Promise((resolve, reject) => {
    const state = { settled: false, outputClosed: false, archiveFinished: false };
    const { output, archive } = openArchivePipeline(ctx.tempPath, stats.level);
    const finish = createSettler(state);

    const resolveIfComplete = () => {
      if (!state.outputClosed || !state.archiveFinished) return;
      finish(() =>
        resolve({
          outputPath: ctx.tempPath,
          entries: items.length,
          bytesIn: counters.processedBytes,
          bytesOut: archive.pointer(),
          durationMs: Date.now() - stats.startedAt,
          skippedSymlinks: stats.skippedSymlinks,
        }),
      );
    };

    if (stats.signal) {
      if (stats.signal.aborted) {
        abortCreate(archive, ctx.tempPath, finish, reject);
        return;
      }
      stats.signal.addEventListener('abort', () => abortCreate(archive, ctx.tempPath, finish, reject), { once: true });
    }

    attachEntryProgress(archive, { items, report, counters, sizeByEntry, totalBytes });
    attachCreateFailureHandlers({ archive, output, tempPath: ctx.tempPath, finish, reject });
    output.on('close', () => {
      state.outputClosed = true;
      resolveIfComplete();
    });

    appendEntriesToArchive(archive, items, report);
    archive.finalize().then(
      () => {
        state.archiveFinished = true;
        resolveIfComplete();
      },
      (error) => finish(() => {
        removeTempFile(ctx.tempPath);
        reject(error);
      }),
    );
  });
}

async function create(ctx) {
  await assertCreatable(ctx);

  const { items, skippedSymlinks } = await collectEntries(ctx);
  const summary = summarizeEntries(items);

  return runCreateStream(ctx, items, summary, {
    startedAt: Date.now(),
    skippedSymlinks,
    level: resolveLevel(ctx.options),
    signal: ctx.options && ctx.options.signal,
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

  const startedAt = Date.now();
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);
  const directory = await openArchive(ctx.archivePath);

  // ① 判定（写盘之前）：zip-slip + 覆盖检查，全部通过才开始写 —— 与 tar 系列共用同一套代码
  const planned = planTargets(toSharedEntries(directory), targetDir, overwrite);

  // ② 写出
  const written = await writePlan(planned, targetDir, {
    signal: ctx.options && ctx.options.signal,
    onProgress: ctx.onProgress,
  });

  return {
    targetDir,
    entries: written.entries,
    bytesOut: written.bytesOut,
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
