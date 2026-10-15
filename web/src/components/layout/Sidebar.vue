<script setup>
// 左侧栏（docs/08 第八节：桌面常驻；M8 触屏改为抽屉）
// 内容：主导航（文件/任务/看板/设置）+ 卷/目录树占位 + 支持的格式清单
//
// 为什么这里列出格式：格式清单的唯一来源是 shared/format-list.js，
// 侧边栏直接消费它，也是「前端不硬编码枚举」的活证据（删掉 shared 里的格式，这里立刻少一项）。
//
// F1.1 变更：图标从「手写内联 SVG path 常量表」改为 **lucide-vue-next** 组件。
// 原因：项目原则是「优先成熟库，不自研轮子」——手写 path 属于自研图标集，
// 增删改都要自己维护；lucide 按需 import 且 tree-shakable，打包体积只算用到的几个。
// 原手写表已按 safe-delete 备份（见交付汇报里的回收点路径），不在此保留死代码。

import { RouterLink } from 'vue-router';
import { Archive, ChartColumn, FileArchive, Folder, HardDrive, Settings } from 'lucide-vue-next';

import { FORMATS, ROUTES } from '../../constants/index.js';

// 导航项：icon 直接存 lucide 组件（模板里用 <component :is>）
const navItems = [
  { to: ROUTES.FILES, label: '文件浏览', icon: Folder },
  { to: ROUTES.TASKS, label: '压缩任务', icon: Archive },
  { to: ROUTES.METRICS, label: '性能看板', icon: ChartColumn },
  { to: ROUTES.SETTINGS, label: '设置', icon: Settings },
];
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
            <!-- size/stroke 与手写版视觉对齐；颜色继承 currentColor，高亮态自动跟随 -->
            <component :is="item.icon" :size="16" :stroke-width="1.8" />
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">
        <HardDrive :size="13" :stroke-width="1.8" aria-hidden="true" />
        存储卷
      </h2>
      <ul class="tree">
        <li class="tree__item tree__item--root">根目录 /</li>
        <li class="tree__item">目录树（M1 接入）</li>
      </ul>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">
        <FileArchive :size="13" :stroke-width="1.8" aria-hidden="true" />
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
