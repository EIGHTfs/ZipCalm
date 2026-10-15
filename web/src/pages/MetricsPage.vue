<script setup>
// 性能看板页（占位）：M7 接入 GET /api/v1/metrics/snapshot 与 /metrics/history
//
// 卡片数量与名称严格按 docs/07 §五「固定 6 个卡片」：
// CPU / 内存 / 事件循环延迟 / 磁盘 IO / 活跃压缩任务 / 最近完成。
// F1 阶段数值显示「—」，采集频率文案来自契约（系统 5s、进程 1s、前端 2s 轮询）。
//
// F1.1 变更：图表库拍板为 **uplot**（docs/07 的候选之一），这里用 TrendChart 渲染
// 一张**静态示例图**验证「依赖可用 + 能构建 + 能渲染」。真实指标采集/SSE/6 卡数据接入属 M7，
// 本页仍保持占位，不做任何请求。

import { METRICS_POLL_MS } from '../constants/index.js';
import TrendChart from '../components/metrics/TrendChart.vue';

const cards = [
  { key: 'cpu', title: 'CPU', desc: '系统总占用 + 本进程占用（双线图）' },
  { key: 'memory', title: '内存', desc: 'RSS + Heap' },
  { key: 'eventloop', title: '事件循环延迟', desc: '反映服务卡不卡（最关键）' },
  { key: 'diskio', title: '磁盘 IO', desc: '读/写速率' },
  { key: 'tasks', title: '活跃压缩任务', desc: '数字 + 队列长度' },
  { key: 'recent', title: '最近完成', desc: '最近 5 个任务的节省比例' },
];

// ===== 静态示例数据（假数据，仅用于验证图表库可用；M7 会换成 /metrics/history）=====
// 用确定性函数生成 60 个点，不用随机数：这样"示例图长什么样"在每次构建/刷新都一致，
// 出问题时也容易判断是渲染问题而不是数据抖动。
const SAMPLE_POINTS = 60;
const sampleX = Array.from({ length: SAMPLE_POINTS }, (_, i) => i);

function wave(amplitude, period, offset) {
  return sampleX.map((i) => Number((offset + amplitude * Math.sin((i / period) * Math.PI * 2)).toFixed(2)));
}

// 与 docs/07 的 CPU 卡片设计对应：系统占用 + 本进程占用（两条线，单位 %）
const sampleSeries = [
  {},
  { label: '系统 CPU（%）', stroke: '#2f6fed', width: 1.5 },
  { label: '本进程 CPU（%）', stroke: '#16a34a', width: 1.5 },
];
const sampleData = [sampleX, wave(18, 20, 34), wave(6, 13, 9)];
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

  <section class="card" data-testid="chart-library-demo">
    <h3 class="card__title">图表库可用性验证（uPlot）</h3>
    <p class="card__desc">
      下面这张是<strong>静态示例数据</strong>（两条正弦波，模拟「系统 CPU / 本进程 CPU」），只为证明图表库
      能构建、能渲染、尺寸自适应；<strong>M7 接入真实指标</strong>后替换为
      <code>/api/v1/metrics/history</code> 的数据。
    </p>
    <div style="margin-top: var(--space-4)">
      <TrendChart :series="sampleSeries" :data="sampleData" :height="220" />
    </div>
  </section>

  <section class="placeholder-grid">
    <article v-for="card in cards" :key="card.key" class="card">
      <h4 class="card__title">{{ card.title }}</h4>
      <p style="font-size: var(--font-size-xl); margin: var(--space-2) 0">—</p>
      <p class="card__desc">{{ card.desc }}</p>
    </article>
  </section>
</template>
