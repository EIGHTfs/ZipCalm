// pinia store：登录态（F1 只做「未登录/凭据失效」的展示，M1 接入真实登录）
//
// 与后端契约的对应（docs/M0/API规范.md §二）：
// - 登录成功后后端同时下发 Session Cookie 与 Bearer Token；
// - Web 使用 Cookie（随请求自动携带），APK 使用 Token；
// - 凭据失效分三种错误码：AUTH_REQUIRED（没带）、AUTH_INVALID（无效）、AUTH_EXPIRED（过期），
//   客户端动作都是「先刷新 token，失败再跳登录」。F1 还没有登录页，因此只落状态、不跳转。

import { defineStore } from 'pinia';

import { ERROR_CODES } from '../constants/index.js';

export const useSessionStore = defineStore('session', {
  state: () => ({
    /** 是否已确认登录（M1 由 GET /api/v1/auth/me 的结果决定） */
    authenticated: false,
    userName: null,
    /** 凭据失效标记：为 true 时顶栏显示「登录已过期」，M1 起触发跳登录页 */
    expired: false,
    /** 最近一次判定失效的错误码，便于排查（只存码，不存凭据） */
    lastAuthErrorCode: null,
    /** 认证通道：'session' | 'bearer'，后端 /auth/me 返回 */
    authType: null,
  }),

  getters: {
    /** 顶栏徽标文案 */
    label: (state) => {
      if (state.authenticated) return state.userName || '已登录';
      if (state.expired) return '登录已过期';
      return '未登录';
    },
    /** 徽标色调：与 layout.css 的 .badge--* 对应 */
    tone: (state) => {
      if (state.authenticated) return 'ok';
      if (state.expired) return 'warn';
      return 'muted';
    },
    /** 供模板拼接 class 用，例如 badge--warn */
    badgeClass() {
      return `badge--${this.tone}`;
    },
  },

  actions: {
    setAuthenticated(user, authType) {
      this.authenticated = true;
      this.userName = (user && user.name) || null;
      this.authType = authType || null;
      this.expired = false;
      this.lastAuthErrorCode = null;
    },
    /** 401 统一钩子（main.js 注册进 api/client.js）落状态 */
    markUnauthorized(info) {
      this.authenticated = false;
      this.userName = null;
      this.authType = null;
      this.expired = true;
      this.lastAuthErrorCode = info && info.code ? info.code : ERROR_CODES.AUTH_REQUIRED;
    },
    clear() {
      this.authenticated = false;
      this.userName = null;
      this.authType = null;
      this.expired = false;
      this.lastAuthErrorCode = null;
    },
  },
});
