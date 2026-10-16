// 任务 store（M3）：SSE 单一数据源 + 断线重连（先快照再增量）+ 降级轮询
//
// 契约：docs/M0/API规范.md §五（SSE）+ docs/09 约定 3（不支持 SSE 时 1s 轮询兜底）
//
// 为什么"重连后先拉快照"是铁律（INV-05）：进度是**状态**不是消息。
// 断线期间丢掉的增量无法补齐，唯一可靠的恢复方式是重新拿一份当前状态；
// 服务端每次连接都会先发 `snapshot`，所以客户端只要重连即可，不必自己攒事件。
//
// 本 store 是任务的唯一真相来源：底部任务条、任务抽屉、页面内的进度面板都读它，
// 不再各自轮询（M2 的 1s 轮询在 M3 被替换掉）。

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { api } from '../api/client.js';

const MAX_RECONNECT_DELAY_MS = 15000;
const POLL_INTERVAL_MS = 1000;
const FALLBACK_AFTER_FAILURES = 3;

export const useTasksStore = defineStore('tasks', () => {
  /** Map<id, task>：快照 + 增量合并后的任务表 */
  const tasks = ref(new Map());
  const history = ref([]);
  const queue = ref({ active: null, waiting: 0, parallel: false });
  /** connected | connecting | polling */
  const connectionMode = ref('connecting');
  const lastSeq = ref(0);
  const bootId = ref(null);
  const drawerOpen = ref(false);
  /** 最近一次通过 SSE 收到的任务事件（浏览器实测可断言"增量真的到了"） */
  const lastEventAt = ref(0);
  const lastEventStatus = ref(null);

  let source = null;
  let reconnectTimer = null;
  let pollTimer = null;
  let reconnectDelay = 1000;
  let failures = 0;

  const list = computed(() => [...tasks.value.values()].sort((a, b) => b.createdAt - a.createdAt));
  /** 活任务：只有这些才算"进行中"（终态一律不算） */
  const NON_TERMINAL = ['queued', 'running', 'cancelling'];
  /** 终态但**仍有活动记录**：failed/interrupted 为"可重试"保留在 tasks.json 里，因此可删、可重试 */
  const RETRYABLE = ['failed', 'interrupted'];
  const unfinished = computed(() => list.value.filter((task) => NON_TERMINAL.includes(task.status)));
  const retryable = computed(() => list.value.filter((task) => RETRYABLE.includes(task.status)));
  const activeTask = computed(() => list.value.find((task) => task.status === 'running' || task.status === 'cancelling')
    || list.value.find((task) => task.status === 'queued')
    || null);
  /** 该 id 是否还有活动记录（决定历史行要不要给「删除」按钮：done/aborted 早已移出 tasks.json） */
  function hasActiveRecord(id) {
    const task = tasks.value.get(id);
    return Boolean(task && (NON_TERMINAL.includes(task.status) || RETRYABLE.includes(task.status)));
  }
  const queuedCount = computed(() => list.value.filter((task) => task.status === 'queued').length);
  const runningCount = computed(() => list.value.filter((task) => task.status === 'running').length);

  function upsert(task) {
    if (!task || !task.id) return;
    const next = new Map(tasks.value);
    const previous = next.get(task.id);
    // 增量是"摘要"，别用摘要覆盖已有的完整对象里更全的字段（details 只在详情接口有）
    next.set(task.id, previous ? { ...previous, ...task, progress: { ...task.progress } } : { ...task });
    tasks.value = next;
  }

  function applySnapshot(data) {
    const next = new Map();
    for (const task of data.tasks || []) next.set(task.id, task);
    tasks.value = next;
    queue.value = data.queue || queue.value;
    bootId.value = data.bootId || bootId.value;
    if (Number.isInteger(data.seq)) lastSeq.value = Math.max(lastSeq.value, data.seq);
  }

  /** 降级轮询：SSE 连不上时用 GET /tasks（契约 §五 规则 6） */
  function startPolling() {
    if (pollTimer) return;
    connectionMode.value = 'polling';
    const tick = async () => {
      try {
        const listPayload = await api.get('/tasks', { limit: 50 });
        const next = new Map();
        for (const task of listPayload.items || []) next.set(task.id, task);
        tasks.value = next;
        queue.value = listPayload.queue || queue.value;
        history.value = listPayload.history || history.value;
        if (Number.isInteger(listPayload.seq)) lastSeq.value = Math.max(lastSeq.value, listPayload.seq);
      } catch {
        /* 轮询失败下个周期再试 */
      }
    };
    void tick();
    pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  function handleFrame(eventName, event) {
    let payload = null;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (Number.isInteger(payload.seq)) lastSeq.value = Math.max(lastSeq.value, payload.seq);

    if (eventName === 'snapshot') {
      applySnapshot(payload);
      return;
    }
    if (eventName === 'task') {
      upsert(payload.task);
      lastEventAt.value = Date.now();
      lastEventStatus.value = payload.task && payload.task.status;
    }
  }

  /** SSE 地址（带 since 续传参数；lastSeq=0 时不带） */
  function eventsUrl() {
    const since = lastSeq.value > 0 ? `&since=${lastSeq.value}` : '';
    return `/api/v1/tasks/events?channels=tasks${since}`;
  }

  /**
   * 记一次连接失败；达到阈值就降级轮询。
   * @returns {boolean} true = 已降级到轮询（调用方据此决定还要不要安排重连）
   */
  function recordConnectFailure() {
    failures += 1;
    if (failures >= FALLBACK_AFTER_FAILURES) {
      startPolling();
      return true;
    }
    return false;
  }

  /** 挂上快照/增量/心跳/开闭事件（每条只做自己那件事） */
  function attachSourceHandlers(openedSource) {
    openedSource.addEventListener('snapshot', (event) => {
      handleFrame('snapshot', event);
      connectionMode.value = 'connected';
      failures = 0;
      reconnectDelay = 1000;
      stopPolling();
    });
    openedSource.addEventListener('task', (event) => handleFrame('task', event));
    openedSource.addEventListener('heartbeat', () => {
      connectionMode.value = 'connected';
    });
    openedSource.onopen = () => {
      connectionMode.value = 'connected';
      failures = 0;
    };
    openedSource.onerror = () => {
      connectionMode.value = 'connecting';
      if (source) {
        source.close();
        source = null;
      }
      recordConnectFailure();
      scheduleReconnect();
    };
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

  /** 详情：从服务端拉完整任务（含 result/delete 明细）并回填 store */
  async function loadDetail(id) {
    const detailPayload = await api.get(`/tasks/${id}`);
    upsert(detailPayload.task);
    return detailPayload.task;
  }

  async function loadHistory(limit = 50) {
    const historyPayload = await api.get('/tasks/history', { limit });
    history.value = historyPayload.items || [];
    return history.value;
  }

  async function cancel(id) {
    const cancelled = await api.post(`/tasks/${id}/cancel`, {});
    upsert(cancelled.task);
    return cancelled.task;
  }

  async function retry(id) {
    const retried = await api.post(`/tasks/${id}/retry`, {});
    upsert(retried.task);
    return retried.task;
  }

  async function confirmDelete(id, expectedFiles) {
    const confirmed = await api.post(`/tasks/${id}/confirm-delete`, { confirm: true, expectedFiles });
    upsert(confirmed.task);
    return confirmed.task;
  }

  /** 删除活动记录（仅终态；后端会拒绝非终态）。删除后本地立即移除，再拉一次历史保持一致 */
  async function remove(id) {
    const removeResult = await api.del(`/tasks/${id}`);
    const next = new Map(tasks.value);
    next.delete(id);
    tasks.value = next;
    // loadHistory 自带默认页大小（不重复写 50，避免两处默认值漂移）
    await loadHistory().catch(() => {});
    return removeResult;
  }

  return {
    tasks,
    history,
    queue,
    connectionMode,
    lastSeq,
    bootId,
    drawerOpen,
    lastEventAt,
    lastEventStatus,
    list,
    unfinished,
    retryable,
    hasActiveRecord,
    activeTask,
    queuedCount,
    runningCount,
    connect,
    disconnect,
    upsert,
    loadDetail,
    loadHistory,
    cancel,
    retry,
    confirmDelete,
    remove,
  };
});
