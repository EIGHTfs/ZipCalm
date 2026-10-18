// 路由表（vue-router 4 + hash 模式）
//
// 为什么用 hash：docs/09 §七 明确「Web 前端用路由，但 URL 不为 APK 服务」——
// APK 靠 API 拉状态恢复，Web 用 hash 免去服务端 rewrite 配置（Fastify 只管 /api/v1）。
//
// M1：文件页与登录页已真实联调；tasks/metrics/settings 仍是占位（分别在 M3/M7/M6 接入）。
//
// 鉴权守卫：非 public 路由必须已登录，否则跳到 /login 并把原地址放进 ?redirect=
// （注意：登录态探测在 main.js 里"先探测、后安装 router"，所以守卫看到的状态是准的）。

import { createRouter, createWebHashHistory } from 'vue-router';

import FilesPage from '../pages/FilesPage.vue';
import HardlinkPage from '../pages/HardlinkPage.vue';
import LoginPage from '../pages/LoginPage.vue';
import TasksPage from '../pages/TasksPage.vue';
import MetricsPage from '../pages/MetricsPage.vue';
import SettingsPage from '../pages/SettingsPage.vue';
import NotFoundPage from '../pages/NotFoundPage.vue';
import { ROUTES, DEFAULT_ROUTE } from '../constants/index.js';
import { useSessionStore } from '../stores/session.js';

export const routes = [
  { path: '/', redirect: DEFAULT_ROUTE },
  {
    path: ROUTES.LOGIN,
    name: 'login',
    component: LoginPage,
    meta: { title: '登录', hint: 'M1 已接入 /api/v1/auth/login', public: true },
  },
  {
    path: ROUTES.FILES,
    name: 'files',
    component: FilesPage,
    meta: { title: '文件浏览', hint: 'M1 已接入 /api/v1/fs/list' },
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
    path: ROUTES.HARDLINK,
    name: 'hardlink',
    component: HardlinkPage,
    meta: { title: '硬链接去重', hint: 'docs/15：POST /hardlink/scan（只读）+ execute（显式确认）' },
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
    meta: { title: '页面不存在', hint: '', public: true },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 鉴权守卫：未登录访问受保护页面 → 登录页（带 redirect 回跳）
router.beforeEach((to) => {
  if (to.meta && to.meta.public) return true;

  const session = useSessionStore();
  if (session.authenticated) return true;

  return {
    path: ROUTES.LOGIN,
    query: to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : undefined,
  };
});

// 路由变化时同步浏览器标题（便于在多标签场景分辨页面）
router.afterEach((to) => {
  const title = to.meta && to.meta.title ? to.meta.title : '';
  document.title = title ? `${title} · ZipCalm` : 'ZipCalm 压压惊';
});

export default router;
