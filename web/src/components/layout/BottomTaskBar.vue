<script setup>
// 底部任务条（docs/08 第八节布局图第三行 + §「任务进度要常驻可见」）
// 内容：任务摘要（活跃/排队）| 当前任务摘要 | 微型指标占位 | 操作按钮
//
// F1 阶段：数字全部来自 pinia 的 taskSummary（默认 0），指标显示「—」并标注 M7 接入；
// 「展开/清空」按钮 disabled，因为任务抽屉属于 M3 范围。

import { computed } from 'vue';

import { useUiStore } from '../../stores/ui.js';

const ui = useUiStore();

const summary = computed(() => ui.taskSummary);
const currentText = computed(() =>
  summary.value.active > 0 ? '有任务正在压缩（M3 接入实时进度）' : '暂无进行中的任务',
);
const parallelText = computed(() => (summary.value.parallel ? '并行已开启' : '串行执行'));
</script>

<template>
  <footer class="bottom-task-bar" data-region="bottom-task-bar">
    <div class="bottom-task-bar__summary">
      <span class="badge badge--active">活跃 {{ summary.active }}</span>
      <span class="badge">排队 {{ summary.queued }}</span>
      <span class="badge" :title="'v1 契约：压缩串行执行；并行开关为占位'">{{ parallelText }}</span>
    </div>

    <div class="bottom-task-bar__current">{{ currentText }}</div>

    <div class="bottom-task-bar__metrics" aria-label="微型指标">
      <span>CPU —</span>
      <span>内存 —</span>
      <span>事件循环 —</span>
      <span class="badge">M7 接入</span>
    </div>

    <div class="bottom-task-bar__actions">
      <button type="button" disabled title="任务抽屉将在 M3 实现">展开</button>
      <button type="button" disabled title="清理历史将在 M8 实现">清空</button>
    </div>
  </footer>
</template>
