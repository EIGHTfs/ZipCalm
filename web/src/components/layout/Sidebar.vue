<script setup>
// 左侧栏（docs/08 第八节：桌面常驻；M8 触屏改为抽屉）
// 内容：主导航（文件/任务/看板/设置）+ 卷/目录树占位 + 支持的格式清单
//
// 为什么这里列出格式：格式清单的唯一来源是 shared/format-list.js，
// 侧边栏直接消费它，也是「前端不硬编码枚举」的活证据（删掉 shared 里的格式，这里立刻少一项）。
//
// 图标演进：手写内联 SVG（F1）→ 直接 import lucide 组件（F1.1）→ **Icon.vue 收口组件（F1.2）**。
// 现在本文件**不再 import 任何图标库**，只写业务语义名（files/tasks/metrics/settings/storage/formats）；
// 「语义名 → 图标库组件」的映射只在 components/common/Icon.vue 一处，换库时调用方零改动。

import { RouterLink } from 'vue-router';

import Icon from '../common/Icon.vue';
import { useUiStore } from '../../stores/ui.js';
import { FORMATS, ROUTES } from '../../constants/index.js';

// 导航项：icon 存**语义名**（不存组件），模板里交给 <Icon name="..." />
const navItems = [
  { to: ROUTES.FILES, label: '文件浏览', icon: 'files' },
  { to: ROUTES.TASKS, label: '压缩任务', icon: 'tasks' },
  { to: ROUTES.METRICS, label: '性能看板', icon: 'metrics' },
  { to: ROUTES.SETTINGS, label: '设置', icon: 'settings' },
];

// 触屏抽屉的开关状态与 TopBar 共用同一个 store（避免两处各自维护 open 状态）
const ui = useUiStore();
</script>

<template>
  <aside class="sidebar scroll-area" :class="{ 'sidebar--open': ui.sidebarOpen }" data-region="sidebar">
    <!-- 触屏抽屉的关闭按钮：只在窄屏显示（桌面常驻不需要） -->
    <button type="button" class="sidebar__close" data-testid="sidebar-close" aria-label="关闭导航" @click="ui.toggleSidebar()">✕</button>
    <section class="sidebar__section">
      <h2 class="sidebar__title">导航</h2>
      <nav class="nav-list" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
        >
          <!-- 颜色继承 currentColor（由 .nav-item 控制），选中态自动跟随 -->
          <span class="nav-item__icon" aria-hidden="true">
            <Icon :name="item.icon" :size="16" />
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">
        <Icon name="storage" :size="13" />
        存储卷
      </h2>
      <ul class="tree">
        <li class="tree__item tree__item--root">根目录 /</li>
        <li class="tree__item">目录树（M1 接入）</li>
      </ul>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">
        <Icon name="formats" :size="13" />
        支持格式
      </h2>
      <ul class="tree">
        <li v-for="format in FORMATS" :key="format.id" class="tree__item">
          <span>{{ format.name }}</span>
          <span class="badge">{{ format.ext }}</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
