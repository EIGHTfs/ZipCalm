// 任务集合状态（从 stores/tasks.js 拆出）：refs + computed + upsert/applySnapshot
//
// 为什么单独一层：原 store 的 setup 函数把"集合状态 / SSE 传输 / 服务端动作"三类关注点
// 混在一个 246 行的函数里（审计 readability/max-function-length 拦截）。
// 这一层只关心"任务表怎么存、怎么合并、怎么派生计数"，不碰网络。

import { computed, ref } from 'vue';

/** 活任务：只有这些才算"进行中"（终态一律不算） */
export const NON_TERMINAL_STATUSES = ['queued', 'running', 'cancelling'];
/** 终态但**仍有活动记录**：failed/interrupted 为"可重试"保留在 tasks.json 里，因此可删、可重试 */
export const RETRYABLE_STATUSES = ['failed', 'interrupted'];

export function createTaskCollection() {
  /** Map<id, task>：快照 + 增量合并后的任务表 */
  const tasks = ref(new Map());
  const history = ref([]);
  const queue = ref({ active: null, waiting: 0, parallel: false });
  const lastSeq = ref(0);
  const bootId = ref(null);

  const list = computed(() => [...tasks.value.values()].sort((a, b) => b.createdAt - a.createdAt));
  const unfinished = computed(() => list.value.filter((task) => NON_TERMINAL_STATUSES.includes(task.status)));
  const retryable = computed(() => list.value.filter((task) => RETRYABLE_STATUSES.includes(task.status)));
  const queuedCount = computed(() => list.value.filter((task) => task.status === 'queued').length);
  const runningCount = computed(() => list.value.filter((task) => task.status === 'running').length);
  const activeTask = computed(() => list.value.find((task) => task.status === 'running' || task.status === 'cancelling')
    || list.value.find((task) => task.status === 'queued')
    || null);

  /** 该 id 是否还有活动记录（决定历史行要不要给「删除」按钮：done/aborted 早已移出 tasks.json） */
  function hasActiveRecord(id) {
    const task = tasks.value.get(id);
    return Boolean(task && (NON_TERMINAL_STATUSES.includes(task.status) || RETRYABLE_STATUSES.includes(task.status)));
  }

  /** 合并一条任务（增量是"摘要"，别用摘要覆盖已有的完整对象里更全的字段：details 只在详情接口有） */
  function upsert(task) {
    if (!task || !task.id) return;
    const next = new Map(tasks.value);
    const previous = next.get(task.id);
    next.set(task.id, previous ? { ...previous, ...task, progress: { ...task.progress } } : { ...task });
    tasks.value = next;
  }

  /** 应用服务端快照（SSE 首帧 / 重连首帧）：整表替换 + 队列/启动号/序号 */
  function applySnapshot(data) {
    const next = new Map();
    for (const task of data.tasks || []) next.set(task.id, task);
    tasks.value = next;
    queue.value = data.queue || queue.value;
    bootId.value = data.bootId || bootId.value;
    if (Number.isInteger(data.seq)) lastSeq.value = Math.max(lastSeq.value, data.seq);
  }

  /** 轮询降级时用列表接口整表替换（接口形状与快照略有不同：items/history） */
  function replaceFromList(payload) {
    const next = new Map();
    for (const task of payload.items || []) next.set(task.id, task);
    tasks.value = next;
    queue.value = payload.queue || queue.value;
    history.value = payload.history || history.value;
    if (Number.isInteger(payload.seq)) lastSeq.value = Math.max(lastSeq.value, payload.seq);
  }

  /** 本地移除一条（删除活动记录后立即生效，不必等下一次拉取） */
  function removeLocal(id) {
    const next = new Map(tasks.value);
    next.delete(id);
    tasks.value = next;
  }

  /** SSE 帧里的 seq 只增不减，保证 since 续传参数单调 */
  function bumpSeq(seq) {
    if (Number.isInteger(seq)) lastSeq.value = Math.max(lastSeq.value, seq);
  }

  return {
    tasks,
    history,
    queue,
    lastSeq,
    bootId,
    list,
    unfinished,
    retryable,
    queuedCount,
    runningCount,
    activeTask,
    hasActiveRecord,
    upsert,
    applySnapshot,
    replaceFromList,
    removeLocal,
    bumpSeq,
  };
}
