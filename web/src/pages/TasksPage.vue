<script setup>
// 压缩任务页（占位）：M3 接入 GET /api/v1/tasks + GET /api/v1/tasks/events(SSE)
//
// 这里把 shared/task-status.js 与 shared/task-phase.js 的枚举**渲染成可见清单**：
// 既是给使用者的说明，也是「前端枚举来自 shared/、没有硬编码」的可视证据
// （改 shared 里的状态名，这个列表会跟着变）。

import {
  TASK_STATUS_VALUES,
  TASK_STATUS_LABELS,
  TASK_PHASE_ORDER,
  TASK_PHASE_LABELS,
  COMPRESS_MODE_LABELS,
  COMPRESS_MODE_VALUES,
} from '../constants/index.js';
</script>

<template>
  <section class="card">
    <h3 class="card__title">压缩任务</h3>
    <p class="card__desc">
      F1 仅占位。M3 起接入 <code>/api/v1/tasks</code>（列表/单查）与
      <code>/api/v1/tasks/events</code>（SSE 推送）；断线重连后先收 <code>snapshot</code>
      快照再收增量，进度是「状态」不是「消息」。
    </p>
  </section>

  <section class="card">
    <h3 class="card__title">任务状态（7 值，来自 shared/task-status.js）</h3>
    <ul class="placeholder-grid" style="margin-top: var(--space-3)">
      <li v-for="status in TASK_STATUS_VALUES" :key="status" class="placeholder-block">
        <strong>{{ TASK_STATUS_LABELS[status] }}</strong><br />
        <code>{{ status }}</code>
      </li>
    </ul>
  </section>

  <section class="card">
    <h3 class="card__title">执行阶段（6 步，来自 shared/task-phase.js）</h3>
    <ol class="placeholder-grid" style="margin-top: var(--space-3)">
      <li v-for="(phase, index) in TASK_PHASE_ORDER" :key="phase" class="placeholder-block">
        <strong>{{ index + 1 }}. {{ TASK_PHASE_LABELS[phase] }}</strong><br />
        <code>{{ phase }}</code>
      </li>
    </ol>
  </section>

  <section class="card">
    <h3 class="card__title">压缩模式（互斥单选，来自 shared/compress-modes.js）</h3>
    <ul class="tree" style="margin-top: var(--space-3)">
      <li v-for="mode in COMPRESS_MODE_VALUES" :key="mode" class="tree__item">
        <span class="badge">{{ mode }}</span>
        <span>{{ COMPRESS_MODE_LABELS[mode] }}</span>
      </li>
    </ul>
  </section>
</template>
