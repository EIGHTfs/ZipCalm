<script setup>
// 左侧栏（docs/08 第八节：桌面常驻；M8 触屏改为抽屉）
// 内容：主导航（文件/任务/看板/设置）+ 卷/目录树占位 + 支持的格式清单
//
// 为什么这里列出格式：格式清单的唯一来源是 shared/format-list.js，
// 侧边栏直接消费它，也是「前端不硬编码枚举」的活证据（删掉 shared 里的格式，这里立刻少一项）。
//
// 图标演进：手写内联 SVG（F1）→ 直接 import lucide 组件（F1.1）→ **Icon.vue 收口组件（F1.2）**。
// 现在本文件**不再 import 任何图标库**，只写业务语义名（files/tasks/metrics/settings/storage/formats）；
// 「语义名 → 图标库组件」的映射只在 components/common/Icon.vue 一处，换库时调用方零改动。

import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import Icon from '../common/Icon.vue';
import { useSessionStore } from '../../stores/session.js';
import { useUiStore } from '../../stores/ui.js';
import { FORMATS, ROUTES } from '../../constants/index.js';
import { api } from '../../api/client.js';
import { formatBytes } from '../../utils/format.js';

// 导航项：icon 存**语义名**（不存组件），模板里交给 <Icon name="..." />
const navItems = [
  { to: ROUTES.FILES, label: '文件浏览', icon: 'files' },
  { to: ROUTES.TASKS, label: '压缩任务', icon: 'tasks' },
  { to: ROUTES.HARDLINK, label: '硬链接去重', icon: 'hardlink' },
  { to: ROUTES.METRICS, label: '性能看板', icon: 'metrics' },
  { to: ROUTES.SETTINGS, label: '设置', icon: 'settings' },
];

// 触屏抽屉的开关状态与 TopBar 共用同一个 store（避免两处各自维护 open 状态）
const ui = useUiStore();
const session = useSessionStore();
const router = useRouter();

// ===== 存储根（docs/16）：数据源由后端按平台决定（B 列卷 / C 列共享），前端只负责渲染 =====
const roots = ref([]);
const rootsMode = ref('');
const rootsError = ref('');

/** 标题随模式变：群晖是「位置」（用户心智是共享），其他是「存储卷」 */
const rootsTitle = computed(() => (rootsMode.value === 'C' ? '位置' : '存储卷'));

let rootsRetry = 0;

// ===== 支持格式清单 =====
// 为什么另拉一份而不直接用 shared 的静态 FORMATS：那份是前后端共用的常量，
// 而真正的格式来源是 server/plugins/formats/ 下的插件目录 —— 两个来源必然会漂移
// （实测：7z 与 rar 插件加好了，侧栏还显示老四样）。这里以注册表为准，
// 静态列表降级为「接口不可用时的兜底」，新加插件自动出现在列表里。
const apiFormats = ref([]);
const displayFormats = computed(() => (apiFormats.value.length > 0 ? apiFormats.value : FORMATS));

async function loadSidebarFormats() {
  try {
    const payload = await api.get('/formats');
    const list = (payload && payload.formats) || [];
    apiFormats.value = list.map((item) => ({
      id: item.id,
      name: item.name,
      ext: item.ext,
      // 只读格式（如 RAR）标一下，避免用户以为它也能压缩
      extractOnly: item.extractOnly === true,
    }));
  } catch {
    // 拉不到就保持静态兜底，不阻塞侧栏
    apiFormats.value = [];
  }
}

/** 把 /fs/volumes 的结果落到状态里，并把"当前根"收敛到列表内的某一项 */
function applyRootsPayload(payload) {
  rootsRetry = 0;
  roots.value = (payload && payload.roots) || [];
  rootsMode.value = (payload && payload.mode) || '';
  // 存进 store：主区面包屑与压缩抽屉要显示"当前在哪个位置"，不能只靠侧栏自己知道
  ui.setRoots(roots.value);
  // 当前根不在列表里（如默认根在 C 模式下被隐藏）→ 落到第一个可用项，避免"切了根但列表全不亮"
  if (!roots.value.some((root) => root.id === ui.currentRootId) && roots.value.length > 0) {
    ui.setCurrentRoot(roots.value[0].id);
  }
}

/**
 * 失败处理：登录瞬间的 AUTH_REQUIRED 是竞态（token 还没落到 store），不是真错误，
 * 有限重试几次；其它错误（或重试用尽）记录原因并**照样放行**（文件页按默认根加载 + 显示提示，好过白屏）。
 * @returns {boolean} true 表示已安排重试（调用方不要再往下走）
 */
function handleLoadFailure(error) {
  if (error.code === 'AUTH_REQUIRED' && rootsRetry < 5) {
    rootsRetry += 1;
    rootsError.value = '';
    window.setTimeout(() => { void loadRoots(); }, 600);
    return true;
  }
  rootsError.value = `[${error.code || 'ERROR'}] ${error.message}`;
  ui.setRootsResolved({ roots: roots.value, rootId: ui.currentRootId, error: rootsError.value });
  return false;
}

async function loadRoots() {
  try {
    applyRootsPayload(await api.get('/fs/volumes'));
    const readable = await ensureReadableRoot();
    // 放行文件页首屏：探测结果（含"全不可读"）必须写进 store，否则页面会一直等
    ui.setRootsResolved({ roots: roots.value, mode: rootsMode.value, rootId: readable || ui.currentRootId, error: '' });
  } catch (error) {
    handleLoadFailure(error);
  }
}

/**
 * 保证当前根可读：群晖上共享的权限各不相同，首个共享未必允许本应用访问。
 * 做法是逐个探测（只读 1 条），把用户落到**第一个能读的**位置；全不可读时保持原样（页面会给出权限提示）。
 */
async function ensureReadableRoot() {
  const candidates = [
    ...roots.value.filter((root) => root.id === ui.currentRootId),
    ...roots.value.filter((root) => root.id !== ui.currentRootId),
  ];
  for (const root of candidates) {
    try {
      await api.get('/fs/list', { path: '/', limit: 1, rootId: root.id });
      if (ui.currentRootId !== root.id) ui.setCurrentRoot(root.id);
      return root.id;
    } catch {
      // 不可读：试下一个
    }
  }
}

/** 已用百分比（0~100 整数）；容量缺失时返回 0（调用方用 v-if 挡住不渲染） */
function usedPercentOf(root) {
  const total = Number(root.totalBytes);
  const free = Number(root.freeBytes);
  if (!(total > 0) || !Number.isFinite(free)) return 0;
  const used = ((total - free) / total) * 100;
  return Math.min(100, Math.max(0, Math.round(used)));
}

/** 容量分档：>90% 危险红，80~90% 警告黄，其余中性（颜色比数字先被看见） */
function barToneOf(root) {
  const percent = usedPercentOf(root);
  if (percent > 90) return 'root-item__bar-fill--danger';
  if (percent >= 80) return 'root-item__bar-fill--warn';
  return '';
}

function switchRoot(rootId) {
  if (ui.currentRootId === rootId) return;
  ui.setCurrentRoot(rootId);
  // 切根后回到根目录：上一个根的路径在新根下没有意义（文件页监听到变化也会重置路径与多选）
  void router.push({ path: ROUTES.FILES, query: { path: '/' } });
}

onMounted(() => {
  void loadRoots();
  void loadSidebarFormats();
});

// 登录前就挂着侧栏时，首次 /fs/volumes 会 401（且之后不会自动重试）。
// 路由变化实际等价于"用户已进入应用"，这时重拉一次即可；另外登录后停留原页也会有 route 变化。
watch(() => ui.route, () => {
  void loadRoots();
  void loadSidebarFormats();
});

// 登录成功后必须重拉一次：页面可能先于登录挂载，首次 /fs/volumes 拿到 AUTH_REQUIRED，
// 而重试窗口只有几秒 —— 用户在登录页停留久一点，侧栏就会一直停在"需要登录"（实测踩过）。
// 这里以"登录态变成已认证"为触发点，与停留时长无关。
watch(() => session.authenticated, (authenticated) => {
  if (!authenticated) return;
  rootsRetry = 0;
  rootsError.value = '';
  void loadRoots();
  // 格式清单同理：侧栏常先于登录挂载，首次 /formats 拿到 401 就回落到静态列表，
  // 结果新增的 7z/rar 一直不显示（实测踩过）。登录态一变就重拉。
  void loadSidebarFormats();
});
</script>

<template>
  <aside class="sidebar scroll-area" :class="{ 'sidebar--open': ui.sidebarOpen }" data-region="sidebar">
    <!-- 触屏抽屉的关闭按钮：只在窄屏显示（桌面常驻不需要） -->
    <button type="button" class="sidebar__close" data-testid="sidebar-close" aria-label="关闭导航" @click="ui.toggleSidebar()">✕</button>
    <section class="sidebar__section">
      <h2 class="sidebar__title">导航</h2>
      <nav class="nav-list" aria-label="主导航">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-item"
        >
          <!-- 颜色继承 currentColor（由 .nav-item 控制），选中态自动跟随 -->
          <span class="nav-item__icon" aria-hidden="true">
            <Icon :name="item.icon" :size="16" />
          </span>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title" data-testid="roots-title">
        <Icon name="storage" :size="13" />
        {{ rootsTitle }}
      </h2>
      <p v-if="rootsError" class="card__desc" data-testid="roots-error">{{ rootsError }}</p>
      <p v-else-if="roots.length === 0" class="card__desc">未发现可用的存储位置</p>
      <ul v-else class="tree" data-testid="roots-list">
        <li v-for="root in roots" :key="root.id" class="tree__item">
          <button
            type="button"
            class="root-item"
            :class="{ 'root-item--active': ui.currentRootId === root.id }"
            :data-testid="`root-${root.id}`"
            :title="root.path"
            @click="switchRoot(root.id)"
          >
            <span class="root-item__name">{{ root.label }}</span>
            <span v-if="root.totalBytes" class="root-item__size">
              {{ formatBytes(root.freeBytes) }} 可用 / {{ formatBytes(root.totalBytes) }}
            </span>
            <!-- statfs 失败时 totalBytes 为 null：不渲染进度条，避免 NaN% -->
            <span
              v-if="root.totalBytes"
              class="root-item__bar"
              role="progressbar"
              :aria-valuemin="0"
              :aria-valuemax="100"
              :aria-valuenow="usedPercentOf(root)"
              :aria-label="`${root.label} 已用 ${usedPercentOf(root)}%`"
            >
              <i class="root-item__bar-fill" :class="barToneOf(root)" :style="{ width: `${usedPercentOf(root)}%` }"></i>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section class="sidebar__section">
      <h2 class="sidebar__title">
        <Icon name="formats" :size="13" />
        支持格式
      </h2>
      <ul class="tree">
        <li v-for="format in displayFormats" :key="format.id" class="tree__item">
          <span>{{ format.name }}</span>
          <span class="badge">{{ format.ext }}</span>
          <span v-if="format.extractOnly" class="badge" title="只能解压，不能压缩">仅解压</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
