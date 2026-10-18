<script setup>
// uPlot 最小封装（F1.1 选型落地：图表库 = uplot）
//
// 为什么单独封一层：uPlot 是命令式 API（new uPlot(opts, data, target)），
// 直接写在页面里会出现「重复 create / 忘记 destroy / 窗口变化不重绘」三类问题。
// 这里只做三件事：挂载时 create、尺寸变化时 setSize、卸载时 destroy。
//
// 职责边界（重要）：
// - 本组件**只画图**，不做指标采集、不做 SSE、不发请求 —— 真实数据接入是 M7 的事。
// - 样式（uPlot 自带 CSS）在这里 import 一次，避免每个使用方各自引。

import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

const props = defineProps({
  /** 系列定义：[{ label, stroke, fill? }]，第 0 项是 X 轴占位（不需要 label） */
  series: { type: Array, default: () => [{}] },
  /** 数据：[[x, x, ...], [y, y, ...], ...]，长度与 series 对应 */
  data: { type: Array, default: () => [[], []] },
  /** 图表高度（像素）；宽度由容器自适应 */
  height: { type: Number, default: 220 },
  /** 图例/轴颜色等可选覆盖（保持最小，需要的场景再扩展） */
  scales: { type: Object, default: () => ({ x: { time: false } }) },
  /**
   * 是否显示 uPlot 自带图例。默认 **关**：
   * uPlot 的 legend 是"悬停才填值"的（无光标时显示 `--`），而且默认文案是英文 `Value`，
   * 放在中文卡片里既突兀又容易被误读成"数据没绑上"。标签交给卡片自己画。
   */
  showLegend: { type: Boolean, default: false },
});

// shallowRef：uPlot 实例是大对象，不需要 Vue 深度代理（避免性能与递归问题）
const chartRef = shallowRef(null);
const containerRef = ref(null);
let resizeObserver = null;

/** 按容器当前宽度创建图表（宽度为 0 时不创建，等 ResizeObserver 再触发） */
function createChart() {
  const el = containerRef.value;
  if (!el) return;
  const width = el.clientWidth;
  if (!width) return;

  destroyChart();

  chartRef.value = new uPlot(
    {
      width,
      height: props.height,
      series: props.series,
      scales: props.scales,
      legend: { show: props.showLegend },
      cursor: { drag: { x: false, y: false } },
    },
    props.data,
    el,
  );
}

function destroyChart() {
  if (chartRef.value) {
    chartRef.value.destroy();
    chartRef.value = null;
  }
}

/** 尺寸变化：uPlot 不会自己响应容器变化，必须显式 setSize */
function handleResize() {
  const el = containerRef.value;
  if (!el) return;
  const width = el.clientWidth;
  if (!width) return;
  if (!chartRef.value) {
    createChart();
    return;
  }
  chartRef.value.setSize({ width, height: props.height });
}

onMounted(() => {
  createChart();
  // 容器宽度依赖布局（侧栏、窗口大小），用 ResizeObserver 跟随
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => handleResize());
    if (containerRef.value) resizeObserver.observe(containerRef.value);
  }
  window.addEventListener('resize', handleResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  destroyChart();
});

// 数据更新：先判断 series 是否变化（变化需重建，uPlot 不支持换 series 数量），否则只 setData
watch(
  () => props.data,
  (next) => {
    if (!chartRef.value) {
      createChart();
      return;
    }
    chartRef.value.setData(next);
  },
  { deep: true },
);

watch(
  () => props.height,
  (next) => {
    if (chartRef.value) chartRef.value.setSize({ width: chartRef.value.width, height: next });
  },
);

// 暴露实例，方便 M7 做「暂停/恢复」等高级操作（当前不额外提供方法）
defineExpose({ chartRef, handleResize });
</script>

<template>
  <!-- 容器必须自己撑住高度：uPlot 只负责往里面塞 canvas -->
  <div
    ref="containerRef"
    class="trend-chart"
    data-component="trend-chart"
    :style="{ minHeight: `${height}px` }"
  ></div>
</template>

<style scoped>
.trend-chart {
  width: 100%;
  /* uPlot 生成的 .uplot 容器会自带尺寸，这里只保证父层可测量 */
  overflow: hidden;
}
</style>
