<script setup>
// 任务抽屉（M3）：进行中 + 历史 + 详情/操作
//
// 数据来自 `stores/tasks.js`（SSE 单一数据源）；打开时补拉一次历史（历史来自 task-history.jsonl 的内存缓存）。
// 操作：取消（运行中）、重试（failed/interrupted → **新建任务** + retryOf）、确认删除（waiting_confirm）、
// **删除活动记录**（仅终态可点；非终态置灰，且要两步确认；只动 tasks.json，历史不动）。
// 契约：docs/M0/数据模型.md §3.2（重试=新任务）/ §六 规则 8（DELETE 只删活动记录）、API 规范 §3.3。

import { computed, ref, watch } from 'vue';

import { useTasksStore } from '../../stores/tasks.js';
import { formatBytes, formatDateTime, formatPercent } from '../../utils/format.js';
import { TASK_PHASE_LABELS, taskStatusLabel, taskStatusTone } from '../../constants/index.js';

const TERMINAL_STATUSES = ['done', 'failed', 'aborted', 'interrupted'];

const tasks = useTasksStore();
const selectedId = ref(null);
const detail = ref(null);
const errorText = ref('');
const busy = ref(false);
/** 两步确认：非 null 时该行显示「确认删除 / 取消」 */
const pendingDeleteId = ref(null);

const unfinished = computed(() => tasks.unfinished);
const retryable = computed(() => tasks.retryable);

function isTerminal(task) {
  return Boolean(task && TERMINAL_STATUSES.includes(task.status));
}

function phaseLabel(task) {
  if (!task) return '';
  if (task.phase === 'waiting_confirm') return '待确认删除';
  return TASK_PHASE_LABELS[task.phase] || task.phase || '';
}

function taskTitle(task) {
  if (!task) return '';
  if (task.sources && task.sources[0]) return task.sources[0].name;
  return task.archivePath || task.id.slice(0, 8);
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
      return;
    }
    if (action === 'confirm-delete') {
      const count = detail.value && detail.value.delete ? detail.value.delete.targets.length : 0;
      await tasks.confirmDelete(selectedId.value, count);
    }
    await openDetail(selectedId.value);
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    busy.value = false;
  }
}

/** 删除活动记录（两步确认后的第二步）；删完列表由 store 本地即时更新 */
async function confirmRemove(id) {
  if (busy.value) return;
  busy.value = true;
  errorText.value = '';
  try {
    await tasks.remove(id);
    pendingDeleteId.value = null;
    if (selectedId.value === id) {
      selectedId.value = null;
      detail.value = null;
    }
  } catch (error) {
    errorText.value = `[${error.code || 'ERROR'}] ${error.message}`;
  } finally {
    busy.value = false;
  }
}

watch(
  () => tasks.drawerOpen,
  (open) => {
    if (!open) {
      pendingDeleteId.value = null;
      return;
    }
    tasks.loadHistory(50).catch(() => {});
    if (!selectedId.value && tasks.activeTask) openDetail(tasks.activeTask.id);
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
          <div
            v-for="task in unfinished"
            :key="task.id"
            class="task-drawer__row"
            :class="{ 'task-drawer__row--active': task.id === selectedId }"
            :data-task-id="task.id"
            role="button"
            tabindex="0"
            @click="openDetail(task.id)"
          >
            <span class="badge" :class="`badge--${taskStatusTone(task.status)}`">{{ taskStatusLabel(task.status) }}</span>
            <span>{{ taskTitle(task) }}</span>
            <span class="card__desc">{{ formatPercent(task.progress.percent || 0) }}</span>
            <span class="topbar__spacer"></span>
            <button type="button" disabled title="任务未结束，请先取消再删除记录">删除</button>
          </div>
          <p v-if="unfinished.length === 0" class="card__desc">没有进行中的任务。</p>

          <h4>待重试 / 待清理（{{ retryable.length }}）</h4>
          <div
            v-for="task in retryable"
            :key="task.id"
            class="task-drawer__row"
            :class="{ 'task-drawer__row--active': task.id === selectedId }"
            :data-retryable-id="task.id"
            role="button"
            tabindex="0"
            @click="openDetail(task.id)"
          >
            <span class="badge" :class="`badge--${taskStatusTone(task.status)}`">{{ taskStatusLabel(task.status) }}</span>
            <span>{{ taskTitle(task) }}</span>
            <span class="topbar__spacer"></span>
            <button
              v-if="pendingDeleteId !== task.id"
              type="button"
              :data-delete="task.id"
              @click.stop="pendingDeleteId = task.id"
            >
              删除
            </button>
            <template v-else>
              <button type="button" :disabled="busy" :data-confirm-delete="task.id" @click.stop="confirmRemove(task.id)">
                确认删除
              </button>
              <button type="button" @click.stop="pendingDeleteId = null">取消</button>
            </template>
          </div>
          <p v-if="retryable.length === 0" class="card__desc">没有待重试或待清理的记录。</p>

          <h4>历史（{{ tasks.history.length }}，最多 200）</h4>
          <div
            v-for="item in tasks.history"
            :key="item.id"
            class="task-drawer__row"
            :class="{ 'task-drawer__row--active': item.id === selectedId }"
            :data-history-id="item.id"
            role="button"
            tabindex="0"
            @click="openDetail(item.id)"
          >
            <span class="badge" :class="`badge--${taskStatusTone(item.status)}`">{{ taskStatusLabel(item.status) }}</span>
            <span>{{ taskTitle(item) }}</span>
            <span class="card__desc">{{ formatDateTime(item.finishedAt || item.createdAt) }}</span>
            <span class="topbar__spacer"></span>
            <span v-if="!tasks.hasActiveRecord(item.id)" class="badge" data-history-only>仅历史</span>
            <button
              v-else-if="pendingDeleteId !== item.id"
              type="button"
              :data-delete="item.id"
              @click.stop="pendingDeleteId = item.id"
            >
              删除
            </button>
            <template v-else>
              <button type="button" :disabled="busy" :data-confirm-delete="item.id" @click.stop="confirmRemove(item.id)">
                确认删除
              </button>
              <button type="button" @click.stop="pendingDeleteId = null">取消</button>
            </template>
          </div>
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
              <button
                v-if="isTerminal(detail)"
                type="button"
                :disabled="busy"
                data-testid="detail-remove"
                @click="confirmRemove(detail.id)"
              >
                删除记录
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
