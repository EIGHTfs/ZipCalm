// 认证存储（M1）：Session + Bearer 双通道
//
// 契约（docs/M0/API规范.md §二）：
// - Session：HttpOnly Cookie `zc_session`，7 天**滑动续期**；
// - Bearer：`Authorization: Bearer <token>`，30 天；
// - 两者同时存在时 **Bearer 优先**；
// - 凭据只存哈希（sha256），磁盘上不出现明文（INV-16）。
//
// 会话放内存（重启即失效，属可接受语义）；Bearer token 落盘持久化，
// 这样 APK/脚本重启服务后仍可用（数据模型 §六 storage/auth-tokens.json）。

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../../lib/atomic-json.js';
import { randomToken, sha256 } from './password.js';

/** 滑动续期阈值：剩余时间低于 TTL 的一半时才重新签发 Cookie（避免每个请求都 Set-Cookie） */
const RENEW_THRESHOLD_RATIO = 0.5;

export function createAuthStore({ config, logger, dataDir }) {
  const sessionTtlMs = config.sessionTtlMs;
  const tokenTtlMs = config.tokenTtlMs;
  const username = config.username;
  const tokenFilePath = path.join(dataDir, 'auth-tokens.json');

  /** Map<sha256(sid), {user, expiresAt, issuedAt, lastSeenAt}> */
  const sessions = new Map();
  /** Map<sha256(token), {user, expiresAt, issuedAt}> */
  const tokens = new Map();
  /** 登录失败计数：Map<ip, {count, firstAt}> */
  const loginFailures = new Map();

  let persistTimer = null;

  // ===== 持久化（只存哈希 + 过期时间）=====

  /** 一条落盘 token 是否还能用（字段合法 + 未过期）；不合法/过期一律丢弃 */
  function isUsableToken(tokenEntry, nowTs) {
    if (!tokenEntry || typeof tokenEntry.hash !== 'string' || typeof tokenEntry.expiresAt !== 'number') return false;
    return tokenEntry.expiresAt > nowTs;
  }

  /** 把落盘记录灌进内存索引（过期与不合法条目直接跳过） */
  function restoreTokens(entries, nowTs) {
    for (const tokenEntry of entries) {
      if (!isUsableToken(tokenEntry, nowTs)) continue;
      tokens.set(tokenEntry.hash, {
        user: tokenEntry.user || username,
        expiresAt: tokenEntry.expiresAt,
        issuedAt: tokenEntry.issuedAt || nowTs,
      });
    }
  }

  async function load() {
    const storedTokens = await readJson(tokenFilePath, { tokens: [] });
    if (!storedTokens.ok) {
      if (storedTokens.reason !== 'not-found') {
        logger.warn('auth token store unreadable, starting empty', { reason: storedTokens.reason });
      }
      return;
    }
    const entries = Array.isArray(storedTokens.data && storedTokens.data.tokens) ? storedTokens.data.tokens : [];
    restoreTokens(entries, Date.now());
    if (tokens.size > 0) logger.info('auth tokens restored', { count: tokens.size });
  }

  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persist().catch((error) => logger.error('persist auth tokens failed', { error: error.message }));
    }, 50);
    if (typeof persistTimer.unref === 'function') persistTimer.unref();
  }

  async function persist() {
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      tokens: [...tokens.entries()].map(([hash, value]) => ({
        hash, // sha256(token)：磁盘上无法反推出可登录明文
        user: value.user,
        issuedAt: value.issuedAt,
        expiresAt: value.expiresAt,
      })),
    };
    await writeJsonAtomic(tokenFilePath, payload);
  }

  /**
   * 立即落盘（关停时调用）。
   * 为什么需要：签发 token 后走的是 50ms 节流；若进程在这 50ms 内退出，
   * 刚发出的 token 就没落盘 —— 重启后拿着有效凭据的客户端会突然 401（实测踩过）。
   */
  async function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist();
  }

  // ===== Session =====

  function createSession(user = username) {
    const sid = randomToken(32);
    const now = Date.now();
    const expiresAt = now + sessionTtlMs;
    sessions.set(sha256(sid), { user, expiresAt, issuedAt: now, lastSeenAt: now });
    return { sid, expiresAt };
  }

  /**
   * 校验 Session；命中且已过续期阈值时返回 renewed=true（调用方据此重发 Cookie）。
   */
  function verifySession(sid) {
    if (!sid) return null;
    const key = sha256(sid);
    const session = sessions.get(key);
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt <= now) {
      sessions.delete(key);
      return null;
    }

    session.lastSeenAt = now;
    const remaining = session.expiresAt - now;
    let renewed = false;
    if (remaining < sessionTtlMs * RENEW_THRESHOLD_RATIO) {
      session.expiresAt = now + sessionTtlMs;
      renewed = true;
    }
    return { key, user: session.user, expiresAt: session.expiresAt, renewed };
  }

  function revokeSession(sid) {
    if (!sid) return false;
    return sessions.delete(sha256(sid));
  }

  // ===== Bearer Token =====

  function createToken(user = username) {
    const token = randomToken(32);
    const now = Date.now();
    const expiresAt = now + tokenTtlMs;
    tokens.set(sha256(token), { user, expiresAt, issuedAt: now });
    schedulePersist();
    return { token, expiresAt };
  }

  function verifyToken(token) {
    if (!token) return null;
    const key = sha256(token);
    const record = tokens.get(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      tokens.delete(key);
      schedulePersist();
      return null;
    }
    return { key, user: record.user, expiresAt: record.expiresAt };
  }

  function revokeToken(token) {
    const key = sha256(token);
    const existed = tokens.delete(key);
    if (existed) schedulePersist();
    return existed;
  }

  // ===== 登录失败限流（内存计数，够 M1 用）=====

  function isLoginBlocked(ip, limit) {
    const record = loginFailures.get(ip);
    if (!record) return false;
    if (Date.now() - record.firstAt > limit.windowMs) {
      loginFailures.delete(ip);
      return false;
    }
    return record.count >= limit.max;
  }

  function recordLoginFailure(ip, limit) {
    const now = Date.now();
    const record = loginFailures.get(ip);
    if (!record || now - record.firstAt > limit.windowMs) {
      loginFailures.set(ip, { count: 1, firstAt: now });
      return;
    }
    record.count += 1;
  }

  function clearLoginFailures(ip) {
    loginFailures.delete(ip);
  }

  // ===== 过期清理（定时器 unref，不阻止进程退出）=====

  function startCleanup() {
    const timer = setInterval(() => {
      const now = Date.now();
      let removedTokens = 0;
      for (const [key, value] of tokens) {
        if (value.expiresAt <= now) {
          tokens.delete(key);
          removedTokens += 1;
        }
      }
      for (const [key, value] of sessions) {
        if (value.expiresAt <= now) sessions.delete(key);
      }
      for (const [ip, record] of loginFailures) {
        if (now - record.firstAt > config.loginRateLimit.windowMs) loginFailures.delete(ip);
      }
      if (removedTokens > 0) {
        schedulePersist();
        logger.debug('expired auth tokens cleaned', { removedTokens });
      }
    }, 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  return {
    load,
    flush,
    sessionTtlMs,
    tokenTtlMs,
    createSession,
    verifySession,
    revokeSession,
    createToken,
    verifyToken,
    revokeToken,
    isLoginBlocked,
    recordLoginFailure,
    clearLoginFailures,
    startCleanup,
    /** 仅用于测试/诊断，不暴露明文 */
    stats: () => ({ sessions: sessions.size, tokens: tokens.size }),
  };
}
