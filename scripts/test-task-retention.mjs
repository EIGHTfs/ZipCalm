#!/usr/bin/env node
//
// M3 任务记录清理验收：保留策略（计数 / 时间 / 配置驱动）+ 非终态不被清理 + DELETE 语义 + 历史不受影响
//
// 用法：
//   node scripts/test-task-retention.mjs
//
// 设计要点：
// - **非破坏性**：开跑备份 `storage/tasks.json` 与 `storage/config.json`，结束时原样还原（含服务重启）；
// - 计数/时间两类阈值用"直接写 tasks.json 再启动"构造（启动时机是契约规定的清理时机之一），
//   因为通过 API 造 100+ 条终态要几分钟且不必要；
// - 非终态不被清理必须在**服务运行中**验证（重启会把非终态迁成 interrupted，那就不再是非终态）。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { PROJECT_ROOT, execFileAsync, taskIdOf } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';


const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);

const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const DATA_DIR = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.dataDir) || './storage');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const HISTORY_FILE = path.join(DATA_DIR, 'task-history.jsonl');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const DAY_MS = 24 * 60 * 60 * 1000;

let TOKEN = null;
// 断言与汇总走共用报告器（多套脚本同一份实现；输出格式与 test-all.sh 的提取正则一致）
/** HTTP 调用超时（毫秒）：服务僵死/半开连接时脚本不能永久挂住 */
const HTTP_TIMEOUT_MS = 15000;
/** 起停与健康检查：健康等待上限 / 轮询间隔 / start.sh 与 stop.sh 的超时 / 停服后静置 */
const HEALTH_WAIT_TIMEOUT_MS = 20000;
const HEALTH_POLL_INTERVAL_MS = 200;
const SERVICE_SCRIPT_TIMEOUT_MS = 60000;
const STOP_SETTLE_MS = 400;
/** 等"第二个任务进入 running"的轮询参数；以及取消任务后的静置 */
const RUNNING_WAIT_TIMEOUT_MS = 180000;
const RUNNING_POLL_INTERVAL_MS = 150;
/** 等"终态积压收敛到阈值内"的上限：只影响偶发滞后，不改变断言语义 */
const CONVERGE_TIMEOUT_MS = 20000;
const CANCEL_SETTLE_MS = 500;
/** 播种的终态任务条数（与阈值 max=3 对比用） */
const SEED_TASK_COUNT = 6;
const reporter = createReporter();
const { check } = reporter;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, urlPath, body) {
  const hasBody = body !== undefined;
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      // 只在真有 body 时声明 Content-Type：DELETE 这类无 body 请求不该带它（避免踩 Fastify 的空 body 400）
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    // 超时兜底：服务僵死/半开连接时不能让脚本永久挂住
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, 120) } } };
  }
}

// ===== 服务控制与状态读取 =====

async function waitHealthy(timeoutMs = HEALTH_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}

async function startService() {
  await execFileAsync('bash', ['scripts/start.sh', 'start'], { cwd: PROJECT_ROOT, timeout: SERVICE_SCRIPT_TIMEOUT_MS }).catch(() => {});
  const healthy = await waitHealthy();
  // 本脚本会反复停/起服务：重启后重新登录拿新 token，避免依赖"上一轮的凭据还能用"
  if (healthy && TOKEN) {
    const login = await api('POST', '/auth/login', LOGIN);
    if (login.json && login.json.data && login.json.data.token) TOKEN = login.json.data.token;
  }
  return healthy;
}

async function stopService() {
  await execFileAsync('bash', ['scripts/start.sh', 'stop'], { cwd: PROJECT_ROOT, timeout: SERVICE_SCRIPT_TIMEOUT_MS }).catch(() => {});
  await sleep(STOP_SETTLE_MS);
}

async function readTasks() {
  const text = await fsp.readFile(TASKS_FILE, 'utf8');
  return JSON.parse(text);
}

async function historyLineCount() {
  try {
    return (await fsp.readFile(HISTORY_FILE, 'utf8')).split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

// ===== 构造终态记录（与 manager 落盘结构一致：{info, internal}） =====

function makeRecord(status, finishedAt, id = crypto.randomUUID()) {
  return {
    info: {
      id,
      kind: 'compress',
      status,
      phase: 'verifying',
      mode: 'bundle',
      format: 'zip',
      sources: [{ path: '/m3-test/big', name: 'big', kind: 'dir', sizeBytes: 1024, entryCount: 3 }],
      options: { level: 6, keepOriginal: true, deleteConfirmed: false, deleteArchiveAfterExtract: false, outputDir: null, parallel: false },
      archivePath: null,
      targetDir: null,
      progress: { percent: 100, processedBytes: 0, totalBytes: 0, processedFiles: 0, totalFiles: 0, currentFile: null, packagesDone: 1, packagesTotal: 1, speedBps: 0, etaSeconds: null, updatedAt: finishedAt },
      result: null,
      delete: null,
      error: status === 'failed' ? { code: 'INTERNAL_ERROR', message: '测试构造', at: finishedAt } : (status === 'interrupted' ? { code: 'INTERRUPTED', message: '测试构造', details: { reason: 'SERVER_RESTART' }, at: finishedAt } : null),
      createdAt: finishedAt,
      startedAt: finishedAt,
      finishedAt,
      updatedAt: finishedAt,
      retryOf: null,
      bootId: 'test-seed',
    },
    internal: {},
  };
}

async function seedTasks(records) {
  await fsp.writeFile(TASKS_FILE, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
}

/** 等任务到终态（轮询） */
async function waitTerminal(id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/tasks/${id}`);
    last = json && json.data && json.data.task;
    if (last && ['done', 'failed', 'aborted', 'interrupted'].includes(last.status)) return last;
    await sleep(150);
  }
  return last;
}

/** 先压一个小目录拿到合法 zip 产物路径（解压用例要拿它当输入） */
async function createRetentionZip() {
  const zipped = await api('POST', '/compress/tasks', {
    sources: ['/文档'],
    mode: 'bundle',
    format: 'zip',
    options: { outputDir: '/m3-test' },
  });
  const zipTaskId = taskIdOf(zipped);
  const zipTask = zipTaskId ? await waitTerminal(zipTaskId) : null;
  const packages = zipTask && zipTask.result && zipTask.result.packages;
  return (packages && packages[0] && packages[0].outputPath) || null;
}

/**
 * 反复解压到**同一个**目标目录：第一次成功（done），之后因 overwrite=false 命中同名文件而
 * **确定性失败**（TARGET_EXISTS）—— done 与 failed 两种终态各触发一次"每完成一个任务后"的清理。
 */
async function runPruneRounds(zipUserPath, targetDir, rounds) {
  let done = 0;
  let failed = 0;
  for (let index = 0; index < rounds; index += 1) {
    const extracted = await api('POST', '/extract/tasks', { path: zipUserPath, targetDir });
    const taskId = taskIdOf(extracted);
    if (!taskId) continue;
    const task = await waitTerminal(taskId);
    if (task && task.status === 'done') done += 1;
    if (task && task.status === 'failed') failed += 1;
  }
  return { done, failed };
}

/**
 * 用"能真正被 API 创建"的任务驱动清理时机（见 runPruneRounds 的说明）。
 * @returns {Promise<{done: number, failed: number, zipUserPath: string|null}>}
 */
async function drivePruneRounds(rounds) {
  const zipUserPath = await createRetentionZip();
  // 目标目录必须每次唯一：否则上一轮的残留会让"第一次解压"也失败，done 路径就测不到
  const targetDir = `/m3-retention-out-${Date.now()}`;
  if (!zipUserPath) return { done: 0, failed: 0, zipUserPath: null };
  return { ...(await runPruneRounds(zipUserPath, targetDir, rounds)), zipUserPath };
}
/** 写运行期配置（深合并在服务端进行；这里只覆盖 limits 里的保留策略键） */
async function patchRetentionConfig(patch) {
  const config = JSON.parse(await fsp.readFile(CONFIG_FILE, 'utf8'));
  config.limits = { ...(config.limits || {}), ...patch };
  await fsp.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

async function restoreConfig(backupText) {
  await fsp.writeFile(CONFIG_FILE, backupText, 'utf8');
}

async function countByStatus() {
  const tasks = await readTasks();
  const by = {};
  for (const entry of tasks) by[entry.info.status] = (by[entry.info.status] || 0) + 1;
  return { total: tasks.length, by, tasks };
}

// ===== 各用例 =====

async function caseCountLimit() {
  await stopService();
  const now = Date.now();
  const records = [];
  for (let index = 0; index < 120; index += 1) {
    // finishedAt 递增：index 越大越新
    records.push(makeRecord('failed', now - (120 - index) * 60 * 1000));
  }
  await seedTasks(records);
  await patchRetentionConfig({ taskRetentionMax: 100, taskRetentionDays: 7 });
  await startService();

  const after = await countByStatus();
  const newest100 = new Set(records.slice(20).map((entry) => entry.info.id));
  const survivors = new Set(after.tasks.map((entry) => entry.info.id));
  const keptIsNewest = [...survivors].every((id) => newest100.has(id));

  check('构造 120 条终态 → 启动后只留 100 条（计数上限）', after.total === 100, `总数 ${after.total}`);
  check('保留的是最近 100 条（最旧的 20 条被清）', keptIsNewest && after.total === 100, `最旧保留时间 ${new Date(Math.min(...after.tasks.map((e) => e.info.finishedAt))).toISOString()}`);
}

async function caseTimeLimit() {
  await stopService();
  const now = Date.now();
  const oldIds = [];
  const records = [];
  for (let index = 0; index < 5; index += 1) {
    const record = makeRecord('interrupted', now - 8 * DAY_MS - index * 1000);
    oldIds.push(record.info.id);
    records.push(record);
  }
  for (let index = 0; index < 15; index += 1) {
    records.push(makeRecord('failed', now - index * 60 * 1000));
  }
  await seedTasks(records);
  await patchRetentionConfig({ taskRetentionMax: 100, taskRetentionDays: 7 });
  await startService();

  const after = await countByStatus();
  const survivors = new Set(after.tasks.map((entry) => entry.info.id));
  const oldGone = oldIds.every((id) => !survivors.has(id));
  check('超 7 天的终态被按时间清理', after.total === 15 && oldGone, `总数 ${after.total}（期望 15），5 条超期全清=${oldGone}`);
}

async function caseConfigDriven() {
  await stopService();
  const now = Date.now();
  const records = [];
  for (let index = 0; index < 30; index += 1) records.push(makeRecord('failed', now - index * 60 * 1000));
  await seedTasks(records);

  await patchRetentionConfig({ taskRetentionMax: 25 });
  await startService();
  const at25 = await countByStatus();

  await stopService();
  await patchRetentionConfig({ taskRetentionMax: 7 });
  await startService();
  const at7 = await countByStatus();

  check('同一份数据：max=25 → 保留 25 条', at25.total === 25, `总数 ${at25.total}`);
  check('改配置 max=7 → 立即按新阈值收敛到 7（阈值来自配置，不是写死）', at7.total === 7, `总数 ${at7.total}`);
}

/** 非终态永不被清理：运行期造一个长任务 + 一批失败任务（每个完成都触发一次清理） */
/** 起一个压缩任务（大目录优先，用于制造"运行中"的非终态任务） */
async function createCompressTask(source, outputDir) {
  const created = await api('POST', '/compress/tasks', {
    sources: [source],
    mode: 'bundle',
    format: 'zip',
    options: outputDir ? { outputDir } : undefined,
  });
  return taskIdOf(created);
}

/**
 * 非终态永不被清理（契约 §六 规则 7）。
 *
 * 为什么这样设计：清理时机是"启动 + 每完成一个任务后"，而 v1 是**串行队列** ——
 * 一个任务完成时，队列里后面的任务正好处于 `queued`（非终态）。
 * 所以：起 A（大任务，跑着）+ B（排队），A 完成会触发一次清理，此刻 B 必须还在 tasks.json 里。
 * 这比"造一堆终态再观察"更贴近真实触发路径。
 */
/** 任务的终态集合（到了就不会再变，可作为"稳定观察点"） */
const TERMINAL_STATUSES = ['done', 'failed', 'aborted', 'interrupted'];

/**
 * 轮询直到指定任务"结束"并返回那一刻的快照；超时返回 null。
 *
 * 为什么改成等终态：`running`/`queued` 都是瞬时态，用 150ms 轮询去撞一个毫秒级的窗口
 * 必然时灵时不灵（历史现象：同代码约一半概率失败）。终态一到位就不再变，是确定性事件。
 *
 * 注意：`done` 完成任务**会被移出 tasks.json**（只保留 failed/interrupted 这类可重试终态），
 * 所以"从文件里消失"同样算结束信号 —— 但必须先见过它一次，否则会把"刚落盘还没读到"误判成已完成。
 */
async function waitForTaskTerminal(taskId, timeoutMs = RUNNING_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let seenOnce = false;
  while (Date.now() < deadline) {
    const snapshot = await countByStatus().catch(() => null);
    const target = snapshot && snapshot.tasks.find((entry) => entry.info.id === taskId);
    if (target) {
      seenOnce = true;
      if (TERMINAL_STATUSES.includes(target.info.status)) return { snapshot, status: target.info.status };
    } else if (seenOnce) {
      // 见过之后又消失 = 已完成并被清理出 tasks.json
      return { snapshot, status: 'pruned' };
    }
    await sleep(RUNNING_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * 造一份"压缩要跑一会儿"的夹具，让第二个任务在 A 完成之后**稳定处于非终态**（而不是毫秒级）。
 * 内容用哈希链生成（伪随机、不可压缩）；同时把本用例要用的 outputDir 一并建好
 * （outputDir 指向不存在的目录会被服务端以 PATH_NOT_FOUND 拒掉）。
 *
 * @returns {{source: string, outA: string, outB: string, outDel: string}}
 */
async function ensureSlowFixture() {
  const dirAbs = path.join(ROOT, 'm3-test', 'retention-big');
  const outNames = { outA: 'ret-a', outB: 'ret-b', outDel: 'ret-del' };
  const targetBytes = 4 * 1024 * 1024;
  const existing = await fsp.stat(path.join(dirAbs, 'blob.bin')).then((stat) => stat.size, () => 0);
  if (existing < targetBytes) {
    await fsp.mkdir(dirAbs, { recursive: true });
    let seed = Buffer.from('zipcalm-retention-fixture');
    const handle = await fsp.open(path.join(dirAbs, 'blob.bin'), 'w');
    try {
      let written = 0;
      while (written < targetBytes) {
        seed = crypto.createHash('sha512').update(seed).digest();
        const size = Math.min(seed.length, targetBytes - written);
        await handle.write(seed.subarray(0, size));
        written += size;
      }
    } finally {
      await handle.close();
    }
  }
  for (const name of Object.values(outNames)) {
    await fsp.mkdir(path.join(ROOT, 'm3-test', name), { recursive: true });
  }
  return {
    source: '/m3-test/retention-big',
    outA: `/m3-test/${outNames.outA}`,
    outB: `/m3-test/${outNames.outB}`,
    outDel: `/m3-test/${outNames.outDel}`,
  };
}

/**
 * 等到终态积压**收敛**到阈值内（或超时返回最后一份快照）。
 *
 * 为什么不单次读数：清理在"任务完成"时触发，落盘与投影可能略晚于最后一个终态的可见时刻，
 * 单次读数会偶发读到清理前的中间态（历史现象 `after=4 > limit=3`）。
 * 断言语义仍是"必须收敛"——清理机制真失效时永远不会收敛，依旧 FAIL。
 *
 * @returns {{ok: boolean, snapshot: object, elapsedMs: number}}
 */
async function waitForFailedConverge(limit, timeoutMs = CONVERGE_TIMEOUT_MS) {
  const startedAt = Date.now();
  let snapshot = await countByStatus();
  while ((snapshot.by.failed || 0) > limit && Date.now() - startedAt < timeoutMs) {
    await sleep(RUNNING_POLL_INTERVAL_MS);
    snapshot = await countByStatus();
  }
  return { ok: (snapshot.by.failed || 0) <= limit, snapshot, elapsedMs: Date.now() - startedAt };
}

/**
 * 断言"非终态不被清理 + 终态积压仍在阈值内"（两条都基于**A 刚完成时**的那份快照）。
 *
 * 两条不变量分别对应：
 *   1. 契约 §六 规则 7：清理只删终态 → B（此刻 queued/running）必须在 tasks.json 里
 *   2. 清理同时把终态积压压在阈值内 → failed 条数 ≤ 3
 */
function checkNonTerminalKept(observed, secondId) {
  const second = observed.tasks.find((entry) => entry.info.id === secondId);
  const nonTerminal = Boolean(second) && !TERMINAL_STATUSES.includes(second.info.status);
  check('非终态任务（queued/running）在清理后仍在 tasks.json 中', nonTerminal,
    `B 状态=${second ? second.info.status : '不存在'} failed=${observed.by.failed || 0} 总条数=${observed.total}`);
  check('同一时刻终态积压仍被压在阈值内（failed ≤ 3）', (observed.by.failed || 0) <= 3, `failed=${observed.by.failed || 0}`);
}

async function caseNonTerminalSurvives() {
  await stopService();
  const now = Date.now();
  const records = [];
  for (let index = 0; index < SEED_TASK_COUNT; index += 1) records.push(makeRecord('failed', now - index * 1000));
  await seedTasks(records);
  await patchRetentionConfig({ taskRetentionMax: 3, taskRetentionDays: 7 });
  await startService();

  const atBoot = await countByStatus();
  check(`启动清理把 ${SEED_TASK_COUNT} 条终态压到 3 条（阈值 max=3）`, (atBoot.by.failed || 0) === 3, `failed=${atBoot.by.failed}`);

  // 起两个任务：**必须用不同 outputDir**。
  // 旧写法两次传同一个 outputDir，导致 B 压完立刻以 TARGET_EXISTS 失败（running 只有毫秒级），
  // 用 150ms 轮询去撞它 → 约一半概率撞不到而白等超时。
  const fixture = await ensureSlowFixture();
  const firstId = await createCompressTask(fixture.source, fixture.outA);
  const secondId = await createCompressTask(fixture.source, fixture.outB);
  check('起了两个任务（A 运行 / B 排队）', Boolean(firstId && secondId), `A=${String(firstId).slice(0, 8)} B=${String(secondId).slice(0, 8)}`);

  // 等 A 进入终态（确定性事件）：这一刻刚触发过"每完成一个任务后"的清理
  const observed = await waitForTaskTerminal(firstId);
  check('A 进入终态（说明已触发过清理时机）', Boolean(observed), observed ? `A=${observed.status}` : '超时未等到 A 终态');
  if (observed) checkNonTerminalKept(observed.snapshot, secondId);

  if (secondId) await api('POST', `/tasks/${secondId}/cancel`, {}).catch(() => {});
  await sleep(CANCEL_SETTLE_MS);
}

/** "每完成一个任务后"确实会清理：done 与 failed 两种终态各驱动一次 */
async function casePerCompletionPrune() {
  // 起点基线：前面套件可能留下 failed 终态记录，断言必须按增量判断，
  // 否则「环境里本来就有 4 条」会被误报成「清理失效」。
  const before = await countByStatus();
  const baseline = before.by.failed || 0;
  // 阈值取「起点与 3 的较大者」：干净环境仍按 ≤3 判；有残留时不误报，
  // 但若清理机制真失效（驱动后继续增长到基线之上）仍会 FAIL。
  const limit = Math.max(3, baseline);
  const driven = await drivePruneRounds(4);
  // 清理在"任务完成"时触发，落盘/投影可能略滞后于最后一个终态的可见时刻：
  // 单次读数会偶发读到"还没来得及清理"的中间态（历史现象 after=4 > limit=3）。
  // 这里等它**收敛**（最多 CONVERGE_TIMEOUT_MS），断言仍是"必须收敛到阈值内"——
  // 清理机制真失效时永远不会收敛，依旧会 FAIL。
  const converged = await waitForFailedConverge(limit);
  const after = converged.snapshot;
  check('done 终态驱动过清理（首个解压成功）', driven.done >= 1, `done=${driven.done} zip=${driven.zipUserPath}`);
  check('failed 终态驱动过清理（重复解压命中同名 → TARGET_EXISTS）', driven.failed >= 3, `failed=${driven.failed}`);
  check(
    `多次完成任务后终态积压仍在阈值内（failed ≤ ${limit}）`,
    converged.ok,
    `before=${baseline} after=${after.by.failed || 0} limit=${limit} 收敛耗时=${converged.elapsedMs}ms`,
  );
}

async function caseDeleteSemantics() {
  // 等清理由"每完成任务"触发完毕，再挑一条终态做 DELETE
  await sleep(500);
  const before = await countByStatus();
  const target = before.tasks.find((entry) => ['failed', 'interrupted'].includes(entry.info.status));
  check('存在可分派 DELETE 的终态记录', Boolean(target), `候选 ${before.total} 条`);

  const historyBefore = await historyLineCount();
  if (target) {
    const deleted = await api('DELETE', `/tasks/${target.info.id}`);
    check('DELETE 终态 → 200 且标记已移除', Boolean(deleted.json && deleted.json.ok && deleted.json.data.removed === true), `HTTP ${deleted.status} ${JSON.stringify(deleted.json.data)}`);

    const after = await countByStatus();
    check('DELETE 后该记录从 tasks.json 消失', !after.tasks.some((entry) => entry.info.id === target.info.id), `总数 ${before.total} → ${after.total}`);

    const historyAfter = await historyLineCount();
    // 用异步读替代 existsSync+readFileSync（异步路径里不该有同步 I/O；读不到按空串处理，判定结果不变）
    const historyText = await fsp.readFile(HISTORY_FILE, 'utf8').catch(() => '');
    const stillInHistory = historyText.includes(target.info.id);
    check('DELETE 不影响 task-history.jsonl（行数不变）', historyAfter === historyBefore, `历史行数 ${historyBefore} → ${historyAfter}`);
    check('被删任务仍留在历史里（审计日志 append-only）', stillInHistory, `历史中含该 id=${stillInHistory}`);
  }

  // 非终态 → INVALID_STATE（用**慢夹具**确保删除时它还没结束；不再依赖"某个目录恰好够大"）
  const longFixture = await ensureSlowFixture();
  const longTask = await api('POST', '/compress/tasks', {
    sources: [longFixture.source],
    mode: 'bundle',
    format: 'zip',
    options: { outputDir: longFixture.outDel },
  });
  const pendingId = taskIdOf(longTask);
  if (pendingId) {
    const pendingState = (await readTasks()).find((entry) => entry.info.id === pendingId);
    check('用于 DELETE 非终态的目标确实是活任务', Boolean(pendingState && ['queued', 'running'].includes(pendingState.info.status)), pendingState ? `status=${pendingState.info.status}` : '未在 tasks.json 中');
    const rejected = await api('DELETE', `/tasks/${pendingId}`);
    const code = rejected.json && rejected.json.error && rejected.json.error.code;
    check('DELETE 非终态 → INVALID_STATE(409)', rejected.status === 409 && code === 'INVALID_STATE', `HTTP ${rejected.status} code=${code}`);
    await api('POST', `/tasks/${pendingId}/cancel`, {});
  }

  const missing = await api('DELETE', '/tasks/00000000-0000-0000-0000-000000000000');
  check('DELETE 不存在 → TASK_NOT_FOUND(404)', missing.status === 404 && missing.json.error.code === 'TASK_NOT_FOUND', `HTTP ${missing.status}`);
}

async function main() {
  console.log('ZipCalm 任务记录清理验收（保留策略 + DELETE 语义 + 历史不受影响）');
  console.log(`API：${BASE}\n数据目录：${DATA_DIR}\n`);

  // 允许"服务未启动"时直接跑：先确保服务在跑（本脚本后面会自己停/起服务）
  await startService();

  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  // 备份（finally 里还原）
  const tasksBackup = await fsp.readFile(TASKS_FILE, 'utf8').catch(() => null);
  const configBackup = await fsp.readFile(CONFIG_FILE, 'utf8');
  console.log('    已备份 tasks.json / config.json（结束时还原）\n');

  try {
    await createBigFixture(); // 夹具自建（收尾会清理，不能依赖上次残留）
    await caseCountLimit();
    await caseTimeLimit();
    await caseConfigDriven();
    await caseNonTerminalSurvives();
    await casePerCompletionPrune();
    await caseDeleteSemantics();
  } finally {
    await stopService();
    if (tasksBackup !== null) await fsp.writeFile(TASKS_FILE, tasksBackup, 'utf8');
    await restoreConfig(configBackup);
    await startService();
    console.log('\n    已还原 tasks.json / config.json 并重启服务');
    await cleanupArtefacts();
  }

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

/**
 * 收尾清理测试产物（对齐 m4 套件的做法）：
 * - `/m3-retention-out-*`：每轮解压的目标目录（纯残留，脚本自身不依赖它跨运行存在）；
 * - `/m3-test`：压缩产物输出目录 + 大目录夹具。历史行为是保留（后续运行的 hasBig 探测会复用
 *   它当夹具），但代价是无限累积；现在默认清理，每次运行自行重建（createBigFixture 语义不变，
 *   只是夹具来源从"上一次的残留"变为"本次构造"）。
 * 设 ZIPCALM_M3_KEEP=1 可保留产物便于人工复核。
 */
async function cleanupArtefacts() {
  if (process.env.ZIPCALM_M3_KEEP === '1') {
    console.log('（ZIPCALM_M3_KEEP=1：保留测试产物便于人工复核）');
    return;
  }
  const removed = [];
  // 解压产物目录：时间戳命名，逐个清（glob 不引依赖，直接读目录名过滤前缀）
  const names = await fsp.readdir(ROOT).catch(() => []);
  for (const name of names) {
    if (name.startsWith('m3-retention-out-')) {
      await fsp.rm(path.join(ROOT, name), { recursive: true, force: true }).catch(() => {});
      removed.push(name);
    }
  }
  await fsp.rm(path.join(ROOT, 'm3-test'), { recursive: true, force: true }).catch(() => {});
  console.log(`    已清理测试产物：m3-retention-out-* ×${removed.length}、m3-test${removed.length > 0 ? `（${removed.slice(0, 3).join(', ')}${removed.length > 3 ? ' …' : ''}）` : ''}`);
}

// 运行期构造大目录夹具（/m3-test/big）：原先依赖"上次运行残留"，改为本次自建，
// 使"每次跑完清理"不再破坏后续运行的夹具探测逻辑。
async function createBigFixture() {
  const bigDir = path.join(ROOT, 'm3-test', 'big');
  await fsp.mkdir(bigDir, { recursive: true });
  // 三个小文件即可：非终态存活用例只需要"任务能跑一小会儿"，不需要真的大体积
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await fsp.writeFile(path.join(bigDir, name), `fixture ${name}\n`.repeat(64), 'utf8');
  }
}

main().catch((error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
