// 性能指标轮询 store（M7）
//
// 契约与纪律：
// - docs/07 §二：前端 **2 秒**轮询一次；指标是快照不是事件，所以用轮询不用 SSE
// - docs/07 §四：只保留 6 张卡片需要的字段，不堆指标
// - 三条实现要求（本项目踩过的坑）：
//   ① **防竞态**：上一条请求没回来不叠发下一条（inFlight 闸门）
//   ② **离开即停**：页面卸载或切到后台时清掉定时器，回来先立即拉一次再恢复轮询
//   ③ 轮询失败不清空已有数值（旧值比"—"有用），只把错误显示出来

import { defineStore } from 'pinia';

import { api } from '../api/client.js';
import { METRICS_POLL_MS } from '../constants/index.js';

/** 历史曲线每隔多少个 tick 拉一次（2s × 5 = 10s）：曲线不需要 2s 那么细，省一点接口调用 */
const HISTORY_EVERY_TICKS = 5;
/** 「最近完成」每隔多少个 tick 拉一次（2s × 3 = 6s） */
const RECENT_EVERY_TICKS = 3;
/** 「最近完成」卡片只展示最近几条（历史接口会返回很多条，卡片不该塞整天历史） */
const RECENT_LIMIT = 3;

export const useMetricsStore = defineStore('metrics', {
  state: () => ({
    frame: null,
    history: [],
    recent: [],
    errorText: '',
    /** 是否已拿到过至少一帧（区分"还没采到"与"采集到 0"） */
    loadedOnce: false,
    running: false,
    /** ① 防竞态闸门：上一条请求未回时不再发下一条 */
    inFlight: false,
    tickCount: 0,
    timer: null,
    onVisibilityChange: null,
  }),
  actions: {
    /** 拉一帧快照 */
    async fetchSnapshot() {
      const frame = await api.get('/metrics/snapshot');
      this.frame = frame || null;
      this.loadedOnce = true;
    },
    /** 拉历史曲线（window 固定 5 分钟，step 5 秒 → 60 点） */
    async fetchHistory() {
      const payload = await api.get('/metrics/history', { window: 300, step: 5 });
      this.history = (payload && payload.samples) || [];
    },
    /** 拉最近完成（只取最近 N 条终态任务） */
    async fetchRecent() {
      const payload = await api.get('/tasks/history', { limit: RECENT_LIMIT });
      this.recent = ((payload && payload.items) || []).slice(0, RECENT_LIMIT);
    },
    /** 一个 tick：快照每次都拉，历史/最近完成按节流拉 */
    async tick() {
      if (this.inFlight) return; // ① 防竞态：上一条没回来就不叠发
      this.inFlight = true;
      this.tickCount = (this.tickCount || 0) + 1;
      try {
        await this.fetchSnapshot();
        if (this.tickCount % HISTORY_EVERY_TICKS === 1) await this.fetchHistory();
        if (this.tickCount % RECENT_EVERY_TICKS === 1) await this.fetchRecent();
        this.errorText = '';
      } catch (error) {
        // ③ 失败不清空旧值：页面继续显示上一次的数，只在顶部提示
        this.errorText = `[${error.code || 'ERROR'}] ${error.message}`;
      } finally {
        this.inFlight = false;
      }
    },
    /** 启动轮询（幂等）：先立即拉一次，再按 2s 节奏 */
    start() {
      if (this.running) return;
      this.running = true;
      this.tickCount = 0;
      void this.tick();
      this.timer = setInterval(() => {
        // 切到后台时浏览器会节流定时器；这里再挡一层，避免"人不在还一直打接口"
        if (document.visibilityState === 'hidden') return;
        void this.tick();
      }, METRICS_POLL_MS);
      this.onVisibilityChange = () => {
        // 回到前台：立即补一帧（2s 定时器可能已被浏览器节流得不准），不等下一个 tick
        if (document.visibilityState === 'visible' && this.running) void this.tick();
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    },
    /** 停止轮询（页面卸载时调用）：清定时器 + 摘监听，避免离开的页面继续打接口 */
    stop() {
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.onVisibilityChange) document.removeEventListener('visibilitychange', this.onVisibilityChange);
      this.onVisibilityChange = null;
    },
  },
});
