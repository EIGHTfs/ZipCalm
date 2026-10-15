// 任务状态枚举（前后端共用的唯一来源）
//
// 依据：docs/M0/数据模型.md §三「状态机」——7 个值。
// 为什么是 7 个而不是最初的 5 个：docs/11 M3 要求「服务重启后未完成的任务标记为中断」
// 且「能取消正在执行的任务」——「取消完成」(aborted) 与「重启中断」(interrupted) 是两种
// 不同终态；cancelling 是取消的过渡态（对齐参考实现 taskManager.ts 的 cancelTask）。

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  DONE: 'done',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
});

export const TASK_STATUS_VALUES = Object.freeze(Object.values(TASK_STATUS));

// 终态：进入后不可再迁移（重试 = 新建任务，见数据模型 §3.2 禁止迁移）
export const TASK_TERMINAL_STATUSES = Object.freeze([
  TASK_STATUS.DONE,
  TASK_STATUS.FAILED,
  TASK_STATUS.ABORTED,
  TASK_STATUS.INTERRUPTED,
]);

// 可取消的状态集合（后端还有 phase 守卫，这里只做 UI 置灰判断）
export const TASK_CANCELLABLE_STATUSES = Object.freeze([
  TASK_STATUS.QUEUED,
  TASK_STATUS.RUNNING,
]);

// 可重试的状态集合（失败/中断可重试；重试会生成新 UUID）
export const TASK_RETRYABLE_STATUSES = Object.freeze([
  TASK_STATUS.FAILED,
  TASK_STATUS.INTERRUPTED,
]);

// 中文文案：UI 直接取用，避免各处手写不同措辞
export const TASK_STATUS_LABELS = Object.freeze({
  [TASK_STATUS.QUEUED]: '排队中',
  [TASK_STATUS.RUNNING]: '压缩中',
  [TASK_STATUS.CANCELLING]: '正在取消',
  [TASK_STATUS.DONE]: '已完成',
  [TASK_STATUS.FAILED]: '失败',
  [TASK_STATUS.ABORTED]: '已取消',
  [TASK_STATUS.INTERRUPTED]: '已中断',
});

// CSS 修饰类后缀：样式按状态着色（如 .task--failed）
export const TASK_STATUS_TONES = Object.freeze({
  [TASK_STATUS.QUEUED]: 'muted',
  [TASK_STATUS.RUNNING]: 'active',
  [TASK_STATUS.CANCELLING]: 'warn',
  [TASK_STATUS.DONE]: 'ok',
  [TASK_STATUS.FAILED]: 'error',
  [TASK_STATUS.ABORTED]: 'muted',
  [TASK_STATUS.INTERRUPTED]: 'warn',
});

export function isTaskStatus(value) {
  return TASK_STATUS_VALUES.includes(value);
}

export function isTerminalStatus(status) {
  return TASK_TERMINAL_STATUSES.includes(status);
}

export function isCancellableStatus(status) {
  return TASK_CANCELLABLE_STATUSES.includes(status);
}

export function isRetryableStatus(status) {
  return TASK_RETRYABLE_STATUSES.includes(status);
}

export function taskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || '未知状态';
}

export function taskStatusTone(status) {
  return TASK_STATUS_TONES[status] || 'muted';
}
