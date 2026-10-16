// 请求日志（结构化 + 脱敏）
//
// 只记录「定位问题需要的最小信息」：requestId / method / path / status / 耗时 / 认证通道。
// **不记录**查询串原文（可能含 path 但更可能含将来出现的敏感参数）、不记录 Cookie/Authorization
// （lib/logger.js 的 redact 也会兜一层）。

import crypto from 'node:crypto';

export function registerRequestLogger(app, { logger }) {
  app.addHook('onRequest', async (request, reply) => {
    request.requestId = crypto.randomUUID();
    request.startAt = process.hrtime.bigint();
    reply.header('X-Request-Id', request.requestId);
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = request.startAt ? Number(process.hrtime.bigint() - request.startAt) / 1e6 : null;
    logger.info('request', {
      requestId: request.requestId,
      method: request.method,
      path: request.url.split('?')[0],
      status: reply.statusCode,
      durationMs: durationMs === null ? null : Number(durationMs.toFixed(1)),
      authType: request.auth ? request.auth.type : null,
    });
  });
}
