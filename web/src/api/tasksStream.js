// 任务流传输层（从 stores/tasks.js 拆出）：SSE 优先 + 3 次失败降级轮询 + 重连退避
//
// 契约：docs/09 约定 3（不支持 SSE 时 1s 轮询兜底）、docs/M0 的 INV-05
// （断线期间丢的增量补不回来，唯一可靠恢复是重连后拿服务端发的 `snapshot`）。
//
// 这一层只管"连接与帧分发"，不持有任务表——任务表在 stores/tasks/collection.js。

import { api } from './client.js';

const MAX_RECONNECT_DELAY_MS = 15000;
const POLL_INTERVAL_MS = 1000;
const FALLBACK_AFTER_FAILURES = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('../stores/tasks/collection.js').createTaskCollection>} deps.collection
 * @param {{value: string}} deps.connectionMode connecting | connected | polling
 * @param {{value: number}} deps.lastEventAt 最近一次收到任务事件的时间戳（浏览器实测可断言增量真的到了）
 * @param {{value: string|null}} deps.lastEventStatus 最近一次事件里的任务状态
 */
export function createTasksStream({ collection, connectionMode, lastEventAt, lastEventStatus }) {
  let source = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let reconnectDelay = RECONNECT_BASE_DELAY_MS;
  let failures = 0;

  /** 降级轮询：SSE 连不上时用 GET /tasks（契约 §五 规则 6） */
  function startPolling() {
    if (pollTimer) return;
    connectionMode.value = 'polling';
    const tick = async () => {
      try {
        const payload = await api.get('/tasks', { limit: 50 });
        collection.replaceFromList(payload);
      } catch {
        /* 轮询失败下个周期再试 */
      }
    };
    void tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /** 重连退避：1s 起翻倍，上限 15s（成功收到 snapshot 时重置） */
  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  /**
   * 记一次连接失败；达到阈值就降级轮询。
   * @returns {boolean} true = 已降级到轮询（调用方据此决定还要不要安排重连）
   */
  function recordConnectFailure() {
    failures += 1;
    if (failures < FALLBACK_AFTER_FAILURES) return false;
    startPolling();
    return true;
  }

  /** SSE 地址（带 since 续传参数；lastSeq=0 时不带） */
  function eventsUrl() {
    const since = collection.lastSeq.value > 0 ? `&since=${collection.lastSeq.value}` : '';
    return `/api/v1/tasks/events?channels=tasks${since}`;
  }

  /** 解析一帧；解析失败直接丢弃（不让坏帧影响连接状态） */
  function parseFrame(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  function onSnapshotFrame(event) {
    const payload = parseFrame(event);
    if (!payload) return;
    collection.bumpSeq(payload.seq);
    collection.applySnapshot(payload);
    connectionMode.value = 'connected';
    failures = 0;
    reconnectDelay = RECONNECT_BASE_DELAY_MS;
    stopPolling();
  }

  function onTaskFrame(event) {
    const payload = parseFrame(event);
    if (!payload) return;
    collection.bumpSeq(payload.seq);
    collection.upsert(payload.task);
    lastEventAt.value = Date.now();
    lastEventStatus.value = payload.task && payload.task.status;
  }

  function onSourceError() {
    connectionMode.value = 'connecting';
    if (source) {
      source.close();
      source = null;
    }
    recordConnectFailure();
    scheduleReconnect();
  }

  /** 挂上快照/增量/心跳/开闭事件（每条只做自己那件事） */
  function attachSourceHandlers(openedSource) {
    openedSource.addEventListener('snapshot', onSnapshotFrame);
    openedSource.addEventListener('task', onTaskFrame);
    openedSource.addEventListener('heartbeat', () => {
      connectionMode.value = 'connected';
    });
    openedSource.onopen = () => {
      connectionMode.value = 'connected';
      failures = 0;
    };
    openedSource.onerror = onSourceError;
  }

  /** 建立 SSE：连接后服务端**先发快照**再发增量；重连时带 since 续传 */
  function connect() {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    if (source) {
      source.close();
      source = null;
    }
    connectionMode.value = 'connecting';

    try {
      source = new EventSource(eventsUrl());
    } catch {
      // 构造失败（如浏览器禁用 EventSource）：降级轮询；没到阈值才安排重连
      if (!recordConnectFailure()) scheduleReconnect();
      return;
    }

    attachSourceHandlers(source);
  }

  function disconnect() {
    if (source) {
      source.close();
      source = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    stopPolling();
    connectionMode.value = 'connecting';
  }

  return { connect, disconnect, startPolling, stopPolling };
}
