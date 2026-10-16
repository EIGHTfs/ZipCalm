// 前端挂载入口（M1：真实登录态 + 401 统一跳登录）
//
// 职责：
// 1. 装配 createApp(App) + pinia + vue-router；
// 2. **先探测登录态、再安装 router**：路由守卫依赖 session.authenticated，
//    如果先安装 router，已登录用户首屏会被守卫误判成未登录而弹到登录页（一帧闪烁 + redirect 污染）；
// 3. 注册 401 统一钩子：清态 + 跳登录页（带 redirect 回跳）；
// 4. 运行期错误观察器（window.__zipcalmErrors）：供自动化验收判断"控制台有没有报错"。

import { createApp } from 'vue';
import { createPinia } from 'pinia';

// 样式：原生 CSS + CSS 变量（必须在挂载前引入，否则四区栅格不生效）
import './styles/variables.css';
import './styles/base.css';
import './styles/layout.css';

import App from './App.vue';
import router from './router/index.js';
import { ROUTES } from './constants/index.js';
import { setUnauthorizedHandler } from './api/client.js';
import { useSessionStore } from './stores/session.js';
import { useUiStore } from './stores/ui.js';

// ===== 1. 创建应用 =====

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);

const sessionStore = useSessionStore(pinia);
const uiStore = useUiStore(pinia);

// ===== 2. 运行期错误观察器（先装，才能捕获后面所有阶段的问题）=====

window.__zipcalmErrors = [];
const recordError = (kind, detail) => {
  window.__zipcalmErrors.push({ kind, detail: String(detail), at: Date.now() });
};

window.addEventListener('error', (event) => {
  recordError('error', event.message || event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  recordError('unhandledrejection', event.reason && event.reason.message ? event.reason.message : event.reason);
});
// 只包裹 console.error：console.warn/info 属正常提示，不算「报错」
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  recordError('console.error', args.join(' '));
  originalConsoleError(...args);
};

// ===== 3. 401 钩子：凭据失效 → 清态 + 跳登录（带 redirect）=====

setUnauthorizedHandler((info) => {
  const current = router.currentRoute.value;

  // 已经在登录页时不落"过期"状态：此时的 401 多半是用户输错密码或探测未登录，
  // 标成「登录已过期」是误导（真实踩过：登录失败后顶栏显示"登录已过期"）。
  if (current.path === ROUTES.LOGIN) return;

  sessionStore.markUnauthorized(info);

  router.replace({
    path: ROUTES.LOGIN,
    query: current.fullPath && current.fullPath !== '/' ? { redirect: current.fullPath } : undefined,
  });
});

// ===== 4. 路由 → UI store（标题/提示/面包屑的单一来源）=====

router.afterEach((to) => {
  uiStore.syncRoute(to);
});

// ===== 5. 启动序列：探测登录态 → 安装 router → 挂载 =====

async function bootstrap() {
  try {
    await sessionStore.ensureLoaded();
  } catch (error) {
    // 探测失败（例如后端没起）不应白屏：记录后继续，由页面/守卫给出可读提示
    recordError('session-probe', (error && error.message) || '登录态探测失败');
  }

  app.use(router);
  app.mount('#app');

  await router.isReady();
  uiStore.syncRoute(router.currentRoute.value);

  // 给自动化验收留一个可读的启动快照
  window.__zipcalmBoot = {
    mountedAt: Date.now(),
    route: router.currentRoute.value.path,
    authenticated: sessionStore.authenticated,
    viewMode: uiStore.viewMode,
    regions: ['topbar', 'sidebar', 'main-area', 'bottom-task-bar'].filter((region) =>
      Boolean(document.querySelector(`[data-region="${region}"]`)),
    ),
  };
}

bootstrap();
