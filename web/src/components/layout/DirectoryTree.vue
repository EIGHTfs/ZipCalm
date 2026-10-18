<script setup>
// 左侧目录树（M8）：懒加载 + 拖放目标
//
// 为什么现在才做：M1 的侧栏树一直是占位文案，但 M8 的"拖动文件到目录树 = 移动"必须有真实目标。
// 设计要点：
// - **懒加载**：只在展开时拉一层（GET /fs/list），大目录不会一次性把整棵树塞进内存；
// - **只显示目录**：文件不进树（树是导航，不是第二个列表）；
// - **扁平化渲染**：递归组件在 SFC 里要额外绕（自引用），这里把"可见节点"拍平成一个数组，靠缩进表达层级；
// - **拖放**：dragover 时高亮，drop 时把 dataTransfer 里的路径交给父组件去调 /fs/move。

import { computed, onMounted, ref, watch } from 'vue';

import { api } from '../../api/client.js';

const props = defineProps({
  /** 当前所在目录（用于高亮） */
  currentPath: { type: String, default: '/' },
});
const emit = defineEmits(['navigate', 'drop-paths']);

/** path -> { children: [{path,name}], expanded, loading } */
const nodes = ref(new Map());
const dropTargetPath = ref(null);

const ROOT_PATH = '/';

async function loadChildren(nodePath) {
  const existing = nodes.value.get(nodePath);
  // 用 loaded 标记判断"是否真的加载过"：不能拿 children 是否为空当依据
  // （登录前/网络失败时 children 也是空，早退会让树永远空着，不再重试 —— 实测踩过）
  if (existing && existing.loaded) return;
  nodes.value.set(nodePath, { ...(existing || {}), loading: true, children: existing?.children || [], expanded: true, loaded: false });
  try {
    const payload = await api.get('/fs/list', { path: nodePath, sort: 'name', order: 'asc' });
    const children = ((payload && payload.entries) || [])
      .filter((entry) => entry.type === 'dir')
      .map((entry) => ({ path: entry.path, name: entry.name }));
    nodes.value.set(nodePath, { loading: false, children, expanded: true, loaded: true });
  } catch {
    // 目录不可读（或暂时没登录）：保持空子树但**标记未加载**，下次进入/展开会重试
    nodes.value.set(nodePath, { loading: false, children: [], expanded: true, loaded: false });
  }
}

async function toggle(nodePath) {
  const node = nodes.value.get(nodePath);
  if (node && node.expanded) {
    nodes.value.set(nodePath, { ...node, expanded: false });
    return;
  }
  await loadChildren(nodePath);
}

/** 拍平可见节点：根 + 递归展开的部分 */
const visibleNodes = computed(() => {
  const result = [];
  const walk = (nodePath, depth) => {
    const node = nodes.value.get(nodePath);
    if (!node) return;
    for (const child of node.children || []) {
      result.push({ ...child, depth, expanded: Boolean(nodes.value.get(child.path)?.expanded) });
      if (nodes.value.get(child.path)?.expanded) walk(child.path, depth + 1);
    }
  };
  walk(ROOT_PATH, 0);
  return result;
});

async function onDrop(targetPath, event) {
  dropTargetPath.value = null;
  let paths = [];
  try {
    paths = JSON.parse(event.dataTransfer.getData('application/x-zipcalm-paths') || '[]');
  } catch {
    paths = [];
  }
  if (!Array.isArray(paths) || paths.length === 0) return;
  emit('drop-paths', { paths, targetDir: targetPath });
}

function onDragOver(nodePath, event) {
  // preventDefault 才允许 drop（浏览器默认拒绝）
  event.preventDefault();
  dropTargetPath.value = nodePath;
}

// 进入目录后刷新根层：新目录可能刚建出来（右键"新建文件夹" / 压缩产物），树要能看见
watch(
  () => props.currentPath,
  async () => {
    nodes.value.delete(ROOT_PATH);
    await loadChildren(ROOT_PATH);
  },
);

onMounted(() => {
  nodes.value.set(ROOT_PATH, { loading: false, children: [], expanded: true });
  void loadChildren(ROOT_PATH);
});
</script>

<template>
  <div class="dir-tree" data-testid="directory-tree">
    <p class="dir-tree__caption">目录树（拖文件到这里可移动）</p>
    <button
      type="button"
      class="dir-tree__node dir-tree__node--root"
      :class="{ 'dir-tree__node--active': currentPath === '/' }"
      :data-drop-active="dropTargetPath === '/'"
      data-testid="tree-node-root"
      @click="emit('navigate', '/')"
      @dragover="onDragOver('/', $event)"
      @dragleave="dropTargetPath = null"
      @drop="onDrop('/', $event)"
    >
      / 根目录
    </button>
    <ul class="dir-tree__list">
      <li
        v-for="node in visibleNodes"
        :key="node.path"
        class="dir-tree__row"
        :style="{ paddingLeft: `${node.depth * 14}px` }"
      >
        <!-- 展开按钮与行按钮是**兄弟**关系：嵌套可交互元素在 HTML/ARIA 里都是非法结构 -->
        <button
          type="button"
          class="dir-tree__toggle"
          :aria-label="`${node.expanded ? '收起' : '展开'} ${node.name}`"
          :aria-expanded="node.expanded ? 'true' : 'false'"
          :data-testid="`tree-toggle-${node.name}`"
          @click.stop="toggle(node.path)"
        >
          {{ node.expanded ? '▾' : '▸' }}
        </button>
        <button
          type="button"
          class="dir-tree__node"
          :class="{ 'dir-tree__node--active': currentPath === node.path }"
          :data-drop-active="dropTargetPath === node.path"
          :data-testid="`tree-node-${node.name}`"
          @click="emit('navigate', node.path)"
          @dragover="onDragOver(node.path, $event)"
          @dragleave="dropTargetPath = null"
          @drop="onDrop(node.path, $event)"
        >
          {{ node.name }}
        </button>
      </li>
    </ul>
  </div>
</template>
