// 7z 外部引擎封装（三级回退：系统 7z/7za → WASM 引擎 → 不可用）
//
// 为什么先探测系统二进制：本机 `/bin/7z`（p7zip 16.02）零新增依赖、零加载开销，
// 只有部署机上没有 7z 时才需要 WASM 兜底（WASM 引擎需额外依赖，见 docs/18 §附四）。
//
// 实测事实（p7zip 16.02，本项目验证环境）：
// - `7z a -t7z -mx0..9` 的级别真实生效（同一份 20 KB 文本：-mx0=20210B / -mx9=282B）
// - 加密：`7z a -p<密码>` 可加密；**解压时"没给密码"与"给错密码"退出码相同（都是 2）**，
//   无法从退出码区分 —— 只能按"调用方有没有传密码"判定 MISSING_PASSWORD / BAD_PASSWORD
// - `7z l -slt` 是机器可读列表：`Path / Size / Packed Size / Attributes / Encrypted`
// - 符号链接条目在 `Attributes` 里体现为权限位以 `l` 开头（如 `A_ lrwxrwxrwx`）
// - 目录条目 `Attributes = D_ ...`（压缩包里不含空目录时可能没有目录条目，父目录由解压时自动创建）

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { currentCpuCores, runEngineProcess } from '../../../core/engineRunner.js';

// 供 index.js 的 `-mmt` 对齐使用
export { currentCpuCores };

/**
 * WASM 引擎能不能直接写这个路径所在的文件系统？
 *
 * **不能写网络盘（CIFS/SMB/NFS）**：WASM 侧通过 Emscripten 的 NODEFS 落盘，它创建文件后会做
 * chmod/chown/utime 这类元数据操作，而 CIFS 挂载会直接拒绝 → 7z 报 `errno=63 : Operation not permitted`
 * （该构建里 errno 63 = EPERM，已在 js7z.js 的 ERRNO_CODES 表里核对过）。
 *
 * 对照实验（同一份 runner，只改挂载根）：
 *   挂 CIFS 目录  → exit=2，产物 0B，报 errno=63
 *   挂本地 btrfs → exit=0，产物 166B
 *   读 CIFS + 写本地 → exit=0（**读没问题，只有写不行**）
 *
 * 因此：WASM 模式下**可写路径一律先落本地盘**，再由 Node 拷到目标（Node 的 fs 在 CIFS 上正常）。
 */
export function needsLocalWorkPath(engine) {
  return Boolean(engine) && engine.kind === 'wasm';
}

/** 在本地盘（os.tmpdir()）建一个临时工作目录，供 WASM 引擎写产物 */
export async function makeLocalWorkDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * 把本地盘上的文件搬到目标路径（可能是 CIFS 网络盘）。
 *
 * **不能用 `fs.copyFile`**：本机 CIFS 挂载上它必报 `EPERM: operation not permitted, copyfile`
 * （实测 copyFile / COPYFILE_EXCL 都失败，而 `readFile+writeFile` 与流式 pipeline 都成功）。
 * 这里用流式管道：内存占用与文件大小无关，适合大压缩包。
 */
export async function copyLocalToTarget(sourcePath, targetPath) {
  await pipeline(fs.createReadStream(sourcePath), fs.createWriteStream(targetPath));
}

// CPU 纪律（绑核「总核数 − 1」+ nice + 全局串行）统一由 `server/core/engineRunner.js` 提供，与 7z 共用同一把锁。
// 这是部署环境约束（本机 3 核、跑满会触发宿主保护），不是 7z 私有实现，RAR 的 js 引擎同样要用。

/** 探测结果缓存（60s，与格式注册表的可用性缓存同频） */
const PROBE_TTL_MS = 60 * 1000;
let probeCache = null;

export const LIST_TIMEOUT_MS = 60 * 1000;
export const CREATE_TIMEOUT_MS = 60 * 60 * 1000;
export const EXTRACT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 候选二进制。
 *
 * `ZC_7Z_BIN` **设了就独占**（不是"优先再回落"）：这个变量的语义是"我明确指定用哪个二进制"，
 * 若它指向不可执行的文件，说明部署配置有误——此时应当如实报"不可用"并让人去修，
 * 而不是悄悄换用另一个 7z（那样"回退链②③"永远测不出来，运维也看不出自己配错了）。
 */
function nativeCandidates() {
  const fromEnv = process.env.ZC_7Z_BIN;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return [fromEnv];
  return ['/bin/7z', '/usr/bin/7z', '/usr/local/bin/7z', '/bin/7za', '/usr/bin/7za'];
}

function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** WASM 引擎的包名（可选依赖）：装了就用，没装就不算可用 */
const WASM_PACKAGES = ['js7z-tools'];

/**
 * 探测可用引擎。
 * @returns {{kind: 'native'|'wasm'|null, bin: string|null, wasmPackage: string|null, nativePresent: boolean}}
 */
export function resolveEngine() {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.engine;

  const bin = nativeCandidates().find(isExecutable) || null;
  let engine = { kind: bin ? 'native' : null, bin, wasmPackage: null, nativePresent: Boolean(bin) };

  // WASM 兜底：系统没有二进制时才启用。判定标准是"依赖可解析"
  // （真正的加载/执行放到子进程里，见 wasm-runner.mjs —— 缺依赖时子进程启动即失败，不会误报可用）。
  let resolvableWasm = null;
  // ZC_7Z_DISABLE_WASM=1：用于验收"回退③两者都没有"，也供运维在 WASM 出问题时临时关掉
  const wasmDisabled = process.env.ZC_7Z_DISABLE_WASM === '1';
  if (!bin && !wasmDisabled) {
    const requireFromHere = createRequire(import.meta.url);
    for (const name of WASM_PACKAGES) {
      try {
        requireFromHere.resolve(name);
        resolvableWasm = name;
        break;
      } catch {
        /* 未安装：继续看下一个候选 */
      }
    }
  }
  engine = {
    kind: bin ? 'native' : (resolvableWasm ? 'wasm' : null),
    bin,
    wasmPackage: resolvableWasm,
    nativePresent: Boolean(bin),
  };

  probeCache = { at: now, engine };
  return engine;
}

/** 测试用：清掉探测缓存（换了环境变量后不必等 60 秒） */
export function resetProbeCache() {
  probeCache = null;
}

/** 版本探测（供 probe()/诊断；失败返回 null） */
export function probeVersion(bin) {
  try {
    const output = execFileSync(bin, [], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const matched = String(output).match(/7-Zip[^\n]*?(\d+\.\d+)/i);
    return matched ? matched[1] : null;
  } catch {
    return null;
  }
}

/**
 * 跑一次 7z 命令（薄封装：绑核/降优先级/串行/超时硬杀都在 `core/engineRunner.js` 里统一做）。
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 */
export function run7z(bin, args, options = {}) {
  return runEngineProcess({
    command: bin,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || LIST_TIMEOUT_MS,
    onLine: options.onLine,
    signal: options.signal,
    label: '7z',
  });
}

/**
 * 解析 `7z l -slt` 输出。
 * 结构：头部块（Path/Type/Physical Size…）→ `----------` 分隔线 → 每个条目一块。
 * @returns {Array<{name: string, type: 'dir'|'file', size: number, compressedSize: number, encrypted: boolean, symlink: boolean}>}
 */
export function parseSlt(output) {
  const lines = String(output || '').split(/\r?\n/);
  const separatorAt = lines.findIndex((line) => /^-{5,}$/.test(line.trim()));
  if (separatorAt < 0) return [];

  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.name) entries.push(current);
    current = null;
  };
  for (const rawLine of lines.slice(separatorAt + 1)) {
    const line = rawLine.trim();
    if (line.startsWith('Path = ')) {
      flush();
      current = {
        name: line.slice(7).replace(/\\/g, '/'),
        type: 'file',
        size: 0,
        compressedSize: 0,
        encrypted: false,
        symlink: false,
      };
      continue;
    }
    if (!current) continue;
    const attributes = line.match(/^Attributes = (.*)$/);
    if (attributes) {
      const attributeText = attributes[1];
      // 目录标记：p7zip 16.02 写 `D_ drwxr-xr-x`，7-Zip 25.01（WASM）写 `D drwxr-xr-x` —— 两者都要认
      if (/^D[\s_]/.test(attributeText) || /^D$/.test(attributeText)) current.type = 'dir';
      // 符号链接判定：**权限串首字符必须是 `l`**（`A_ lrwxrwxrwx`）。
      // 不能宽匹配 `-rw-r--r--`——普通文件的权限串也以 `-` 开头，宽匹配会把所有普通文件误判成链接（实测踩过）。
      const permission = attributeText.split(/\s+/).find((token) => /^[dl-][rwx-]{9}$/.test(token)) || '';
      if (permission.startsWith('l')) current.symlink = true;
      continue;
    }
    const size = line.match(/^Size = (\d+)/);
    if (size) {
      current.size = Number(size[1]);
      continue;
    }
    const packed = line.match(/^Packed Size = (\d+)/);
    if (packed) {
      current.compressedSize = Number(packed[1]);
      continue;
    }
    if (/^Encrypted = \+/.test(line)) current.encrypted = true;
    // 25.01 用 `Folder = +` 表达目录（与 Attributes 双保险）
    if (/^Folder = \+/.test(line)) current.type = 'dir';
  }
  flush();
  return entries;
}

/** 列表里是否含加密内容（任一文件条目 Encrypted=+ 即视为加密包） */
export function isEncryptedList(entries) {
  return entries.some((entry) => entry.encrypted === true);
}

/**
 * 失败 → 契约错误码（四种情况不能混用）。
 * @param {{stdout: string, stderr: string, code: number, timedOut?: boolean, aborted?: boolean}} outcome
 * @param {{hasPassword: boolean, operation: 'list'|'test'|'extract'|'create'}} context
 */
export function mapFailure(outcome, context) {
  if (outcome.aborted) throw apiError(ERROR_CODES.ABORTED, '任务已取消');
  if (outcome.timedOut) throw apiError(ERROR_CODES.INTERNAL_ERROR, '7z 操作超时（外部程序未在限定时间内完成）');
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  const passwordState = () => {
    if (!context.hasPassword) throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
    throw apiError(ERROR_CODES.BAD_PASSWORD, '密码错误');
  };
  // 明确的密码字样（p7zip 16.02 会打 "Wrong password"/"Enter password"）
  if (/wrong password|enter password|can not open encrypted|password/i.test(text)) passwordState();
  // 明确的数据损坏信号
  if (/data error|crc failed|unexpected end|headers error|is not archive/i.test(text)) {
    // 落到下面的"损坏"分支
  } else if (context.archiveEncrypted) {
    // 关键：WASM 版 7-Zip（25.01）密码错时只说 "Archives with Errors"，**不含 password 字样**。
    // 已知包是加密的，又没命中损坏信号 → 就是密码问题（有没有传密码决定是哪一态）。
    passwordState();
  }
  if (context.operation === 'create') {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '7z 压缩失败', {
      detail: sanitizeDetail(text),
    });
  }
  throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包损坏', {
    exitCode: outcome.code,
    detail: sanitizeDetail(text),
  });
}

/**
 * 把 7z 输出里的**宿主绝对路径**收敛成文件名，避免把存储根路径带进任务 error（进而出现在 API 响应里）。
 *
 * 为什么必须做：原生引擎调 7z 时传的是宿主绝对路径，失败时 7z 会把路径原样打出来；
 * 而 m2/m3/probes 都有"响应不含绝对路径"的断言 —— 带路径的错误文案会让这些断言变红，
 * 也确实属于信息泄漏（用户看到的错误不需要知道服务器目录结构）。
 * 完整原文仍写服务日志，便于排查。
 */
function sanitizeDetail(rawText) {
  const tail = String(rawText || '').trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 200);
  if (tail.length === 0) return '';
  console.error(`[sevenzip] 7z 失败原文：${tail}`);
  return tail.replace(/\/[^\s'":,]+/g, (matched) => matched.split('/').filter(Boolean).pop() || matched);
}

/** WASM 执行器脚本路径（与被本文件同目录） */
const WASM_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'wasm-runner.mjs');

/**
 * 把宿主绝对路径翻译成 WASM 虚拟路径，并给出需要挂载的目录清单。
 *
 * 规则：
 *   - `-o/abs/dir`      → 挂载 `/abs/dir` 本身，参数变 `-o/mN`
 *   - `/abs/file`       → 挂载其父目录，参数变 `/mN/file`
 *   - 相对名（create 的条目名）→ 原样保留，靠 `cwd` 决定基准
 * @returns {{argv: string[], cwdWasm: string|null, mounts: Array<{host: string, wasm: string}>}}
 */
export function planWasmMounts(argv, cwd) {
  const mounts = [];
  const mountOf = (hostAbs) => {
    const found = mounts.find((item) => item.host === hostAbs);
    if (found) return found.wasm;
    const wasmPath = `/m${mounts.length}`;
    mounts.push({ host: hostAbs, wasm: wasmPath });
    return wasmPath;
  };
  const translated = argv.map((arg) => {
    const outputPrefix = arg.match(/^-o(\/.*)$/);
    if (outputPrefix) return `-o${mountOf(outputPrefix[1])}`;
    if (arg.startsWith('/')) return `${mountOf(path.dirname(arg))}/${path.basename(arg)}`;
    return arg;
  });
  return { argv: translated, cwdWasm: cwd ? mountOf(cwd) : null, mounts };
}

/**
 * 统一执行入口：引擎是原生二进制就走 spawn，是 WASM 就走子进程执行器。
 *
 * 串行闸门与绑核/降优先级都来自 `server/core/engineRunner.js`（跨插件共享一把锁），
 * 避免"每个格式各写一份 CPU 纪律、下一个格式必然漏掉"。
 */
export function runEngine(engine, options = {}) {
  // 串行/限核由 runEngineProcess 内部统一处理，这里不再自己排队（避免双重排队）
  return runEngineUnsafe(engine, options);
}

async function runEngineUnsafe(engine, options = {}) {
  if (engine.kind === 'native') return run7z(engine.bin, options.argv, options);
  if (engine.kind !== 'wasm') {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, '没有可用的 7z 引擎（系统二进制与 WASM 都不可用）');
  }

  const spec = planWasmMounts(options.argv, options.cwd);
  // 绑核 / nice / 全局串行 / 超时硬杀 / 取消：统一由 core/engineRunner.js 处理
  const outcome = await runEngineProcess({
    command: process.execPath,
    args: [WASM_RUNNER, JSON.stringify(spec)],
    timeoutMs: options.timeoutMs || LIST_TIMEOUT_MS,
    signal: options.signal,
    onLine: options.onLine,
    label: '7z-wasm',
  });

  // 信封是 stderr 的**最后一行** JSON（前面的行是运行器诊断信息）
  let code = -1;
  try {
    const lastLine = String(outcome.stderr || '').trim().split('\n').filter((line) => line.startsWith('{')).pop() || '{}';
    const parsed = JSON.parse(lastLine);
    code = typeof parsed.exit === 'number' ? parsed.exit : -1;
  } catch {
    code = -1;
  }
  // WASM 模式下把 7z 输出放进 stdout，让 parseSlt 等既有解析逻辑无需分支
  return { code, stdout: outcome.stdout, stderr: '', timedOut: outcome.timedOut, aborted: outcome.aborted };
}
