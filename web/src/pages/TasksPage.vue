<script setup>
// 任务状态枚举查阅页：把 shared/ 里的状态/阶段/模式清单渲染出来，供使用者查阅与「前端未硬编码」的可视证据
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
      实际的任务列表、进度与取消按钮在<b>底部任务条</b>与<b>任务抽屉</b>里（由
      <code>/api/v1/tasks/events</code> 的 SSE 推送驱动，断线重连后先收
      <code>snapshot</code> 快照再收增量 —— 进度是「状态」不是「消息」）。
      本页列出状态/阶段/模式的取值清单，供查阅。
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
