<script setup>
// 性能看板页（占位）：M7 接入 GET /api/v1/metrics/snapshot 与 /metrics/history
//
// 卡片数量与名称严格按 docs/07 §五「固定 6 个卡片」：
// CPU / 内存 / 事件循环延迟 / 磁盘 IO / 活跃压缩任务 / 最近完成。
// F1 阶段数值显示「—」，采集频率文案来自契约（系统 5s、进程 1s、前端 2s 轮询）。

import { METRICS_POLL_MS } from '../constants/index.js';

const cards = [
  { key: 'cpu', title: 'CPU', desc: '系统总占用 + 本进程占用（双线图）' },
  { key: 'memory', title: '内存', desc: 'RSS + Heap' },
  { key: 'eventloop', title: '事件循环延迟', desc: '反映服务卡不卡（最关键）' },
  { key: 'diskio', title: '磁盘 IO', desc: '读/写速率' },
  { key: 'tasks', title: '活跃压缩任务', desc: '数字 + 队列长度' },
  { key: 'recent', title: '最近完成', desc: '最近 5 个任务的节省比例' },
];
</script>

<template>
  <section class="card">
    <h3 class="card__title">性能看板</h3>
    <p class="card__desc">
      F1 仅占位。M7 接入 <code>/api/v1/metrics/snapshot</code>（最新一帧）与
      <code>/api/v1/metrics/history</code>（最近 5 分钟环形缓冲）；前端轮询间隔 {{ METRICS_POLL_MS }} ms，
      监控本身开销要求 &lt; 1% CPU。
    </p>
  </section>

  <section class="placeholder-grid">
    <article v-for="card in cards" :key="card.key" class="card">
      <h4 class="card__title">{{ card.title }}</h4>
      <p style="font-size: var(--font-size-xl); margin: var(--space-2) 0">—</p>
      <p class="card__desc">{{ card.desc }}</p>
    </article>
  </section>
</template>
