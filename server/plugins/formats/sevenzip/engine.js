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

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';

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

  // WASM 兜底：**只探测依赖是否可解析**（不做加载/执行）。
  // 说明：WASM 引擎的调用适配尚未接入（需要 js7z-tools 的 onExit 异步语义，见 docs/18 §附四），
  // 因此 kind 保持 null —— available() 不会误报"可用"，避免用户点下去才发现跑不了。
  let resolvableWasm = null;
  if (!bin) {
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
  engine = { ...engine, wasmPackage: resolvableWasm };

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
 * 跑一次 7z 命令，按行回调（进度解析用）。
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?: string, timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 */
export function run7z(bin, args, options = {}) {
  const timeoutMs = options.timeoutMs || LIST_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: options.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error && error.message), timedOut: false, aborted: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const emit = (chunk, isError) => {
      const text = chunk.toString();
      if (isError) stderr += text;
      else stdout += text;
      if (typeof options.onLine === 'function') {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) options.onLine(line);
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        child.kill('SIGKILL');
      } else {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          child.kill('SIGKILL');
        }, { once: true });
      }
    }
    child.stdout.on('data', (chunk) => emit(chunk, false));
    child.stderr.on('data', (chunk) => emit(chunk, true));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${String(error && error.message)}`, timedOut, aborted });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, stdout, stderr, timedOut, aborted });
    });
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
      if (/^D_/.test(attributeText)) current.type = 'dir';
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
  if (/wrong password|Can not open encrypted|password/i.test(text)) {
    if (!context.hasPassword) throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
    throw apiError(ERROR_CODES.BAD_PASSWORD, '密码错误');
  }
  if (context.operation === 'create') {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '7z 压缩失败', {
      detail: text.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 200),
    });
  }
  throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包损坏', {
    exitCode: outcome.code,
    detail: text.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 200),
  });
}
