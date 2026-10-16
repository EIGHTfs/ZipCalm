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

import { onBeforeUnmount, onMounted } from 'vue';

import TopBar from './components/layout/TopBar.vue';
import Sidebar from './components/layout/Sidebar.vue';
import MainArea from './components/layout/MainArea.vue';
import BottomTaskBar from './components/layout/BottomTaskBar.vue';
import TaskDrawer from './components/task/TaskDrawer.vue';
import { useTasksStore } from './stores/tasks.js';

// SSE 连接在根组件建立：**全局只连一条**，页面切换不影响任务状态展示，
// 也保证"关掉浏览器任务继续跑、回来还能看到进度"（连接与执行解耦，INV-04）。
const tasks = useTasksStore();
onMounted(() => tasks.connect());
onBeforeUnmount(() => tasks.disconnect());
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
    <TaskDrawer />
  </div>
</template>
