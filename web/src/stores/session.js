// pinia store：登录态（M1 起是**真实**登录态，不再是占位）
//
// 与后端契约的对应（docs/M0/API规范.md §二 / §4.1）：
// - 登录一次性返回 Session Cookie 与 Bearer Token；Web 主用 Cookie（浏览器自动携带），
//   同时把 token 存下来作为兜底通道（client.js 的请求拦截器会自动注入）；
// - 401 分 AUTH_REQUIRED / AUTH_INVALID / AUTH_EXPIRED，统一由 client.js 的钩子回调到这里；
// - 启动时调 GET /auth/me 确认登录态（不弹错、不报"过期"，只是判断要不要跳登录页）。

import { defineStore } from 'pinia';

import { api, clearToken, setToken } from '../api/client.js';
import { ERROR_CODES } from '../constants/index.js';

export const useSessionStore = defineStore('session', {
  state: () => ({
    /** 是否已确认登录（由 /auth/me 或登录成功决定） */
    authenticated: false,
    userName: null,
    /** 凭据失效标记：为 true 时顶栏显示「登录已过期」 */
    expired: false,
    /** 最近一次判定失效的错误码，便于排查（只存码，不存凭据） */
    lastAuthErrorCode: null,
    /** 认证通道：'session' | 'bearer'，后端 /auth/me 返回 */
    authType: null,
    /** 是否正在做启动期登录态探测 */
    checking: false,
  }),

  getters: {
    label: (state) => {
      if (state.authenticated) return state.userName || '已登录';
      if (state.expired) return '登录已过期';
      return '未登录';
    },
    tone: (state) => {
      if (state.authenticated) return 'ok';
      if (state.expired) return 'warn';
      return 'muted';
    },
    badgeClass() {
      return `badge--${this.tone}`;
    },
  },

  actions: {
    setAuthenticated(user, authType) {
      this.authenticated = true;
      this.userName = (user && user.name) || this.userName;
      this.authType = authType || this.authType;
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

    /**
     * 登录（POST /auth/login）。
     * 失败时把 ApiError 原样抛给页面（页面负责展示 code + message）。
     */
    async login(username, password) {
      // skipAuthHandler：登录失败的 401 由本页自己展示（错误码 + 文案），
      // 不应触发全局"凭据失效"钩子，否则顶栏会被误标成「登录已过期」。
      const data = await api.post('/auth/login', { username, password }, { skipAuthHandler: true });
      if (data && data.token) setToken(data.token);
      this.setAuthenticated((data && data.user) || { name: username }, 'session');
      return data;
    },

    /** 登出（POST /auth/logout）；本地状态无论如何都清干净 */
    async logout() {
      try {
        await api.post('/auth/logout', {});
      } catch {
        // 忽略：服务端可能已失效，本地清态即可
      }
      clearToken();
      this.clear();
    },

    /**
     * 启动期确认登录态。
     * 用 skipAuthHandler 避免"未登录"被当成"登录已过期"而弹提示/跳转。
     * @returns {Promise<boolean>} 是否已登录
     */
    async ensureLoaded() {
      this.checking = true;
      try {
        const data = await api.get('/auth/me', undefined, { skipAuthHandler: true });
        this.setAuthenticated((data && data.user) || null, data && data.authType);
        return true;
      } catch (error) {
        if (error && error.isAuthError) {
          // 未登录属正常情况：静默清态，由路由守卫送到登录页
          this.authenticated = false;
          this.userName = null;
          this.authType = null;
          this.expired = false;
          return false;
        }
        throw error;
      } finally {
        this.checking = false;
      }
    },
  },
});
