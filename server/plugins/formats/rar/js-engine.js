// RAR 的纯 JS/WASM 引擎适配（node-unrar-js）——**客户端侧**：只负责起子进程、解析信封、映射错误码
//
// 真正的解压在 `js-runner.mjs` 子进程里跑。原因（务必保留这段说明，别再改回同进程）：
//   1) `node-unrar-js` 的 `extract()` 是**同步**的（返回 ArcFiles，不是 Promise）。
//      在服务进程里直接调 → 解压期间事件循环停摆：SSE 不推进度、HTTP 全站无响应、取消按钮点不动。
//   2) WASM 内存会占在服务进程里（7z 那边峰值 460MB 在子进程），WASM 崩了会带走整个服务。
//   3) 同步执行无法取消 —— 子进程 + SIGKILL 是唯一可靠的超时/取消手段。
//
// CPU 纪律（绑核「总核数 − 1」+ nice + 全局串行）统一由 `server/core/engineRunner.js` 提供，与 7z 共用同一把锁。
//
// **实测能力边界（node-unrar-js@2.0.2，内置 unrar 6.1.7）**：
//   ✅ rar4 / rar5、嵌套目录、纯 ASCII 文件名
//   ✅ 多卷（给 part1 自动续卷）
//   ✅ 加密包：正确密码可解；缺密码 → MISSING_PASSWORD；错密码 → BAD_PASSWORD
//   ❌ **RAR5 中文名仍然乱码**（与 unrar 5.70 一致）→ 这一层**修不了文件名**，所以有原生 unrar 时仍优先原生
//   ⚠️ 损坏包**不报错**：静默只解出部分文件（原生 unrar 会明确报 ARCHIVE_CORRUPTED）；
//      这里用「解出条数/字节数 vs 清单」兜底，清单本身被截断时抓不到（已知限制）

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { runEngineProcess } from '../../../core/engineRunner.js';

const JS_PACKAGE = 'node-unrar-js';
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'js-runner.mjs');

const LIST_TIMEOUT_MS = 60 * 1000;
const EXTRACT_TIMEOUT_MS = 30 * 60 * 1000;

let loaded = null;

/** 载入 node-unrar-js（只用于"能不能用"的探测与版本号；真正干活在子进程） */
export function loadUnrarJs() {
  if (loaded !== null) return loaded.module;
  try {
    loaded = { module: createRequire(import.meta.url)(JS_PACKAGE) };
  } catch {
    loaded = { module: null };
  }
  return loaded.module;
}

export function jsAvailable() {
  return Boolean(loadUnrarJs());
}

export function jsVersion() {
  if (!jsAvailable()) return null;
  try {
    return createRequire(import.meta.url)(`${JS_PACKAGE}/package.json`).version;
  } catch {
    return 'unknown';
  }
}

/** 错误码 → 契约错误（三态与原生 unrar 完全一致） */
function throwMapped(errorCode, message, details) {
  if (errorCode === 'MISSING_PASSWORD') throw apiError(ERROR_CODES.MISSING_PASSWORD, message || '该压缩包已加密，请输入密码');
  if (errorCode === 'BAD_PASSWORD') throw apiError(ERROR_CODES.BAD_PASSWORD, message || '密码错误');
  throw apiError(ERROR_CODES.ARCHIVE_CORRUPTED, message || '压缩包损坏', details);
}

/**
 * 跑一次 js 引擎子进程。
 * @param {{op: 'list'|'extract'|'test', archivePath: string, targetPath?: string, password?: string}} spec
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 * @returns {Promise<object>} 信封内容
 */
export async function runJsEngine(spec, options = {}) {
  if (!jsAvailable()) throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, 'node-unrar-js 不可用');
  const timeoutMs = options.timeoutMs || (spec.op === 'list' ? LIST_TIMEOUT_MS : EXTRACT_TIMEOUT_MS);
  // 测试用：允许把超时压到很小，验证"超时能被 SIGKILL 掉"
  const overrideTimeout = Number(process.env.ZC_RAR_JS_TIMEOUT_MS);
  const effectiveTimeout = Number.isInteger(overrideTimeout) && overrideTimeout > 0 ? overrideTimeout : timeoutMs;

  const outcome = await runEngineProcess(
    { command: process.execPath, args: [RUNNER, JSON.stringify(spec)], label: 'unrar-js' },
    { timeoutMs: effectiveTimeout, signal: options.signal },
  );

  if (outcome.aborted) throw apiError(ERROR_CODES.ABORTED, '任务已取消');
  if (outcome.timedOut) {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, 'RAR 解压超时（js 引擎未在限定时间内完成，已强制终止）');
  }

  const lastLine = String(outcome.stdout || '').trim().split(/\r?\n/).filter((line) => line.startsWith('{')).pop();
  if (!lastLine) {
    // 子进程崩了/没输出：任务失败即可，**服务不受影响**（这正是子进程化的收益）
    throw apiError(ERROR_CODES.INTERNAL_ERROR, 'js 引擎异常退出（详见服务日志）', {
      exitCode: outcome.code,
      reason: String(outcome.stderr || '').slice(-120),
    });
  }
  const envelope = JSON.parse(lastLine);
  if (envelope.ok !== true) throwMapped(envelope.errorCode, envelope.message, { reason: envelope.reason });
  return envelope;
}

/** 读清单（含是否加密） */
export async function jsInspect(archivePath) {
  const envelope = await runJsEngine({ op: 'list', archivePath });
  return { entries: envelope.entries || [], encrypted: envelope.encrypted === true };
}

/** 校验：完整解一遍到临时目录（子进程自己清理），并核对条数/字节数 */
export async function jsTest(archivePath, options = {}) {
  const password = options && typeof options.password === 'string' ? options.password : '';
  const envelope = await runJsEngine({ op: 'test', archivePath, ...(password ? { password } : {}) });
  return { ok: true, checked: envelope.fileCount || 0, failures: [], strategy: 'unrar-js-extract' };
}

/** 解压到指定目录 */
export async function jsExtractTo(archivePath, targetDir, options = {}) {
  const password = options && typeof options.password === 'string' ? options.password : '';
  const envelope = await runJsEngine(
    { op: 'extract', archivePath, targetPath: targetDir, ...(password ? { password } : {}) },
    { signal: options.signal },
  );
  return { fileCount: envelope.fileCount || 0, bytesOut: envelope.bytesOut || 0 };
}
