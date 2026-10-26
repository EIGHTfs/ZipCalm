// ZipCalm 错误码枚举（前后端共用的唯一来源）
//
// 依据：docs/M0/API规范.md §八「错误码枚举」——逐项对齐，不新增、不改语义。
// 为什么要集中在 shared/：契约要求「所有 code 同时写入 server/lib/errors.js 与
// shared/error-codes.js，两端 import 同一份」，否则会出现「后端返回 DISK_FULL、
// 前端不认识」的漂移（docs/12 §四）。
//
// 特例：INTERRUPTED / ABORTED 是「任务内专用码」，只出现在任务对象的 error.code
// 里，HTTP 层不返回（见 API 规范 §八「任务内专用码」）。

// 错误码字面量枚举：使用处一律 ERROR_CODES.XXX，禁止手写裸字符串
export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_PATH: 'INVALID_PATH',
  PATH_OUT_OF_ROOT: 'PATH_OUT_OF_ROOT',
  PATH_NOT_FOUND: 'PATH_NOT_FOUND',
  NOT_A_DIRECTORY: 'NOT_A_DIRECTORY',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_CONFLICT: 'TASK_CONFLICT',
  TASK_NOT_CANCELLABLE: 'TASK_NOT_CANCELLABLE',
  INVALID_STATE: 'INVALID_STATE',
  TARGET_EXISTS: 'TARGET_EXISTS',
  CROSS_DEVICE_UNSUPPORTED: 'CROSS_DEVICE_UNSUPPORTED',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  FORMAT_UNAVAILABLE: 'FORMAT_UNAVAILABLE',
  DISK_FULL: 'DISK_FULL',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  ARCHIVE_CORRUPTED: 'ARCHIVE_CORRUPTED',
  ALL_SOURCES_SKIPPED: 'ALL_SOURCES_SKIPPED',
  SCAN_LIMIT_EXCEEDED: 'SCAN_LIMIT_EXCEEDED',
  RANGE_NOT_SATISFIABLE: 'RANGE_NOT_SATISFIABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INTERRUPTED: 'INTERRUPTED',
  ABORTED: 'ABORTED',
  // 加密压缩包解压（docs/19 §七 P4）：三态必须区分，密码错 ≠ 文件损坏
  MISSING_PASSWORD: 'MISSING_PASSWORD',
  BAD_PASSWORD: 'BAD_PASSWORD',
  SEVENZIP_MISSING: 'SEVENZIP_MISSING',
});

// 数组形态：便于做「码是否在全集内」的校验与遍历
export const ERROR_CODE_VALUES = Object.freeze(Object.values(ERROR_CODES));

// 每个码的元信息：HTTP 状态 + 中文提示 + 是否建议重试（http=null 表示不落到 HTTP 层）
export const ERROR_CODE_META = Object.freeze({
  [ERROR_CODES.BAD_REQUEST]: { http: 400, label: '请求格式错误', retryable: false },
  [ERROR_CODES.VALIDATION_FAILED]: { http: 400, label: '字段校验失败', retryable: false },
  [ERROR_CODES.INVALID_PATH]: { http: 400, label: '路径格式非法', retryable: false },
  [ERROR_CODES.PATH_OUT_OF_ROOT]: { http: 403, label: '路径超出可访问范围', retryable: false },
  [ERROR_CODES.PATH_NOT_FOUND]: { http: 404, label: '路径不存在', retryable: false },
  [ERROR_CODES.NOT_A_DIRECTORY]: { http: 400, label: '目标不是目录', retryable: false },
  [ERROR_CODES.PERMISSION_DENIED]: { http: 403, label: '没有访问权限', retryable: false },
  [ERROR_CODES.AUTH_REQUIRED]: { http: 401, label: '需要登录', retryable: false },
  [ERROR_CODES.AUTH_INVALID]: { http: 401, label: '凭据无效', retryable: false },
  [ERROR_CODES.AUTH_EXPIRED]: { http: 401, label: '登录已过期', retryable: false },
  [ERROR_CODES.FORBIDDEN]: { http: 403, label: '策略拒绝', retryable: false },
  [ERROR_CODES.TASK_NOT_FOUND]: { http: 404, label: '任务不存在', retryable: false },
  [ERROR_CODES.TASK_CONFLICT]: { http: 409, label: '路径正被其他任务使用', retryable: false },
  [ERROR_CODES.TASK_NOT_CANCELLABLE]: { http: 409, label: '当前状态不可取消', retryable: false },
  [ERROR_CODES.INVALID_STATE]: { http: 409, label: '当前状态不允许该操作', retryable: false },
  [ERROR_CODES.TARGET_EXISTS]: { http: 409, label: '目标已存在（不会覆盖）', retryable: false },
  [ERROR_CODES.CROSS_DEVICE_UNSUPPORTED]: { http: 409, label: '不支持跨分区移动', retryable: false },
  [ERROR_CODES.UNSUPPORTED_FORMAT]: { http: 400, label: '不支持的压缩格式', retryable: false },
  [ERROR_CODES.FORMAT_UNAVAILABLE]: { http: 503, label: '该格式当前不可用', retryable: false },
  [ERROR_CODES.DISK_FULL]: { http: 507, label: '磁盘空间不足', retryable: true },
  [ERROR_CODES.QUOTA_EXCEEDED]: { http: 507, label: '已达到存储配额', retryable: true },
  [ERROR_CODES.VERIFY_FAILED]: { http: 422, label: '压缩包校验未通过', retryable: false },
  [ERROR_CODES.ARCHIVE_CORRUPTED]: { http: 422, label: '压缩包无法解析', retryable: false },
  [ERROR_CODES.ALL_SOURCES_SKIPPED]: { http: 422, label: '没有可压缩的文件', retryable: false },
  [ERROR_CODES.SCAN_LIMIT_EXCEEDED]: { http: 400, label: '扫描条目超出上限', retryable: false },
  [ERROR_CODES.RANGE_NOT_SATISFIABLE]: { http: 416, label: '请求区间超出文件大小', retryable: false },
  [ERROR_CODES.NOT_IMPLEMENTED]: { http: 501, label: '该功能尚未实现', retryable: false },
  [ERROR_CODES.SERVICE_UNAVAILABLE]: { http: 503, label: '服务暂不可用', retryable: true },
  [ERROR_CODES.RATE_LIMITED]: { http: 429, label: '请求过于频繁', retryable: true },
  [ERROR_CODES.INTERNAL_ERROR]: { http: 500, label: '服务内部错误', retryable: false },
  [ERROR_CODES.INTERRUPTED]: { http: null, label: '服务重启导致任务中断', retryable: true, taskOnly: true },
  [ERROR_CODES.ABORTED]: { http: null, label: '任务已取消', retryable: false, taskOnly: true },
  [ERROR_CODES.MISSING_PASSWORD]: { http: 422, label: '该压缩包已加密，请输入密码', retryable: true },
  [ERROR_CODES.BAD_PASSWORD]: { http: 422, label: '密码错误', retryable: true },
  [ERROR_CODES.SEVENZIP_MISSING]: { http: 503, label: '当前环境缺少 7z，无法解压 AES-256 加密包', retryable: false },
});

// 任务内专用码：UI 只在任务对象上遇见它们，不要拿去和 HTTP 状态做映射
export const TASK_ONLY_ERROR_CODES = Object.freeze([
  ERROR_CODES.INTERRUPTED,
  ERROR_CODES.ABORTED,
]);

// 判断一个字符串是否是契约内的错误码
export function isErrorCode(code) {
  return typeof code === 'string' && ERROR_CODE_VALUES.includes(code);
}

// 取错误码元信息；未知码回落 INTERNAL_ERROR，保证调用方永远拿到完整结构
export function errorCodeMeta(code) {
  return ERROR_CODE_META[code] || ERROR_CODE_META[ERROR_CODES.INTERNAL_ERROR];
}

// 错误码 → HTTP 状态（任务内专用码返回 null）
export function httpStatusOf(code) {
  return errorCodeMeta(code).http;
}

// 该错误是否建议用户重试（4xx 多数不可修正，5xx 中的三类可重试）
export function isRetryable(code) {
  return errorCodeMeta(code).retryable === true;
}
