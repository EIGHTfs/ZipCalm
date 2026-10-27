// 任务 store（M3）：装配「集合状态 + 传输层 + 服务端动作」，对外 API 保持不变
//
// 契约：docs/M0/API规范.md §五（SSE）+ docs/09 约定 3（不支持 SSE 时 1s 轮询兜底）
//
// 为什么"重连后先拉快照"是铁律（INV-05）：进度是**状态**不是消息。
// 断线期间丢掉的增量无法补齐，唯一可靠的恢复方式是重新拿一份当前状态；
// 服务端每次连接都会先发 `snapshot`，所以客户端只要重连即可，不必自己攒事件。
//
// 本 store 是任务的唯一真相来源：底部任务条、任务抽屉、页面内的进度面板都读它，
// 不再各自轮询（M2 的 1s 轮询在 M3 被替换掉）。
//
// 文件分工（本文件只做装配，三块实现分别在下面三个模块里，避免把 246 行塞进一个 setup）：
//   stores/tasks/collection.js —— 集合状态：refs + computed + upsert/applySnapshot
//   api/tasksStream.js         —— 传输层：SSE 优先 + 降级轮询 + 重连退避
//   stores/tasks/actions.js    —— 服务端动作：详情/历史/取消/重试/确认删除/删除

import { defineStore } from 'pinia';
import { ref } from 'vue';

import { createTasksStream } from '../api/tasksStream.js';
import { createTaskActions } from './tasks/actions.js';
import { createTaskCollection } from './tasks/collection.js';

export const useTasksStore = defineStore('tasks', () => {
  const collection = createTaskCollection();
  /** connected | connecting | polling */
  const connectionMode = ref('connecting');
  const drawerOpen = ref(false);
  /** 最近一次通过 SSE 收到的任务事件（浏览器实测可断言"增量真的到了"） */
  const lastEventAt = ref(0);
  const lastEventStatus = ref(null);

  const stream = createTasksStream({ collection, connectionMode, lastEventAt, lastEventStatus });
  const actions = createTaskActions({ collection });

  return {
    // 集合状态
    tasks: collection.tasks,
    history: collection.history,
    queue: collection.queue,
    lastSeq: collection.lastSeq,
    bootId: collection.bootId,
    list: collection.list,
    unfinished: collection.unfinished,
    retryable: collection.retryable,
    queuedCount: collection.queuedCount,
    runningCount: collection.runningCount,
    activeTask: collection.activeTask,
    hasActiveRecord: collection.hasActiveRecord,
    upsert: collection.upsert,
    // 传输层
    connectionMode,
    drawerOpen,
    lastEventAt,
    lastEventStatus,
    connect: stream.connect,
    disconnect: stream.disconnect,
    // 服务端动作
    loadDetail: actions.loadDetail,
    loadHistory: actions.loadHistory,
    cancel: actions.cancel,
    retry: actions.retry,
    confirmDelete: actions.confirmDelete,
    remove: actions.remove,
  };
});
