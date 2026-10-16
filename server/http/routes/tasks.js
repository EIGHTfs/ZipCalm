// 任务端点（M3）：SSE 事件流 + 列表/详情/取消/重试/确认删除
//
// 契约：docs/M0/API规范.md §五（SSE 端点）+ §4.3（任务端点）
//
// SSE 实现要点（逐条对齐契约）：
// 1. 连接建立后**第一帧必是 snapshot**（INV-05：进度是状态不是消息，重连先拿快照）；
// 2. 先订阅后发快照：快照期间产生的事件先缓冲，避免"快照与增量之间丢事件"的竞态；
// 3. `since=<seq>` 续传：窗口内补发增量；窗口外（replaySince 返回 null）只靠快照兜底；
// 4. 心跳每 15s（防中间设备断连）；
// 5. 响应头带 `X-Accel-Buffering: no`（反代下不被缓冲）；
// 6. 连接结束（close/error）必须退订，防订阅者泄漏；
// 7. 连接登记进 `app.tasks.sseClients`：关停时统一 end()，否则优雅停止会超时（见 app.js preClose）。
//
// 结构：SSE 的每一步（接管响应 / 建帧写入器 / 缓冲订阅 / 首帧快照 / 续传补发 / 心跳）都是
// 一个模块级小函数，主 handler 只做编排。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

const DEFAULT_CHANNELS = ['tasks'];

/** 解析 channels 查询参数（默认 tasks；空值也回落默认） */
function parseChannels(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_CHANNELS;
  const channels = raw.split(',').map((item) => item.trim()).filter(Boolean);
  return channels.length > 0 ? channels : DEFAULT_CHANNELS;
}

/** 单帧序列化（SSE 报文格式；id 用 seq，便于 Last-Event-ID 续传） */
function frameToText(frame) {
  return `id: ${frame.seq}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

// ===== SSE 分步实现 =====

/** 接管原生响应并写响应头；返回 res（Fastify 的响应装饰不适用于流式响应） */
function hijackForSse(reply, request) {
  reply.hijack();
  const res = reply.raw;
  const socket = request.raw.socket;
  if (socket && typeof socket.setTimeout === 'function') socket.setTimeout(0); // SSE 不能被空闲超时掐断
  if (typeof res.setTimeout === 'function') res.setTimeout(0);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return res;
}

/** 帧写入器：连接已结束返回 false（事件总线据此自愈剔除订阅者） */
function createFrameWriter(res) {
  return (frame) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(frameToText(frame));
      return !res.writableEnded;
    } catch {
      return false;
    }
  };
}

/** 先订阅后发快照：快照完成前的事件先缓冲，activate() 后切换为直发 */
function subscribeBuffered(events, channels, writeFrame) {
  const buffered = [];
  let ready = false;
  const unsubscribe = events.subscribe({
    channels,
    send: (frame) => {
      if (ready) return writeFrame(frame);
      buffered.push(frame);
      return true;
    },
  });
  return {
    buffered,
    unsubscribe,
    activate: () => {
      ready = true;
    },
  };
}

/** 首帧快照；构造失败返回 null（调用方负责断开，绝不静默挂着连接） */
function sendSnapshotFrame(app, manager, events, writeFrame) {
  try {
    const seq = events.currentSeq();
    writeFrame({ seq, event: 'snapshot', data: { ...manager.snapshot(), seq } });
    return seq;
  } catch (error) {
    app.log.error('SSE 首帧快照构造失败，已断开连接', { error: error.message });
    return null;
  }
}

/** since 续传 + 缓冲补发（跳过快照已覆盖的 seq，按 seq 升序去重） */
function flushResumeFrames(events, since, snapshotSeq, buffered, writeFrame) {
  const seen = new Set();
  const replayed = Number.isInteger(since) ? events.replaySince(since) : null;
  for (const frame of replayed || []) {
    if (frame.seq <= snapshotSeq) continue; // 快照已覆盖的状态不再重发
    seen.add(frame.seq);
    writeFrame(frame);
  }
  const pending = [...buffered].filter((frame) => frame.seq > snapshotSeq).sort((a, b) => a.seq - b.seq);
  for (const frame of pending) {
    if (seen.has(frame.seq)) continue;
    writeFrame(frame);
  }
  buffered.length = 0;
}

/** 心跳定时器（连接已结束则走清理）；返回 interval 句柄，由 cleanup 负责清掉 */
function startHeartbeat(res, heartbeatMs, cleanup) {
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanup();
      return;
    }
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    } catch {
      cleanup();
    }
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  return heartbeat;
}

// ===== 端点 handler =====

/** GET /tasks/events —— SSE 事件流（首帧快照 + 增量 + 心跳 + seq/since 续传） */
async function handleTaskEvents(app, request, reply) {
  const { manager, events } = app.tasks;
  const heartbeatMs = app.m2.config.limits.sseHeartbeatMs;
  const channels = parseChannels(request.query.channels);

  const res = hijackForSse(reply, request);
  const writeFrame = createFrameWriter(res);
  const subscription = subscribeBuffered(events, channels, writeFrame);

  // ① 首帧：当前状态快照（契约铁律，无论是否带 since 都先发）
  const snapshotSeq = sendSnapshotFrame(app, manager, events, writeFrame);
  if (snapshotSeq === null) {
    subscription.unsubscribe();
    try {
      res.end();
    } catch {
      /* 连接可能已被对端关闭：忽略即可，不影响订阅者清理 */
    }
    return;
  }

  // ② since 续传 + ③ 缓冲补发，随后切换为直发
  const since = Number.parseInt(request.query.since, 10);
  flushResumeFrames(events, since, snapshotSeq, subscription.buffered, writeFrame);
  subscription.activate();

  // ④ 心跳与断开清理（登记 res，关停时由 app.preClose 统一 end()）
  let cleaned = false;
  let heartbeat = null;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (heartbeat) clearInterval(heartbeat);
    subscription.unsubscribe();
    app.tasks.sseClients.delete(res);
    app.log.info('SSE 订阅断开', { remaining: events.subscriberCount() });
  }
  app.tasks.sseClients.add(res);
  heartbeat = startHeartbeat(res, heartbeatMs, cleanup);

  request.raw.on('close', cleanup);
  request.raw.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);

  app.log.info('SSE 订阅建立', {
    channels,
    since: Number.isInteger(since) ? since : null,
    subscribers: events.subscriberCount(),
    snapshotSeq,
  });
}

/** GET /tasks —— 任务列表（内存非终态 + 历史缓存；契约 §六.5） */
async function handleTaskList(app, request, reply) {
  const rawStatus = request.query.status;
  const status = typeof rawStatus === 'string' && rawStatus.length > 0
    ? rawStatus.split(',').map((item) => item.trim()).filter(Boolean)
    : null;
  const limit = Number.parseInt(request.query.limit, 10);
  reply.ok(app.tasks.manager.list({ status, limit: Number.isInteger(limit) ? limit : 50 }));
}

/** GET /tasks/history —— 历史查询（最近 N 条；内存缓存 + 文件兜底） */
async function handleTaskHistory(app, request, reply) {
  const limit = Number.parseInt(request.query.limit, 10);
  const rawStatus = request.query.status;
  const status = typeof rawStatus === 'string' && rawStatus.length > 0
    ? rawStatus.split(',').map((item) => item.trim()).filter(Boolean)
    : null;
  const items = app.tasks.store.listHistory({ limit: Number.isInteger(limit) ? limit : 50, status });
  reply.ok({ items, total: items.length, max: app.tasks.store.historyMax });
}

/** GET /tasks/{id} —— 单任务详情（终态任务从历史缓存还原） */
async function handleTaskGet(app, request, reply) {
  const task = app.tasks.manager.get(request.params.id);
  if (!task) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: request.params.id });
  reply.ok({ task });
}

/** POST /tasks/{id}/cancel —— 取消（queued/running → cancelling → aborted） */
async function handleTaskCancel(app, request, reply) {
  reply.ok({ task: app.tasks.manager.cancel(request.params.id) });
}

/** POST /tasks/{id}/retry —— 重试 = **新任务**（新 UUID + retryOf 指向原任务） */
async function handleTaskRetry(app, request, reply) {
  const { manager } = app.tasks;
  const orchestrator = app.m2.orchestrator;
  const task = await manager.retry(request.params.id);
  manager.enqueue(task.id, (record) => (task.kind === 'extract'
    ? orchestrator.runExtract(record)
    : orchestrator.runCompress(record)));
  reply.ok({ task: manager.get(task.id) }, 201);
}

/** 取任务并确认它确实处于"待二次确认"状态（三个前置条件是同一类错误，集中判定） */
function requireConfirmableTask(manager, id) {
  const task = manager.get(id);
  if (!task) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
  if (!task.delete) throw apiError(ERROR_CODES.INVALID_STATE, '该任务没有待删除目标', { taskId: id });
  if (task.phase !== 'waiting_confirm') {
    throw apiError(ERROR_CODES.INVALID_STATE, '当前不是待确认状态', { phase: task.phase });
  }
  return task;
}

/** 数量/字节比对（INV-03：弹窗数字与实际不一致就拒绝删除）；返回归一化后的期望值 */
function parseExpectedCounts(body, task) {
  const expectedFiles = Number.isInteger(body.expectedFiles) ? body.expectedFiles : null;
  const expectedBytes = Number.isFinite(body.expectedBytes) ? body.expectedBytes : null;
  const actualFiles = task.delete.targets.length;
  const actualBytes = task.delete.targets.reduce((sum, target) => sum + (Number(target.sizeBytes) || 0), 0);

  if (expectedFiles !== null && expectedFiles !== actualFiles) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, '待删除数量与弹窗不一致，已拒绝删除', { expectedFiles, actualFiles });
  }
  if (expectedBytes !== null && Math.abs(expectedBytes - actualBytes) > 1) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, '待删除字节数与弹窗不一致，已拒绝删除', { expectedBytes, actualBytes });
  }
  return { expectedFiles, expectedBytes };
}

/** POST /tasks/{id}/confirm-delete —— 二次确认删除（压缩删原文件 / 解压删压缩包共用） */
async function handleTaskConfirmDelete(app, request, reply) {
  const { manager } = app.tasks;
  const id = request.params.id;
  const task = requireConfirmableTask(manager, id);

  const body = request.body || {};
  if (body.confirm === false) {
    manager.resolveConfirm(id, { confirmed: false });
    reply.ok({ task: manager.get(id) });
    return;
  }

  const { expectedFiles, expectedBytes } = parseExpectedCounts(body, task);
  manager.resolveConfirm(id, { confirmed: true, expectedFiles, expectedBytes });
  reply.ok({ task: manager.get(id) });
}

/** DELETE /tasks/{id} —— 删除**终态**任务的活动记录（只动 tasks.json，绝不动历史） */
async function handleTaskDelete(app, request, reply) {
  // 删除后由 manager 广播一次快照，其他客户端自行对齐
  reply.ok(await app.tasks.manager.remove(request.params.id));
}

export default async function taskRoutes(app) {
  const auth = { preHandler: [app.requireAuth] };
  const bind = (handler) => (request, reply) => handler(app, request, reply);

  // SSE 必须注册在 /tasks/:id 之前（否则 "events" 会被当成任务 id）
  app.get('/tasks/events', auth, bind(handleTaskEvents));
  app.get('/tasks/history', auth, bind(handleTaskHistory));

  app.get('/tasks', auth, bind(handleTaskList));
  app.get('/tasks/:id', auth, bind(handleTaskGet));
  app.get('/compress/tasks/:id', auth, bind(handleTaskGet)); // 契约别名

  app.delete('/tasks/:id', auth, bind(handleTaskDelete));

  app.post('/tasks/:id/cancel', auth, bind(handleTaskCancel));
  app.post('/compress/tasks/:id/cancel', auth, bind(handleTaskCancel));

  app.post('/tasks/:id/retry', auth, bind(handleTaskRetry));
  app.post('/tasks/:id/confirm-delete', auth, bind(handleTaskConfirmDelete));
  app.post('/compress/tasks/:id/confirm-delete', auth, bind(handleTaskConfirmDelete));
}
