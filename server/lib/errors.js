// 错误对象与错误码统一入口（M1）
//
// 铁律（docs/M0/API规范.md §八 + INV-12）：**错误码全部来自 shared/error-codes.js，不允许自造**。
// 这里只做三件事：
//   1. 提供 ApiError（携带契约错误码 + 可选 details）；
//   2. 把 Node 的系统错误（ENOENT/EACCES/ENOSPC…）翻译成契约错误码；
//   3. 输出契约要求的 error 载荷 {code, message, details}。

import { ERROR_CODES, isErrorCode, errorCodeMeta } from '../../shared/error-codes.js';

/** 系统错误码 → 契约错误码（只映射已知的，其余落到 INTERNAL_ERROR） */
const SYSTEM_ERROR_MAP = {
  ENOENT: ERROR_CODES.PATH_NOT_FOUND,
  EACCES: ERROR_CODES.PERMISSION_DENIED,
  EPERM: ERROR_CODES.PERMISSION_DENIED,
  ENOTDIR: ERROR_CODES.NOT_A_DIRECTORY,
  EISDIR: ERROR_CODES.NOT_A_DIRECTORY,
  ENOSPC: ERROR_CODES.DISK_FULL,
  EDQUOT: ERROR_CODES.QUOTA_EXCEEDED,
  EMFILE: ERROR_CODES.SERVICE_UNAVAILABLE,
  ENFILE: ERROR_CODES.SERVICE_UNAVAILABLE,
  ELOOP: ERROR_CODES.PATH_OUT_OF_ROOT,
  // 路径类错误：全部归 INVALID_PATH(400)，**不允许落到 500**
  // （契约 §八 把「超长」明确列在 INVALID_PATH 的触发场景里：这是客户端可修正的请求，
  //   不是服务端故障。真实案例：GET /fs/list?path=/aaaa…(300) 曾返回 500 INTERNAL_ERROR，
  //   根因就是 ENAMETOOLONG 没有映射，落到兜底 INTERNAL_ERROR。）
  ENAMETOOLONG: ERROR_CODES.INVALID_PATH,
  EINVAL: ERROR_CODES.INVALID_PATH,
  EBADF: ERROR_CODES.INVALID_PATH,
  EFAULT: ERROR_CODES.INVALID_PATH,
};

/**
 * 与路径操作相关的系统调用名。
 * 用途：**兜底**——即便某个底层错误码没在上面显式映射，只要它出自路径类 syscall，
 * 也一律翻译成 INVALID_PATH(400)，避免"路径太长/非法"再次变成 500。
 */
const PATH_SYSCALLS = new Set([
  'realpath',
  'stat',
  'lstat',
  'fstat',
  'readdir',
  'scandir',
  'opendir',
  'open',
  'access',
  'readlink',
  'mkdir',
  'rename',
]);

export class ApiError extends Error {
  /**
   * @param {string} code shared/error-codes.js 里的错误码
   * @param {string} [message] 给人看的说明（不给则用契约里的中文文案）
   * @param {object|null} [details] 机器可读的附加信息
   */
  constructor(code, message = '', details = null) {
    const safeCode = isErrorCode(code) ? code : ERROR_CODES.INTERNAL_ERROR;
    super(message || errorCodeMeta(safeCode).label);
    this.name = 'ApiError';
    this.code = safeCode;
    this.details = details;
    // 标记为非预期错误（用于日志级别判断）
    this.expected = true;
  }
}

/** 语法糖：throw apiError('PATH_NOT_FOUND', '...', {path}) */
export function apiError(code, message, details = null) {
  return new ApiError(code, message, details);
}

/**
 * 任意异常 → ApiError。
 * 已经是 ApiError 的原样返回；系统错误按表翻译；其余归 INTERNAL_ERROR（保留 cause 便于排查）。
 *
 * 安全：对外可见的 message **绝不携带本机绝对路径与内部细节**——
 * Node 系统错误的原始 message 里通常带 `realpath '<绝对路径>'`，直接透出等于把存储根布局
 * 告诉任何已登录客户端。因此这里只保留 syscall（如 realpath）作为排障线索，路径不进 message。
 */
/** 标 expected=true 的错误：属于调用方造成的可预期失败，不写内部堆栈 */
function expectedError(code, details) {
  const mapped = new ApiError(code, undefined, details);
  mapped.expected = true;
  return mapped;
}

/**
 * 系统错误码 → 契约错误（不为认知的错误返回 null，由调用方继续兜底）。
 * @returns {ApiError|null}
 */
function mapSystemError(error) {
  const systemCode = error && error.code;
  if (typeof systemCode !== 'string') return null;
  if (SYSTEM_ERROR_MAP[systemCode]) {
    return expectedError(SYSTEM_ERROR_MAP[systemCode], { syscall: error.syscall || null });
  }
  // 未映射的路径类 syscall：按"路径非法"处理（4xx），不要变成 500
  if (PATH_SYSCALLS.has(error && error.syscall)) {
    return expectedError(ERROR_CODES.INVALID_PATH, { syscall: error.syscall, sys: systemCode });
  }
  return null;
}

export function toApiError(error) {
  if (error instanceof ApiError) return error;

  const mappedSystem = mapSystemError(error);
  if (mappedSystem) return mappedSystem;

  // Fastify 自带校验错误（如 body 结构不对）
  if (error && error.validation) {
    return new ApiError(ERROR_CODES.VALIDATION_FAILED, error.message, { validation: error.validation });
  }
  if (error && typeof error.statusCode === 'number' && error.statusCode === 400) {
    return new ApiError(ERROR_CODES.BAD_REQUEST, '请求格式不正确');
  }

  // 兜底：内部错误对外只给通用文案（真实原因写日志，靠 traceId 关联）
  const internal = new ApiError(ERROR_CODES.INTERNAL_ERROR, undefined, null);
  internal.expected = false;
  internal.cause = error;
  return internal;
}

/** 契约的 error 载荷 */
export function errorPayload(error) {
  const apiErr = toApiError(error);
  const payload = {
    code: apiErr.code,
    message: apiErr.message || errorCodeMeta(apiErr.code).label,
  };
  if (apiErr.details) payload.details = apiErr.details;
  return payload;
}

/** HTTP 状态：优先契约里的映射，缺省 500 */
export function httpStatusOfError(error) {
  const meta = errorCodeMeta(toApiError(error).code);
  return meta.http || 500;
}

export { ERROR_CODES };
