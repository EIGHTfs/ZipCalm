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

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

async function waitHealthy(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

async function startService() {
  await execFileAsync('bash', ['scripts/start.sh', 'start'], { cwd: PROJECT_ROOT, timeout: 60000 }).catch(() => {});
  const healthy = await waitHealthy();
  // 本脚本会反复停/起服务：重启后重新登录拿新 token，避免依赖"上一轮的凭据还能用"
  if (healthy && TOKEN) {
    const login = await api('POST', '/auth/login', LOGIN);
    if (login.json && login.json.data && login.json.data.token) TOKEN = login.json.data.token;
  }
  return healthy;
}

async function stopService() {
  await execFileAsync('bash', ['scripts/start.sh', 'stop'], { cwd: PROJECT_ROOT, timeout: 60000 }).catch(() => {});
  await sleep(400);
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

/**
 * 用"能真正被 API 创建"的任务驱动清理时机：
 * 先压一个小目录拿到合法 zip，再反复解压到同一目标目录 —— 第一次成功（done），
 * 之后因 overwrite=false 命中同名文件而**确定性失败**（TARGET_EXISTS），
 * 这样 done 与 failed 两种终态各触发一次"每完成一个任务后"的清理。
 */
async function drivePruneRounds(rounds) {
  const zipped = await api('POST', '/compress/tasks', {
    sources: ['/文档'],
    mode: 'bundle',
    format: 'zip',
    options: { outputDir: '/m3-test' },
  });
  const zipTaskId = zipped.json && zipped.json.data && zipped.json.data.task && zipped.json.data.task.id;
  const zipTask = zipTaskId ? await waitTerminal(zipTaskId) : null;
  const zipUserPath = zipTask && zipTask.result && zipTask.result.packages && zipTask.result.packages[0]
    ? zipTask.result.packages[0].outputPath
    : null;

  let done = 0;
  let failed = 0;
  // 目标目录必须每次唯一：否则上一轮的残留会让"第一次解压"也失败，done 路径就测不到
  const targetDir = `/m3-retention-out-${Date.now()}`;
  if (zipUserPath) {
    for (let index = 0; index < rounds; index += 1) {
      const extracted = await api('POST', '/extract/tasks', { path: zipUserPath, targetDir });
      const taskId = extracted.json && extracted.json.data && extracted.json.data.task && extracted.json.data.task.id;
      if (!taskId) continue;
      const task = await waitTerminal(taskId);
      if (task && task.status === 'done') done += 1;
      if (task && task.status === 'failed') failed += 1;
    }
  }
  return { done, failed, zipUserPath };
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
  return created.json && created.json.data && created.json.data.task && created.json.data.task.id;
}

/**
 * 非终态永不被清理（契约 §六 规则 7）。
 *
 * 为什么这样设计：清理时机是"启动 + 每完成一个任务后"，而 v1 是**串行队列** ——
 * 一个任务完成时，队列里后面的任务正好处于 `queued`（非终态）。
 * 所以：起 A（大任务，跑着）+ B（排队），A 完成会触发一次清理，此刻 B 必须还在 tasks.json 里。
 * 这比"造一堆终态再观察"更贴近真实触发路径。
 */
async function caseNonTerminalSurvives() {
  await stopService();
  const now = Date.now();
  const records = [];
  for (let index = 0; index < 6; index += 1) records.push(makeRecord('failed', now - index * 1000));
  await seedTasks(records);
  await patchRetentionConfig({ taskRetentionMax: 3, taskRetentionDays: 7 });
  await startService();

  const atBoot = await countByStatus();
  check('启动清理把 6 条终态压到 3 条（阈值 max=3）', (atBoot.by.failed || 0) === 3, `failed=${atBoot.by.failed}`);

  const bigDir = path.join(ROOT, 'm3-test', 'big');
  const hasBig = fs.existsSync(bigDir);
  const source = hasBig ? '/m3-test/big' : '/文档';
  const outputDir = hasBig ? '/m3-test' : undefined;
  const firstId = await createCompressTask(source, outputDir);
  const secondId = await createCompressTask(source, outputDir);
  check('起了两个任务（A 运行 / B 排队）', Boolean(firstId && secondId), `A=${String(firstId).slice(0, 8)} B=${String(secondId).slice(0, 8)}`);

  // 轮询等 B 进入 running：那一刻 A 已完成 —— A 的 finalize 正好触发过一次清理
  const deadline = Date.now() + 180000;
  let observed = null;
  while (Date.now() < deadline) {
    const snapshot = await countByStatus().catch(() => null);
    const second = snapshot && snapshot.tasks.find((entry) => entry.info.id === secondId);
    if (second && second.info.status === 'running') {
      observed = snapshot;
      break;
    }
    await sleep(150);
  }
  check('B 进入 running（说明 A 已完成并触发过清理时机）', Boolean(observed), observed ? '' : '超时未观察到 B 运行');

  if (observed) {
    const stillThere = observed.tasks.some((entry) => entry.info.id === secondId && entry.info.status === 'running');
    check('非终态任务（running）在清理后仍在 tasks.json 中', stillThere, `failed=${observed.by.failed || 0} 总条数=${observed.total}`);
    check('同一时刻终态积压仍被压在阈值内（failed ≤ 3）', (observed.by.failed || 0) <= 3, `failed=${observed.by.failed || 0}`);
  }

  if (secondId) await api('POST', `/tasks/${secondId}/cancel`, {}).catch(() => {});
  await sleep(500);
}

/** "每完成一个任务后"确实会清理：done 与 failed 两种终态各驱动一次 */
async function casePerCompletionPrune() {
  const driven = await drivePruneRounds(4);
  const after = await countByStatus();
  check('done 终态驱动过清理（首个解压成功）', driven.done >= 1, `done=${driven.done} zip=${driven.zipUserPath}`);
  check('failed 终态驱动过清理（重复解压命中同名 → TARGET_EXISTS）', driven.failed >= 3, `failed=${driven.failed}`);
  check('多次完成任务后终态积压仍在阈值内（failed ≤ 3）', (after.by.failed || 0) <= 3, `failed=${after.by.failed || 0}`);
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
    const stillInHistory = fs.existsSync(HISTORY_FILE) && fs.readFileSync(HISTORY_FILE, 'utf8').includes(target.info.id);
    check('DELETE 不影响 task-history.jsonl（行数不变）', historyAfter === historyBefore, `历史行数 ${historyBefore} → ${historyAfter}`);
    check('被删任务仍留在历史里（审计日志 append-only）', stillInHistory, `历史中含该 id=${stillInHistory}`);
  }

  // 非终态 → INVALID_STATE（用长任务，确保删除时它还没结束）
  const bigDirForDelete = path.join(ROOT, 'm3-test', 'big');
  const longTask = await api('POST', '/compress/tasks', {
    sources: [fs.existsSync(bigDirForDelete) ? '/m3-test/big' : '/文档'],
    mode: 'bundle',
    format: 'zip',
    options: { outputDir: fs.existsSync(bigDirForDelete) ? '/m3-test' : undefined },
  });
  const pendingId = longTask.json && longTask.json.data && longTask.json.data.task && longTask.json.data.task.id;
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
  }

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
