<script setup>
// 顶部栏（docs/08 第八节布局图第一行）
// 内容：品牌 | 面包屑 | 搜索 | 视图切换 | 用户态
//
// F1 阶段的克制点：
// - 搜索框只做视觉占位（disabled + 提示 M1 接入），不发请求；
// - 视图切换是「真交互」：点列表/网格会改 pinia 里的 viewMode（鼠标优先设计的一部分）；
// - 用户态来自 session store，未登录时不跳转（登录页 M1 才做）。

import { computed } from 'vue';

import { useUiStore } from '../../stores/ui.js';
import { useSessionStore } from '../../stores/session.js';
import { APP_NAME, APP_NAME_ZH, VIEW_MODES, VIEW_MODE_LABELS } from '../../constants/index.js';

const ui = useUiStore();
const session = useSessionStore();

const crumbs = computed(() => ui.breadcrumbs);
const viewModes = VIEW_MODES;
</script>

<template>
  <header class="topbar" data-region="topbar">
    <div class="topbar__brand">
      {{ APP_NAME }}
      <span class="topbar__brand-sub">{{ APP_NAME_ZH }}</span>
    </div>

    <nav class="topbar__crumbs" aria-label="面包屑">
      <template v-for="(crumb, index) in crumbs" :key="crumb.path">
        <span v-if="index > 0" aria-hidden="true">/</span>
        <span :aria-current="index === crumbs.length - 1 ? 'page' : undefined">{{ crumb.label }}</span>
      </template>
    </nav>

    <div class="topbar__search">
      <label class="visually-hidden" for="topbar-search">搜索文件</label>
      <input
        id="topbar-search"
        type="search"
        placeholder="搜索文件（M1 接入）"
        disabled
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
      <span class="badge" :class="session.badgeClass">{{ session.label }}</span>
    </div>
  </header>
</template>
