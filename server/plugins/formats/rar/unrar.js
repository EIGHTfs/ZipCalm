// RAR 外部解压工具封装（unrar 优先，7z 兜底）
//
// 为什么必须走外部二进制：RAR 的压缩算法是闭源商业算法，Node 生态没有合规实现。
// **绝不把 rar/unrar 打进项目或仓库**（docs/18 §附三法律边界）；调用用户已安装的程序是合法的。
//
// 实测结论（UNRAR 5.70 / p7zip 16.02）：
// - `unrar lt` 是机器可读的技术列表（Name / Type / Size / Packed size / Flags: encrypted）
// - 缺密码与错密码在 unrar 侧**同为 exit 11 + 同一句提示**，无法从输出区分 —— 只能由调用方
//   根据"我们有没有传密码"来判定 MISSING_PASSWORD / BAD_PASSWORD（三态口径见 P4）
// - 损坏包 exit 1（"Unexpected end of archive" / "Total errors: N"）
// - p7zip 16.02 对 rar5 返回 exit 2（本机实测），所以 **unrar 是唯一可靠后端**，7z 仅作兜底

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { runEngineProcess } from '../../../core/engineRunner.js';
import { jsAvailable, jsVersion } from './js-engine.js';

/** 二进制探测结果缓存 60s（与格式注册表的可用性缓存同频，装了工具最多一分钟就该亮起来） */
const PROBE_TTL_MS = 60 * 1000;
let probeCache = null;

/** 单次命令超时：列表/校验给 60s，解压给 30min（大包慢盘） */
export const LIST_TIMEOUT_MS = 60 * 1000;
export const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

/** 候选路径：环境变量优先，其次常见安装位置（禁止写死单一绝对路径） */
/**
 * 候选二进制。
 *
 * `ZC_UNRAR_BIN` / `ZC_7Z_BIN` **设了就独占**（不是"优先再回落"）：语义是"我明确指定用哪个二进制"，
 * 指到不可执行的文件说明部署配错，应当如实报不可用并让人去修，而不是悄悄换另一个
 * （那样运维看不出自己配错，回退链也测不出来）。与 7z 的 `ZC_7Z_BIN` 同规则。
 */
function candidatesOf(kind) {
  const envValue = kind === 'unrar' ? process.env.ZC_UNRAR_BIN : process.env.ZC_7Z_BIN;
  if (typeof envValue === 'string' && envValue.length > 0) return [envValue];
  return kind === 'unrar'
    ? ['/bin/unrar', '/usr/bin/unrar', '/usr/local/bin/unrar']
    : ['/bin/7z', '/usr/bin/7z', '/usr/local/bin/7z'];
}

/** 可执行文件判定：必须存在且真的能执行（只看存在会把坏链接/无执行位当可用） */
function isExecutable(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测可用后端。
 * @returns {{unrar: string|null, sevenZip: string|null}}
 */
export function resolveTools() {
  const now = Date.now();
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.tools;
  const tools = {
    unrar: candidatesOf('unrar').find(isExecutable) || null,
    sevenZip: candidatesOf('sevenZip').find(isExecutable) || null,
  };
  probeCache = { at: now, tools };
  return tools;
}

/** 测试用：清掉探测缓存（换了环境变量后不必等 60s） */
export function resetProbeCache() {
  probeCache = null;
}

/**
 * 运行外部命令，按行回调（用于进度解析）。
 * @param {string} bin
 * @param {string[]} args
 * @param {{timeoutMs?: number, onLine?: (line: string) => void, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean, aborted: boolean}>}
 */
export function runCommand(bin, args, options = {}) {
  // 绑核 / nice / 全局串行 / 超时硬杀 / 取消：统一由 core/engineRunner.js 处理（与 7z 共用一把锁）
  return runEngineProcess({
    command: bin,
    args,
    // **必须**强制 UTF-8 locale：默认 locale 与 C.UTF-8 都会让 unrar 输出有损的 `?`（不可还原），
    // 只有 en_US.UTF-8 / zh_CN.UTF-8 才输出可逆的 PUA 转义（详见 _shared/nameRepair.js 头注释）
    env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    timeoutMs: options.timeoutMs || LIST_TIMEOUT_MS,
    onLine: options.onLine,
    signal: options.signal,
    label: 'unrar',
  });
}

/** 是否加密：`lt` 的条目块里出现 `Flags: encrypted` */
export function hasEncryptionFlag(ltOutput) {
  return /Flags:.*encrypted/i.test(String(ltOutput || ''));
}

/**
 * 解析 `unrar lt` 的技术列表。
 * 输出随版本变化 → 解析不出来就返回空数组，由调用方降级到 `lb`（裸名列表），**不报错**。
 * @returns {Array<{name: string, type: 'dir'|'file', size: number, compressedSize: number}>}
 */
export function parseTechnicalList(ltOutput) {
  const entries = [];
  let current = null;
  for (const rawLine of String(ltOutput || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const nameMatch = line.match(/^Name:\s*(.+)$/);
    if (nameMatch) {
      if (current && current.name) entries.push(current);
      current = { name: nameMatch[1], type: 'file', size: 0, compressedSize: 0 };
      continue;
    }
    if (!current) continue;
    const typeMatch = line.match(/^Type:\s*(\S+)/);
    if (typeMatch) {
      current.type = /dir/i.test(typeMatch[1]) ? 'dir' : 'file';
      continue;
    }
    const sizeMatch = line.match(/^Size:\s*(\d+)/);
    if (sizeMatch) {
      current.size = Number(sizeMatch[1]);
      continue;
    }
    const packedMatch = line.match(/^Packed size:\s*(\d+)/);
    if (packedMatch) current.compressedSize = Number(packedMatch[1]);
  }
  if (current && current.name) entries.push(current);
  return entries.map((entry) => ({
    // 归档内路径统一成 POSIX：RAR 可能用反斜杠（Windows 打的包）
    name: String(entry.name).replace(/\\/g, '/'),
    type: entry.type,
    size: entry.type === 'dir' ? 0 : entry.size,
    compressedSize: entry.compressedSize,
  }));
}

/** `lb` 裸名列表（解析降级路径）：只有名字，大小未知 */
export function parseBareList(lbOutput) {
  return String(lbOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const name = line.replace(/\\/g, '/');
      return { name, type: name.endsWith('/') ? 'dir' : 'file', size: 0, compressedSize: 0 };
    });
}

/**
 * 把 unrar/7z 的失败翻译成契约错误码（**四种情况不能混用**）。
 * @param {{stderr: string, stdout: string, code: number, timedOut?: boolean, aborted?: boolean}} outcome
 * @param {{hasPassword: boolean}} context
 */
export function mapToolFailure(outcome, context) {
  if (outcome.aborted) throw apiError(ERROR_CODES.ABORTED, '任务已取消');
  if (outcome.timedOut) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, 'RAR 解压超时（外部程序未在限定时间内完成）');
  }
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  // 密码相关：unrar 对"没给密码"和"密码给错"都是同一句提示，只能靠我们是否传了密码来判定
  if (/password/i.test(text)) {
    if (!context.hasPassword) throw apiError(ERROR_CODES.MISSING_PASSWORD, '该压缩包已加密，请输入密码');
    throw apiError(ERROR_CODES.BAD_PASSWORD, '密码错误');
  }
  if (/cannot open|No such file|is not RAR archive|Unexpected end|corrupt|CRC failed|checksum/i.test(text)) {
    throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包损坏');
  }
  throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, '压缩包损坏', {
    exitCode: outcome.code,
    detail: text.trim().split(/\r?\n/).slice(-2).join(' / ').slice(0, 200),
  });
}

/** 是否存在可用的后端（unrar 优先） */
export function pickBinaries() {
  const tools = resolveTools();
  return { unrar: tools.unrar, sevenZip: tools.sevenZip };
}

/** 同步探测版本（供 /formats 的 unavailableReason 附带线索；失败返回 null） */
export function probeUnrarVersion(bin) {
  try {
    const output = execFileSync(bin, [], { encoding: 'utf8', timeout: 5000 });
    const matched = String(output).match(/UNRAR\s+([\d.]+)/i);
    return matched ? matched[1] : null;
  } catch {
    return null;
  }
}

/** 版本号比较（只比较数字段，缺位按 0 算）：a<b 返回 -1，相等 0，a>b 返回 1 */
export function compareVersion(a, b) {
  const left = String(a || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 「文件名是否可靠」的版本阈值。
 *
 * 实测依据（同一份 RAR5 中文名样本 `scripts/fixtures/rar/s7-chinese.rar`）：
 *   unrar 5.70（DSM 自带）→ `s7/????????????????.txt` / 落盘字节 `efbfbe ee83a5…`（UTF-8 被当 UTF-16）✗
 *   unrar 7.23（新版）    → `s7/中文文件名.txt` / 落盘字节 `e4b8ad e69687…` ✓
 *   node-unrar-js 2.0.2（内置 unrar 6.1.7）→ 仍是乱码 ✗
 * 所以阈值取 **7.0**（保守）：低于它一律认为文件名不可靠，需要提示用户升级。
 */
export const FILENAME_SAFE_MIN_VERSION = '7.0';

export function isFilenameSafe(version) {
  if (!version) return false;
  return compareVersion(version, FILENAME_SAFE_MIN_VERSION) >= 0;
}

/**
 * 解析 RAR 引擎（三级回退：原生 unrar → node-unrar-js → 7z → 无）。
 *
 * 默认策略（`ZC_UNRAR_ENGINE=auto`）：**有原生 unrar 就用原生**，哪怕版本旧——
 * 因为实测 js 引擎修不了中文名，且对损坏包不报错，换过去是能力退化；
 * 原生缺失时才回落到 js（至少"能解"），再不行看 7z。
 * `ZC_UNRAR_ENGINE=native|js` 可强制指定（验收与排障用）。
 *
 * @returns {{kind: 'unrar'|'js'|'7z'|null, bin: string|null, version: string|null, filenameSafe: boolean, reason: string|null}}
 */
export function resolveEngine() {
  const mode = String(process.env.ZC_UNRAR_ENGINE || 'auto').toLowerCase();
  const tools = resolveTools();
  const native = tools.unrar
    ? { kind: 'unrar', bin: tools.unrar, version: probeUnrarVersion(tools.unrar) }
    : null;
  const nativeEngine = native
    ? { ...native, filenameSafe: isFilenameSafe(native.version), reason: null }
    : null;
  const jsEngine = jsAvailable()
    ? { kind: 'js', bin: null, version: jsVersion(), filenameSafe: false, reason: null }
    : null;
  const sevenEngine = tools.sevenZip
    ? { kind: '7z', bin: tools.sevenZip, version: probe7zVersion(tools.sevenZip), filenameSafe: false, reason: null }
    : null;

  if (mode === 'native') return nativeEngine || { kind: null, bin: null, version: null, filenameSafe: false, reason: 'ZC_UNRAR_ENGINE=native 但没找到可执行的 unrar' };
  if (mode === 'js') return jsEngine || { kind: null, bin: null, version: null, filenameSafe: false, reason: 'ZC_UNRAR_ENGINE=js 但 node-unrar-js 不可用' };

  const picked = nativeEngine || jsEngine || sevenEngine;
  if (picked) return picked;
  return { kind: null, bin: null, version: null, filenameSafe: false, reason: '未找到 unrar / node-unrar-js / 7z' };
}

/** 7z 的版本（只在没有 unrar/js 时用于兜底诊断） */
function probe7zVersion(bin) {
  try {
    const output = execFileSync(bin, [], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const matched = String(output).match(/7-Zip[^\n]*?(\d+\.\d+)/i);
    return matched ? matched[1] : null;
  } catch {
    return null;
  }
}
