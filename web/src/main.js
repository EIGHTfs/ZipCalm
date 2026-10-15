// 前端挂载入口（F1 前端准备块 · Vue 3 版）
//
// 职责：
// 1. 装配 createApp(App) + pinia + vue-router，挂到 #app；
// 2. 注册 401 统一钩子：把「凭据失效」翻译成 ui 状态（M1 接入登录页后改为跳转 #/login）；
// 3. 留一个轻量的运行期错误观察器（window.__zipcalmErrors），供自动化验收读取
//    「控制台是否有报错」——这是 docs/11 §十四「每阶段结束固定动作」里自审的一部分。

import { createApp } from 'vue';
import { createPinia } from 'pinia';

// 样式：原生 CSS + CSS 变量（技术栈约定，不用预处理器/CSS-in-JS）
// 必须在挂载前引入，否则四区栅格不生效、页面会退化成块级堆叠
import './styles/variables.css';
import './styles/base.css';
import './styles/layout.css';

import App from './App.vue';
import router from './router/index.js';
import { setUnauthorizedHandler } from './api/client.js';
import { useSessionStore } from './stores/session.js';
import { useUiStore } from './stores/ui.js';

// ===== 1. 创建应用 =====

const app = createApp(App);
const pinia = createPinia();

app.use(pinia);
app.use(router);

// ===== 2. 401 钩子：任何请求判定凭据失效时统一走这里 =====

const sessionStore = useSessionStore(pinia);
const uiStore = useUiStore(pinia);

setUnauthorizedHandler((info) => {
  // 契约（docs/M0/API规范.md §二）：401 分 AUTH_REQUIRED / AUTH_INVALID / AUTH_EXPIRED，
  // 客户端动作是「先刷新 token，失败再跳登录」。F1 还没有登录页，所以只落状态：
  // 顶栏会显示「未登录」，M1 补上登录路由后在这里改为 router.push(ROUTES.LOGIN)。
  sessionStore.markUnauthorized(info);
});

// 路由 → UI store：MainArea 的标题/提示、顶栏面包屑都读这里（单一来源，避免各组件各自推断）
router.afterEach((to) => {
  uiStore.syncRoute(to);
});
uiStore.syncRoute(router.currentRoute.value);

// ===== 3. 运行期错误观察器（供验收断言，不影响业务逻辑）=====

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

// ===== 4. 挂载 =====

app.mount('#app');

// 给自动化验收留一个可读的启动快照（区域数量、当前路由）。
// 必须等 router.isReady()：初始导航完成前 currentRoute 还是 '/'，
// 过早快照会记录成错误的初始路由（同时补一次 syncRoute，保证首屏标题/提示正确）。
router.isReady().then(() => {
  uiStore.syncRoute(router.currentRoute.value);
  window.__zipcalmBoot = {
    mountedAt: Date.now(),
    route: router.currentRoute.value.path,
    viewMode: uiStore.viewMode,
    regions: ['topbar', 'sidebar', 'main-area', 'bottom-task-bar'].filter((region) =>
      Boolean(document.querySelector(`[data-region="${region}"]`)),
    ),
  };
});
