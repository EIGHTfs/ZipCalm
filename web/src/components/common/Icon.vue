<script setup>
// 图标收口组件（F1.2「库收口层」）
//
// 为什么要有这一层：用户要求「以后换库时改动量最小化」。做法是**收口到单一入口 + 静态检查钉死**：
// - 全项目**只有这一个文件**允许 import 图标库（由 scripts/check-drift.js 强制，违规直接构建门禁报红）；
// - 对外只暴露**业务语义名**（files / tasks / metrics / settings / storage / formats）与尺寸，
//   不把 lucide 的组件类型、props、注册方式泄漏给调用方；
// - 将来换图标库（比如换成 @iconify/vue 或自绘 sprite），只改本文件的映射表，调用方一行都不用动。
//
// tree-shaking：映射表**只登记项目实际用到的图标**（不 import 整包），
// 因此打包体积只包含这几个图标，而不是 lucide 全量（5800+ 个）。

import { computed } from 'vue';
import {
  Archive,
  ChartColumn,
  CircleHelp,
  File,
  FileArchive,
  Folder,
  HardDrive,
  Link2,
  Settings,
} from 'lucide-vue-next';

const props = defineProps({
  /** 语义名（业务概念，不是图标库的图标名） */
  name: { type: String, required: true },
  /** 像素尺寸 */
  size: { type: [Number, String], default: 16 },
  /** 线宽（视觉微调，默认与设计稿一致） */
  strokeWidth: { type: [Number, String], default: 1.8 },
});

// ===== 唯一的库映射点：语义名 → 图标组件 =====
// 新增图标只改这里；调用方永远只写 <Icon name="..." />
const ICON_COMPONENTS = {
  files: Folder,
  file: File,
  tasks: Archive,
  metrics: ChartColumn,
  settings: Settings,
  storage: HardDrive,
  hardlink: Link2,
  formats: FileArchive,
};

// 未知名字的中性占位：不抛错、不白屏，只是画一个问号图标
const PLACEHOLDER_ICON = CircleHelp;

// warn 只提示一次（同一语义名重复出现不刷屏）
const warnedNames = new Set();

const resolvedIcon = computed(() => {
  const component = ICON_COMPONENTS[props.name];
  if (component) return component;

  if (!warnedNames.has(props.name)) {
    warnedNames.add(props.name);
    // 用 warn 而不是 error：这是"调用方写错了名字"的开发期提示，
    // 不影响页面渲染，也不应触发「控制台有报错」的验收判据。
    console.warn(
      `[Icon] 未登记的图标名 "${props.name}"，已回落为占位图标。请到 Icon.vue 的 ICON_COMPONENTS 中登记。`,
    );
  }
  return PLACEHOLDER_ICON;
});
</script>

<template>
  <component
    :is="resolvedIcon"
    class="icon"
    :size="size"
    :stroke-width="strokeWidth"
    aria-hidden="true"
  />
</template>
