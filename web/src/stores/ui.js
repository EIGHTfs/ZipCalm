// pinia store：纯前端的 UI 状态
//
// 边界（docs/09 约定 1「一切状态从 API 拉，不存前端内存」）：
// 这里只放「前端自己的」状态（当前路由、视图模式、任务摘要数字的镜像）。
// 业务真源永远是 API：任务列表/文件列表 M1/M3 起各自建 store，且由 API 填充、不本地造。

import { defineStore } from 'pinia';

import { VIEW_MODE, VIEW_MODES, DEFAULT_ROUTE } from '../constants/index.js';

export const useUiStore = defineStore('ui', {
  state: () => ({
    /** 当前路由 path（由 router.afterEach 同步，供侧边栏高亮与面包屑使用） */
    route: DEFAULT_ROUTE,
    /** 页面标题/提示：取自路由 meta，避免组件重复推断 */
    pageTitle: '',
    pageHint: '',
    /** 视图模式：docs/08 §二 默认列表视图 */
    viewMode: VIEW_MODE.LIST,
    /** 底部任务条摘要：F1 恒为 0，M3 由 /api/v1/tasks 填充 */
    taskSummary: { active: 0, queued: 0, parallel: false },
    /** 侧边栏（鼠标优先：桌面常驻；M8 触屏改为抽屉） */
    sidebarOpen: true,
  }),

  getters: {
    /** 面包屑：F1 只有「根目录 + 当前页」两级，M1 接入真实目录层级后替换 */
    breadcrumbs: (state) => [
      { label: '根目录', path: '/' },
      { label: state.pageTitle || '文件浏览', path: state.route },
    ],
    viewModeLabel: (state) => VIEW_MODES.find((mode) => mode === state.viewMode) || VIEW_MODE.LIST,
  },

  actions: {
    /** 路由变化时同步（由 router.afterEach 调用） */
    syncRoute(to) {
      this.route = to.path;
      this.pageTitle = (to.meta && to.meta.title) || '';
      this.pageHint = (to.meta && to.meta.hint) || '';
    },
    /** 切换列表/网格视图；非法值直接忽略，不抛错（UI 不该因脏输入崩） */
    setViewMode(mode) {
      if (VIEW_MODES.includes(mode)) this.viewMode = mode;
    },
    toggleSidebar() {
      this.sidebarOpen = !this.sidebarOpen;
    },
    /** M3 起由任务 API/SSE 调用；F1 保留接口形状便于接线 */
    setTaskSummary(patch) {
      this.taskSummary = { ...this.taskSummary, ...patch };
    },
  },
});
