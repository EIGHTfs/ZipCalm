// 路由表（vue-router 4 + hash 模式）
//
// 为什么用 hash：docs/09 §七 明确「Web 前端用路由，但 URL 不为 APK 服务」——
// APK 靠 API 拉状态恢复，Web 用 hash 免去服务端 rewrite 配置（Fastify 只管 /api/v1）。
//
// F1 阶段所有页面都是占位组件（不含真实数据），M1 起逐个接后端。

import { createRouter, createWebHashHistory } from 'vue-router';

import FilesPage from '../pages/FilesPage.vue';
import TasksPage from '../pages/TasksPage.vue';
import MetricsPage from '../pages/MetricsPage.vue';
import SettingsPage from '../pages/SettingsPage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';
import { ROUTES, DEFAULT_ROUTE } from '../constants/index.js';

export const routes = [
  { path: '/', redirect: DEFAULT_ROUTE },
  {
    path: ROUTES.FILES,
    name: 'files',
    component: FilesPage,
    meta: { title: '文件浏览', hint: 'M1 接入 /api/v1/fs/list' },
  },
  {
    path: ROUTES.TASKS,
    name: 'tasks',
    component: TasksPage,
    meta: { title: '压缩任务', hint: 'M3 接入 /api/v1/tasks + SSE' },
  },
  {
    path: ROUTES.METRICS,
    name: 'metrics',
    component: MetricsPage,
    meta: { title: '性能看板', hint: 'M7 接入 /api/v1/metrics/*' },
  },
  {
    path: ROUTES.SETTINGS,
    name: 'settings',
    component: SettingsPage,
    meta: { title: '设置', hint: 'M6 接入 /api/v1/blacklist/*' },
  },
  // 兜底路由必须放最后
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundPage,
    meta: { title: '页面不存在', hint: '' },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 路由变化时同步标题，便于在浏览器标签上分辨当前页面
router.afterEach((to) => {
  const title = to.meta && to.meta.title ? to.meta.title : '';
  document.title = title ? `${title} · ZipCalm` : 'ZipCalm 压压惊';
});

export default router;
