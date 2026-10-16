// 统一错误处理 + 统一响应信封（docs/M0/API规范.md §一 / §八）
//
// 三条硬规则：
// 1. 所有响应都是 { ok, data, error }（成功 error=null，失败 data=null）；
// 2. 错误码一律来自 shared/error-codes.js，HTTP 状态由契约元信息决定（不自造映射）；
// 3. 5xx 记 error 级日志并带 traceId，4xx 记 warn 级（便于排查又不吵）。

import crypto from 'node:crypto';

import { ERROR_CODES, errorPayload, httpStatusOfError, toApiError } from '../../lib/errors.js';

export function registerErrorHandling(app, { logger }) {
  // 成功响应助手：reply.ok(data) —— 业务代码永远不手写 { ok:true, ... }
  app.decorateReply('ok', function sendOk(data, statusCode = 200) {
    this.code(statusCode).send({ ok: true, data: data === undefined ? null : data, error: null });
  });

  // 404（路由不存在）也必须是契约信封
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      ok: false,
      data: null,
      error: {
        code: ERROR_CODES.PATH_NOT_FOUND,
        message: `接口不存在：${request.method} ${request.url.split('?')[0]}`,
      },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = toApiError(error);
    const statusCode = httpStatusOfError(apiError);
    const traceId = request.id || crypto.randomUUID();

    const logContext = {
      traceId,
      method: request.method,
      url: request.url.split('?')[0],
      statusCode,
      code: apiError.code,
    };
    if (statusCode >= 500) {
      logger.error('request failed', { ...logContext, error: apiError.message, stack: apiError.cause ? String(apiError.cause.stack || '').split('\n').slice(0, 3).join(' | ') : undefined });
    } else {
      logger.warn('request rejected', { ...logContext, error: apiError.message });
    }

    const payload = errorPayload(apiError);
    // 5xx 附带 traceId，方便对着日志查（不泄漏堆栈）
    if (statusCode >= 500) payload.details = { ...(payload.details || {}), traceId };

    reply.code(statusCode).send({ ok: false, data: null, error: payload });
  });
}
