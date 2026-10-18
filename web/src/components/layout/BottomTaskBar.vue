<script setup>
// 底部任务条（M3：真实数据 + 常驻进度 + 取消）
//
// 数据全部来自 `stores/tasks.js`（SSE 单一数据源），**不再自己轮询**。
// 内容：活跃/排队摘要 | 当前任务与进度 | 微型指标占位 | 操作（展开抽屉 / 取消）
// 契约：docs/08 第八节「任务进度要常驻可见」+ docs/11 M3「底部任务条 + 任务抽屉」

import { computed } from 'vue';

import { useMetricsStore } from '../../stores/metrics.js';
import { useTasksStore } from '../../stores/tasks.js';
import { formatBytes, formatPercent } from '../../utils/format.js';
import { taskStatusLabel, taskStatusTone } from '../../constants/index.js';

const tasks = useTasksStore();

const active = computed(() => tasks.activeTask);
const progress = computed(() => (active.value && active.value.progress) || {});
const summaryText = computed(() => {
  const task = active.value;
  if (!task) return '暂无进行中的任务';
  const label = task.kind === 'extract' ? '解压' : '压缩';
  const name = task.sources && task.sources[0] ? task.sources[0].name : (task.archivePath || '');
  return `${label}中 · ${name}`;
});
const connectionLabel = computed(() => {
  if (tasks.connectionMode === 'connected') return 'SSE 已连接';
  if (tasks.connectionMode === 'polling') return '轮询降级';
  return '连接中…';
});

async function cancelActive() {
  if (!active.value) return;
  await tasks.cancel(active.value.id);
}

// 微型指标：复用 M7 的 store（它只在性能页轮询；这里只读"最近一帧"，不会额外打接口）
const metrics = useMetricsStore();
const memoryPercent = computed(() => {
  const system = metrics.frame && metrics.frame.system;
  if (!system || !system.memUsedBytes || !system.memTotalBytes) return null;
  return (system.memUsedBytes / system.memTotalBytes) * 100;
});
const eventLoopText = computed(() => {
  const processStats = (metrics.frame && metrics.frame.process) || {};
  return typeof processStats.eventLoopDelayMs === 'number' ? `${processStats.eventLoopDelayMs.toFixed(1)} ms` : '—';
});
</script>

<template>
  <footer class="bottom-task-bar" data-region="bottom-task-bar" data-testid="task-bar">
    <div class="bottom-task-bar__summary">
      <span class="badge" :class="{ 'badge--active': tasks.runningCount > 0 }" data-testid="task-bar-running">
        活跃 {{ tasks.runningCount }}
      </span>
      <span class="badge" data-testid="task-bar-queued">排队 {{ tasks.queuedCount }}</span>
      <span class="badge" title="v1 契约：压缩串行执行；并行开关为占位">串行执行</span>
      <span class="badge" data-testid="task-bar-connection">{{ connectionLabel }}</span>
    </div>

    <div class="bottom-task-bar__current" data-testid="task-bar-current">
      <template v-if="active">
        <span class="badge" :class="`badge--${taskStatusTone(active.status)}`">{{ taskStatusLabel(active.status) }}</span>
        <span>{{ summaryText }}</span>
        <span class="bottom-task-bar__progress" role="progressbar" :aria-valuenow="progress.percent || 0" aria-valuemin="0" aria-valuemax="100">
          <span class="progress__bar" data-testid="task-bar-progress-bar" :style="{ width: `${progress.percent || 0}%` }"></span>
        </span>
        <span data-testid="task-bar-percent">
          {{ formatPercent(progress.percent || 0) }} · {{ progress.processedFiles || 0 }}/{{ progress.totalFiles || 0 }} ·
          {{ formatBytes(progress.processedBytes || 0) }}/{{ formatBytes(progress.totalBytes || 0) }}
        </span>
        <span v-if="progress.currentFile" class="bottom-task-bar__file" data-testid="task-bar-current-file">{{ progress.currentFile }}</span>
      </template>
      <template v-else>
        <span>暂无进行中的任务</span>
      </template>
    </div>

    <!-- 微型指标：数据来自 M7 的指标 store；**没有数据就不显示**，而不是摆一堆「—」和过期徽标 -->
    <div v-if="metrics.frame" class="bottom-task-bar__metrics" aria-label="微型指标" data-testid="task-bar-metrics">
      <span>CPU {{ formatPercent(metrics.frame.system.cpuPercent) }}</span>
      <span>内存 {{ formatPercent(memoryPercent) }}</span>
      <span>事件循环 {{ eventLoopText }}</span>
    </div>

    <div class="bottom-task-bar__actions">
      <button type="button" :disabled="!active" data-testid="task-bar-cancel" @click="cancelActive">取消</button>
      <button type="button" data-testid="task-bar-open-drawer" @click="tasks.drawerOpen = true">任务</button>
    </div>
  </footer>
</template>
