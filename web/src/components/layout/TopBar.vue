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

// ===== 搜索（docs/16 批次②需求①）=====
// 交互范式：顶栏只做**入口**，结果由文件列表（FilesPage）在主区渲染 ——
// 用户搜索时想看"一批结果"，不是被下拉框带着跳走。状态放 ui store，两处共享同一个关键字。
const SEARCH_DEBOUNCE_MS = 300;
let debounceTimer = null;

/** 输入防抖：连续敲字只发最后一次（搜索是遍历型操作） */
function onInput(event) {
  ui.setSearchQuery(event.target.value);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (ui.searchQuery.trim().length === 0) {
    ui.clearSearch();
    return;
  }
  debounceTimer = setTimeout(() => { void ui.runSearch(ui.currentRootId); }, SEARCH_DEBOUNCE_MS);
}

/** Esc：清空搜索并退出搜索态（文件列表恢复原目录） */
function onEscape() {
  ui.clearSearch();
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
        :value="ui.searchQuery"
        type="search"
        placeholder="搜索当前根内的文件（结果显示在文件列表）"
        data-testid="topbar-search"
        autocomplete="off"
        @input="onInput"
        @keydown.esc="onEscape"
      />
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
