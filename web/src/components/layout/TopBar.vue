<script setup>
// 顶部栏（docs/08 第八节布局图第一行）
// 内容：品牌 | 面包屑 | 搜索 | 视图切换 | 用户态 + 登出
//
// M1 变更：
// - 面包屑改为**跟随当前浏览路径**（ui store 由 route.query.path 推导）；
// - 用户态从占位变成真实登录态，并新增「登出」按钮（调用 POST /auth/logout）。
//
// 仍未做的：搜索框保持 disabled（M8 打磨期实现）。

import { computed } from 'vue';
import { useRouter } from 'vue-router';

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
</script>

<template>
  <header class="topbar" data-region="topbar">
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
      <input id="topbar-search" type="search" placeholder="搜索文件（M8 接入）" disabled />
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
