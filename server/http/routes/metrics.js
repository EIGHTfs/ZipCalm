// 性能指标端点（docs/M0/API规范.md §4.6）
//
// - GET /metrics/snapshot        最新一帧（前端 2 秒轮询这一支）
// - GET /metrics/history?window=300&step=5  最近窗口内的降采样样本
//
// 约束（docs/07 §四）：只暴露 6 张卡片对应的字段，不堆砌指标。
// 兼容性：/proc 缺失时字段为 null（接口照常 200，前端显示"—"），绝不因为采集不到而 500。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/** 历史窗口上限（秒）：契约 §4.6 说明环形缓冲只保留最近 5 分钟 */
const MAX_HISTORY_WINDOW_SECONDS = 300;
/** 默认与最小步长（秒） */
const DEFAULT_STEP_SECONDS = 5;
const MIN_STEP_SECONDS = 1;

/** 查询参数 → 正整数（非法值回退默认，不抛错） */
function positiveInt(raw, fallback) {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function metricsRoutes(app) {
  app.get('/metrics/snapshot', { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (!app.metrics) throw apiError(ERROR_CODES.SERVICE_UNAVAILABLE, '指标采集尚未就绪');
    reply.ok(app.metrics.snapshot());
  });

  app.get('/metrics/history', { preHandler: [app.requireAuth] }, async (request, reply) => {
    if (!app.metrics) throw apiError(ERROR_CODES.SERVICE_UNAVAILABLE, '指标采集尚未就绪');
    const query = request.query || {};
    const windowSeconds = Math.min(MAX_HISTORY_WINDOW_SECONDS, positiveInt(query.window, MAX_HISTORY_WINDOW_SECONDS));
    const stepSeconds = Math.max(MIN_STEP_SECONDS, positiveInt(query.step, DEFAULT_STEP_SECONDS));
    reply.ok({ samples: app.metrics.history({ window: windowSeconds, step: stepSeconds }) });
  });
}
