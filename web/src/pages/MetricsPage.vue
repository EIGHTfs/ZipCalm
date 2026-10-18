<script setup>
// 性能看板（M7）：6 张卡片，2 秒轮询 /api/v1/metrics/snapshot
//
// 卡片集合严格按 docs/07 §四/§五：CPU / 内存 / 事件循环延迟 / 磁盘 IO / 活跃任务 / 最近完成。
// 不堆指标（温度/风扇/网络都不做）；事件循环延迟要有"卡不卡"的语义分档，而不能只给一个毫秒数。
//
// 轮询纪律在 store 里（web/src/stores/metrics.js）：防叠发、离开即停、回来先补一帧、失败不清空旧值。

import { computed, onMounted, onUnmounted } from 'vue';

import TrendChart from '../components/metrics/TrendChart.vue';
import { useMetricsStore } from '../stores/metrics.js';
import { formatBytes, formatPercent, formatRate, formatRelativeTime } from '../utils/format.js';

const metrics = useMetricsStore();

/** 事件循环延迟分档：<10ms 正常 / 10~50ms 有压力 / >50ms 卡顿（docs/11 验收第 2 条） */
const LAG_TIERS = [
  { maxMs: 10, label: '正常', tone: 'ok', hint: '事件循环响应及时，服务不卡' },
  { maxMs: 50, label: '有压力', tone: 'warn', hint: '主线程开始排队，长任务可能拖慢请求' },
  { maxMs: Number.POSITIVE_INFINITY, label: '卡顿', tone: 'error', hint: '主线程被占用，接口会明显变慢' },
];

const system = computed(() => (metrics.frame && metrics.frame.system) || {});
const processStats = computed(() => (metrics.frame && metrics.frame.process) || {});
const tasks = computed(() => (metrics.frame && metrics.frame.tasks) || {});

/** 延迟分档（无数据时返回 null，页面上显示"—"而不是假装"正常"） */
const lagTier = computed(() => {
  const delay = processStats.value.eventLoopDelayMs;
  if (typeof delay !== 'number') return null;
  return LAG_TIERS.find((tier) => delay < tier.maxMs);
});

/** CPU 曲线：把 history 的 samples 转成 uPlot 的 [x, 系统, 本进程] 结构 */
const chartSeries = computed(() => [
  {},
  { label: '系统 CPU（%）', stroke: '#2f6fed', width: 1.5 },
  { label: '本进程 CPU（%）', stroke: '#16a34a', width: 1.5 },
]);
const chartData = computed(() => {
  const samples = metrics.history || [];
  if (samples.length === 0) return [[], [], []];
  const firstTs = samples[0].ts;
  const x = samples.map((sample) => Math.round((sample.ts - firstTs) / 1000));
  const systemValues = samples.map((sample) => Number(sample.system.cpuPercent ?? 0));
  const processValues = samples.map((sample) => Number(sample.process.cpuPercent ?? 0));
  return [x, systemValues, processValues];
});

/** 系统内存占用率（拿不到总量时为 null，不显示假的 0%） */
const memoryPercent = computed(() => {
  const used = system.value.memUsedBytes;
  const total = system.value.memTotalBytes;
  if (!used || !total) return null;
  return (used / total) * 100;
});

/** 最近完成：一行一个，格式 + 节省比例 + 相对时间 */
const recentItems = computed(() => (metrics.recent || []).slice(0, 3));

function sourceLabel(task) {
  const first = task && Array.isArray(task.sources) && task.sources[0];
  if (!first) return '—';
  const name = first.name || first.path || '—';
  const count = (task.sources || []).length;
  return count > 1 ? `${name} 等 ${count} 项` : name;
}

onMounted(() => metrics.start());
onUnmounted(() => metrics.stop());
</script>

<template>
  <section class="card">
    <h3 class="card__title">性能看板</h3>
    <p class="card__desc">
      每 2 秒轮询一次；系统指标 5 秒采一次、进程指标 1 秒采一次。采集开销实测 &lt; 0.1% CPU。
      <span v-if="metrics.errorText" class="badge badge--warn" data-testid="metrics-error">{{ metrics.errorText }}</span>
    </p>
  </section>

  <section class="placeholder-grid" data-testid="metrics-cards">
    <!-- ① CPU：系统 + 本进程，附最近 5 分钟曲线（压缩时能直接看出飙升） -->
    <article class="card" data-testid="card-cpu">
      <h4 class="card__title">CPU</h4>
      <p class="metric__value">{{ formatPercent(system.cpuPercent) }}</p>
      <p class="card__desc">系统占用；本进程 {{ formatPercent(processStats.cpuPercent) }}</p>
      <div v-if="chartData[0].length > 1" style="margin-top: var(--space-3)">
        <TrendChart :series="chartSeries" :data="chartData" :height="120" />
      </div>
      <p v-else class="card__desc">最近 5 分钟还没有足够的采样点</p>
    </article>

    <!-- ② 内存：RSS + Heap + 系统占用 -->
    <article class="card" data-testid="card-memory">
      <h4 class="card__title">内存</h4>
      <p class="metric__value">{{ formatBytes(processStats.rssBytes) }}</p>
      <p class="card__desc">
        RSS；Heap {{ formatBytes(processStats.heapUsedBytes) }}
        <template v-if="memoryPercent !== null"> · 系统已用 {{ formatPercent(memoryPercent) }}（{{ formatBytes(system.memUsedBytes) }} / {{ formatBytes(system.memTotalBytes) }}）</template>
        <template v-else> · 系统内存数据不可用</template>
      </p>
    </article>

    <!-- ③ 事件循环延迟：数值 + 语义分档（用户要能看懂"卡不卡"） -->
    <article class="card" data-testid="card-eventloop">
      <h4 class="card__title">事件循环延迟</h4>
      <p class="metric__value">
        {{ typeof processStats.eventLoopDelayMs === 'number' ? `${processStats.eventLoopDelayMs.toFixed(1)} ms` : '—' }}
      </p>
      <p class="card__desc">
        <span v-if="lagTier" class="badge" :class="`badge--${lagTier.tone}`" data-testid="lag-tier">{{ lagTier.label }}</span>
        {{ lagTier ? lagTier.hint : '还没有采样数据' }}
      </p>
      <p class="card__desc">事件循环利用率 {{ typeof processStats.eventLoopUtilization === 'number' ? formatPercent(processStats.eventLoopUtilization * 100) : '—' }}</p>
    </article>

    <!-- ④ 磁盘 IO：读/写速率（kworker 层面的物理盘，已排除 md/dm 避免重复计数） -->
    <article class="card" data-testid="card-diskio">
      <h4 class="card__title">磁盘 IO</h4>
      <p class="metric__value">{{ formatRate(system.diskReadBps) }}</p>
      <p class="card__desc">读；写 {{ formatRate(system.diskWriteBps) }}</p>
    </article>

    <!-- ⑤ 活跃任务：正在跑 + 排队 -->
    <article class="card" data-testid="card-tasks">
      <h4 class="card__title">活跃压缩任务</h4>
      <p class="metric__value">{{ metrics.loadedOnce ? Number(tasks.active || 0) : '—' }}</p>
      <p class="card__desc">排队 {{ metrics.loadedOnce ? Number(tasks.queued || 0) : '—' }} 个（串行执行）</p>
    </article>

    <!-- ⑥ 最近完成：只显示最近 3 条（历史接口返回很多，卡片不塞整天记录） -->
    <article class="card" data-testid="card-recent">
      <h4 class="card__title">最近完成</h4>
      <ul v-if="recentItems.length > 0" class="tree" style="margin-top: var(--space-2)">
        <li v-for="task in recentItems" :key="task.id" class="tree__item" data-testid="recent-item">
          <span class="badge">{{ task.format }}</span>
          <span>
            {{ sourceLabel(task) }}
            <template v-if="task.result && typeof task.result.ratio === 'number'"> · 节省 {{ formatPercent(task.result.ratio * 100) }}</template>
            · {{ formatRelativeTime(task.finishedAt || task.updatedAt) }}
          </span>
        </li>
      </ul>
      <p v-else class="card__desc" data-testid="recent-empty">还没有完成的任务（压缩完成后会出现在这里）</p>
    </article>
  </section>
</template>
