// 任务阶段枚举（前后端共用的唯一来源）
//
// 依据：docs/M0/数据模型.md §3.3「phase 与删除子状态机」——6 个值，按执行顺序排列。
// 为什么单独于 status：status 只回答「任务处于什么大状态」，phase 回答「卡在哪一步」；
// M5 的二次确认 UI（waiting_confirm）与 M6 的预检提示都依赖 phase。

export const TASK_PHASE = Object.freeze({
  PRECHECK: 'precheck',
  SCANNING: 'scanning',
  COMPRESSING: 'compressing',
  VERIFYING: 'verifying',
  WAITING_CONFIRM: 'waiting_confirm',
  DELETING: 'deleting',
});

// 顺序表：进度条与步骤条按此顺序渲染
export const TASK_PHASE_ORDER = Object.freeze([
  TASK_PHASE.PRECHECK,
  TASK_PHASE.SCANNING,
  TASK_PHASE.COMPRESSING,
  TASK_PHASE.VERIFYING,
  TASK_PHASE.WAITING_CONFIRM,
  TASK_PHASE.DELETING,
]);

export const TASK_PHASE_VALUES = Object.freeze(Object.values(TASK_PHASE));

// 中文文案（用户能看懂的措辞，不要直接暴露英文枚举）
export const TASK_PHASE_LABELS = Object.freeze({
  [TASK_PHASE.PRECHECK]: '检查权限与空间',
  [TASK_PHASE.SCANNING]: '统计文件',
  [TASK_PHASE.COMPRESSING]: '压缩中',
  [TASK_PHASE.VERIFYING]: '校验压缩包',
  [TASK_PHASE.WAITING_CONFIRM]: '待确认删除原文件',
  [TASK_PHASE.DELETING]: '删除原文件',
});

// 可被取消的阶段：删除阶段不允许取消（删除是安全敏感动作，中途停止语义不清）
export const TASK_CANCELLABLE_PHASES = Object.freeze([
  TASK_PHASE.PRECHECK,
  TASK_PHASE.SCANNING,
  TASK_PHASE.COMPRESSING,
  TASK_PHASE.VERIFYING,
]);

export function isTaskPhase(value) {
  return TASK_PHASE_VALUES.includes(value);
}

export function taskPhaseLabel(phase) {
  return TASK_PHASE_LABELS[phase] || '处理中';
}

export function isCancellablePhase(phase) {
  return TASK_CANCELLABLE_PHASES.includes(phase);
}

// 阶段进度序号（1 起）：UI 显示「第 3/6 步」
export function taskPhaseIndex(phase) {
  const index = TASK_PHASE_ORDER.indexOf(phase);
  return index === -1 ? 0 : index + 1;
}
