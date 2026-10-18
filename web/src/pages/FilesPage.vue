<script setup>
// 文件浏览页（M1 列表 + M2 压缩/解压入口）
//
// 数据来源：**只有 API**（docs/09 约定 1）。路径放 URL query（#/files?path=/文档），刷新/分享可恢复。
//
// M2 新增：
// - 多选（复选框列）→ 工具栏入口：压缩（≥1 项）、解压（恰好选 1 个归档，扩展名清单来自 GET /formats）；
// - 压缩抽屉（格式/模式/保留原文件）+ 解压对话框（目标目录 / 解压后删除压缩包）；
// - 任务进度面板（M2 用轮询，M3 换 SSE）；任务结束自动刷新目录（新产物/新解压目录立即可见）。

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../api/client.js';
import Icon from '../components/common/Icon.vue';
import ContextMenu from '../components/common/ContextMenu.vue';
import PromptDialog from '../components/common/PromptDialog.vue';
import DirectoryTree from '../components/layout/DirectoryTree.vue';
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

// ===== M8：右键菜单 / 快捷键 / 拖拽（桌面侧）=====
const rootRef = ref(null);
const contextMenu = ref({ open: false, x: 0, y: 0, target: null });
/** 统一对话框状态（重命名 / 新建文件夹 / 删除确认 / 移动目标共用一个组件） */
const promptState = ref({ open: false, mode: 'prompt', title: '', label: '', value: '', danger: false, busy: false, submit: null });
/** 键盘焦点行（上下箭头移动）；-1 表示没有焦点行 */
const focusIndex = ref(-1);
const dragPaths = ref([]);
const dropActive = ref(false);
/** 操作结果提示（成功/失败都走这一条，避免页面里到处散落 alert） */
const actionNotice = ref('');
const actionError = ref('');
const activeTaskId = computed(() => submittedTaskId.value || (tasks.activeTask ? tasks.activeTask.id : null));

const currentPath = computed(() => {
  const pathParam = route.query.path;
  return typeof pathParam === 'string' && pathParam.length > 0 ? pathParam : '/';
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
    const formatsResponse = await api.get('/formats');
    const collectedExts = [];
    for (const formatInfo of (formatsResponse && formatsResponse.formats) || []) {
      for (const extCandidate of [formatInfo.ext, ...(formatInfo.extAliases || [])]) {
        if (typeof extCandidate === 'string' && extCandidate.startsWith('.')) {
          collectedExts.push(extCandidate.toLowerCase());
        }
      }
    }
    archiveExts.value = [...new Set(collectedExts)].sort((a, b) => b.length - a.length);
  } catch {
    // 拉不到就退化为"仅按服务端预检判定"：不阻塞页面，解压入口保守置灰
    archiveExts.value = [];
  }
}

function looksLikeArchive(fileName) {
  const lowerName = String(fileName || '').toLowerCase();
  return archiveExts.value.some((ext) => lowerName.endsWith(ext));
}

const extractTarget = computed(() => {
  const pickedEntries = selectedEntries.value;
  if (pickedEntries.length !== 1) return null;
  const onlyEntry = pickedEntries[0];
  return onlyEntry.type === 'file' && looksLikeArchive(onlyEntry.name) ? onlyEntry : null;
});

/** 把 /fs/list 的信封数据落到页面状态（缺字段给安全默认，不让 undefined 流到界面） */
function applyListingPayload(listingPayload) {
  entries.value = Array.isArray(listingPayload && listingPayload.entries) ? listingPayload.entries : [];
  listing.value = {
    path: (listingPayload && listingPayload.path) || currentPath.value,
    parent: listingPayload && typeof listingPayload.parent === 'string' ? listingPayload.parent : null,
    total: listingPayload && Number.isInteger(listingPayload.total) ? listingPayload.total : entries.value.length,
    truncated: Boolean(listingPayload && listingPayload.truncated),
  };
  // 焦点行跟随新列表（否则上下箭头可能落在已不存在的索引上）
  focusIndex.value = entries.value.length > 0 ? 0 : -1;
}

/** 加载失败：把契约错误码与文案收进 errorInfo，并清空列表（避免展示上一目录的残留） */
function applyListingError(error) {
  errorInfo.value = {
    code: (error && error.code) || 'INTERNAL_ERROR',
    message: (error && error.message) || '加载目录失败',
  };
  entries.value = [];
  status.value = 'error';
}

async function load() {
  status.value = 'loading';
  errorInfo.value = null;
  try {
    applyListingPayload(await api.get('/fs/list', {
      path: currentPath.value,
      sort: sortKey.value,
      order: order.value,
    }));
    status.value = 'ready';
  } catch (error) {
    applyListingError(error);
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

// ===== M8：右键菜单 =====

/**
 * 打开右键菜单。
 * 右键点在**未选中**的行上时，先把选择切成该行（与桌面文件管理器一致）；
 * 点在已选中的行上则保留多选（用户可能想批量操作）。
 */
function openContextMenu(event, target) {
  if (target && !isSelected(target)) {
    selected.value = new Map([[target.path, target]]);
  }
  contextMenu.value = { open: true, x: event.clientX, y: event.clientY, target };
}

const menuTarget = computed(() => contextMenu.value.target);

/** 菜单项按"目标类型"分组：文件 / 目录 / 空白处三套内容不同 */
const menuItems = computed(() => {
  const target = menuTarget.value;
  const multiCount = selected.value.size;
  const items = [];

  if (target) {
    items.push({ key: 'compress', label: multiCount > 1 ? `压缩选中的 ${multiCount} 项` : '压缩' });
    if (target.type === 'dir') items.push({ key: 'enter', label: '进入目录' });
    if (target.type === 'file' && looksLikeArchive(target.name)) items.push({ key: 'extract', label: '解压' });
    items.push({ divider: true });
    items.push({ key: 'rename', label: '重命名', shortcut: 'F2', disabled: multiCount > 1 });
    items.push({ key: 'move', label: '移动到…', disabled: multiCount === 0 });
    items.push({ key: 'copy-path', label: '复制路径' });
    items.push({ divider: true });
    items.push({ key: 'delete', label: `删除${multiCount > 1 ? ` ${multiCount} 项` : ''}`, shortcut: 'Delete', danger: true });
    return items;
  }

  // 空白处：整页级操作
  items.push({ key: 'compress', label: multiCount > 0 ? `压缩选中的 ${multiCount} 项` : '压缩', disabled: multiCount === 0 });
  items.push({ key: 'select-all', label: '全选', shortcut: 'Ctrl+A' });
  items.push({ key: 'mkdir', label: '新建文件夹' });
  items.push({ divider: true });
  items.push({ key: 'reload', label: '刷新' });
  return items;
});

/** 菜单动作分发 */
function pickMenuItem(key) {
  const target = menuTarget.value;
  switch (key) {
    case 'compress':
      if (selected.value.size > 0) showCompress.value = true;
      break;
    case 'extract':
      if (target) selectOnly(target);
      showExtract.value = true;
      break;
    case 'enter':
      if (target) goto(target.path);
      break;
    case 'rename':
      if (target) openRename(target);
      break;
    case 'move':
      openMove();
      break;
    case 'copy-path':
      void copyPath(target);
      break;
    case 'delete':
      openDeleteConfirm();
      break;
    case 'select-all':
      selectAll();
      break;
    case 'mkdir':
      openMkdir();
      break;
    case 'reload':
      void load();
      break;
    default:
      break;
  }
}

/** 只选中某一项（用于"对单个文件解压"这类动作） */
function selectOnly(entry) {
  selected.value = new Map([[entry.path, entry]]);
}

function selectAll() {
  selected.value = new Map(entries.value.map((entry) => [entry.path, entry]));
}

function clearSelection() {
  selected.value = new Map();
}

/** 统一打开对话框（submit 由调用方给，成功/失败提示也由它处理） */
function openPrompt(config) {
  promptState.value = { open: true, mode: 'prompt', title: '', label: '', value: '', danger: false, busy: false, ...config };
}

function closePrompt() {
  promptState.value = { ...promptState.value, open: false, busy: false };
}

async function confirmPrompt(value) {
  const submit = promptState.value.submit;
  if (!submit) {
    closePrompt();
    return;
  }
  promptState.value = { ...promptState.value, busy: true };
  try {
    await submit(value);
    closePrompt();
  } catch (error) {
    actionError.value = `[${error.code || 'ERROR'}] ${error.message}`;
    promptState.value = { ...promptState.value, busy: false };
  }
}

/** 操作后统一提示 + 失败交给 error 字段 */
function notice(text) {
  actionError.value = '';
  actionNotice.value = text;
  window.setTimeout(() => { actionNotice.value = ''; }, 2500);
}

function fail(error) {
  actionNotice.value = '';
  actionError.value = `[${error.code || 'ERROR'}] ${error.message}`;
}

async function copyPath(entry) {
  if (!entry) return;
  // 为什么需要两级：navigator.clipboard 只在**安全上下文**（https 或 localhost）可用，
  // 而本项目的实际部署是局域网 http（http://<NAS>:3010）——只用新 API 会在这类环境里直接失败。
  try {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(entry.path);
      notice(`已复制：${entry.path}`);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = entry.path;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand && document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) throw new Error('复制失败（浏览器不允许剪贴板操作）');
    notice(`已复制：${entry.path}`);
  } catch (error) {
    fail(error);
  }
}

function openRename(entry) {
  openPrompt({
    title: '重命名',
    label: '新名称（不能包含 / ）',
    value: entry.name,
    submit: async (newName) => {
      if (newName === entry.name) return;
      await api.post('/fs/rename', { path: entry.path, newName });
      notice(`已重命名为 ${newName}`);
      await load();
    },
  });
}

function openDeleteConfirm() {
  const targets = selectedEntries.value;
  if (targets.length === 0) return;
  const summary = targets.length === 1 ? targets[0].path : `${targets[0].path} 等 ${targets.length} 项`;
  openPrompt({
    mode: 'confirm',
    title: '删除',
    label: `将把 ${summary} 移入回收站（可在 storage/trash 恢复）。确定删除？`,
    danger: true,
    submit: async () => {
      const result = await api.post('/fs/delete', { paths: targets.map((entry) => entry.path) });
      const moved = (result && result.deleted && result.deleted.length) || 0;
      notice(`已移入回收站：${moved} 项`);
      clearSelection();
      await load();
    },
  });
}

function openMkdir() {
  openPrompt({
    title: '新建文件夹',
    label: '文件夹名称',
    value: '',
    submit: async (name) => {
      const parent = currentPath.value === '/' ? '' : currentPath.value;
      await api.post('/fs/mkdir', { path: `${parent}/${name}` });
      notice(`已创建 ${name}`);
      await load();
    },
  });
}

/** 移动到…：v1 用输入目标路径（触屏批次会换成底部抽屉里的目录选择） */
function openMove() {
  const targets = selectedEntries.value;
  if (targets.length === 0) return;
  openPrompt({
    title: '移动到',
    label: '目标目录（例如 /备份/2024）',
    value: currentPath.value,
    submit: async (targetDir) => {
      const result = await api.post('/fs/move', { paths: targets.map((entry) => entry.path), targetDir });
      const movedCount = (result && result.moved && result.moved.length) || 0;
      notice(`已移动 ${movedCount} 项到 ${targetDir}`);
      clearSelection();
      await load();
    },
  });
}

async function onTreeDrop({ paths, targetDir }) {
  try {
    const result = await api.post('/fs/move', { paths, targetDir });
    notice(`已移动 ${(result && result.moved && result.moved.length) || 0} 项到 ${targetDir}`);
    clearSelection();
    await load();
  } catch (error) {
    fail(error);
  }
}

// ===== M8：快捷键（不碰鼠标也能走完 浏览 → 多选 → 压缩）=====

/** 输入框里按快捷键不能劫持（否则回车/删除都乱掉） */
function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName ? target.tagName.toLowerCase() : '';
  return tag === 'input' || tag === 'textarea' || target.isContentEditable === true;
}

function moveFocus(delta) {
  if (entries.value.length === 0) return;
  const next = Math.max(0, Math.min(entries.value.length - 1, focusIndex.value + delta));
  focusIndex.value = next;
  const entry = entries.value[next];
  if (entry && !isSelected(entry)) selectOnly(entry); // 焦点行与选择同步，Enter 才有明确目标
  const row = rootRef.value ? rootRef.value.querySelector(`tr[data-name="${CSS.escape(entry.name)}"]`) : null;
  if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
}

function mainSelectedEntries() {
  return selectedEntries.value.length > 0 ? selectedEntries.value : (focusIndex.value >= 0 ? [entries.value[focusIndex.value]].filter(Boolean) : []);
}

function onGlobalKeyDown(event) {
  if (isTypingTarget(event.target)) return;
  if (promptState.value.open) {
    if (event.key === 'Escape') closePrompt();
    return;
  }
  if (contextMenu.value.open) {
    if (event.key === 'Escape') contextMenu.value = { ...contextMenu.value, open: false };
    return;
  }

  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selectAll();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Enter') {
    const targets = mainSelectedEntries();
    if (targets.length === 1) {
      event.preventDefault();
      if (targets[0].type === 'dir') goto(targets[0].path);
      else if (looksLikeArchive(targets[0].name)) showExtract.value = true;
      else showCompress.value = true;
    }
    return;
  }
  if (event.key === 'F2') {
    // 多选时 F2 仍应可用：语义是"重命名当前焦点行"（而不是要求先取消多选）
    const focused = focusIndex.value >= 0 ? entries.value[focusIndex.value] : null;
    const target = focused || (selectedEntries.value.length === 1 ? selectedEntries.value[0] : null);
    if (target) {
      event.preventDefault();
      openRename(target);
    }
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (selected.value.size > 0) {
      event.preventDefault();
      openDeleteConfirm();
    }
    return;
  }
  if (event.key === 'Escape') clearSelection();
}

// ===== M8：拖拽（桌面保留 DnD；触屏走长按 + 底部操作栏）=====

function onRowDragStart(entry, event) {
  const paths = isSelected(entry) ? selectedEntries.value.map((item) => item.path) : [entry.path];
  dragPaths.value = paths;
  event.dataTransfer.setData('application/x-zipcalm-paths', JSON.stringify(paths));
  event.dataTransfer.setData('text/plain', paths.join('\n'));
  event.dataTransfer.effectAllowed = 'move';
}

function onRowDragEnd() {
  dragPaths.value = [];
  dropActive.value = false;
}

/** 拖到"压缩"区：把拖来的项直接变成当前选择并打开抽屉 */
function onCompressDropZone(event) {
  event.preventDefault();
  dropActive.value = false;
  try {
    const paths = JSON.parse(event.dataTransfer.getData('application/x-zipcalm-paths') || '[]');
    if (!Array.isArray(paths) || paths.length === 0) return;
    selected.value = new Map(entries.value.filter((entry) => paths.includes(entry.path)).map((entry) => [entry.path, entry]));
    if (selected.value.size > 0) showCompress.value = true;
  } catch (error) {
    fail(error);
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeyDown);
});
</script>

<template>
  <section ref="rootRef" class="card file-browser" data-testid="files-page" @contextmenu.prevent="openContextMenu($event, null)">
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
      <button
        type="button"
        :disabled="!canCompress"
        :class="{ 'drop-target': dropActive }"
        data-testid="open-compress"
        title="把文件拖到这里可直接压缩"
        @click="showCompress = true"
        @dragover.prevent="dropActive = true"
        @dragleave="dropActive = false"
        @drop="onCompressDropZone"
      >压缩</button>
      <button type="button" :disabled="!extractTarget" data-testid="open-extract" @click="showExtract = true">解压</button>
      <button type="button" data-testid="reload" :disabled="status === 'loading'" @click="load">刷新</button>
    </div>

    <div class="file-browser__split">
      <aside class="file-browser__tree-pane">
        <DirectoryTree :current-path="currentPath" @navigate="goto" @drop-paths="onTreeDrop" />
      </aside>
      <div class="file-browser__content">

    <p v-if="actionNotice" class="file-browser__hint" data-testid="action-notice">✅ {{ actionNotice }}</p>
    <p v-if="actionError" class="login-form__error" role="alert" data-testid="action-error">{{ actionError }}</p>

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
          v-for="(entry, index) in entries"
          :key="entry.path"
          class="file-table__row"
          :class="{
            'file-table__row--dir': entry.type === 'dir',
            'file-table__row--focused': index === focusIndex,
            'file-table__row--selected': isSelected(entry),
          }"
          :data-name="entry.name"
          :data-type="entry.type"
          draggable="true"
          @click="openEntry(entry)"
          @contextmenu.prevent.stop="openContextMenu($event, entry)"
          @dragstart="onRowDragStart(entry, $event)"
          @dragend="onRowDragEnd"
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
              <!-- 黑名单角标：服务端已返回 blacklisted/blacklistLayer（契约 §4.2），这里只是把它显示出来，
                   让用户一眼看出"压了也几乎不省空间"，不用等选中后在抽屉里才发现被跳过 -->
              <span
                v-if="entry.blacklisted"
                class="badge"
                data-testid="blacklist-badge"
                :title="`命中黑名单（${entry.blacklistLayer} 层）：压缩时会跳过，不会进包也不会被删除`"
              >已压缩格式</span>
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
      </div>
    </div>
  </section>

  <ContextMenu
    :open="contextMenu.open"
    :x="contextMenu.x"
    :y="contextMenu.y"
    :items="menuItems"
    @close="contextMenu = { ...contextMenu, open: false }"
    @pick="pickMenuItem"
  />

  <PromptDialog
    :open="promptState.open"
    :mode="promptState.mode"
    :title="promptState.title"
    :label="promptState.label"
    :value="promptState.value"
    :danger="promptState.danger"
    :busy="promptState.busy"
    @confirm="confirmPrompt"
    @cancel="closePrompt"
  />

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
