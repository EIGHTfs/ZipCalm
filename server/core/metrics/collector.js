// 性能指标采集（M7）：/proc 系统指标 5s + 进程指标 1s → 5 分钟环形缓冲
//
// 契约：
// - docs/M0/API规范.md §4.6：snapshot 的字段集合（system / process / tasks），history 的 window/step
// - docs/07 §二 采集频率：系统 5s、进程 1s、前端 2s 轮询；§四 只允许这 6 张卡片对应的字段
// - 依赖策略（lead 拍板）：**不引 systeminformation**，全部 Node 内置 + /proc（见 procfs.js 头部）
//
// 三条硬约束（lead 验收项，改代码时别丢）：
// 1. 定时器必须 unref()，并在 stop() 里清掉 —— 否则优雅关闭会被这两个定时器拖住；
// 2. 任何采集失败都降级为 null/0，**绝不向外抛**（定时器里的未捕获异常会把整个服务带走）；
// 3. 环形缓冲只保留最近 5 分钟，不做持久化。

import os from 'node:os';
import { performance } from 'node:perf_hooks';

import { readProcSnapshot, sectorsToBytes } from './procfs.js';

/** 采集频率（契约 docs/07 §二，不开放配置 —— 契约写死，避免"配了但没人读"的死配置） */
const SYSTEM_INTERVAL_MS = 5000;
/** 进程指标节奏，同时也是环形缓冲的帧间隔 */
const PROCESS_INTERVAL_MS = 1000;
/** 环形缓冲覆盖的时长与上限帧数（5 分钟 / 1s） */
const HISTORY_WINDOW_MS = 5 * 60 * 1000;
const HISTORY_MAX_FRAMES = Math.ceil(HISTORY_WINDOW_MS / PROCESS_INTERVAL_MS);
/** 事件循环延迟取最近多少个 tick 的均值（单帧尖刺不该立刻变成"服务很卡"） */
const LAG_SAMPLE_COUNT = 5;

/**
 * 事件循环延迟（毫秒）——**定时器漂移法**，不用 `perf_hooks.monitorEventLoopDelay`。
 *
 * 为什么不用内置直方图：实测 `monitorEventLoopDelay({ resolution: 20 })` 在**空载**下
 * `mean` 就是 20.95ms ≈ 分辨率本身（分辨率 20ms 时它把量化误差当成了延迟）。用它报"卡不卡"
 * 会把每个部署都显示成"延迟 20ms"。漂移法的原理是"期望时刻 vs 实际时刻"的差，没有量化偏差。
 */
export function createLagMeter(intervalMs = PROCESS_INTERVAL_MS) {
  let lastScheduledAt = null;
  const samples = [];

  return {
    /** 在每个 tick 开头调用：返回本次漂移（ms），并记录最近 N 个样本 */
    tick(nowMs = Date.now()) {
      const drift = lastScheduledAt === null ? 0 : Math.max(0, nowMs - lastScheduledAt - intervalMs);
      lastScheduledAt = nowMs;
      samples.push(drift);
      if (samples.length > LAG_SAMPLE_COUNT) samples.shift();
      return drift;
    },
    /** 最近 N 个样本的均值（没有样本时 null） */
    average() {
      if (samples.length === 0) return null;
      return samples.reduce((sum, value) => sum + value, 0) / samples.length;
    },
    reset() {
      lastScheduledAt = null;
      samples.length = 0;
    },
  };
}

/**
 * 采集器：start() 起两个定时器，stop() 清掉；snapshot()/history() 给路由用。
 * @param {{ logger?: object, taskStats?: () => object }} options
 */
export function createMetricsCollector({ logger, taskStats } = {}) {
  const cpuCount = Math.max(1, os.cpus().length);
  const frames = [];
  const lagMeter = createLagMeter(PROCESS_INTERVAL_MS);

  /** /proc 累计值快照（用于算两次采样之间的差值） */
  let prevCpuTimes = null;
  let prevDisk = null;
  let prevCpuUsage = null;
  let prevTickAt = null;
  let prevElu = performance.eventLoopUtilization();

  /** 最近一帧（system 部分单独缓存：它 5s 才采一次，1s 的帧复用最近值） */
  let latestSystem = { cpuPercent: null, memUsedBytes: null, memTotalBytes: null, diskReadBps: null, diskWriteBps: null };

  let systemTimer = null;
  let processTimer = null;
  let running = false;

  /** 百分比夹取（null 透传） */
  function clampPercent(value) {
    if (value === null || !Number.isFinite(value)) return null;
    return Math.min(100, Math.max(0, Number(value.toFixed(1))));
  }

  /** 系统指标（含 CPU 差值、内存、磁盘 Bps）——失败字段一律 null */
  async function collectSystem() {
    let snapshot = null;
    try {
      snapshot = await readProcSnapshot();
    } catch {
      snapshot = null;
    }
    const nowMs = Date.now();
    const cpuPercent = computeSystemCpu(snapshot && snapshot.cpuTimes);
    const disk = computeDiskRates(snapshot && snapshot.disk, nowMs);
    latestSystem = {
      cpuPercent: cpuPercent === null ? latestSystem.cpuPercent : cpuPercent,
      memUsedBytes: snapshot && snapshot.memory ? snapshot.memory.usedBytes : latestSystem.memUsedBytes,
      memTotalBytes: snapshot && snapshot.memory ? snapshot.memory.totalBytes : latestSystem.memTotalBytes,
      diskReadBps: disk ? disk.readBps : null,
      diskWriteBps: disk ? disk.writeBps : null,
    };
    prevDisk = snapshot && snapshot.disk ? { ...snapshot.disk, atMs: nowMs } : prevDisk;
    return latestSystem;
  }

  /** 系统 CPU 使用率：1 − 空闲增量/总增量（/proc/stat 累计值） */
  function computeSystemCpu(cpuTimes) {
    if (!cpuTimes) return null;
    const previous = prevCpuTimes;
    prevCpuTimes = cpuTimes;
    if (!previous) return null;
    const totalDelta = cpuTimes.total - previous.total;
    const idleDelta = cpuTimes.idle - previous.idle;
    if (!(totalDelta > 0)) return null;
    return clampPercent((1 - idleDelta / totalDelta) * 100);
  }

  /** 磁盘读写速率（Bps）：扇区差值 × 512 / 实际经过时间 */
  function computeDiskRates(disk, nowMs) {
    if (!disk || !prevDisk) return null;
    const elapsedMs = nowMs - prevDisk.atMs;
    if (!(elapsedMs > 0)) return null;
    const readBytes = sectorsToBytes(disk.readSectors - prevDisk.readSectors);
    const writeBytes = sectorsToBytes(disk.writeSectors - prevDisk.writeSectors);
    return {
      readBps: Math.max(0, Math.round((readBytes * 1000) / elapsedMs)),
      writeBps: Math.max(0, Math.round((writeBytes * 1000) / elapsedMs)),
    };
  }

  /** 进程指标：CPU（相对全部核，便于和 system.cpuPercent 直接比较）+ 内存 + 事件循环 */
  function collectProcess() {
    const nowMs = Date.now();
    const lagMs = lagMeter.tick(nowMs);

    let cpuPercent = null;
    const usage = process.cpuUsage();
    if (prevCpuUsage) {
      const elapsedMs = prevTickAt === null ? PROCESS_INTERVAL_MS : Math.max(1, nowMs - prevTickAt);
      const usedUs = (usage.user - prevCpuUsage.user) + (usage.system - prevCpuUsage.system);
      // 除以核数：与系统 CPU 同口径（0~100 表示"整机占比"），否则 4 核机器上进程跑满会显示 400%
      cpuPercent = clampPercent((usedUs / 1000 / elapsedMs / cpuCount) * 100);
    }
    prevCpuUsage = usage;
    prevTickAt = nowMs;

    const memory = process.memoryUsage();
    let utilization = null;
    try {
      const elu = performance.eventLoopUtilization(prevElu);
      prevElu = performance.eventLoopUtilization();
      utilization = Number.isFinite(elu.utilization) ? Number(elu.utilization.toFixed(3)) : null;
    } catch {
      utilization = null;
    }

    return {
      cpuPercent,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      eventLoopDelayMs: Number((lagMeter.average() === null ? lagMs : lagMeter.average()).toFixed(2)),
      eventLoopUtilization: utilization,
      uptimeMs: Math.round(process.uptime() * 1000),
    };
  }

  /** 任务三件套（契约 §4.6 的 tasks）；manager.stats().active 是 taskId，这里转成计数 */
  function collectTasks() {
    if (typeof taskStats !== 'function') return { active: 0, queued: 0, parallel: false };
    try {
      const stats = taskStats() || {};
      return {
        active: stats.active ? 1 : 0,
        queued: Number(stats.waiting) || 0,
        parallel: false, // v1 强制串行（docs/05 §二）
      };
    } catch {
      return { active: 0, queued: 0, parallel: false };
    }
  }

  /** 采一帧（1s 节奏）；同步部分不抛异常 */
  function collectFrame() {
    const processStats = collectProcess();
    const frame = {
      ts: Date.now(),
      system: { ...latestSystem },
      process: processStats,
      tasks: collectTasks(),
    };
    frames.push(frame);
    pruneFrames();
    return frame;
  }

  /** 环形缓冲：按时间窗裁剪（时间窗比帧数更稳：偶尔掉帧也不会提前丢历史） */
  function pruneFrames() {
    const deadline = Date.now() - HISTORY_WINDOW_MS;
    while (frames.length > 0 && (frames[0].ts < deadline || frames.length > HISTORY_MAX_FRAMES)) frames.shift();
  }

  function start() {
    if (running) return;
    running = true;
    lagMeter.reset();
    prevElu = performance.eventLoopUtilization();
    // 先采一次系统指标，保证第一个请求不是全 null（否则前端首帧会显示"—"）
    void collectSystem().catch(() => {});
    void collectProcess();
    frames.length = 0;
    collectFrame();

    systemTimer = setInterval(() => {
      void collectSystem().catch((error) => logger && logger.warn && logger.warn('metrics 系统指标采集失败', { error: error.message }));
    }, SYSTEM_INTERVAL_MS);
    processTimer = setInterval(() => {
      try {
        collectFrame();
      } catch (error) {
        // 定时器里的异常绝不能逃逸（未捕获异常会带走整个服务）
        if (logger && logger.warn) logger.warn('metrics 进程指标采集失败', { error: error.message });
      }
    }, PROCESS_INTERVAL_MS);
    // 两个定时器都不该阻止进程退出
    if (typeof systemTimer.unref === 'function') systemTimer.unref();
    if (typeof processTimer.unref === 'function') processTimer.unref();
  }

  function stop() {
    if (systemTimer) clearInterval(systemTimer);
    if (processTimer) clearInterval(processTimer);
    systemTimer = null;
    processTimer = null;
    running = false;
  }

  /** 最新一帧（还没采到时按需采一帧，保证接口可用） */
  function snapshot() {
    if (frames.length === 0) collectFrame();
    return frames[frames.length - 1];
  }

  /**
   * 历史样本：window 秒内、每 step 秒取一帧（契约 §4.6 `?window=300&step=5`）。
   * @param {{window?: number, step?: number}} options
   */
  function history({ window = 300, step = 5 } = {}) {
    const windowMs = Math.min(HISTORY_WINDOW_MS, Math.max(1, window) * 1000);
    const stepMs = Math.max(1, step) * 1000;
    const deadline = Date.now() - windowMs;
    // 用"时间桶内取最后一帧"而不是按 deadline 取模：deadline 随每次调用漂移，取模会让样本数抖动，
    // 桶对齐才是"每 step 秒一个点"的确定语义。
    const lastByBucket = new Map();
    for (const frame of frames) {
      if (frame.ts < deadline) continue;
      lastByBucket.set(Math.floor(frame.ts / stepMs), frame);
    }
    return [...lastByBucket.values()].sort((left, right) => left.ts - right.ts);
  }

  return {
    start,
    stop,
    snapshot,
    history,
    get running() {
      return running;
    },
    /** 供测试/自检：当前缓冲帧数 */
    get frameCount() {
      return frames.length;
    },
  };
}
