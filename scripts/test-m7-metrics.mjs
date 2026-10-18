#!/usr/bin/env node
//
// M7 后端验收：指标端点形状 + 环形缓冲窗口语义 + /proc 降级 + 采集开销对照自证 + 定时器不拖进程
//
// 覆盖 docs/11 §十 的后端部分与 lead 的三条实现要求：
//   ① 开销必须有**对照**：同一窗口内「采集关闭」vs「采集开启」的 process.cpuUsage() 差值都打出来
//   ② /proc 读不到时解析器返回 null（接口不 500）
//   ③ 定时器 unref：起过采集器的子进程必须能自行退出（不 unref 会挂住）
//
// 用法：bash scripts/start.sh start && node scripts/test-m7-metrics.mjs

import path from 'node:path';

import { createMetricsCollector, createLagMeter } from '../server/core/metrics/collector.js';
import { parseDiskStats, parseMemInfo, parseProcStat, readProcSnapshot } from '../server/core/metrics/procfs.js';
import { PROJECT_ROOT, execFileAsync } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const HTTP_TIMEOUT_MS = 15000;
/** 开销对照窗口（毫秒）：4 秒一段，交错跑 2×2（OFF/ON/OFF/ON）抵消漂移 */
const OVERHEAD_WINDOW_MS = 4000;
/** 单次系统采样的重复次数（确定性成本测量，几乎无噪声） */
const SAMPLE_COST_ITERATIONS = 300;
/** 契约采集频率：系统 5s 一次、进程 1s 一次 */
const SYSTEM_SAMPLE_EVERY_SECONDS = 5;
const PROCESS_SAMPLE_EVERY_SECONDS = 1;
/** 开销阈值（lead 验收："监控本身开销 < 1% CPU"） */
const OVERHEAD_LIMIT_PERCENT = 1;
/** 子进程自退出观察上限（毫秒）：unref 生效时它会立刻退出 */
const CHILD_EXIT_TIMEOUT_MS = 8000;
/** history 采样等待：window=10&step=1 至少应拿到 5 个点 */
const HISTORY_WAIT_MS = 12000;

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

async function api(method, urlPath) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, 120) } };
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一帧的结构校验：字段齐全 + 数值/ null */
function frameShapeProblems(frame) {
  const problems = [];
  if (!frame || typeof frame.ts !== 'number') problems.push('ts');
  const system = (frame && frame.system) || {};
  for (const key of ['cpuPercent', 'memUsedBytes', 'memTotalBytes', 'diskReadBps', 'diskWriteBps']) {
    if (!(key in system)) problems.push(`system.${key}`);
  }
  const processStats = (frame && frame.process) || {};
  for (const key of ['cpuPercent', 'rssBytes', 'heapUsedBytes', 'eventLoopDelayMs', 'eventLoopUtilization', 'uptimeMs']) {
    if (!(key in processStats)) problems.push(`process.${key}`);
  }
  const tasks = (frame && frame.tasks) || {};
  for (const key of ['active', 'queued', 'parallel']) {
    if (!(key in tasks)) problems.push(`tasks.${key}`);
  }
  return problems;
}

/** 单次系统采样的 CPU 成本（微秒）：重复 N 次 readProcSnapshot，用 cpuUsage 差值均摊 */
async function measureSystemSampleCost(iterations) {
  const os = await import('node:os');
  const cores = Math.max(1, os.cpus().length);
  // 预热（首次读文件/解析会触发模块与 JIT 开销，不能算进稳态）
  for (let index = 0; index < 5; index += 1) await readProcSnapshot();
  const before = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) await readProcSnapshot();
  const usage = process.cpuUsage(before);
  return { usPerSample: (usage.user + usage.system) / iterations, cores };
}

/** 同窗口 CPU 占用（百分比，相对全部核）：cpuUsage 差值 / 窗口 / 核数 */
async function cpuPercentOver(windowMs) {
  const usageBefore = process.cpuUsage();
  const startedAt = process.hrtime.bigint();
  await sleep(windowMs);
  const usage = process.cpuUsage(usageBefore);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const cores = Math.max(1, (await import('node:os')).cpus().length);
  const cpuPercent = ((usage.user + usage.system) / 1000 / elapsedMs / cores) * 100;
  return { user: usage.user, system: usage.system, elapsedMs, cpuPercent };
}

async function main() {
  // ===== 端点形状 =====
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOGIN),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const loginJson = await login.json();
  TOKEN = loginJson && loginJson.data && loginJson.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  await sleep(5500); // 等一次系统采样（5s 节奏）
  const snapshot = await api('GET', '/metrics/snapshot');
  const frame = snapshot.json && snapshot.json.data;
  const problems = frameShapeProblems(frame);
  check('GET /metrics/snapshot 结构完整（system/process/tasks 全字段）', problems.length === 0, `缺字段=${problems.join(',')}`);
  check('snapshot 的 ts 接近当前时间', Boolean(frame && Math.abs(Date.now() - frame.ts) < 10000), `ts=${frame && frame.ts}`);
  check('系统 CPU 为 0~100 的数值', Boolean(frame && frame.system && frame.system.cpuPercent === null
    || (frame.system.cpuPercent >= 0 && frame.system.cpuPercent <= 100)), `cpu=${frame && frame.system && frame.system.cpuPercent}`);
  check('内存总量 > 0 且占用 ≤ 总量', Boolean(frame && frame.system.memTotalBytes > 0
    && frame.system.memUsedBytes >= 0 && frame.system.memUsedBytes <= frame.system.memTotalBytes));
  check('进程 RSS/heap 为正数', Boolean(frame && frame.process.rssBytes > 0 && frame.process.heapUsedBytes > 0));
  check('事件循环延迟有限且非负（漂移法，不是分辨率）', Boolean(frame && Number.isFinite(frame.process.eventLoopDelayMs) && frame.process.eventLoopDelayMs >= 0), `delay=${frame && frame.process.eventLoopDelayMs}`);
  check('tasks 三字段类型正确', Boolean(frame && Number.isInteger(frame.tasks.active) && Number.isInteger(frame.tasks.queued) && typeof frame.tasks.parallel === 'boolean'));

  // ===== 环形缓冲窗口/步长语义 =====
  await sleep(HISTORY_WAIT_MS);
  const history = await api('GET', '/metrics/history?window=10&step=1');
  const samples = (history.json && history.json.data && history.json.data.samples) || [];
  check('GET /metrics/history 返回 samples 数组', Array.isArray(samples) && samples.length >= 5, `samples=${samples.length}`);
  const ascending = samples.every((item, index) => index === 0 || item.ts >= samples[index - 1].ts);
  check('samples 按时间升序', ascending);
  check('samples 每帧结构完整', samples.every((item) => frameShapeProblems(item).length === 0));
  const tooMany = samples.length > 12; // window=10s / step=1s → 上限 11
  check('samples 数量不超过窗口中可容纳的步数', !tooMany, `samples=${samples.length}`);

  // ===== /proc 降级：解析器对坏输入返回 null（接口不会因缺字段 500）=====
  check('/proc/stat 解析：空文本 → null', parseProcStat('') === null);
  check('/proc/stat 解析：缺 cpu 行 → null', parseProcStat('intr 1 2\n') === null);
  check('/proc/meminfo 解析：缺 MemAvailable → null', parseMemInfo('MemTotal:       1000 kB\n') === null);
  check('/proc/diskstats 解析：无关设备 → null', parseDiskStats('8 0 loop0 1 2 3 4 5 6 7 8\n') === null);
  const physicalDiskSample = parseDiskStats('8 0 sda 1 2 300 4 5 6 700 8\n');
  check('/proc/diskstats 解析：物理盘正常累计', physicalDiskSample?.readSectors === 300, JSON.stringify(physicalDiskSample));

  // ===== 事件循环延迟：量化坑的回归锁 =====
  const lagMeter = createLagMeter(1000);
  lagMeter.tick(1000);
  const drift = lagMeter.tick(1130); // 期望 2000，实际 1130 → 早到不算漂移；再造一个"迟到"
  const lateDrift = lagMeter.tick(2450); // 期望 2130，实际 2450 → 320ms 漂移
  check('漂移法：准时/早到不计延迟', drift === 0, `drift=${drift}`);
  check('漂移法：迟到按实际差值计（不含量化误差）', lateDrift === 320, `lateDrift=${lateDrift}`);

  // ===== 开销自证（两个口径，都打数字）=====
  // 口径 A：单次采集成本（确定性）→ 推稳态占用。为什么需要它：ON/OFF 窗口法会被本机其它活动淹没
  // （实测 OFF 0.400% vs ON 0.022%，负差值证明噪声大于真实开销），只靠窗口法等于没证明。
  const sampleCost = await measureSystemSampleCost(SAMPLE_COST_ITERATIONS);
  // 稳态：每 5s 一次系统采样；进程帧只读内存/统计（成本可忽略，保守按同量级×5 计入）
  const steadyPercent = ((sampleCost.usPerSample / 1e6) / SYSTEM_SAMPLE_EVERY_SECONDS
    + (sampleCost.usPerSample / 1e6) * PROCESS_SAMPLE_EVERY_SECONDS) / sampleCost.cores * 100;
  console.log(`[开销 A] 单次系统采样 ${sampleCost.usPerSample.toFixed(1)}us（${SAMPLE_COST_ITERATIONS} 次均值，${sampleCost.cores} 核）`
    + ` → 稳态估算 ${steadyPercent.toFixed(4)}%`);
  check('单次系统采样成本 < 10ms（300 次均值）', sampleCost.usPerSample < 10000, `${sampleCost.usPerSample.toFixed(1)}us`);
  check('稳态估算占用 < 1% CPU', steadyPercent < OVERHEAD_LIMIT_PERCENT, `${steadyPercent.toFixed(4)}%`);

  // 口径 B：ON/OFF 交错 2×2（消漂移），四个数都打印，只做"不超出噪声带"的宽松断言
  const collector = createMetricsCollector({ taskStats: () => ({ active: null, waiting: 0 }) });
  const off1 = await cpuPercentOver(OVERHEAD_WINDOW_MS);
  collector.start();
  const on1 = await cpuPercentOver(OVERHEAD_WINDOW_MS);
  collector.stop();
  const off2 = await cpuPercentOver(OVERHEAD_WINDOW_MS);
  collector.start();
  const on2 = await cpuPercentOver(OVERHEAD_WINDOW_MS);
  collector.stop();
  const meanOff = (off1.cpuPercent + off2.cpuPercent) / 2;
  const meanOn = (on1.cpuPercent + on2.cpuPercent) / 2;
  const delta = meanOn - meanOff;
  console.log(`[开销 B] OFF ${off1.cpuPercent.toFixed(3)}% / ${off2.cpuPercent.toFixed(3)}%`
    + ` ｜ ON ${on1.cpuPercent.toFixed(3)}% / ${on2.cpuPercent.toFixed(3)}%`
    + ` → 均值差 ${delta.toFixed(3)}%（负值=噪声大于开销，属正常）`);
  check('交错对照：均值差 < 1%（宽松上界，主证看口径 A）', delta < OVERHEAD_LIMIT_PERCENT, `delta=${delta.toFixed(3)}%`);
  check('采集器 stop 后 running=false', collector.running === false);
  check('重复 stop 幂等', (() => { collector.stop(); return collector.running === false; })());

  // ===== 定时器 unref：子进程能自行退出（不 unref 会挂住）=====
  const probeScript = `
    import { createMetricsCollector } from '${path.join(PROJECT_ROOT, 'server/core/metrics/collector.js').replace(/\\/g, '/')}';
    const collector = createMetricsCollector({ taskStats: () => ({}) });
    collector.start();
    console.log('collector-started');
  `;
  let childOk = false;
  let childDetail = '';
  try {
    const started = Date.now();
    await execFileAsync(process.execPath, ['--input-type=module', '-e', probeScript], { timeout: CHILD_EXIT_TIMEOUT_MS });
    childOk = Date.now() - started < CHILD_EXIT_TIMEOUT_MS;
    childDetail = `子进程 ${Date.now() - started}ms 内退出`;
  } catch (error) {
    childDetail = `子进程未按期退出（定时器可能没 unref）：${error.message.slice(0, 80)}`;
  }
  check('起过采集器的子进程能自行退出（定时器已 unref）', childOk, childDetail);

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`M7 验收脚本异常：${error.message}`);
  process.exitCode = 1;
});
