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

import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';

import Icon from '../common/Icon.vue';
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
const router = useRouter();

// ===== 存储根（docs/16）：数据源由后端按平台决定（B 列卷 / C 列共享），前端只负责渲染 =====
const roots = ref([]);
const rootsMode = ref('');
const rootsError = ref('');

/** 标题随模式变：群晖是「位置」（用户心智是共享），其他是「存储卷」 */
const rootsTitle = computed(() => (rootsMode.value === 'C' ? '位置' : '存储卷'));

async function loadRoots() {
  try {
    const payload = await api.get('/fs/volumes');
    roots.value = (payload && payload.roots) || [];
    rootsMode.value = (payload && payload.mode) || '';
    // 当前根不在列表里（如默认根在 C 模式下被隐藏）→ 落到第一个可用项，避免"切了根但列表全不亮"
    if (!roots.value.some((root) => root.id === ui.currentRootId) && roots.value.length > 0) {
      ui.setCurrentRoot(roots.value[0].id);
    }
  } catch (error) {
    rootsError.value = `[${error.code || 'ERROR'}] ${error.message}`;
  }
}

function switchRoot(rootId) {
  if (ui.currentRootId === rootId) return;
  ui.setCurrentRoot(rootId);
  // 切根后回到根目录：上一个根的路径在新根下没有意义（文件页监听到变化也会重置路径与多选）
  void router.push({ path: ROUTES.FILES, query: { path: '/' } });
}

onMounted(loadRoots);
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
        <li v-for="format in FORMATS" :key="format.id" class="tree__item">
          <span>{{ format.name }}</span>
          <span class="badge">{{ format.ext }}</span>
        </li>
      </ul>
    </section>
  </aside>
</template>
