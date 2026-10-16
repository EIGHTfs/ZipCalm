// 认证路由（docs/M0/API规范.md §4.1）
//
// 端点：login / logout / me / token/refresh
// 要点：
// - 登录一次同时下发 Session Cookie 与 Bearer Token（契约 §二）；
// - 密码只比对哈希（scrypt），明文永不落盘、不入日志；
// - 失败限流用内存计数（配置 auth.loginRateLimit）。
//
// 结构：每个端点的处理是模块级函数（接收 ctx），工厂只做路由注册 —— 这样单个函数短、可单测。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/** 请求体统一取成对象（Fastify 在无 body 时给 undefined） */
function bodyOf(request) {
  return request.body && typeof request.body === 'object' ? request.body : {};
}

/** 从 Authorization 头里取出 Bearer token 原文（没有则空串） */
function bearerTokenOf(request) {
  const header = request.headers.authorization || '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

/** POST /auth/login：校验 → 限流 → 比对 → 下发 session + token */
async function handleLogin(ctx, request, reply) {
  const { username, password } = bodyOf(request);

  if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'username 与 password 必填', { fields: ['username', 'password'] });
  }

  const ip = request.ip || 'unknown';
  if (ctx.store.isLoginBlocked(ip, ctx.config.loginRateLimit)) {
    throw apiError(ERROR_CODES.RATE_LIMITED, '登录失败次数过多，请稍后再试');
  }

  const usernameMatches = username === ctx.config.username;
  const passwordMatches = await ctx.verifyPassword(password);

  if (!usernameMatches || !passwordMatches) {
    ctx.store.recordLoginFailure(ip, ctx.config.loginRateLimit);
    // 不区分"用户名错"与"密码错"（避免账号枚举）
    throw apiError(ERROR_CODES.AUTH_INVALID, '用户名或密码错误');
  }

  ctx.store.clearLoginFailures(ip);

  const session = ctx.store.createSession(username);
  const token = ctx.store.createToken(username);
  ctx.app.setSessionCookie(reply, session.sid, ctx.store.sessionTtlMs);

  ctx.app.appLogger.info('login succeeded', { requestId: request.requestId, user: username, authType: 'session+bearer' });

  reply.ok({
    user: { name: username },
    token: token.token,
    tokenExpiresAt: token.expiresAt,
    sessionExpiresAt: session.expiresAt,
  });
}

/** POST /auth/logout：撤销当前会话（与 Bearer token），可选全设备下线；幂等 */
async function handleLogout(ctx, request, reply) {
  const body = bodyOf(request);

  if (request.sessionId) ctx.store.revokeSession(request.sessionId);
  if (request.auth && request.auth.type === 'bearer') {
    ctx.store.revokeToken(bearerTokenOf(request));
  }

  let revokedTokens = 0;
  if (body.allDevices === true) {
    revokedTokens = ctx.store.revokeAllTokens ? ctx.store.revokeAllTokens() : 0;
  }

  ctx.app.clearSessionCookie(reply);
  // 幂等：未登录调用也返回成功（API 规范 §4.1）
  reply.ok({ loggedOut: true, revokedTokens });
}

/** GET /auth/me：回显当前身份与过期时间 */
async function handleMe(request, reply) {
  reply.ok({
    user: { name: request.auth.user },
    authType: request.auth.type,
    expiresAt: request.auth.expiresAt,
  });
}

/** POST /auth/token/refresh：默认轮换（旧 token 立即失效） */
async function handleTokenRefresh(ctx, request, reply) {
  const body = bodyOf(request);
  const rotate = body.rotate !== false;

  if (rotate && request.auth.type === 'bearer') {
    ctx.store.revokeToken(bearerTokenOf(request));
  }

  const token = ctx.store.createToken(request.auth.user);
  reply.ok({ token: token.token, tokenExpiresAt: token.expiresAt });
}

export default async function authRoutes(app, options) {
  const ctx = {
    app,
    config: options.config,
    store: options.store,
    verifyPassword: options.verifyPassword,
  };

  app.post('/auth/login', (request, reply) => handleLogin(ctx, request, reply));
  app.post('/auth/logout', (request, reply) => handleLogout(ctx, request, reply));
  app.get('/auth/me', { preHandler: [app.requireAuth] }, (request, reply) => handleMe(request, reply));
  app.post('/auth/token/refresh', { preHandler: [app.requireAuth] }, (request, reply) => handleTokenRefresh(ctx, request, reply));
}
