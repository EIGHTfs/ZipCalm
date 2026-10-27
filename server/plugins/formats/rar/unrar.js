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

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';

/** 二进制探测结果缓存 60s（与格式注册表的可用性缓存同频，装了工具最多一分钟就该亮起来） */
const PROBE_TTL_MS = 60 * 1000;
let probeCache = null;

/** 单次命令超时：列表/校验给 60s，解压给 30min（大包慢盘） */
export const LIST_TIMEOUT_MS = 60 * 1000;
export const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

/** 候选路径：环境变量优先，其次常见安装位置（禁止写死单一绝对路径） */
function candidatesOf(kind) {
  const envValue = kind === 'unrar' ? process.env.ZC_UNRAR_BIN : process.env.ZC_7Z_BIN;
  const fixed = kind === 'unrar'
    ? ['/bin/unrar', '/usr/bin/unrar', '/usr/local/bin/unrar']
    : ['/bin/7z', '/usr/bin/7z', '/usr/local/bin/7z'];
  return [envValue, ...fixed].filter((item) => typeof item === 'string' && item.length > 0);
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
  const timeoutMs = options.timeoutMs || LIST_TIMEOUT_MS;
  const onLine = typeof options.onLine === 'function' ? options.onLine : null;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) onLine(line);
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
