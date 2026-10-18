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

import { onBeforeUnmount, onMounted, onUnmounted } from 'vue';

import TopBar from './components/layout/TopBar.vue';
import Sidebar from './components/layout/Sidebar.vue';
import MainArea from './components/layout/MainArea.vue';
import BottomTaskBar from './components/layout/BottomTaskBar.vue';
import TaskDrawer from './components/task/TaskDrawer.vue';
import { useTasksStore } from './stores/tasks.js';
import { useUiStore } from './stores/ui.js';

// SSE 连接在根组件建立：**全局只连一条**，页面切换不影响任务状态展示，
// 也保证"关掉浏览器任务继续跑、回来还能看到进度"（连接与执行解耦，INV-04）。
const tasks = useTasksStore();
const ui = useUiStore();

/** 窄屏阈值：与 layout.css 的 760px 断点保持一致（侧栏在窄屏改为抽屉） */
const NARROW_MAX_WIDTH = 760;

/**
 * 窄屏下侧栏默认收起（抽屉）：
 * 桌面常驻是舒适默认，但手机上常驻会把主内容挤成一根"竖排单字"的窄条（实测踩过）。
 * 只在跨过断点时改一次，不跟用户手动开关抢状态。
 */
function syncSidebarForViewport() {
  ui.sidebarOpen = window.innerWidth > NARROW_MAX_WIDTH;
}
onMounted(() => {
  tasks.connect();
  syncSidebarForViewport();
  window.addEventListener('resize', syncSidebarForViewport);
});
onBeforeUnmount(() => tasks.disconnect());

onUnmounted(() => {
  window.removeEventListener('resize', syncSidebarForViewport);
});
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
