<script setup>
// 主内容区容器（docs/08 第八节布局图第二行右侧）
// 职责：只做「工具栏 + 可滚动内容区 + 插槽」，业务页面通过默认插槽渲染。
// 这样路由切换只重绘内容区，四区骨架保持稳定（不会整页闪烁）。

import { useUiStore } from '../../stores/ui.js';

const ui = useUiStore();
</script>

<template>
  <main class="main-area" data-region="main-area">
    <div class="main-area__toolbar">
      <span class="main-area__toolbar-title">{{ ui.pageTitle || '文件浏览' }}</span>
      <span v-if="ui.pageHint" class="main-area__toolbar-hint">{{ ui.pageHint }}</span>
      <div class="topbar__spacer"></div>
      <slot name="toolbar"></slot>
    </div>

    <div class="main-area__body scroll-area">
      <div class="page-outlet">
        <slot></slot>
      </div>
    </div>
  </main>
</template>
