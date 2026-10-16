<script setup>
// 文件浏览页（M1：真实联调 GET /api/v1/fs/list）
//
// 状态来源：**只有 API**（docs/09 约定 1）。当前路径放在 URL query（#/files?path=/文档），
// 这样刷新/分享/回退都能恢复，符合"状态可从 API/URL 拉回"的约定。
//
// 交互（docs/08 第八节，鼠标优先）：
// - 点目录行进入；面包屑可跳任意上级；「上级」按钮在根目录置灰；
// - 列头可点排序（名称/大小/修改时间），排序参数交给服务端（服务端是唯一真相）。
//
// 错误态：展示后端契约错误码 + message（如 PATH_NOT_FOUND / PERMISSION_DENIED），
// 401 由 client.js 的统一钩子处理（跳登录页），页面不重复处理。

import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { api } from '../api/client.js';
import Icon from '../components/common/Icon.vue';
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
const lastLoadedAt = ref(null);

const currentPath = computed(() => {
  const value = route.query.path;
  return typeof value === 'string' && value.length > 0 ? value : '/';
});
const crumbs = computed(() => breadcrumbsOf(currentPath.value));
const upLevel = computed(() => parentPath(currentPath.value));

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
    lastLoadedAt.value = Date.now();
    status.value = 'ready';
  } catch (error) {
    // 契约错误码优先；网络类错误由 client.js 归一到 SERVICE_UNAVAILABLE
    errorInfo.value = {
      code: (error && error.code) || 'INTERNAL_ERROR',
      message: (error && error.message) || '加载目录失败',
    };
    entries.value = [];
    status.value = 'error';
  }
}

// 路径变化即重新拉取（immediate：首屏也走同一路径，避免"两套初始化逻辑"）
watch(currentPath, load, { immediate: true });

function goto(path) {
  const target = typeof path === 'string' && path.length > 0 ? path : '/';
  router.push(target === '/' ? { path: ROUTES.FILES } : { path: ROUTES.FILES, query: { path: target } });
}

function openEntry(entry) {
  if (entry.type === 'dir') goto(entry.path);
}

function changeSort(key) {
  if (sortKey.value === key) {
    order.value = order.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    order.value = 'asc';
  }
  load();
}

function sortIndicator(key) {
  if (sortKey.value !== key) return '';
  return order.value === 'asc' ? '↑' : '↓';
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
      <button
        type="button"
        data-testid="go-up"
        :disabled="!upLevel"
        @click="goto(upLevel)"
      >
        ← 上级
      </button>

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
      <button type="button" data-testid="reload" :disabled="status === 'loading'" @click="load">
        刷新
      </button>
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
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('name')">
              名称 {{ sortIndicator('name') }}
            </button>
          </th>
          <th scope="col" class="file-table__col-type">类型</th>
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('size')">
              大小 {{ sortIndicator('size') }}
            </button>
          </th>
          <th scope="col">
            <button type="button" class="file-table__sort" @click="changeSort('mtime')">
              修改时间 {{ sortIndicator('mtime') }}
            </button>
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
</template>
