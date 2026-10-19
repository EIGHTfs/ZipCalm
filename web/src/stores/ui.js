// pinia store：纯前端的 UI 状态
//
// 边界（docs/09 约定 1「一切状态从 API 拉，不存前端内存」）：
// 这里只放「前端自己的」状态（当前路由、视图模式、任务摘要数字的镜像）。
// 业务真源永远是 API：任务列表/文件列表 M1/M3 起各自建 store，且由 API 填充、不本地造。

import { defineStore } from 'pinia';

import { api } from '../api/client.js';

import { VIEW_MODE, VIEW_MODES, DEFAULT_ROUTE, ROUTES } from '../constants/index.js';
import { breadcrumbsOf } from '../utils/path.js';

export const useUiStore = defineStore('ui', {
  state: () => ({
    /** 当前路由 path（由 router.afterEach 同步，供侧边栏高亮与面包屑使用） */
    route: DEFAULT_ROUTE,
    /** 页面标题/提示：取自路由 meta，避免组件重复推断 */
    pageTitle: '',
    pageHint: '',
    /** 文件页当前浏览路径（由 route.query.path 推导；null 表示当前页面不是文件页） */
    fsPath: null,
    /** 搜索关键字（空 = 不在搜索态；文件列表按它切换成结果视图） */
    searchQuery: '',
    /** 搜索状态：结果集与元信息（边界由后端保证：深度/条数/超时） */
    searchState: { running: false, error: '', items: [], truncated: false, elapsedMs: 0, scannedDirs: 0 },
    /** 当前存储根（docs/16）：侧栏切根后所有 fs 请求都带它；'default' = 配置里的 storage.root */
    currentRootId: 'default',
    /** 根列表（侧栏拉 /fs/volumes 后写入）：主区/抽屉要显示"我在哪个位置"，不能只有 id 没有名字 */
    roots: [],
    /**
     * 根是否已"定下来"（含可读性探测）。
     * 文件页首屏必须等它：否则可能先按不可读的第一个根加载 → PERMISSION_DENIED（实测踩过）。
     * 探测失败/超时也必须置 true（带 rootsError），否则文件页会永远等下去。
     */
    rootsReady: false,
    /** 探测过程中是否有错误（页面据此给提示，但不阻断加载） */
    rootsError: '',
    /** 服务进程的实际运行身份（来自 /health.runtime）：权限提示据此说清"给谁授权" */
    runtimeUser: '',
    runtimeUid: null,
    /** 视图模式：docs/08 §二 默认列表视图 */
    viewMode: VIEW_MODE.LIST,
    /** 底部任务条摘要：F1 恒为 0，M3 由 /api/v1/tasks 填充 */
    taskSummary: { active: 0, queued: 0, parallel: false },
    /** 侧边栏（鼠标优先：桌面常驻；M8 触屏改为抽屉） */
    sidebarOpen: true,
  }),

  getters: {
    /**
     * 当前根对用户可见的名字（C 模式=共享名，B 模式=卷名）。
     * 根列表还没拉到时退回 id —— 宁可显示 'default' 也不显示空白。
     */
    currentRootLabel(state) {
      const matched = state.roots.find((root) => root.id === state.currentRootId);
      return matched && matched.label ? matched.label : state.currentRootId;
    },
    /** 当前目录的展示名：'/' 显示成「根目录」（与面包屑一致）；目录来自 fsPath，不是路由原文 */
    currentDirLabel(state) {
      const dir = state.fsPath || '/';
      return dir === '/' ? '根目录' : dir;
    },
    /**
     * 面包屑：
     * - 文件页 → 跟随真实浏览路径（/文档/子目录）；
     * - 其它页 → 「根目录 + 当前页标题」两级。
     */
    breadcrumbs: (state) => {
      if (state.route === ROUTES.FILES) return breadcrumbsOf(state.fsPath || '/');
      return [
        { label: '根目录', path: '/' },
        { label: state.pageTitle || 'ZipCalm', path: state.route },
      ];
    },
    viewModeLabel: (state) => VIEW_MODES.find((mode) => mode === state.viewMode) || VIEW_MODE.LIST,
  },

  actions: {
    /** 路由变化时同步（由 router.afterEach 调用） */
    syncRoute(to) {
      this.route = to.path;
      this.pageTitle = (to.meta && to.meta.title) || '';
      this.pageHint = (to.meta && to.meta.hint) || '';

      if (to.path === ROUTES.FILES) {
        const queryPath = to.query && to.query.path;
        this.fsPath = typeof queryPath === 'string' && queryPath.length > 0 ? queryPath : '/';
      } else {
        this.fsPath = null;
      }
    },
    /** 写入根列表（侧栏 loadRoots 后调用；主区/抽屉据此显示位置名） */
    setRoots(list) {
      this.roots = Array.isArray(list) ? list : [];
    },
    /**
     * 写入"根已确定"的结论（侧栏探测完可读根后调用）。
     * 无论成功失败都要调用 —— 这是文件页首屏的放行信号。
     * @param {{roots?: Array, mode?: string, rootId?: string, error?: string}} outcome
     */
    setRootsResolved(outcome = {}) {
      if (Array.isArray(outcome.roots)) this.roots = outcome.roots;
      if (typeof outcome.rootId === 'string' && outcome.rootId.length > 0) this.currentRootId = outcome.rootId;
      this.rootsError = typeof outcome.error === 'string' ? outcome.error : '';
      this.rootsReady = true;
    },
    /** 写入服务运行身份（/health.runtime）；拿不到用户名时只有 uid */
    setRuntime(runtime) {
      const source = runtime || {};
      this.runtimeUser = typeof source.user === 'string' ? source.user : '';
      this.runtimeUid = Number.isInteger(source.uid) ? source.uid : null;
    },
    /** 设置搜索关键字（只改 UI 态；真正请求由 runSearch 触发） */
    setSearchQuery(value) {
      this.searchQuery = typeof value === 'string' ? value : '';
    },
    /**
     * 执行搜索（只在当前根内、有界遍历）。空关键字 = 清空并退出搜索态。
     * @param {string} rootId
     * @param {number} [limit]
     */
    async runSearch(rootId, limit = 500) {
      const keyword = this.searchQuery.trim();
      if (keyword.length === 0) {
        this.clearSearch();
        return;
      }
      this.searchState = { ...this.searchState, running: true, error: '' };
      try {
        const payload = await api.get('/fs/search', { q: keyword, rootId, limit });
        this.searchState = {
          running: false,
          error: '',
          items: (payload && payload.items) || [],
          truncated: Boolean(payload && payload.truncated),
          elapsedMs: Number((payload && payload.elapsedMs) || 0),
          scannedDirs: Number((payload && payload.scannedDirs) || 0),
        };
      } catch (error) {
        this.searchState = { running: false, error: `[${error.code || 'ERROR'}] ${error.message}`, items: [], truncated: false, elapsedMs: 0, scannedDirs: 0 };
      }
    },
    /** 退出搜索态（文件列表恢复原目录） */
    clearSearch() {
      this.searchQuery = '';
      this.searchState = { running: false, error: '', items: [], truncated: false, elapsedMs: 0, scannedDirs: 0 };
    },
    /** 切换存储根（docs/16）：只管 id，路径/多选的重置由文件页监听处理 */
    setCurrentRoot(rootId) {
      if (typeof rootId === 'string' && rootId.length > 0) this.currentRootId = rootId;
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
