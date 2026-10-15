<script setup>
// 应用根组件：按 docs/08 第八节的布局图拼装四区骨架
//
//   ┌──────────────────────────────────────┐
//   │ TopBar：面包屑 | 搜索 | 视图切换 | 用户 │
//   ├────────┬─────────────────────────────┤
//   │Sidebar │  MainArea（router-view）    │
//   ├────────┴─────────────────────────────┤
//   │ BottomTaskBar：任务摘要 | 指标 | 操作 │
//   └──────────────────────────────────────┘
//
// 四区都是「布局容器」，只负责位置与骨架，不含业务；业务页面通过 MainArea 的默认插槽渲染。

import TopBar from './components/layout/TopBar.vue';
import Sidebar from './components/layout/Sidebar.vue';
import MainArea from './components/layout/MainArea.vue';
import BottomTaskBar from './components/layout/BottomTaskBar.vue';
</script>

<template>
  <div class="app-shell">
    <TopBar />
    <Sidebar />
    <MainArea>
      <!-- 路由出口放在 MainArea 内：页面切换只重绘主内容区，四区骨架保持稳定 -->
      <router-view />
    </MainArea>
    <BottomTaskBar />
  </div>
</template>
