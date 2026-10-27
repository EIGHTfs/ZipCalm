// 7z 格式包（**双向**：可压缩、可解压）
//
// 引擎：三级回退链（见 engine.js 与 docs/18 §附四）——
//   ① 系统 7z / 7za（本机 p7zip 16.02）→ 默认走这条，零新增依赖
//   ② WASM 引擎（js7z-tools，MT）→ **尚未接入调用适配**（依赖需额外安装，见 docs/17 D-7）
//   ③ 都没有 → available=false + unavailableReason 说明
//
// 与 RAR 的关系：RAR 只读（extractOnly），7z 双向 —— 所以本插件**不要** extractOnly 标记，
// 它会正常出现在压缩格式列表里。
//
// 条目安全：解压先落到目标目录旁边的中转目录，再经 `_shared/entrySafety.js` 的
// planTargets + writePlan 搬入（与 zip / tar / rar 同一套 zip-slip / 符号链接 / 不覆盖判定）。
//
// 内存上限提示（docs/18 §附四坑 2）：WASM 引擎是 32 位地址空间（≤4 GB），超大输入会 OOM；
// 系统二进制没有这个限制。当前只走系统二进制，故预检不额外拦；接入 WASM 后需在预检按 2 GB 上限提示。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { planTargets, writePlan } from '../_shared/entrySafety.js';
import {
  CREATE_TIMEOUT_MS,
  EXTRACT_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  isEncryptedList,
  mapFailure,
  parseSlt,
  probeVersion,
  resolveEngine,
  run7z,
} from './engine.js';

const FORMAT_ID = '7z';
const LEVEL_RANGE = [0, 9];
const DEFAULT_LEVEL = 5;
/** 进度上报节流（解析外部程序输出，避免每行都推一次） */
const PROGRESS_INTERVAL_MS = 120;

/** 取引擎；不可用时抛契约错误码（调用方不用自己拼错） */
function requireEngine() {
  const engine = resolveEngine();
  if (engine.kind !== 'native') {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, '未找到 7z/7za，无法处理 7z 包（可设置 ZC_7Z_BIN 指定路径）');
  }
  return engine;
}

async function available() {
  return resolveEngine().kind === 'native';
}

async function unavailableReason() {
  const engine = resolveEngine();
  if (engine.wasmPackage) {
    // 依赖装了但适配未接入：说清楚，别让用户以为"装个包就能用"
    return `仅检测到 WASM 引擎（${engine.wasmPackage}）但调用适配尚未接入；请安装 7z/7za，或用 ZC_7Z_BIN 指定路径`;
  }
  return '未找到 7z/7za，也无法加载 WASM 引擎（请安装 p7zip，或用 ZC_7Z_BIN 指定路径）';
}

/** 压缩级别 → -mxN（非法值回落默认，不抛错） */
function resolveLevel(options) {
  const raw = options && options.level;
  const level = Number(raw);
  if (!Number.isInteger(level)) return DEFAULT_LEVEL;
  return Math.min(LEVEL_RANGE[1], Math.max(LEVEL_RANGE[0], level));
}

/** 7z 的压缩率粗估：实测与 tar.zst 接近（只优 ~1%），这里按 0.98 给量级，仅用于预检分母 */
async function estimate(inputBytes) {
  const bytes = Number(inputBytes) || 0;
  return Math.max(0, Math.ceil(bytes * 0.98));
}

/** 读条目清单（同时给出是否加密） */
async function inspect(archivePath) {
  const engine = requireEngine();
  const outcome = await run7z(engine.bin, ['l', '-slt', '-p-', archivePath], { timeoutMs: LIST_TIMEOUT_MS });
  if (outcome.code !== 0) mapFailure(outcome, { hasPassword: false, operation: 'list' });
  const entries = parseSlt(outcome.stdout);
  return { entries, encrypted: isEncryptedList(entries) };
}

async function list(archivePath) {
  const { entries, encrypted } = await inspect(archivePath);
  const items = entries.map((entry) => ({
    name: entry.name,
    type: entry.type,
    size: entry.size,
    compressedSize: entry.compressedSize,
  }));
  // encrypted 必须透出：解压预检据此弹密码框
  return { entries: items, count: items.length, truncated: false, encrypted };
}

async function test(archivePath, options = {}) {
  const engine = requireEngine();
  const password = options && typeof options.password === 'string' ? options.password : '';
  const { entries } = await inspect(archivePath);
  const args = ['t', '-y', password ? `-p${password}` : '-p-', archivePath];
  const outcome = await run7z(engine.bin, args, { timeoutMs: LIST_TIMEOUT_MS });
  if (outcome.code !== 0) mapFailure(outcome, { hasPassword: Boolean(password), operation: 'test' });
  return {
    ok: true,
    checked: entries.filter((entry) => entry.type !== 'dir').length,
    failures: [],
    strategy: '7z-test',
  };
}

/** 供解压预检调用（与 zip/rar 同构） */
async function probeEncryption(archivePath) {
  const { encrypted } = await inspect(archivePath);
  return { encrypted, isAes: false };
}

/** 供加密包"同一密码再试解一次"使用（编排层优先问插件要这个方法） */
async function verifyWithPassword(archivePath, password) {
  try {
    const result = await test(archivePath, { password });
    return { ok: true, checked: result.checked, strategy: result.strategy };
  } catch (error) {
    // 保留原始错误码：密码错 / 包损坏不能被压成"校验未通过"
    return { ok: false, code: (error && error.code) || null, error: (error && error.message) || '加密包校验失败' };
  }
}

// ===== 压缩 =====

/**
 * 收集要进包的条目（与 zip 同口径）：目录保留源名作顶层，文件用源名作条目名；
 * 符号链接不进包；命中黑名单（shouldSkip）的条目记账后跳过。
 * @returns {Promise<{sources: Array<{cwd: string, names: string[], entryPaths: string[], sizes: Map<string, number>}>, entryPaths: string[], skipped: Array, skippedSymlinks: number, totalBytes: number}>}
 */
async function collectPlan(ctx) {
  const shouldSkip = typeof (ctx.options && ctx.options.shouldSkip) === 'function' ? ctx.options.shouldSkip : null;
  const skipped = [];
  let skippedSymlinks = 0;
  let totalBytes = 0;
  const perSource = [];
  const entryPaths = [];

  const recordSkip = (absPath, name, segments) => {
    if (!shouldSkip) return false;
    const hit = shouldSkip({ name, segments });
    if (!hit) return false;
    skipped.push({ absPath, pattern: hit.pattern, layer: hit.layer });
    return true;
  };

  for (const source of ctx.sources) {
    const sourceName = source.name || path.basename(source.absPath);
    const cwd = path.dirname(source.absPath);
    const names = [];
    const sizes = new Map();

    if (source.kind === 'file') {
      const fileStat = await fsp.lstat(source.absPath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        throw apiError(ERROR_CODES.PATH_NOT_FOUND, '源文件在扫描后已不可用', { source: sourceName });
      }
      if (recordSkip(source.absPath, path.basename(source.absPath), [sourceName])) continue;
      names.push(sourceName);
      sizes.set(sourceName, fileStat.size);
      totalBytes += fileStat.size;
      entryPaths.push(source.absPath);
      perSource.push({ cwd, names, sizes });
      continue;
    }

    const walk = async (dirAbs, prefix) => {
      const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      for (const dirent of dirents) {
        const childAbs = path.join(dirAbs, dirent.name);
        const relative = `${prefix}/${dirent.name}`;
        if (dirent.isSymbolicLink()) {
          skippedSymlinks += 1;
          continue;
        }
        if (dirent.isDirectory()) {
          await walk(childAbs, relative);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (recordSkip(childAbs, dirent.name, relative.split('/'))) continue;
        const fileStat = await fsp.lstat(childAbs).catch(() => null);
        if (!fileStat || !fileStat.isFile()) continue;
        names.push(relative);
        sizes.set(relative, fileStat.size);
        totalBytes += fileStat.size;
        entryPaths.push(childAbs);
      }
    };
    await walk(source.absPath, sourceName);
    if (names.length > 0) perSource.push({ cwd, names, sizes });
  }

  return { perSource, entryPaths, skipped, skippedSymlinks, totalBytes };
}

/** 进度：解析 `+ <path>` 行（-bb1 输出），按文件累计字节 */
function makeCreateReporter(onProgress, totalBytes, sizeByPath) {
  let processedBytes = 0;
  let processedFiles = 0;
  let totalFiles = sizeByPath.size;
  let lastAt = 0;
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  return (line) => {
    const matched = line.match(/^\+\s+(.+?)\s*$/);
    if (!matched) return;
    const name = matched[1].replace(/\\/g, '/');
    const size = sizeByPath.get(name) || 0;
    processedBytes += size;
    processedFiles += 1;
    const now = Date.now();
    if (now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    report({ processedBytes, totalBytes, processedFiles, totalFiles, currentFile: name });
  };
}

async function create(ctx) {
  const engine = requireEngine();
  const plan = await collectPlan(ctx);
  if (plan.entryPaths.length === 0) {
    throw apiError(ERROR_CODES.ALL_SOURCES_SKIPPED, '没有可压缩的文件：全部命中黑名单');
  }

  const level = resolveLevel(ctx.options);
  const password = ctx.options && typeof ctx.options.password === 'string' ? ctx.options.password : '';
  const sizeByPath = new Map();
  for (const group of plan.perSource) {
    for (const [name, size] of group.sizes) sizeByPath.set(name, size);
  }
  const onLine = makeCreateReporter(ctx.onProgress, plan.totalBytes, sizeByPath);

  // 逐个源、分批把条目名当**命令行参数**传给 7z（cwd = 源的父目录，条目名即"源名/子路径"）。
  // 为什么不用 `-i@listfile`：本机 p7zip 16.02 是 `Utf16=off` 构建，读 UTF-8 listfile 里的中文名会报
  // `????: No more files`（实测），而中文名走 argv 是正常的。分批是为了避免参数过长撞 ARG_MAX。
  const MAX_ARGS_CHARS = 60000;
  for (const group of plan.perSource) {
    const batches = [];
    let current = [];
    let currentChars = 0;
    for (const name of group.names) {
      if (currentChars + name.length > MAX_ARGS_CHARS && current.length > 0) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(name);
      currentChars += name.length + 1;
    }
    if (current.length > 0) batches.push(current);

    for (const batch of batches) {
      const args = ['a', '-t7z', `-mx${level}`, '-y', '-bb1', ...(password ? [`-p${password}`] : []), ctx.tempPath, ...batch];
      const outcome = await run7z(engine.bin, args, {
        cwd: group.cwd,
        timeoutMs: CREATE_TIMEOUT_MS,
        onLine,
        signal: ctx.options && ctx.options.signal,
      });
      if (outcome.code !== 0) {
        await fsp.rm(ctx.tempPath, { force: true }).catch(() => {});
        mapFailure(outcome, { hasPassword: Boolean(password), operation: 'create' });
      }
    }
  }

  return {
    bytesIn: plan.totalBytes,
    skippedSymlinks: plan.skippedSymlinks,
    entryPaths: plan.entryPaths,
    skipped: plan.skipped,
  };
}

// ===== 解压 =====

/** 递归收集中转目录条目（符号链接一律不收） */
async function collectStaged(stagingDir) {
  const collected = [];
  const walk = async (dirAbs, relativePrefix) => {
    const dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
    for (const dirent of dirents) {
      const abs = path.join(dirAbs, dirent.name);
      const relative = relativePrefix ? `${relativePrefix}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        collected.push({ name: `${relative}/`, isDir: true, size: 0, link: false, open: null });
        await walk(abs, relative);
        continue;
      }
      if (!dirent.isFile()) continue;
      const stat = await fsp.lstat(abs).catch(() => null);
      collected.push({
        name: relative,
        isDir: false,
        size: stat ? stat.size : 0,
        link: false,
        open: () => fs.createReadStream(abs),
      });
    }
  };
  await walk(stagingDir, '');
  return collected;
}

async function extract(ctx) {
  const engine = requireEngine();
  const startedAt = Date.now();
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);
  const password = ctx.options && typeof ctx.options.password === 'string' ? ctx.options.password : '';
  const signal = ctx.options && ctx.options.signal;

  // ⓪ 先读清单：判断加密 + 符号链接条目（写盘之前就能拒绝）
  const info = await inspect(ctx.archivePath);
  const symlinkEntries = info.entries.filter((entry) => entry.symlink).map((entry) => entry.name);
  if (symlinkEntries.length > 0) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '压缩包含符号链接条目，已拒绝解压', { entry: symlinkEntries[0] });
  }
  if (info.encrypted && !password) {
    throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
  }

  // ① 解到目标目录旁边的中转目录（外部程序不直接写用户目录）
  const stagingDir = path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.zc7z-${Date.now()}`);
  await fsp.mkdir(stagingDir, { recursive: true });
  try {
    const args = ['x', '-y', ...(password ? [`-p${password}`] : []), `-o${stagingDir}`, ctx.archivePath];
    const outcome = await run7z(engine.bin, args, { timeoutMs: EXTRACT_TIMEOUT_MS, signal });
    if (outcome.code !== 0) mapFailure(outcome, { hasPassword: Boolean(password), operation: 'extract' });

    // ② 安全判定 + 搬入目标目录（zip-slip / 不覆盖同名 / 进度 / 半成品清理）
    const staged = await collectStaged(stagingDir);
    const planned = await planTargets(staged, targetDir, overwrite);
    const written = await writePlan(planned, targetDir, { signal, onProgress: ctx.onProgress });
    return {
      targetDir,
      entries: written.entries,
      bytesOut: written.bytesOut,
      durationMs: Date.now() - startedAt,
      encrypted: info.encrypted,
    };
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default {
  id: FORMAT_ID,
  name: '7Z',
  ext: '.7z',
  extAliases: [],
  mime: 'application/x-7z-compressed',
  levelRange: LEVEL_RANGE,
  defaultLevel: DEFAULT_LEVEL,
  // 7z 原生支持密码：能力声明交给密码能力插件（appliesTo 由能力插件决定）
  capabilities: ['password'],
  available,
  unavailableReason,
  estimate,
  create,
  extract,
  list,
  test,
  probeEncryption,
  verifyWithPassword,
  /** 诊断：当前用哪个引擎（验收要看这条） */
  probe: () => {
    const engine = resolveEngine();
    return {
      kind: engine.kind,
      bin: engine.bin,
      version: engine.bin ? probeVersion(engine.bin) : null,
      wasmPackage: engine.wasmPackage,
    };
  },
};
