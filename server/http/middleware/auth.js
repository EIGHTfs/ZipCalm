// 认证中间件：Session（Cookie）+ Bearer Token 双通道（docs/M0/API规范.md §二）
//
// 行为：
// - onRequest 阶段"尽力认证"：有凭据就校验，通过则挂 request.auth，不通过则记下失败原因（不在这里抛错，
//   让公开端点（登录/健康检查）照常工作；受保护端点由 requireAuth 抛错）。
// - Bearer 优先于 Cookie（契约）。
// - Session 命中滑动续期阈值时重发 Cookie（对齐"7 天滑动续期"）。
// - 失败原因区分：完全没带 → AUTH_REQUIRED；带了但无效/过期 → AUTH_INVALID / AUTH_EXPIRED。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/** 从 Authorization 头里取 Bearer token */
function readBearer(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function registerAuth(app, { store, config }) {
  app.decorateRequest('auth', null);
  app.decorateRequest('authFailure', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('sessionRenewed', null);
  /** 是否需要在响应里补发会话 Cookie（见 onRequest 里 Bearer 分支的说明） */
  app.decorateRequest('needsSessionMint', false);

  app.addHook('onRequest', async (request) => {
    const bearer = readBearer(request);
    if (bearer) {
      applyBearerAuth(request, store, config, bearer); // ① Bearer 优先
      return;
    }
    applySessionCookie(request, store, config); // ② Cookie 兜底
  });

  /**
   * 受保护路由的 preHandler。
   * 注意：Session 续期需要"写 Cookie"，所以放在这里（只有真正访问受保护端点时才续期）。
   */
  app.decorate('requireAuth', async function requireAuth(request, reply) {
    assertAuthenticated(request);
    renewSessionCookie(request, reply, config, store);
  });

  // ===== Cookie 助手（统一 HttpOnly / SameSite=Lax，契约 §二）=====

  app.decorate('setSessionCookie', (reply, sid, ttlMs) => setSessionCookie(reply, config, sid, ttlMs));
  app.decorate('clearSessionCookie', (reply) => reply.clearCookie(config.cookieName, { path: '/' }));
}

/** 取会话 Cookie 的值（没装 cookie 插件或没带该 Cookie 时返回 null） */
function readSessionCookie(request, config) {
  return request.cookies ? request.cookies[config.cookieName] : null;
}

/**
 * ① Bearer 分支（优先）。
 * Bearer 通过时仍看一眼 Cookie：能验证就复用（并给滑动续期机会）；
 * 带了却验证不过（典型：服务重启后内存 session 失效）→ 标记补发新会话 Cookie。
 * 为什么必须补：EventSource 无法携带 Authorization 头，浏览器里 SSE 只能靠 Cookie ——
 * 不补的话重启后 SSE 会一直 401，而其余 axios 请求因为有 Bearer 照常工作（表象极具迷惑性）。
 */
function applyBearerAuth(request, store, config, bearer) {
  const record = store.verifyToken(bearer);
  if (!record) {
    request.authFailure = ERROR_CODES.AUTH_INVALID;
    return;
  }
  request.auth = { type: 'bearer', user: record.user, expiresAt: record.expiresAt };

  const cookieValue = readSessionCookie(request, config);
  if (!cookieValue) return;
  const session = store.verifySession(cookieValue);
  if (session) {
    request.sessionId = cookieValue;
    request.sessionRenewed = session.renewed;
    return;
  }
  request.needsSessionMint = true;
}

/** ② Cookie 兜底：验证不过时区分"已过期"与"未带凭据"（前端据此决定是提示重登还是跳登录页） */
function applySessionCookie(request, store, config) {
  const cookieValue = readSessionCookie(request, config);
  if (!cookieValue) {
    request.authFailure = ERROR_CODES.AUTH_REQUIRED;
    return;
  }
  const session = store.verifySession(cookieValue);
  if (!session) {
    request.authFailure = ERROR_CODES.AUTH_EXPIRED;
    return;
  }
  request.auth = { type: 'session', user: session.user, expiresAt: session.expiresAt };
  request.sessionId = cookieValue;
  request.sessionRenewed = session.renewed;
}

/** 未认证就抛契约错误（早返回：把后续的续期/补发逻辑从 if 里解放出来） */
function assertAuthenticated(request) {
  if (request.auth) return;
  const code = request.authFailure || ERROR_CODES.AUTH_REQUIRED;
  throw apiError(code, code === ERROR_CODES.AUTH_REQUIRED ? '需要登录后才能访问' : '登录凭据无效或已过期');
}

/** 需要续期/补发时才写 Cookie（Session 续期与 Bearer 补发共用同一个出口） */
function renewSessionCookie(request, reply, config, store) {
  if (request.auth.type === 'session' && request.sessionRenewed && request.sessionId) {
    setSessionCookie(reply, config, request.sessionId, store.sessionTtlMs);
    return;
  }
  // Bearer 通过但客户端带着失效的会话 Cookie → 补发一次（只补一次：新 Cookie 下次即可验证通过）
  if (request.auth.type === 'bearer' && request.needsSessionMint) {
    const session = store.createSession(request.auth.user);
    setSessionCookie(reply, config, session.sid, store.sessionTtlMs);
  }
}

/** 写会话 Cookie（统一属性；放模块级，避免在注册函数里再嵌一层函数） */
function setSessionCookie(reply, cfg, sid, ttlMs) {
  reply.setCookie(cfg.cookieName, sid, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // 生产环境走 HTTPS 时应置 true；本机/局域网 HTTP 场景保持 false，否则浏览器不回传
    secure: false,
    maxAge: Math.floor(ttlMs / 1000),
  });
}
