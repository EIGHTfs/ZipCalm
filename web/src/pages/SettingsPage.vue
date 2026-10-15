<script setup>
// 设置页（占位）：M6 接入 /api/v1/blacklist/* 与 /api/v1/formats
//
// 展示三层黑名单的结构（docs/M0/数据模型.md §七），让契约在界面上可见：
// global（内置、不可删、可关）/ user（用户自定义、全量替换）/ task（任务级临时）。

import { useUiStore } from '../stores/ui.js';

const ui = useUiStore();

const layers = [
  { key: 'global', title: '全局默认（内置）', note: '不可删除、可整层关闭：已压缩格式 + 系统垃圾' },
  { key: 'user', title: '用户自定义', note: '设置页增删，全量替换，立即生效' },
  { key: 'task', title: '任务级临时', note: '提交压缩任务时临时排除，仅本次生效' },
];
</script>

<template>
  <section class="card">
    <h3 class="card__title">设置</h3>
    <p class="card__desc">
      F1 仅占位。M6 起接入 <code>/api/v1/blacklist</code>（读取三层）、
      <code>PUT /api/v1/blacklist/user</code>（全量替换）与
      <code>/api/v1/blacklist/preview</code>（命中预览）。
    </p>
  </section>

  <section class="card">
    <h3 class="card__title">黑名单三层结构</h3>
    <ul class="tree" style="margin-top: var(--space-3)">
      <li v-for="layer in layers" :key="layer.key" class="tree__item">
        <span class="badge">{{ layer.key }}</span>
        <span><strong>{{ layer.title }}</strong> — {{ layer.note }}</span>
      </li>
    </ul>
  </section>

  <section class="card">
    <h3 class="card__title">界面偏好（已是真交互）</h3>
    <p class="card__desc">
      当前视图模式：<strong>{{ ui.viewMode }}</strong>（顶部栏可切换；该状态存在 pinia，
      未登录也不影响）。深色模式属 M8 范围，F1 不做。
    </p>
  </section>
</template>
