// 认证路由（docs/M0/API规范.md §4.1）
//
// 端点：login / logout / me / token/refresh
// 要点：
// - 登录一次同时下发 Session Cookie 与 Bearer Token（契约 §二）；
// - 密码只比对哈希（scrypt），明文永不落盘、不入日志；
// - 失败限流用内存计数（配置 auth.loginRateLimit）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

export default async function authRoutes(app, options) {
  const { config, store, verifyPassword: verifyPasswordFn } = options;

  app.post('/auth/login', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const { username, password } = body;

    if (typeof username !== 'string' || username.length === 0 || typeof password !== 'string' || password.length === 0) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'username 与 password 必填', { fields: ['username', 'password'] });
    }

    const ip = request.ip || 'unknown';
    if (store.isLoginBlocked(ip, config.loginRateLimit)) {
      throw apiError(ERROR_CODES.RATE_LIMITED, '登录失败次数过多，请稍后再试');
    }

    const usernameMatches = username === config.username;
    const passwordMatches = await verifyPasswordFn(password);

    if (!usernameMatches || !passwordMatches) {
      store.recordLoginFailure(ip, config.loginRateLimit);
      // 不区分"用户名错"与"密码错"（避免账号枚举）
      throw apiError(ERROR_CODES.AUTH_INVALID, '用户名或密码错误');
    }

    store.clearLoginFailures(ip);

    const session = store.createSession(username);
    const token = store.createToken(username);
    app.setSessionCookie(reply, session.sid, store.sessionTtlMs);

    app.appLogger.info('login succeeded', { requestId: request.requestId, user: username, authType: 'session+bearer' });

    reply.ok({
      user: { name: username },
      token: token.token,
      tokenExpiresAt: token.expiresAt,
      sessionExpiresAt: session.expiresAt,
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};

    if (request.sessionId) store.revokeSession(request.sessionId);
    if (request.auth && request.auth.type === 'bearer') {
      const header = request.headers.authorization || '';
      const token = header.replace(/^Bearer\s+/i, '').trim();
      store.revokeToken(token);
    }

    let revokedTokens = 0;
    if (body.allDevices === true) {
      revokedTokens = store.revokeAllTokens ? store.revokeAllTokens() : 0;
    }

    app.clearSessionCookie(reply);
    // 幂等：未登录调用也返回成功（API 规范 §4.1）
    reply.ok({ loggedOut: true, revokedTokens });
  });

  app.get('/auth/me', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok({
      user: { name: request.auth.user },
      authType: request.auth.type,
      expiresAt: request.auth.expiresAt,
    });
  });

  app.post('/auth/token/refresh', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const rotate = body.rotate !== false; // 默认轮换：旧 token 立即失效

    if (rotate && request.auth.type === 'bearer') {
      const header = request.headers.authorization || '';
      store.revokeToken(header.replace(/^Bearer\s+/i, '').trim());
    }

    const token = store.createToken(request.auth.user);
    reply.ok({ token: token.token, tokenExpiresAt: token.expiresAt });
  });
}
