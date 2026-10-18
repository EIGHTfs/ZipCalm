<script setup>
// 顶部栏（docs/08 第八节布局图第一行）
// 内容：品牌 | 面包屑 | 搜索 | 视图切换 | 用户态 + 登出
//
// M1 变更：
// - 面包屑改为**跟随当前浏览路径**（ui store 由 route.query.path 推导）；
// - 用户态从占位变成真实登录态，并新增「登出」按钮（调用 POST /auth/logout）。
//
// 搜索：只在当前存储根内按文件名匹配（后端有界遍历，见 server/core/fs/search.js）。

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { api } from '../../api/client.js';
import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import {
  APP_NAME,
  APP_NAME_ZH,
  ROUTES,
  VIEW_MODES,
  VIEW_MODE_LABELS,
} from '../../constants/index.js';

const ui = useUiStore();
const session = useSessionStore();
const router = useRouter();

const crumbs = computed(() => ui.breadcrumbs);
const viewModes = VIEW_MODES;

async function handleLogout() {
  await session.logout();
  await router.replace({ path: ROUTES.LOGIN });
}

// ===== 搜索（docs/16 批次②需求①）：只在当前根内、有界遍历，未输入不请求 =====
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX_SHOWN = 10;
const query = ref('');
const results = ref([]);
const resultsOpen = ref(false);
const searching = ref(false);
const searchError = ref('');
const truncated = ref(false);
let debounceTimer = null;

/** 父目录（用于"搜到文件后跳到它所在目录"） */
function parentOf(userPath) {
  const parent = userPath.split('/').slice(0, -1).join('/');
  return parent.length === 0 ? '/' : parent;
}

function closeResults() {
  resultsOpen.value = false;
}

async function runSearch() {
  const keyword = query.value.trim();
  if (keyword.length === 0) {
    results.value = [];
    resultsOpen.value = false;
    return;
  }
  searching.value = true;
  searchError.value = '';
  try {
    const payload = await api.get('/fs/search', { q: keyword, rootId: ui.currentRootId, limit: SEARCH_MAX_SHOWN });
    results.value = (payload && payload.items) || [];
    truncated.value = Boolean(payload && payload.truncated);
    resultsOpen.value = true;
  } catch (error) {
    searchError.value = `[${error.code || 'ERROR'}] ${error.message}`;
    resultsOpen.value = true;
  } finally {
    searching.value = false;
  }
}

/** 输入防抖：连续敲字只发最后一次（搜索是遍历型操作，不能每键一次） */
function onQueryInput() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (query.value.trim().length === 0) {
    results.value = [];
    resultsOpen.value = false;
    return;
  }
  debounceTimer = setTimeout(() => { void runSearch(); }, SEARCH_DEBOUNCE_MS);
}

function openResult(item) {
  const target = item.type === 'dir' ? item.path : parentOf(item.path);
  closeResults();
  void router.push({ path: ROUTES.FILES, query: { path: target } });
}

function openFirstResult() {
  if (results.value.length > 0) openResult(results.value[0]);
}
</script>

<template>
  <header class="topbar" data-region="topbar">
    <!-- 触屏：侧栏改为抽屉，这里提供开关（桌面隐藏，见 CSS） -->
    <button
      type="button"
      class="topbar__menu"
      data-testid="sidebar-toggle"
      aria-label="打开导航"
      :aria-expanded="ui.sidebarOpen ? 'true' : 'false'"
      @click="ui.toggleSidebar()"
    >☰</button>
    <div class="topbar__brand">
      {{ APP_NAME }}
      <span class="topbar__brand-sub">{{ APP_NAME_ZH }}</span>
    </div>

    <nav class="topbar__crumbs" aria-label="面包屑" data-testid="topbar-breadcrumb">
      <template v-for="(crumb, index) in crumbs" :key="crumb.path">
        <span v-if="index > 0" aria-hidden="true">/</span>
        <span :aria-current="index === crumbs.length - 1 ? 'page' : undefined">{{ crumb.label }}</span>
      </template>
    </nav>

    <div class="topbar__search">
      <label class="visually-hidden" for="topbar-search">搜索文件</label>
      <input
        id="topbar-search"
        v-model="query"
        type="search"
        placeholder="搜索当前根内的文件"
        data-testid="topbar-search"
        autocomplete="off"
        @input="onQueryInput"
        @keydown.enter.prevent="openFirstResult"
        @keydown.esc="closeResults"
        @focus="onQueryInput"
      />
      <!-- 结果下拉：只展示前 10 条，其余在空状态里说明（搜索本身有 500 条上限） -->
      <div v-if="resultsOpen" class="search-results" data-testid="search-results">
        <p v-if="searching" class="search-results__hint">搜索中…</p>
        <p v-else-if="searchError" class="search-results__hint">{{ searchError }}</p>
        <p v-else-if="results.length === 0" class="search-results__hint">没有匹配的文件名</p>
        <ul v-else>
          <li v-for="item in results" :key="item.path">
            <button type="button" class="search-results__item" :data-testid="`search-hit-${item.name}`" @click="openResult(item)">
              <span class="search-results__name">{{ item.name }}</span>
              <span class="search-results__path">{{ item.path }}</span>
            </button>
          </li>
        </ul>
        <p v-if="truncated" class="search-results__hint">结果过多，只显示前 10 条（搜索上限 500 条 / 3 秒）</p>
      </div>
    </div>

    <div class="topbar__spacer"></div>

    <div class="topbar__views" role="group" aria-label="视图切换">
      <button
        v-for="mode in viewModes"
        :key="mode"
        type="button"
        class="view-toggle"
        :aria-pressed="ui.viewMode === mode"
        @click="ui.setViewMode(mode)"
      >
        {{ VIEW_MODE_LABELS[mode] }}
      </button>
    </div>

    <div class="topbar__user">
      <span class="badge" :class="session.badgeClass" data-testid="session-badge">{{ session.label }}</span>
      <button
        v-if="session.authenticated"
        type="button"
        data-testid="logout"
        @click="handleLogout"
      >
        登出
      </button>
    </div>
  </header>
</template>
