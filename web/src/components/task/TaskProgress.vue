<script setup>
// 任务进度面板（M2：轮询；M3 会换成 SSE 推送）
//
// 为什么用轮询：SSE 属 M3（契约里 /tasks/events 是 M3 交付物）。M2 的进度"能看"即可，
// 所以这里用 1s 轮询 GET /tasks/{id} —— 反正进度是"状态"不是"消息"，轮询语义完全成立。
//
// 展示内容（对齐 docs/08「两层进度」）：
// - 阶段（phase 中文）+ 百分比 + 进度条
// - 文件级：当前文件名 + 已处理 X/Y
// - 等待确认删除时给出「确认删除」按钮（POST /tasks/{id}/confirm-delete）
// - 终态：完成摘要（节省/比率）或契约错误码

import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { api } from '../../api/client.js';
import { formatBytes, formatPercent } from '../../utils/format.js';
import {
  TASK_PHASE_LABELS,
  taskStatusLabel,
  taskStatusTone,
} from '../../constants/index.js';

const props = defineProps({
  taskId: { type: String, default: null },
});
const emit = defineEmits(['finished', 'dismiss']);

const task = ref(null);
const errorText = ref('');
const confirming = ref(false);
let timer = null;

const TERMINAL = ['done', 'failed', 'aborted', 'interrupted'];

const isTerminal = computed(() => Boolean(task.value && TERMINAL.includes(task.value.status)));
const phaseLabel = computed(() => {
  if (!task.value) return '';
  const phase = task.value.phase;
  if (phase === 'waiting_confirm') return '待确认删除';
  return TASK_PHASE_LABELS[phase] || phase;
});
const statusTone = computed(() => (task.value ? taskStatusTone(task.value.status) : 'muted'));
const progress = computed(() => (task.value && task.value.progress) || {});
const deleteState = computed(() => (task.value && task.value.delete) || null);
const deleteTargetCount = computed(() => (deleteState.value && deleteState.value.targets ? deleteState.value.targets.length : 0));

function stopPolling() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function fetchOnce() {
  if (!props.taskId) return;
  try {
    const data = await api.get(`/tasks/${props.taskId}`);
    task.value = data.task;
    if (isTerminal.value) {
      stopPolling();
      emit('finished', task.value);
    }
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
    stopPolling();
  }
}

watch(
  () => props.taskId,
  (id) => {
    stopPolling();
    task.value = null;
    errorText.value = '';
    if (!id) return;
    fetchOnce();
    timer = setInterval(fetchOnce, 1000);
  },
  { immediate: true },
);

onBeforeUnmount(stopPolling);

async function confirmDelete() {
  if (confirming.value || !props.taskId) return;
  confirming.value = true;
  errorText.value = '';
  try {
    await api.post(`/tasks/${props.taskId}/confirm-delete`, {
      confirm: true,
      expectedFiles: deleteTargetCount.value,
    });
    await fetchOnce();
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

      <p v-if="deleteState" class="card__desc" data-testid="task-delete-state">
        删除状态：{{ deleteState.status }}（模式 {{ deleteState.mode || '未执行' }}，目标 {{ deleteTargetCount }} 项）
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
