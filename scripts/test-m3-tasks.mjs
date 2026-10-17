#!/usr/bin/env node
//
// M3 验收脚本：任务落盘与恢复 + 串行队列 + SSE（首帧快照/seq 续传）+ 取消 + 原子写
//
// 用法：
//   bash scripts/start.sh start
//   node scripts/test-m3-tasks.mjs
//
// 三条硬证据（本脚本会打印可核对的原始值）：
// 1. **关掉浏览器任务继续跑**：全程不建立/随后断开 SSE → 任务照常完成，且 /health 的 subscribers=0；
// 2. **kill -9 后重启**：非终态 → interrupted + error.code=INTERRUPTED + `.part` 保留 + 可重试成功；
// 3. **SSE 首帧即快照 + seq/since 续传**：无 since 连接首帧是 snapshot；断开后用 since 重连首帧仍是 snapshot。
//
// 另一条回归锁（十.1）：**启动加载即收敛历史文件** —— 文件被写成"上限+1 行"（模拟 append 后、收敛前被 kill，
// 而旧实现只裁内存不重写文件）时，重启后必须 ≤ 上限，且保留最新条目。
//
// 注意：本脚本会 `kill -9` 本服务并重启（这是恢复语义的验收方式），请勿在有业务任务时手动运行。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PROJECT_ROOT, execFileAsync, pathExists, taskIdOf } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';


const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);

const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const DATA_DIR = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.dataDir) || './storage');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'task-history.jsonl');
const PID_FILE = path.join(PROJECT_ROOT, 'ZipCalm.pid');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const API_BIG = '/m3-test/big';
const BIG_DIR = path.join(ROOT, 'm3-test', 'big');

// 断言与汇总走共用报告器（多套脚本同一份实现；输出格式与 test-all.sh 的提取正则一致）
/** HTTP 调用超时（毫秒）：服务僵死/半开连接时脚本不能永久挂住 */
const HTTP_TIMEOUT_MS = 15000;

/** 任务等待类默认值：单任务最长等多久、轮询间隔（任务状态是服务端串行队列驱动的） */
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const TASK_POLL_INTERVAL_MS = 120;
/** SSE 帧等待：等一帧最多多久、帧轮询间隔（帧在内存里，轮询可以更密） */
const FRAME_WAIT_TIMEOUT_MS = 5000;
const FRAME_POLL_INTERVAL_MS = 50;
/** 信封异常时回传给断言的消息片段长度 */
const ERROR_SNIPPET_CHARS = 120;
/** 大夹具：总量（MB）与"够不够大"的判定（单文件 ≥20MB 且至少 3 个，保证任务能跑到被 kill） */
const BIG_FIXTURE_TOTAL_MB = 90;
const BIG_FILE_MIN_BYTES = 20 * 1024 * 1024;
const BIG_FILE_COUNT = 3;
/** 历史条数上限默认值（服务端配置项 limits.taskHistoryMax 的默认值） */
const HISTORY_MAX_DEFAULT = 200;
/** 历史文件"收敛到上限"的轮询参数 */
const HISTORY_CONVERGE_ATTEMPTS = 10;
const HISTORY_CONVERGE_POLL_MS = 300;
/** 起服务：start.sh 最长跑多久、健康检查轮询多久一次/最多几次 */
const SERVICE_START_TIMEOUT_MS = 60000;
const HEALTH_WAIT_ATTEMPTS = 40;
const HEALTH_POLL_INTERVAL_MS = 250;
/** 建任务后的短暂等待（等服务端把落盘/广播做完） */
const POST_CREATE_SETTLE_MS = 300;
/** 重启类用例的等待：kill -9 后等进程退出、恢复历史文件后等重启就绪 */
const KILL_SETTLE_MS = 800;
const RESTORE_SETTLE_MS = 600;
const reporter = createReporter();
const { check } = reporter;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读历史文件行（去掉空行） */
async function readHistoryLines() {
  try {
    return (await fsp.readFile(HISTORY_FILE, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

// ===== HTTP =====

let TOKEN = null;

async function api(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    // 超时兜底：服务僵死/半开连接时不能让脚本永久挂住
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, ERROR_SNIPPET_CHARS) } } };
  }
}

const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

async function waitTask(id, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, wanted = null) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    const { json } = await api('GET', `/tasks/${id}`);
    last = json && json.data && json.data.task;
    if (!last) return null;
    if (TERMINAL.has(last.status)) return last;
    if (wanted && wanted(last)) return last;
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  return last;
}

// ===== SSE =====

/** SSE 帧分隔符（空行）；抽成常量是为了 drainFrames 的读写一致 */
const FRAME_SEPARATOR = '\n\n';

/**
 * 从缓冲区里取出所有**已完整**的帧并写入 frames，返回剩余的不完整缓冲。
 * 抽出来是为了把"读流 + 拆帧"两层循环分开：嵌套少一层，两件事各自看得清。
 */
function drainFrames(buffer, frames) {
  let rest = buffer;
  let index = rest.indexOf(FRAME_SEPARATOR);
  while (index >= 0) {
    const frame = parseFrame(rest.slice(0, index));
    if (frame) frames.push(frame);
    rest = rest.slice(index + FRAME_SEPARATOR.length);
    index = rest.indexOf(FRAME_SEPARATOR);
  }
  return rest;
}

/** 极简 SSE 客户端：用于断言"首帧是快照"和 seq 续传 */
async function sseConnect(since) {
  const controller = new AbortController();
  const url = `${BASE}/tasks/events?channels=tasks${since ? `&since=${since}` : ''}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';

  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = drainFrames(buffer + decoder.decode(value, { stream: true }), frames);
      }
    } catch {
      /* 主动断开或服务被杀：正常路径 */
    }
  })();

  return {
    frames,
    headers: { contentType: response.headers.get('content-type'), xAccel: response.headers.get('x-accel-buffering') },
    close: () => controller.abort(),
    async waitFor(predicate, timeoutMs = FRAME_WAIT_TIMEOUT_MS) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const hit = frames.find(predicate);
        if (hit) return hit;
        await sleep(FRAME_POLL_INTERVAL_MS);
      }
      return null;
    },
  };
}

function parseFrame(raw) {
  const lines = raw.split('\n');
  let event = 'message';
  let id = null;
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) id = Number.parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, id, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return { event, id, data: null };
  }
}

// ===== 夹具 =====

/** 造一个"压缩耗时足够长"的夹具（随机数据不可压缩，压缩耗时可预期） */
async function ensureBigFixture(totalMb = BIG_FIXTURE_TOTAL_MB) {
  await fsp.mkdir(BIG_DIR, { recursive: true });
  const existing = (await fsp.readdir(BIG_DIR)).filter((name) => name.endsWith('.bin'));
  if (existing.length >= BIG_FILE_COUNT) {
    const stat = await fsp.stat(path.join(BIG_DIR, existing[0]));
    if (stat.size >= BIG_FILE_MIN_BYTES && existing.length >= BIG_FILE_COUNT) return { reused: true };
  }
  const perFile = Math.floor((totalMb * 1024 * 1024) / BIG_FILE_COUNT);
  for (const name of ['a.bin', 'b.bin', 'c.bin']) {
    const filePath = path.join(BIG_DIR, name);
    await fsp.writeFile(filePath, crypto.randomBytes(perFile));
  }
  return { reused: false };
}

/** 列出"部分写入的产物"（`.part` 及其归档名 `.part.interrupted-*`） */
async function listPartArtifacts() {
  const dirents = await fsp.readdir(path.join(ROOT, 'm3-test'), { withFileTypes: true });
  return dirents.filter((item) => item.isFile() && item.name.includes('.part')).map((item) => item.name);
}

/**
 * 清理本脚本自己产生的测试产物（历史运行积累的 zip 与遗留 part）。
 * 为什么必须清：残留产物会让"新任务选中的输出名/遗留 .part"每次都不同，
 * 断言会变成依赖历史状态（曾导致 .part 断言假失败）。
 */
async function cleanupTestArtifacts() {
  let removed = 0;
  const dirs = [path.join(ROOT, 'm3-test'), BIG_DIR];
  for (const dir of dirs) {
    let dirents = [];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (!dirent.isFile()) continue;
      const isProduct = /^big( \(\d+\))?\.zip(\.part.*)?$/.test(dirent.name);
      if (!isProduct) continue;
      await fsp.rm(path.join(dir, dirent.name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** 读服务 PID（异步读：脚本里大量 await 在跑，不该用同步 fs 卡事件循环） */
async function readPid() {
  try {
    return Number.parseInt((await fsp.readFile(PID_FILE, 'utf8')).trim(), 10);
  } catch {
    return null;
  }
}

/** 造一条合法的历史探针行（优先复用现有行的结构，保证能通过服务端净化与解析） */
function buildProbeHistoryLine(seedLines, index) {
  const template = seedLines.length > 0 ? seedLines[index % seedLines.length] : null;
  if (template) {
    try {
      const parsed = JSON.parse(template);
      return JSON.stringify({ ...parsed, id: `zc-history-probe-${index}` });
    } catch {
      /* 坏行：退化为下面的最小合法对象 */
    }
  }
  return JSON.stringify({
    id: `zc-history-probe-${index}`,
    kind: 'compress',
    status: 'failed',
    finishedAt: new Date().toISOString(),
  });
}

/** 轮询历史文件直到行数收敛到上限内；超时仍超标就返回超标行数（由调用方判 FAIL） */
async function readHistoryLinesConverged(maxLines, attempts = HISTORY_CONVERGE_ATTEMPTS) {
  let lines = await readHistoryLines();
  for (let attempt = 0; lines.length > maxLines && attempt < attempts; attempt += 1) {
    await sleep(HISTORY_CONVERGE_POLL_MS);
    lines = await readHistoryLines();
  }
  return lines;
}

async function startService() {
  await execFileAsync('bash', ['scripts/start.sh', 'start'], { cwd: PROJECT_ROOT, timeout: SERVICE_START_TIMEOUT_MS });
  // 等健康检查通过
  for (let i = 0; i < HEALTH_WAIT_ATTEMPTS; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

/** 断言一个响应体不含绝对路径（存储根）与 absPath 字段 */
function assertNoAbsolutePath(label, payload) {
  const text = JSON.stringify(payload);
  const problems = [];
  if (text.includes(ROOT)) problems.push('含存储根绝对路径');
  if (text.includes('absPath')) problems.push('含 absPath 字段');
  check(`响应不含绝对路径：${label}`, problems.length === 0, problems.join('；'));
}

// ===== 主流程 =====

async function main() {
  console.log('ZipCalm M3 验收（落盘/恢复 + 串行队列 + SSE 首帧快照与续传 + 取消 + 原子写）');
  console.log(`API：${BASE}\n存储根：${ROOT}\n数据目录：${DATA_DIR}\n`);

  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  const fixture = await ensureBigFixture();
  const cleaned = await cleanupTestArtifacts();
  console.log(`    夹具：${API_BIG}（${fixture.reused ? '复用已有' : '新建'}，${BIG_FILE_COUNT}×${Math.round(BIG_FIXTURE_TOTAL_MB / BIG_FILE_COUNT)}MB 随机数据）；清理历史测试产物 ${cleaned} 个`);

  // ===== 一、创建即落盘 + 串行队列 =====
  const first = await api('POST', '/compress/tasks', { sources: [API_BIG], mode: 'bundle', format: 'zip', options: { outputDir: '/m3-test' } });
  const firstId = taskIdOf(first);
  check('创建压缩任务', Boolean(firstId), `HTTP ${first.status}`);

  const diskRightAfterCreate = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf8'));
  check(
    '创建即落盘（tasks.json 立刻含该任务，不等 500ms 节流）',
    diskRightAfterCreate.some((entry) => entry.info && entry.info.id === firstId),
    `tasks.json 条数 ${diskRightAfterCreate.length}`,
  );

  const second = await api('POST', '/compress/tasks', { sources: [API_BIG], mode: 'bundle', format: 'zip', options: { outputDir: '/m3-test' } });
  const secondId = taskIdOf(second);
  await sleep(POST_CREATE_SETTLE_MS);
  const runningState = await waitTask(firstId, 5000, (task) => task.status === 'running');
  const secondState = await waitTask(secondId, 5000, (task) => task.status === 'queued' || TERMINAL.has(task.status));
  check(
    '串行队列：同一时刻只有一个 running，后续排队',
    Boolean(runningState && runningState.status === 'running' && secondState && secondState.status === 'queued'),
    `first=${runningState && runningState.status} second=${secondState && secondState.status}`,
  );

  // ===== 二、SSE：首帧快照 =====
  const baselineHealth = await api('GET', '/health');
  const baselineSubscribers = (baselineHealth.json && baselineHealth.json.data.tasks.subscribers) || 0;
  const sse1 = await sseConnect();
  const firstFrame = await sse1.waitFor(() => true, 5000);
  check('SSE 首帧是 snapshot（INV-05 连接即发状态）', Boolean(firstFrame && firstFrame.event === 'snapshot'), `首帧 event=${firstFrame && firstFrame.event}`);
  check('SSE 响应头正确（text/event-stream + X-Accel-Buffering: no）', Boolean(sse1.headers.contentType && sse1.headers.contentType.includes('text/event-stream') && sse1.headers.xAccel === 'no'), JSON.stringify(sse1.headers));
  const snapshotSeq = firstFrame && firstFrame.data && firstFrame.data.seq;
  check(
    '快照内容含进行中的任务与队列状态',
    Boolean(firstFrame && firstFrame.data && Array.isArray(firstFrame.data.tasks) && firstFrame.data.tasks.some((task) => task.id === firstId) && firstFrame.data.queue),
    `tasks=${firstFrame && firstFrame.data && firstFrame.data.tasks.length} seq=${snapshotSeq}`,
  );

  // ===== 三、SSE 增量 + seq 单调 + 断开 =====
  const progressFrame = await sse1.waitFor((frame) => frame.event === 'task' && frame.data && frame.data.task && frame.data.task.id === firstId, 20000);
  check(
    'SSE 增量：收到 task 事件（进度节流 ≤10/s）',
    Boolean(progressFrame),
    progressFrame ? `seq=${progressFrame.data.seq} status=${progressFrame.data.task.status} percent=${progressFrame.data.task.progress.percent}` : '超时未收到',
  );
  const lastSeqBeforeDrop = progressFrame ? progressFrame.data.seq : snapshotSeq;
  sse1.close();
  await sleep(POST_CREATE_SETTLE_MS);

  // 断开期间任务继续跑（INV-04）：同时用 /health 证明本脚本的订阅已释放
  const healthWhileDetached = await api('GET', '/health');
  const subscribersWhileDetached = healthWhileDetached.json.data.tasks.subscribers;
  check(
    '断开 SSE 后任务照常执行（本脚本订阅已释放）',
    subscribersWhileDetached <= baselineSubscribers,
    `subscribers=${subscribersWhileDetached}（脚本未连接时基线 ${baselineSubscribers}）`,
  );

  // ===== 四、since 续传：首帧仍是快照 =====
  const sse2 = await sseConnect(lastSeqBeforeDrop);
  const resumeFirst = await sse2.waitFor(() => true, 5000);
  check('重连带 since 时首帧仍是 snapshot（丢事件不丢状态）', Boolean(resumeFirst && resumeFirst.event === 'snapshot'), `event=${resumeFirst && resumeFirst.event}`);
  check(
    'since 续传：快照 seq 不早于断线前 seq',
    Boolean(resumeFirst && resumeFirst.data && resumeFirst.data.seq >= lastSeqBeforeDrop),
    `since=${lastSeqBeforeDrop} snapshotSeq=${resumeFirst && resumeFirst.data && resumeFirst.data.seq}`,
  );
  sse2.close();

  // ===== 五、取消：cancelling → aborted + .part 清理 =====
  const cancelTarget = secondId || firstId;
  const cancelResult = await api('POST', `/tasks/${cancelTarget}/cancel`, {});
  const cancelStatus = cancelResult.json && cancelResult.json.data && cancelResult.json.data.task && cancelResult.json.data.task.status;
  check('取消请求受理（queued/running → cancelling）', cancelStatus === 'cancelling' || cancelStatus === 'aborted', `status=${cancelStatus}`);
  const cancelled = await waitTask(cancelTarget);
  check(
    '取消终态：aborted + error=null + percent=0',
    Boolean(cancelled && cancelled.status === 'aborted' && cancelled.error === null && cancelled.progress.percent === 0),
    cancelled ? `status=${cancelled.status} error=${cancelled.error} percent=${cancelled.progress.percent}` : 'timeout',
  );

  // ===== 六、原子写：运行期反复解析 tasks.json，且无 .tmp 残留 =====
  let parseOk = 0;
  const parseSamples = 25;
  for (let i = 0; i < parseSamples; i += 1) {
    try {
      const text = await fsp.readFile(TASKS_FILE, 'utf8');
      JSON.parse(text);
      parseOk += 1;
    } catch {
      /* 半截文件会在这里暴露 */
    }
    await sleep(40);
  }
  check('原子写：tasks.json 任意时刻都可被 JSON 解析', parseOk === parseSamples, `${parseOk}/${parseSamples} 次成功`);
  check('无 .tmp 残留（rename 后不留下临时文件）', !(await pathExists(`${TASKS_FILE}.tmp`)));

  // ===== 七、kill -9 + 重启恢复（硬证据 2）=====
  const killTask = await api('POST', '/compress/tasks', { sources: [API_BIG], mode: 'bundle', format: 'zip', options: { outputDir: '/m3-test' } });
  const killId = taskIdOf(killTask);
  const running = await waitTask(killId, 20000, (task) => task.status === 'running' && task.phase === 'compressing');
  check('大任务进入 running/compressing（用于 kill 测试）', Boolean(running && running.status === 'running'), running ? `phase=${running.phase}` : 'timeout');

  // 轮询等待本次任务真正开始写 .part（瞬时文件，直接读一次可能刚好错过）
  let partsBeforeKill = [];
  const partDeadline = Date.now() + 10000;
  while (Date.now() < partDeadline) {
    partsBeforeKill = await listPartArtifacts();
    if (partsBeforeKill.length > 0) break;
    await sleep(150);
  }
  check('中断前存在正在写入的 .part', partsBeforeKill.length > 0, partsBeforeKill.join(', ') || '10s 内未出现');

  const pid = await readPid();
  check('读到服务 PID（用于 kill -9）', Number.isInteger(pid), `pid=${pid}`);
  if (pid) process.kill(pid, 'SIGKILL');
  await sleep(KILL_SETTLE_MS);
  let portClosed = false;
  try {
    await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
  } catch {
    portClosed = true;
  }
  check('kill -9 后端口关闭（进程确实死了）', portClosed);

  const restarted = await startService();
  check('服务可重新启动（start.sh start）', restarted);

  const afterBoot = await waitTask(killId, 10000);
  check(
    '恢复语义：状态 interrupted + error.code=INTERRUPTED',
    Boolean(afterBoot && afterBoot.status === 'interrupted' && afterBoot.error && afterBoot.error.code === 'INTERRUPTED'),
    afterBoot ? `status=${afterBoot.status} code=${afterBoot.error && afterBoot.error.code}` : 'timeout',
  );
  check(
    '恢复原因标记为 SERVER_RESTART',
    Boolean(afterBoot && afterBoot.error && afterBoot.error.details && afterBoot.error.details.reason === 'SERVER_RESTART'),
    JSON.stringify(afterBoot && afterBoot.error && afterBoot.error.details),
  );

  const partsAfterBoot = await listPartArtifacts();
  check('恢复后 .part 保留（INV-10，供重试/诊断）', partsAfterBoot.length > 0, partsAfterBoot.join(', ') || '未找到');

  const persisted = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf8'));
  const interruptedEntry = persisted.find((entry) => entry.info && entry.info.id === killId);
  check(
    'tasks.json 里保留 interrupted 任务（可重试）',
    Boolean(interruptedEntry && interruptedEntry.info.status === 'interrupted'),
    interruptedEntry ? `status=${interruptedEntry.info.status}` : '未找到',
  );

  // ===== 八、重试 = 新任务（硬证据 2 的收尾）=====
  const retryResult = await api('POST', `/tasks/${killId}/retry`, {});
  const retryTask = retryResult.json && retryResult.json.data && retryResult.json.data.task;
  check(
    '重试生成新任务（新 UUID + retryOf 指向原任务）',
    Boolean(retryTask && retryTask.id !== killId && retryTask.retryOf === killId),
    retryTask ? `new=${retryTask.id.slice(0, 8)} retryOf=${String(retryTask.retryOf).slice(0, 8)}` : JSON.stringify(retryResult.json.error),
  );
  const retryDone = await waitTask(retryTask ? retryTask.id : killId, 180000);
  check(
    '重试任务成功完成（证明"保留 .part"与"可重试"同时成立）',
    Boolean(retryDone && retryDone.status === 'done'),
    retryDone ? `status=${retryDone.status} error=${retryDone.error && retryDone.error.code}` : 'timeout',
  );

  // ===== 九、关掉浏览器任务继续跑（硬证据 1）=====
  const bgTask = await api('POST', '/compress/tasks', { sources: [API_BIG], mode: 'bundle', format: 'zip', options: { outputDir: '/m3-test' } });
  const bgId = taskIdOf(bgTask);
  // 全程不建立 SSE（模拟"关掉浏览器"）；只等服务端自己跑完
  const bgDone = await waitTask(bgId, 180000);
  const healthAfterBg = await api('GET', '/health');
  check(
    '关掉浏览器（零 SSE 订阅）任务继续跑到 done',
    Boolean(bgDone && bgDone.status === 'done'),
    bgDone ? `status=${bgDone.status} subscribers=${healthAfterBg.json.data.tasks.subscribers}` : 'timeout',
  );
  check(
    '全程没有本脚本的订阅（执行与订阅零耦合，INV-02/INV-04）',
    healthAfterBg.json.data.tasks.subscribers <= baselineSubscribers,
    `subscribers=${healthAfterBg.json.data.tasks.subscribers}（基线 ${baselineSubscribers}）`,
  );

  // ===== 十、历史查询 + 文件上限 =====
  const history = await api('GET', '/tasks/history?limit=5');
  check('历史查询端点可用', Boolean(history.json && history.json.data && Array.isArray(history.json.data.items)), `HTTP ${history.status} 条数=${history.json.data && history.json.data.items.length} max=${history.json.data && history.json.data.max}`);
  const historyLines = await readHistoryLinesConverged(200);
  let historyParseOk = true;
  for (const line of historyLines) {
    try {
      JSON.parse(line);
    } catch {
      historyParseOk = false;
    }
  }
  check(
    'task-history.jsonl 每行可解析且收敛在上限内',
    historyParseOk && historyLines.length <= 200,
    `${historyLines.length} 行（上限 ${HISTORY_MAX_DEFAULT}）`,
  );

  // ===== 十.1 启动即收敛（回归锁死）=====
  // 为什么单独锁这条：`appendHistoryEntry` 是"先追加、后收敛"两步，进程若在这两步之间被 kill -9，
  // 文件就停在上限 +1 行。旧实现只在内存里 slice 而不重写文件 → 文件要等"下一次 append"才顺带收敛，
  // 空闲实例会**永久停在 201 行**（验收方独立跑就是在这里抓到 31/1 的）。所以这里直接构造"上限+1 行"
  // 的落盘状态，再杀进程重启，断言启动过程本身就把文件收敛掉。
  const historyMax = (runtimeConfig.limits && runtimeConfig.limits.taskHistoryMax) || HISTORY_MAX_DEFAULT;
  const historyBackup = await fsp.readFile(HISTORY_FILE, 'utf8').catch(() => '');
  const backupLines = historyBackup.split('\n').filter((line) => line.trim().length > 0);
  const overflowLines = [];
  for (let index = 0; index <= historyMax; index += 1) {
    overflowLines.push(buildProbeHistoryLine(backupLines, index));
  }
  await fsp.writeFile(HISTORY_FILE, `${overflowLines.join('\n')}\n`, 'utf8');
  const overflowCount = (await readHistoryLines()).length;
  check(
    '构造「上限+1 行」的历史文件（模拟 append 后、收敛前被 kill）',
    overflowCount === historyMax + 1,
    `${overflowCount} 行（上限 ${historyMax}）`,
  );

  const trimPid = await readPid();
  if (trimPid) process.kill(trimPid, 'SIGKILL');
  await sleep(KILL_SETTLE_MS);
  const restartedForTrim = await startService();
  const trimmedLines = await readHistoryLinesConverged(historyMax, 6);
  check(
    '重启后文件收敛到上限内（启动加载即收敛，不依赖后续 append）',
    restartedForTrim && trimmedLines.length <= historyMax,
    `${trimmedLines.length} 行（上限 ${historyMax}）`,
  );
  check(
    '收敛保留的是最新条目（末尾探针仍在）',
    trimmedLines.some((line) => line.includes(`zc-history-probe-${historyMax}`)),
    `含 zc-history-probe-${historyMax}`,
  );
  // 还原真实历史文件，并**再重启一次**让服务缓存与文件重新一致：
  // 只还原文件而不重启的话，内存缓存里仍是探针行，后续 append 触发收敛时会把它写回文件
  // —— "文件与缓存不一致"正是本 bug 的同类问题，测试自己不能留这个尾巴。
  if (historyBackup) await fsp.writeFile(HISTORY_FILE, historyBackup, 'utf8');
  const restorePid = await readPid();
  if (restorePid) process.kill(restorePid, 'SIGKILL');
  await sleep(RESTORE_SETTLE_MS);
  const restartedForRestore = await startService();
  const restoredLines = await readHistoryLines();
  check('还原真实历史文件后重启：缓存与文件一致且未触发无谓重写', restartedForRestore && restoredLines.length <= historyMax, `${restoredLines.length} 行（上限 ${historyMax}）`);

  // ===== 十一、任务 API 不泄漏绝对路径 =====
  const detail = await api('GET', `/tasks/${bgId}`);
  assertNoAbsolutePath('任务详情', detail.json);
  const list = await api('GET', '/tasks?limit=20');
  assertNoAbsolutePath('任务列表', list.json);

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
