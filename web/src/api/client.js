// HTTP 客户端封装（axios 实例 + 统一信封解包 + 错误码分支 + 双认证 + 401 钩子）
//
// 为什么集中在 client.js（docs/12 §三 web/src/api/ 是唯一网络出口）：
// 契约里所有响应都是 `{ ok, data, error }`（docs/M0/API规范.md §一），
// 所有失败都带机器可读的 code（§八）。把「解包 + 分支 + 鉴权 + 失效处理」收在一个地方，
// 页面只写 `const listing = await api.get('/fs/list', { path: '/' })`，不重复处理信封。
//
// 双认证（§二）：
// - Session：`withCredentials: true`，浏览器自动带 Cookie，前端不碰它；
// - Bearer：存在本地存储里的 token，由请求拦截器注入 `Authorization`；两者同时存在时 Bearer 优先。
//
// 401 钩子：命中 AUTH_REQUIRED / AUTH_INVALID / AUTH_EXPIRED 时调用注册的处理函数
// （main.js 注册 → 落 session store 状态；M1 有登录页后改为跳转登录），
// 调用方可用 `skipAuthHandler: true` 自行处理（例如主动调登录接口时）。

import axios from 'axios';

import { ERROR_CODES, isErrorCode, errorCodeMeta, httpStatusOf } from '@shared/error-codes.js';

// ===== 基础配置 =====

// API 前缀来自契约（/api/v1）；部署差异用 Vite 环境变量覆盖，不写死主机与端口
export const API_BASE = (import.meta.env && import.meta.env.VITE_API_BASE) || '/api/v1';

const TOKEN_STORAGE_KEY = 'zipcalm.auth.token';
const DEFAULT_TIMEOUT_MS = 15000;

// 判定「凭据失效」的三个码（docs/M0/API规范.md §八）
const AUTH_ERROR_CODES = [
  ERROR_CODES.AUTH_REQUIRED,
  ERROR_CODES.AUTH_INVALID,
  ERROR_CODES.AUTH_EXPIRED,
];

// HTTP 状态 → 错误码的兜底映射：只用于「响应不是契约信封」的情况
// （例如反向代理返回 HTML 错误页、网关 502）。值全部取自 shared/，不新增私有码。
/** 507 Insufficient Storage（WebDAV 扩展位；本项目用它表达"磁盘空间不足"） */
const HTTP_INSUFFICIENT_STORAGE = 507;
const HTTP_STATUS_FALLBACK = {
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.AUTH_REQUIRED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.PATH_NOT_FOUND,
  409: ERROR_CODES.INVALID_STATE,
  416: ERROR_CODES.RANGE_NOT_SATISFIABLE,
  422: ERROR_CODES.VERIFY_FAILED,
  429: ERROR_CODES.RATE_LIMITED,
  500: ERROR_CODES.INTERNAL_ERROR,
  501: ERROR_CODES.NOT_IMPLEMENTED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
  [HTTP_INSUFFICIENT_STORAGE]: ERROR_CODES.DISK_FULL,
};

// ===== 错误对象 =====

/**
 * 统一的 API 错误。
 * 字段与契约对齐：code 一定来自 shared/error-codes.js；details 为可选附加信息。
 */
export class ApiError extends Error {
  /**
   * @param {{code?: string, message?: string, details?: object|null, httpStatus?: number|null, network?: boolean}} init
   */
  constructor(init = {}) {
    const code = isErrorCode(init.code) ? init.code : ERROR_CODES.INTERNAL_ERROR;
    const meta = errorCodeMeta(code);
    super(init.message || meta.label);
    this.name = 'ApiError';
    this.code = code;
    this.details = init.details || null;
    this.httpStatus = init.httpStatus ?? httpStatusOf(code);
    this.retryable = meta.retryable === true;
    // network=true 表示请求根本没到服务端（断网/超时/被拦截），与业务错误区分开
    this.network = init.network === true;
    this.isAuthError = AUTH_ERROR_CODES.includes(code);
  }
}

export function isApiError(value) {
  return value instanceof ApiError;
}

// ===== 凭据存取（只存 Bearer；Cookie 由浏览器管理）=====

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null; // 隐私模式下 localStorage 可能抛错：降级为「无 token」，不影响 Cookie 通道
  }
}

export function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* 存不了就算了：Web 主通道是 Cookie */
  }
}

export function clearToken() {
  setToken(null);
}

// ===== 401 钩子 =====

let unauthorizedHandler = null;

/**
 * 注册「凭据失效」的统一处理（main.js 调用）。
 * @param {(info: {code: string, message: string, url: string}) => void} handler
 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null;
}

function notifyUnauthorized(error, url) {
  if (!unauthorizedHandler) return;
  try {
    unauthorizedHandler({ code: error.code, message: error.message, url });
  } catch (handlerError) {
    // 钩子自身出错不能覆盖原始错误
    console.error('[api] unauthorized 钩子执行失败：', handlerError);
  }
}

// ===== axios 实例 =====

const http = axios.create({
  baseURL: API_BASE,
  timeout: DEFAULT_TIMEOUT_MS,
  // Session 通道：让浏览器带上 zc_session Cookie
  withCredentials: true,
  headers: { Accept: 'application/json' },
});

// 请求拦截：注入 Bearer（双通道的第二条；与 Cookie 同时存在时服务端 Bearer 优先）
http.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// 响应拦截：统一信封解包 —— 成功直接给 data，失败抛 ApiError
http.interceptors.response.use(
  (response) => unwrapEnvelope(response),
  (error) => Promise.reject(toApiError(error)),
);

/**
 * 解包 `{ ok, data, error }`。
 * 返回 `payload.data`（页面拿到的就是业务数据，不用每次判 ok）。
 * 非契约信封（比如代理返回的 HTML）按 HTTP 状态映射成错误码。
 */
function unwrapEnvelope(response) {
  const { status, data, config } = response;

  // 二进制下载（blob/arraybuffer）不做信封解包
  if (config && (config.responseType === 'blob' || config.responseType === 'arraybuffer')) {
    return response;
  }

  if (data && typeof data === 'object' && typeof data.ok === 'boolean') {
    if (data.ok) return data.data;
    throw new ApiError({
      code: data.error && data.error.code,
      message: data.error && data.error.message,
      details: data.error && data.error.details,
      httpStatus: status,
    });
  }

  // 能走到这里说明响应不是契约格式：按状态码兜底，避免页面拿到 undefined
  throw new ApiError({
    code: HTTP_STATUS_FALLBACK[status] || ERROR_CODES.INTERNAL_ERROR,
    message: `响应不是契约信封（HTTP ${status}）`,
    httpStatus: status,
  });
}

/**
 * 把 axios 错误统一翻译成 ApiError。
 * - 有响应体且是契约信封 → 用信封里的 code
 * - 有响应体但不是信封 → 按 HTTP 状态映射
 * - 超时 / 断网 → SERVICE_UNAVAILABLE（网络类，retryable=true，network=true）
 */
function toApiError(error) {
  const url = (error.config && error.config.url) || '';
  const skipAuthHandler = Boolean(error.config && error.config.skipAuthHandler);

  let apiError;
  const response = error.response;

  if (response) {
    const payload = response.data;
    if (payload && typeof payload === 'object' && typeof payload.ok === 'boolean' && !payload.ok) {
      apiError = new ApiError({
        code: payload.error && payload.error.code,
        message: payload.error && payload.error.message,
        details: payload.error && payload.error.details,
        httpStatus: response.status,
      });
    } else {
      apiError = new ApiError({
        code: HTTP_STATUS_FALLBACK[response.status] || ERROR_CODES.INTERNAL_ERROR,
        message: `请求失败（HTTP ${response.status}）`,
        httpStatus: response.status,
      });
    }
  } else {
    // 没有响应：超时（ECONNABORTED/ETIMEDOUT）或网络不可达，都归到「服务暂不可用」
    const isTimeout = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    apiError = new ApiError({
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      message: isTimeout ? '请求超时' : '网络请求失败',
      details: { reason: error.code || 'NETWORK' },
      network: true,
    });
  }

  if (apiError.isAuthError && !skipAuthHandler) {
    notifyUnauthorized(apiError, url);
  }
  return apiError;
}

// ===== 对外 API =====

/**
 * 发请求并按信封解包。
 * @param {{method?: string, url: string, params?: object, data?: object, headers?: object, timeout?: number, responseType?: string, skipAuthHandler?: boolean, signal?: AbortSignal}} config
 * @returns {Promise<any>} data 部分
 */
export async function request(config) {
  return http.request({
    method: 'get',
    ...config,
  });
}

export const api = {
  request,

  /** GET，第二参数是查询串（已是对象形式，axios 会编码） */
  get(url, params, extra) {
    return request({ method: 'get', url, params, ...extra });
  },
  post(url, data, extra) {
    return request({ method: 'post', url, data, ...extra });
  },
  put(url, data, extra) {
    return request({ method: 'put', url, data, ...extra });
  },
  patch(url, data, extra) {
    return request({ method: 'patch', url, data, ...extra });
  },
  del(url, data, extra) {
    return request({ method: 'delete', url, data, ...extra });
  },

  /**
   * 下载（支持 Range，docs/09 约定 5）。
   * 返回 { blob, headers }：把响应头透出来，方便读取 Content-Range 做续传。
   * @param {string} path 相对存储根的 POSIX 路径
   * @param {{range?: {start: number, end?: number}, timeout?: number}} [options]
   */
  async download(path, options = {}) {
    const headers = {};
    if (options.range) {
      headers.Range = `bytes=${options.range.start}-${options.range.end ?? ''}`;
    }
    const response = await http.request({
      method: 'get',
      url: '/fs/download',
      params: { path },
      headers,
      responseType: 'blob',
      timeout: options.timeout || 0, // 大文件下载不限时（0 = 不超时）
    });
    return { blob: response.data, headers: response.headers };
  },
};

// 便于其它模块判断「这个错误是不是登录问题」（例如统一提示文案）
export { AUTH_ERROR_CODES };

export default api;
