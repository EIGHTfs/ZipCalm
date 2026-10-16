<script setup>
// 文件浏览页（M1 列表 + M2 压缩/解压入口）
//
// 数据来源：**只有 API**（docs/09 约定 1）。路径放 URL query（#/files?path=/文档），刷新/分享可恢复。
//
// M2 新增：
// - 多选（复选框列）→ 工具栏入口：压缩（≥1 项）、解压（恰好选 1 个归档，扩展名清单来自 GET /formats）；
// - 压缩抽屉（格式/模式/保留原文件）+ 解压对话框（目标目录 / 解压后删除压缩包）；
// - 任务进度面板（M2 用轮询，M3 换 SSE）；任务结束自动刷新目录（新产物/新解压目录立即可见）。

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../api/client.js';
import Icon from '../components/common/Icon.vue';
import CompressDrawer from '../components/compress/CompressDrawer.vue';
import ExtractDialog from '../components/compress/ExtractDialog.vue';
import TaskProgress from '../components/task/TaskProgress.vue';
import { useTasksStore } from '../stores/tasks.js';
import { ROUTES } from '../constants/index.js';
import { formatBytes, formatDateTime } from '../utils/format.js';
import { breadcrumbsOf, parentPath } from '../utils/path.js';

const route = useRoute();
const router = useRouter();

/** loading | ready | error */
const status = ref('loading');
const entries = ref([]);
const listing = ref({ path: '/', parent: null, total: 0, truncated: false });
const errorInfo = ref(null);
const sortKey = ref('name');
const order = ref('asc');

// M2：多选与操作面板
const selected = ref(new Map()); // path -> entry
const showCompress = ref(false);
const showExtract = ref(false);
/** 页面内展示的任务：优先最近提交的；否则跟随 store 里当前活动任务（刷新/重开页面也能看到进度） */
const submittedTaskId = ref(null);
const tasks = useTasksStore();
const activeTaskId = computed(() => submittedTaskId.value || (tasks.activeTask ? tasks.activeTask.id : null));

const currentPath = computed(() => {
  const value = route.query.path;
  return typeof value === 'string' && value.length > 0 ? value : '/';
});
const crumbs = computed(() => breadcrumbsOf(currentPath.value));
const upLevel = computed(() => parentPath(currentPath.value));

const selectedEntries = computed(() => [...selected.value.values()]);
const canCompress = computed(() => selectedEntries.value.length > 0);

// 可解压的扩展名**动态来自 GET /formats**（含 extAliases），不在前端写死 .zip：
// 这样注册表里多一个格式包目录，UI 立刻能识别它的归档（M4「加目录即注册」的 UI 侧闭环）。
// 注意必须按长度倒序比对，否则 `x.tar.gz` 会被更短的 `.gz` 规则先命中。
const archiveExts = ref([]);

async function loadArchiveExts() {
  try {
    const data = await api.get('/formats');
    const exts = [];
    for (const item of (data && data.formats) || []) {
      for (const candidate of [item.ext, ...(item.extAliases || [])]) {
        if (typeof candidate === 'string' && candidate.startsWith('.')) exts.push(candidate.toLowerCase());
      }
    }
    archiveExts.value = [...new Set(exts)].sort((a, b) => b.length - a.length);
  } catch {
    // 拉不到就退化为"仅按服务端预检判定"：不阻塞页面，解压入口保守置灰
    archiveExts.value = [];
  }
}

function looksLikeArchive(name) {
  const lower = String(name || '').toLowerCase();
  return archiveExts.value.some((ext) => lower.endsWith(ext));
}

const extractTarget = computed(() => {
  const items = selectedEntries.value;
  if (items.length !== 1) return null;
  const entry = items[0];
  return entry.type === 'file' && looksLikeArchive(entry.name) ? entry : null;
});

async function load() {
  status.value = 'loading';
  errorInfo.value = null;
  try {
    const data = await api.get('/fs/list', {
      path: currentPath.value,
      sort: sortKey.value,
      order: order.value,
    });
    entries.value = Array.isArray(data && data.entries) ? data.entries : [];
    listing.value = {
      path: (data && data.path) || currentPath.value,
      parent: data && typeof data.parent === 'string' ? data.parent : null,
      total: data && Number.isInteger(data.total) ? data.total : entries.value.length,
      truncated: Boolean(data && data.truncated),
    };
    status.value = 'ready';
  } catch (error) {
    errorInfo.value = {
      code: (error && error.code) || 'INTERNAL_ERROR',
      message: (error && error.message) || '加载目录失败',
    };
    entries.value = [];
    status.value = 'error';
  }
}

// 路径变化即重新拉取；换目录时清空选择（避免"跨目录选中"造成误操作）
watch(
  currentPath,
  () => {
    selected.value = new Map();
    load();
  },
  { immediate: true },
);

// 可解压扩展名清单：挂载时拉一次即可（目录切换与它无关）
onMounted(loadArchiveExts);

function goto(path) {
  const target = typeof path === 'string' && path.length > 0 ? path : '/';
  router.push(target === '/' ? { path: ROUTES.FILES } : { path: ROUTES.FILES, query: { path: target } });
}

function openEntry(entry) {
  if (entry.type === 'dir') goto(entry.path);
}

function changeSort(key) {
  if (sortKey.value === key) order.value = order.value === 'asc' ? 'desc' : 'asc';
  else {
    sortKey.value = key;
    order.value = 'asc';
  }
  load();
}

function sortIndicator(key) {
  if (sortKey.value !== key) return '';
  return order.value === 'asc' ? '↑' : '↓';
}

function toggleSelect(entry) {
  const next = new Map(selected.value);
  if (next.has(entry.path)) next.delete(entry.path);
  else next.set(entry.path, entry);
  selected.value = next;
}

function isSelected(entry) {
  return selected.value.has(entry.path);
}

function onSubmitted(taskId) {
  showCompress.value = false;
  showExtract.value = false;
  submittedTaskId.value = taskId;
}

/** 收起面板后回到"跟随当前活动任务" */
function dismissTaskPanel() {
  submittedTaskId.value = null;
}

/** 任务终态：刷新目录（新产物/新解压目录要立刻可见） */
function onTaskFinished() {
  load();
}

function typeLabel(entry) {
  if (entry.type === 'dir') return '目录';
  if (entry.type === 'symlink') return '链接';
  return (entry.extension || '').replace('.', '').toUpperCase() || '文件';
}

function rowIcon(entry) {
  return entry.type === 'dir' ? 'files' : 'file';
}
</script>

<template>
  <section class="card file-browser" data-testid="files-page">
    <div class="file-browser__toolbar">
      <button type="button" data-testid="go-up" :disabled="!upLevel" @click="goto(upLevel)">← 上级</button>

      <nav class="file-browser__crumbs" aria-label="面包屑" data-testid="files-breadcrumb">
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <span v-if="index > 0" aria-hidden="true">/</span>
          <button
            type="button"
            class="file-browser__crumb"
            :aria-current="index === crumbs.length - 1 ? 'page' : undefined"
            @click="goto(crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </nav>

      <div class="topbar__spacer"></div>

      <span v-if="selectedEntries.length > 0" class="badge" data-testid="selection-count">已选 {{ selectedEntries.length }} 项</span>
      <button type="button" :disabled="!canCompress" data-testid="open-compress" @click="showCompress = true">压缩</button>
      <button type="button" :disabled="!extractTarget" data-testid="open-extract" @click="showExtract = true">解压</button>
      <button type="button" data-testid="reload" :disabled="status === 'loading'" @click="load">刷新</button>
    </div>

    <p v-if="status === 'loading'" class="file-browser__hint" data-testid="files-loading">正在加载目录…</p>

    <template v-else-if="status === 'error'">
      <div class="file-browser__error" data-testid="files-error" role="alert">
        <strong>加载失败</strong>
        <span class="badge badge--error">{{ errorInfo.code }}</span>
        <p>{{ errorInfo.message }}</p>
        <button type="button" @click="load">重试</button>
      </div>
    </template>

    <template v-else-if="entries.length === 0">
      <div class="file-browser__empty" data-testid="files-empty">
        <p>这个目录是空的。</p>
        <p class="card__desc">当前路径：{{ listing.path }}</p>
      </div>
    </template>

    <table v-else class="file-table" data-testid="files-table">
      <thead>
        <tr>
          <th scope="col" class="file-table__col-check"></th>
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('name')">名称 {{ sortIndicator('name') }}</button>
          </th>
          <th scope="col" class="file-table__col-type">类型</th>
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('size')">大小 {{ sortIndicator('size') }}</button>
          </th>
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('mtime')">修改时间 {{ sortIndicator('mtime') }}</button>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in entries"
          :key="entry.path"
          class="file-table__row"
          :class="{ 'file-table__row--dir': entry.type === 'dir' }"
          :data-name="entry.name"
          :data-type="entry.type"
          @click="openEntry(entry)"
        >
          <td class="file-table__col-check" @click.stop>
            <input
              type="checkbox"
              :checked="isSelected(entry)"
              :aria-label="`选择 ${entry.name}`"
              :data-select="entry.name"
              @change="toggleSelect(entry)"
            />
          </td>
          <td>
            <span class="file-table__name">
              <Icon :name="rowIcon(entry)" :size="15" />
              <span>{{ entry.name }}</span>
            </span>
          </td>
          <td class="file-table__col-type">{{ typeLabel(entry) }}</td>
          <td class="file-table__size">{{ entry.type === 'dir' ? '—' : formatBytes(entry.size) }}</td>
          <td class="file-table__mtime">{{ formatDateTime(entry.mtime) }}</td>
        </tr>
      </tbody>
    </table>

    <p v-if="status === 'ready'" class="file-browser__hint">
      共 {{ listing.total }} 项<template v-if="listing.truncated">（已截断，仅显示前 {{ entries.length }} 项）</template>
    </p>
  </section>

  <TaskProgress :task-id="activeTaskId" @finished="onTaskFinished" @dismiss="dismissTaskPanel" />

  <CompressDrawer
    :open="showCompress"
    :sources="selectedEntries"
    @close="showCompress = false"
    @submitted="onSubmitted"
  />

  <ExtractDialog
    :open="showExtract"
    :archive-path="extractTarget ? extractTarget.path : ''"
    @close="showExtract = false"
    @submitted="onSubmitted"
  />
</template>
