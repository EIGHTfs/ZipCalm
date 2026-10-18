// 前端常量（docs/12 §三 web/src/constants/index.js）
//
// 硬规则：**枚举一律从 shared/ 转出，这里不重复定义**（验收标准第 5 条：
// 前端无硬编码枚举字面量）。本文件只放「纯前端」的常量（应用名、路由、视图模式等）。

// ===== 从 shared/ 转出（唯一来源，两端一致）=====
export {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  ERROR_CODE_META,
  TASK_ONLY_ERROR_CODES,
  isErrorCode,
  errorCodeMeta,
  httpStatusOf,
  isRetryable,
} from '@shared/error-codes.js';

export {
  TASK_STATUS,
  TASK_STATUS_VALUES,
  TASK_STATUS_LABELS,
  TASK_TERMINAL_STATUSES,
  TASK_CANCELLABLE_STATUSES,
  TASK_RETRYABLE_STATUSES,
  isTaskStatus,
  isTerminalStatus,
  isCancellableStatus,
  isRetryableStatus,
  taskStatusLabel,
  taskStatusTone,
} from '@shared/task-status.js';

export {
  TASK_PHASE,
  TASK_PHASE_ORDER,
  TASK_PHASE_VALUES,
  TASK_PHASE_LABELS,
  isTaskPhase,
  isCancellablePhase,
  taskPhaseLabel,
  taskPhaseIndex,
} from '@shared/task-phase.js';

export {
  COMPRESS_MODE,
  COMPRESS_MODE_VALUES,
  COMPRESS_MODE_DEFAULT,
  COMPRESS_MODE_LABELS,
  COMPRESS_MODE_HINTS,
  isCompressMode,
  compressModeLabel,
} from '@shared/compress-modes.js';

export {
  FORMAT_IDS,
  FORMATS,
  FORMAT_VALUES,
  FORMAT_DEFAULT,
  isFormatId,
  getFormat,
  getFormatExt,
  getFormatMime,
  getFormatIdByExt,
} from '@shared/format-list.js';

// ===== 应用级常量 =====

export const APP_NAME = 'ZipCalm';
export const APP_NAME_ZH = '压压惊';
export const APP_TAGLINE = '浏览 · 压缩 · 看板';
// 版本号与 server 共用 shared/app-version.js 一处定义（改一处两侧同步）
export { APP_VERSION } from '@shared/app-version.js';

// hash 路由表（docs/09 §七：URL 不为 APK 服务，Web 用 hash，状态从 API 拉）
export const ROUTES = Object.freeze({
  FILES: '/files',
  TASKS: '/tasks',
  METRICS: '/metrics',
  HARDLINK: '/hardlink',
  SETTINGS: '/settings',
  LOGIN: '/login',
});

export const DEFAULT_ROUTE = ROUTES.FILES;
export const LOGIN_ROUTE = ROUTES.LOGIN;

// 视图模式（docs/08 §二：默认列表视图，网格留给缩略图场景）
export const VIEW_MODE = Object.freeze({
  LIST: 'list',
  GRID: 'grid',
});

export const VIEW_MODES = Object.freeze(Object.values(VIEW_MODE));

export const VIEW_MODE_LABELS = Object.freeze({
  [VIEW_MODE.LIST]: '列表',
  [VIEW_MODE.GRID]: '网格',
});

// 看板轮询间隔：docs/07 §二「前端 2 秒轮询一次」（M7 接入，这里先冻结常量）
export const METRICS_POLL_MS = 2000;

// 任务列表轮询兜底间隔：docs/09 约定 3 的 SSE 降级方案
export const TASK_FALLBACK_POLL_MS = 1000;
