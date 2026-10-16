<script setup>
// 任务进度面板（M3：数据来自 SSE store，**不再轮询**）
//
// M2 这里是 1s 轮询；M3 换成 `stores/tasks.js` 的 SSE 推送（快照 + 增量），
// 面板本身只做展示与操作，进度来源与"关掉浏览器任务继续跑"完全解耦（INV-04）。
//
// 展示：阶段 + 百分比 + 进度条 + 文件级当前文件 + 结果摘要 + 待确认删除按钮。

import { computed, ref, watch } from 'vue';

import { useTasksStore } from '../../stores/tasks.js';
import { formatBytes, formatPercent } from '../../utils/format.js';
import { TASK_PHASE_LABELS, taskStatusLabel, taskStatusTone } from '../../constants/index.js';

const props = defineProps({
  taskId: { type: String, default: null },
});
const emit = defineEmits(['finished', 'dismiss']);

const tasks = useTasksStore();
const errorText = ref('');
const confirming = ref(false);
const finishedNotified = ref(null);

const task = computed(() => (props.taskId ? tasks.tasks.get(props.taskId) || null : null));
const progress = computed(() => (task.value && task.value.progress) || {});
const isTerminal = computed(() => Boolean(task.value && ['done', 'failed', 'aborted', 'interrupted'].includes(task.value.status)));
const phaseLabel = computed(() => {
  if (!task.value) return '';
  if (task.value.phase === 'waiting_confirm') return '待确认删除';
  return TASK_PHASE_LABELS[task.value.phase] || task.value.phase || '';
});
const statusTone = computed(() => (task.value ? taskStatusTone(task.value.status) : 'muted'));
const deleteTargetCount = computed(() => (task.value && task.value.delete && task.value.delete.targets
  ? task.value.delete.targets.length
  : 0));

// 面板打开时补拉一次完整任务（SSE 增量是摘要，详情/删除目标数需要完整对象）
watch(
  () => props.taskId,
  async (id) => {
    errorText.value = '';
    finishedNotified.value = null;
    if (!id) return;
    try {
      await tasks.loadDetail(id);
    } catch (error) {
      errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
    }
  },
  { immediate: true },
);

// 终态只通知一次（SSE 会重复推送同一任务）
watch(isTerminal, (terminal) => {
  if (terminal && task.value && finishedNotified.value !== task.value.id + task.value.status) {
    finishedNotified.value = task.value.id + task.value.status;
    emit('finished', task.value);
  }
});

async function confirmDelete() {
  if (confirming.value || !props.taskId) return;
  confirming.value = true;
  errorText.value = '';
  try {
    await tasks.confirmDelete(props.taskId, deleteTargetCount.value);
    await tasks.loadDetail(props.taskId);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <section v-if="taskId" class="card task-panel" data-testid="task-panel">
    <div class="task-panel__head">
      <strong>{{ task ? (task.kind === 'extract' ? '解压任务' : '压缩任务') : '任务' }}</strong>
      <span v-if="task" class="badge" :class="`badge--${statusTone}`" data-testid="task-status">
        {{ taskStatusLabel(task.status) }}<template v-if="!isTerminal"> · {{ phaseLabel }}</template>
      </span>
      <span class="topbar__spacer"></span>
      <button type="button" data-testid="task-dismiss" @click="emit('dismiss')">收起</button>
    </div>

    <template v-if="task">
      <div class="progress">
        <div class="progress__bar" data-testid="task-progress-bar" :style="{ width: `${progress.percent || 0}%` }"></div>
      </div>

      <p class="card__desc" data-testid="task-progress-text">
        {{ formatPercent(progress.percent || 0) }} ·
        {{ progress.processedFiles || 0 }}/{{ progress.totalFiles || 0 }} 个文件 ·
        {{ formatBytes(progress.processedBytes || 0) }}/{{ formatBytes(progress.totalBytes || 0) }}
        <template v-if="progress.speedBps">· {{ formatBytes(progress.speedBps) }}/s<template v-if="progress.etaSeconds"> · 剩余 {{ progress.etaSeconds }}s</template></template>
      </p>
      <p v-if="progress.currentFile" class="card__desc" data-testid="task-current-file">
        当前：{{ progress.currentFile }}
      </p>

      <p v-if="task.status === 'done' && task.result" class="card__desc" data-testid="task-result">
        <template v-if="task.kind === 'compress'">
          产物：{{ (task.result.packages || []).map((pkg) => pkg.outputPath).join('、') || '—' }}
          （校验 {{ (task.result.packages || []).every((pkg) => pkg.verified) ? '通过' : '未通过' }}）
        </template>
        <template v-else>
          解压到：{{ task.targetDir }}（{{ task.result.entries || 0 }} 个条目，校验通过）
        </template>
      </p>

      <p v-if="task.delete" class="card__desc" data-testid="task-delete-state">
        删除状态：{{ task.delete.status }}（目标 {{ deleteTargetCount }} 项）
      </p>

      <div v-if="task.phase === 'waiting_confirm'" class="task-panel__confirm" data-testid="task-waiting-confirm">
        <span>需确认删除 {{ deleteTargetCount }} 项</span>
        <button type="button" :disabled="confirming" data-testid="confirm-delete" @click="confirmDelete">
          {{ confirming ? '提交中…' : '确认删除' }}
        </button>
      </div>

      <p v-if="task.error" class="login-form__error" data-testid="task-error" role="alert">
        [{{ task.error.code }}] {{ task.error.message }}
      </p>
    </template>

    <p v-if="errorText" class="login-form__error" role="alert">{{ errorText }}</p>
  </section>
</template>
