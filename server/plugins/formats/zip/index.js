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
import zipEncrypted from 'archiver-zip-encrypted';
import unzipper from 'unzipper';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { createThrottledReporter } from '../../../lib/throttle.js';
// 创建前置守卫（库可用 + 绝不覆盖）**各格式共用一套**——本格式不再自带一份实现
import { assertCreatable as assertSharedCreatable } from '../_shared/createGuards.js';
// 条目安全判定与写出**各格式共用一套**（zip-slip 防护不各写一份，见 _shared/entrySafety.js）
import { planTargets, writePlan } from '../_shared/entrySafety.js';
import { extractWith7z } from '../../capabilities/password/index.js';

/** zip 加密标志位（general purpose bit 0）与 WinZip AES 伪压缩方法号 */
const ENCRYPTED_FLAG = 0x1;
const AES_COMPRESSION_METHOD = 99;

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
  // 能力声明（docs/19 §4.1）：ZIP 规范有加密 → 支持密码能力；TAR 系列声明空数组
  capabilities: ['password'],
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
  const fileItems = [];
  // 黑名单命中项（由编排层传入判定函数）：**收集阶段就不放进包**，既省 CPU/磁盘，
  // 也保证"没进包的不会被删除"从源头成立（M5 的删除集合 = 进包条目 − skipped）。
  const shouldSkip = typeof (ctx.options && ctx.options.shouldSkip) === 'function' ? ctx.options.shouldSkip : null;
  const skipped = [];
  let skippedSymlinks = 0;

  /** 命中就记账并返回 true（调用方据此 continue） */
  const recordSkip = (absPath, name, segments) => {
    if (!shouldSkip) return false;
    const hit = shouldSkip({ name, segments });
    if (!hit) return false;
    skipped.push({ absPath, pattern: hit.pattern, layer: hit.layer });
    return true;
  };

  for (const source of ctx.sources) {
    const sourceName = source.name || path.basename(source.absPath);

    if (source.kind === 'file') {
      const fileStat = await fsp.lstat(source.absPath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        throw apiError(ERROR_CODES.PATH_NOT_FOUND, '源文件在扫描后已不可用', { source: sourceName });
      }
      if (recordSkip(source.absPath, path.basename(source.absPath), [sourceName])) continue;
      fileItems.push({ absPath: source.absPath, entryName: sourceName, size: fileStat.size });
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
          // 目录名规则（如 @eaDir）也参与匹配：所以 segments 带上完整相对路径
          if (recordSkip(childAbs, dirent.name, childEntry.split('/'))) continue;
          const fileStat = await fsp.lstat(childAbs);
          fileItems.push({ absPath: childAbs, entryName: childEntry, size: fileStat.size });
        }
      }
    };
    await walk(source.absPath, sourceName);
  }

  return { fileItems, skippedSymlinks, skipped };
}

// ===== create（压缩）=====

/** create 前置检查：直接复用共用守卫（库可用 + 绝不覆盖），本格式不再自带一份 */
async function assertCreatable(ctx) {
  await assertSharedCreatable(ctx, available, 'zip');
}

/** 汇总待压总量，并建"条目名 → 大小"索引（进度需要按条目累加字节） */
function summarizeEntries(fileItems) {
  const totalBytes = fileItems.reduce((sum, fileItem) => sum + fileItem.size, 0);
  return { totalBytes, sizeByEntry: new Map(fileItems.map((fileItem) => [fileItem.entryName, fileItem.size])) };
}

/** 决定压缩级别（未指定就用格式默认值） */
function resolveLevel(options) {
  return Number.isInteger(options && options.level) ? options.level : meta.defaultLevel;
}

/**
 * 能力注册（docs/19）：archiver-zip-encrypted 提供 zip-encrypted 格式（AES-256/ZipCrypto）。
 * registerFormat 每进程只能注册一次（重复抛错）——模块加载期执行一次，天然幂等。
 */
let zipEncryptedRegistered = false;
function ensureZipEncryptedFormat() {
  if (zipEncryptedRegistered) return;
  archiver.registerFormat('zip-encrypted', zipEncrypted);
  zipEncryptedRegistered = true;
}

/** 建立"归档 → 输出流"管道（archiver 写、file stream 落盘）。
 *  能力装配点（docs/19 图 1 ★ 只改 2 行）：archiverFormat/encryption 由编排层的能力
 *  装配循环（capRegistry.prepareCreate）注入 options —— 本插件不认识任何具体能力。
 */
function openArchivePipeline(tempPath, level, options = {}) {
  const archiverFormat = options.archiverFormat ?? 'zip';
  if (archiverFormat !== 'zip') ensureZipEncryptedFormat();
  const output = fs.createWriteStream(tempPath);
  const archive = archiver(archiverFormat, { zlib: { level }, ...options.archiverExtra });
  archive.pipe(output);
  return { output, archive };
}

/**
 * 删除半成品临时文件。
 * `rmSync(..., { force: true })` 对不存在的路径不算错，因此不必先 `existsSync` 探一次；
 * 这里刻意保持**同步**语义：调用点都在事件回调（`finish(() => …)`）里，无法 await，
 * 而"清理必须在 reject 之前完成"是调用方可依赖的性质（测试会在任务结束后立刻检查没有 .part 残留）。
 * 清理失败不掩盖原始错误。
 */
function removeTempFile(tempPath) {
  try {
    fs.rmSync(tempPath, { force: true });
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
      /* abort 在归档已结束时可能抛错：取消路径上不影响后续清理，忽略即可 */
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
function attachEntryProgress(archive, { fileItems, report, counters, sizeByEntry, totalBytes }) {
  archive.on('entry', (entry) => {
    const name = entry && entry.name ? entry.name : '';
    counters.processedBytes += sizeByEntry.get(name) || 0;
    counters.processedFiles += 1;
    report({
      processedBytes: counters.processedBytes,
      totalBytes,
      processedFiles: counters.processedFiles,
      totalFiles: fileItems.length,
      currentFile: name,
    });
  });
}

/** 把待压条目塞进归档；空集合也要上报一次（避免进度停在 0 让人以为卡住） */
function appendEntriesToArchive(archive, fileItems, report) {
  for (const fileItem of fileItems) {
    archive.file(fileItem.absPath, { name: fileItem.entryName });
  }
  if (fileItems.length === 0) {
    report({ processedBytes: 0, totalBytes: 0, processedFiles: 0, totalFiles: 0, currentFile: null });
  }
}

/**
 * 流式写入归档：archiver 逐条目写、进度事件驱动、取消即清理 .part。
 * 完成条件是**输出流 close**（finalize 返回 ≠ 文件已写完，契约第 5 条），
 * 所以这里同时跟踪 outputClosed 与 archiveFinished 两个标志，二者齐备才算成功。
 */
function runCreateStream(ctx, fileItems, summary, stats) {
  const { totalBytes, sizeByEntry } = summary;
  const report = createThrottledReporter(ctx.onProgress || (() => {}), { intervalMs: 100 });
  const counters = { processedBytes: 0, processedFiles: 0 };

  return new Promise((resolve, reject) => {
    const state = { settled: false, outputClosed: false, archiveFinished: false };
    const { output, archive } = openArchivePipeline(ctx.tempPath, stats.level, ctx.options);
    const finish = createSettler(state);

    const resolveIfComplete = () => {
      if (!state.outputClosed || !state.archiveFinished) return;
      finish(() =>
        resolve({
          outputPath: ctx.tempPath,
          entries: fileItems.length,
          bytesIn: counters.processedBytes,
          bytesOut: archive.pointer(),
          durationMs: Date.now() - stats.startedAt,
          skippedSymlinks: stats.skippedSymlinks,
          skipped: stats.skipped || [],
          // 契约 v2 §3.4 条款 10：实际进包条目的**源绝对路径**（进程内使用，不进 API）。
          // INV-02 删除集合的第一手依据；禁止用包内路径（entryName）反推源路径。
          entryPaths: fileItems.map((item) => item.absPath),
          // INV-03 ⑤ 进包时快照（size 基准）：collectEntries 已 stat 过，原样带出给删除前复核
          entryStats: fileItems.map((item) => [item.absPath, { sizeBytes: item.size }]),
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

    attachEntryProgress(archive, { fileItems, report, counters, sizeByEntry, totalBytes });
    attachCreateFailureHandlers({ archive, output, tempPath: ctx.tempPath, finish, reject });
    output.on('close', () => {
      state.outputClosed = true;
      resolveIfComplete();
    });

    appendEntriesToArchive(archive, fileItems, report);
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

  const { fileItems, skippedSymlinks, skipped } = await collectEntries(ctx);
  const summary = summarizeEntries(fileItems);

  return runCreateStream(ctx, fileItems, summary, {
    startedAt: Date.now(),
    skippedSymlinks,
    skipped,
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

/** 判定归档加密形态（unzipper central directory：flags bit0 = 加密；compressionMethod=99 = AES） */
function detectEncryption(directory) {
  for (const entry of directory.files) {
    if (isDirectoryEntry(entry)) continue;
    const flags = Number(entry.flags) || 0;
    if ((flags & ENCRYPTED_FLAG) === 0) continue;
    const isAes = Number(entry.compressionMethod) === AES_COMPRESSION_METHOD;
    return { encrypted: true, isAes };
  }
  return { encrypted: false, isAes: false };
}

/**
 * 加密包解压（P4）：7z 解到临时中转目录 → 复用 planTargets/writePlan 白名单链搬进目标目录。
 *
 * 为什么不直接 7z -o 目标目录：zip-slip 防护（INV-06）必须对最终交付的文件生效——
 * 归档里的 `../` 条目在 7z 解包层可能被它自己的规范化剥离，但我们的防线不能依赖外部工具的
 * 行为承诺。先解到中转目录、再经 planTargets 校验后搬移，加密包就没有绕过白名单的后门。
 *
 * @returns 同 extract 主路径的返回形状
 */
async function extractEncrypted(ctx, targetDir, overwrite, isAes) {
  const password = ctx.options && ctx.options.password;
  if (!password) {
    throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
  }
  // AES-256 与 ZipCrypto 统一走 7z（unzipper 只有 ZipCrypto 实现；AES 走它必假阴性）。
  // 7z 缺失时 extractWith7z 返回明确错误，不静默降级为「文件损坏」。
  const stagingDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.hl-7z-${Date.now()}`);
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    const verdict = await extractWith7z(ctx.archivePath, password, stagingDir);
    if (!verdict.ok) {
      throw apiError(
        ERROR_CODES[verdict.code] ? ERROR_CODES[verdict.code] : ERROR_CODES.INTERNAL_ERROR,
        verdict.message,
      );
    }
    // 中转目录内容 → planTargets（zip-slip/覆盖检查）→ writePlan 搬移
    const stagedEntries = [];
    const walk = async (dirAbs, relativePrefix) => {
      for (const dirent of await fsp.readdir(dirAbs, { withFileTypes: true })) {
        const childAbs = path.join(dirAbs, dirent.name);
        const relative = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) {
          await walk(childAbs, relative);
          continue;
        }
        if (!dirent.isFile()) continue; // 7z 产出的 symlink 等跳过（与主路径同口径）
        const stat = await fsp.stat(childAbs).catch(() => null);
        stagedEntries.push({
          name: relative,
          isDir: false,
          size: stat ? stat.size : 0,
          link: false,
          open: () => fs.createReadStream(childAbs),
        });
      }
    };
    await walk(stagingDir, '');
    const planned = await planTargets(stagedEntries, targetDir, overwrite);
    const written = await writePlan(planned, targetDir, {
      signal: ctx.options && ctx.options.signal,
      onProgress: ctx.onProgress,
    });
    return {
      targetDir,
      entries: written.entries,
      bytesOut: written.bytesOut,
      durationMs: Date.now() - ctx.startedAt,
    };
  } finally {
    // 中转目录无论成败都清掉（含密码的明文副本不留盘）
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extract(ctx) {
  if (!(await available())) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'zip 格式当前不可用');
  }

  const startedAt = Date.now();
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);
  const directory = await openArchive(ctx.archivePath);

  // ⓪ 加密检测（P4）：加密包走 7z 通道（错误三态：MISSING_PASSWORD/BAD_PASSWORD/损坏）
  const encryption = detectEncryption(directory);
  if (encryption.encrypted) {
    ctx.startedAt = startedAt;
    return extractEncrypted(ctx, targetDir, overwrite, encryption.isAes);
  }

  // ① 判定（写盘之前）：zip-slip + 覆盖检查，全部通过才开始写 —— 与 tar 系列共用同一套代码
  const planned = await planTargets(toSharedEntries(directory), targetDir, overwrite);

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

/**
 * 探测归档是否加密（供解压预检决定是否弹密码输入框）。
 *
 * 为什么单独导出：解压预检需要「不解压就能知道加没加密」，而这件事的实现方式
 * 每个格式都不一样（ZIP 读 central directory 的标志位，RAR 看 unrar 的列表输出）。
 * 统一成这个可选方法后，预检层不必认识具体格式。
 *
 * @param {string} archivePath
 * @returns {Promise<{encrypted: boolean, isAes: boolean}>}
 */
async function probeEncryption(archivePath) {
  const directory = await openArchive(archivePath);
  return detectEncryption(directory);
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
  probeEncryption,
};
