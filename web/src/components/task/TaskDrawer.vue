<script setup>
// 任务抽屉（M3）：进行中 + 历史 + 详情/操作
//
// 数据来自 `stores/tasks.js`；打开时补拉一次历史（历史来自 task-history.jsonl 的内存缓存）。
// 操作：取消（运行中）、重试（failed/interrupted → **新建任务** + retryOf）、确认删除（waiting_confirm）。
// 契约：docs/M0/数据模型.md §3.2（重试=新任务）、API 规范 §4.3（任务端点）

import { computed, ref, watch } from 'vue';

import { useTasksStore } from '../../stores/tasks.js';
import { formatBytes, formatDateTime, formatPercent } from '../../utils/format.js';
import { TASK_PHASE_LABELS, taskStatusLabel, taskStatusTone } from '../../constants/index.js';

const tasks = useTasksStore();
const selectedId = ref(null);
const detail = ref(null);
const errorText = ref('');
const busy = ref(false);

const unfinished = computed(() => tasks.unfinished);
const finished = computed(() => tasks.list.filter((task) => ['done', 'aborted', 'failed', 'interrupted'].includes(task.status)));

function phaseLabel(task) {
  if (!task) return '';
  if (task.phase === 'waiting_confirm') return '待确认删除';
  return TASK_PHASE_LABELS[task.phase] || task.phase || '';
}

async function openDetail(id) {
  selectedId.value = id;
  errorText.value = '';
  try {
    detail.value = await tasks.loadDetail(id);
  } catch (error) {
    detail.value = null;
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  }
}

async function run(action) {
  if (!selectedId.value || busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    if (action === 'cancel') await tasks.cancel(selectedId.value);
    if (action === 'retry') {
      const created = await tasks.retry(selectedId.value);
      await openDetail(created.id);
    }
    if (action === 'confirm-delete') {
      const count = detail.value && detail.value.delete ? detail.value.delete.targets.length : 0;
      await tasks.confirmDelete(selectedId.value, count);
    }
    if (action !== 'retry') await openDetail(selectedId.value);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    busy.value = false;
  }
}

watch(
  () => tasks.drawerOpen,
  (open) => {
    if (open) {
      tasks.loadHistory(50).catch(() => {});
      if (!selectedId.value && tasks.activeTask) openDetail(tasks.activeTask.id);
    }
  },
);
</script>

<template>
  <div v-if="tasks.drawerOpen" class="drawer-backdrop" data-testid="task-drawer" @click.self="tasks.drawerOpen = false">
    <section class="drawer drawer--wide" role="dialog" aria-label="任务列表">
      <header class="drawer__header">
        <h3>任务</h3>
        <span class="badge" data-testid="drawer-connection">
          {{ tasks.connectionMode === 'connected' ? 'SSE 已连接' : (tasks.connectionMode === 'polling' ? '轮询降级' : '连接中…') }}
        </span>
        <button type="button" class="drawer__close" data-testid="task-drawer-close" @click="tasks.drawerOpen = false">关闭</button>
      </header>

      <div class="drawer__body task-drawer__body">
        <div class="task-drawer__list">
          <h4>进行中（{{ unfinished.length }}）</h4>
          <button
            v-for="task in unfinished"
            :key="task.id"
            type="button"
            class="task-drawer__row"
            :class="{ 'task-drawer__row--active': task.id === selectedId }"
            :data-task-id="task.id"
            @click="openDetail(task.id)"
          >
            <span class="badge" :class="`badge--${taskStatusTone(task.status)}`">{{ taskStatusLabel(task.status) }}</span>
            <span>{{ task.sources && task.sources[0] ? task.sources[0].name : (task.archivePath || task.id.slice(0, 8)) }}</span>
            <span class="card__desc">{{ formatPercent(task.progress.percent || 0) }}</span>
          </button>
          <p v-if="unfinished.length === 0" class="card__desc">没有进行中的任务。</p>

          <h4>历史（{{ tasks.history.length }}，最多 200）</h4>
          <button
            v-for="item in tasks.history"
            :key="item.id"
            type="button"
            class="task-drawer__row"
            :class="{ 'task-drawer__row--active': item.id === selectedId }"
            :data-history-id="item.id"
            @click="openDetail(item.id)"
          >
            <span class="badge" :class="`badge--${taskStatusTone(item.status)}`">{{ taskStatusLabel(item.status) }}</span>
            <span>{{ item.sources && item.sources[0] ? item.sources[0].name : item.id.slice(0, 8) }}</span>
            <span class="card__desc">{{ formatDateTime(item.finishedAt || item.createdAt) }}</span>
          </button>
          <p v-if="tasks.history.length === 0" class="card__desc">暂无历史。</p>
        </div>

        <div class="task-drawer__detail" data-testid="task-detail">
          <template v-if="detail">
            <h4>详情</h4>
            <dl class="task-drawer__kv">
              <dt>ID</dt><dd><code>{{ detail.id }}</code></dd>
              <dt>类型</dt><dd>{{ detail.kind === 'extract' ? '解压' : '压缩' }} · {{ detail.format }}</dd>
              <dt>状态</dt><dd>{{ taskStatusLabel(detail.status) }} · {{ phaseLabel(detail) }}</dd>
              <dt>进度</dt><dd>{{ formatPercent(detail.progress.percent || 0) }} · {{ detail.progress.processedFiles || 0 }}/{{ detail.progress.totalFiles || 0 }} 文件 · {{ formatBytes(detail.progress.processedBytes || 0) }}</dd>
              <dt v-if="detail.progress.speedBps">速率</dt>
              <dd v-if="detail.progress.speedBps">{{ formatBytes(detail.progress.speedBps) }}/s · 剩余 {{ detail.progress.etaSeconds }}s</dd>
              <dt>创建</dt><dd>{{ formatDateTime(detail.createdAt) }}</dd>
              <dt v-if="detail.finishedAt">结束</dt><dd v-if="detail.finishedAt">{{ formatDateTime(detail.finishedAt) }}</dd>
              <dt v-if="detail.retryOf">重试自</dt><dd v-if="detail.retryOf"><code>{{ detail.retryOf }}</code></dd>
              <dt v-if="detail.error">错误</dt><dd v-if="detail.error"><code>{{ detail.error.code }}</code> {{ detail.error.message }}</dd>
              <dt v-if="detail.result">产物</dt>
              <dd v-if="detail.result">{{ (detail.result.packages || []).map((pkg) => pkg.outputPath).join('、') || '—' }}</dd>
            </dl>

            <div class="task-drawer__actions">
              <button
                v-if="['running', 'queued', 'cancelling'].includes(detail.status)"
                type="button"
                :disabled="busy"
                data-testid="detail-cancel"
                @click="run('cancel')"
              >
                取消任务
              </button>
              <button
                v-if="['failed', 'interrupted'].includes(detail.status)"
                type="button"
                :disabled="busy"
                data-testid="detail-retry"
                @click="run('retry')"
              >
                重试（新建任务）
              </button>
              <button
                v-if="detail.phase === 'waiting_confirm'"
                type="button"
                :disabled="busy"
                data-testid="detail-confirm-delete"
                @click="run('confirm-delete')"
              >
                确认删除（{{ detail.delete ? detail.delete.targets.length : 0 }} 项）
              </button>
            </div>
          </template>
          <p v-else class="card__desc">从左侧选一个任务查看详情。</p>

          <p v-if="errorText" class="login-form__error" data-testid="detail-error" role="alert">{{ errorText }}</p>
        </div>
      </div>
    </section>
  </div>
</template>
