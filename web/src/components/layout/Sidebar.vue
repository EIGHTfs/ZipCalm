<script setup>
// 左侧栏（docs/08 第八节：桌面常驻；M8 触屏改为抽屉）
// 内容：主导航（文件/任务/看板/设置）+ 卷/目录树占位 + 支持的格式清单
//
// 为什么这里列出格式：格式清单的唯一来源是 shared/format-list.js，
// 侧边栏直接消费它，也是「前端不硬编码枚举」的活证据（删掉 shared 里的格式，这里立刻少一项）。

import { RouterLink } from 'vue-router';

import { FORMATS, ROUTES } from '../../constants/index.js';

const navItems = [
  { to: ROUTES.FILES, label: '文件浏览', icon: 'folder' },
  { to: ROUTES.TASKS, label: '压缩任务', icon: 'list' },
  { to: ROUTES.METRICS, label: '性能看板', icon: 'chart' },
  { to: ROUTES.SETTINGS, label: '设置', icon: 'gear' },
];

// 内联 SVG（不引图标库；docs/08 的图标需求很少，内联即可）
const icons = {
  folder: '<path d="M3 5h5l2 2h6v8H3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  list: '<path d="M4 5h12M4 9h12M4 13h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  chart: '<path d="M4 14V8m4 6V5m4 9v-4m4 4V7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  gear: '<circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 3v2m0 10v2M3 10h2m10 0h2M5 5l1.5 1.5M13.5 13.5L15 15M15 5l-1.5 1.5M6.5 13.5L5 15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
};
</script>

<template>
  <aside class="sidebar scroll-area" data-region="sidebar">
    <section class="sidebar__section">
      <h2 class="sidebar__title">导航</h2>
      <nav class="nav-list" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
        >
          <span class="nav-item__icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 20 20" v-html="icons[item.icon]"></svg>
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">存储卷</h2>
      <ul class="tree">
        <li class="tree__item tree__item--root">根目录 /</li>
        <li class="tree__item">目录树（M1 接入）</li>
      </ul>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">支持格式</h2>
      <ul class="tree">
        <li v-for="format in FORMATS" :key="format.id" class="tree__item">
          <span>{{ format.name }}</span>
          <span class="badge">{{ format.ext }}</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
