// 任务落盘（docs/M0/数据模型.md §六 落盘模型）
//
// 两个文件、两种写法的分野（这是本模块存在的全部理由）：
// - `tasks.json`：**非终态 + failed/interrupted** 任务，原子写（写 .tmp → rename）+ **500ms 节流**；
//   终态 done/aborted 写进历史后从这里移除。
// - `task-history.jsonl`：每次进终态**追加一行**；内存缓存最近 `limits.taskHistoryMax`（默认 200）条，
//   文件增长过大时按缓存重写压缩（避免无限增长）。
//
// 为什么必须原子写：任务状态是"服务重启后唯一能还原真相的来源"，
// 原地截断写被中断 → 半个 JSON → 重启后任务全丢（INV-11）。
//
// 结构：状态全部放在 `ctx` 里，具体动作都是**模块级小函数**（每个只做一件事），
// 工厂函数只负责建 ctx 并把动作绑上去（便于单测与审读）。

import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, writeJsonAtomic } from '../../lib/atomic-json.js';

/** 历史条目净化：历史文件可能由旧版本写入（含 absPath 等内部字段），读取/追加时一律剥掉，防止经 API 泄漏 */
function sanitizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const clean = { ...entry };
  if (Array.isArray(clean.sources)) {
    clean.sources = clean.sources.map(({ absPath, userPath, ...rest }) => rest);
  }
  if (clean.result && Array.isArray(clean.result.packages)) {
    clean.result = { ...clean.result, packages: clean.result.packages.map(({ absPath, ...rest }) => rest) };
  }
  return clean;
}

function buildContext(options) {
  const { dataDir } = options;
  return {
    logger: options.logger,
    historyMax: Number.isInteger(options.historyMax) ? options.historyMax : 200,
    saveThrottleMs: Number.isInteger(options.saveThrottleMs) ? options.saveThrottleMs : 500,
    // 契约里的路径是 `storage/tasks.json`；本项目 dataDir 就是 ./storage（见 config/defaults.js）
    tasksFile: path.join(dataDir, 'tasks.json'),
    historyFile: path.join(dataDir, 'task-history.jsonl'),
    /** 最近 historyMax 条历史（旧 → 新，与文件顺序一致） */
    historyCache: [],
    saveTimer: null,
    savePending: null,
    saveInFlight: null,
    /** 写入串行链（并发写会互相截断 .tmp，见 saveTasksNow 注释） */
    writeChain: Promise.resolve(),
  };
}

/** 读 tasks.json；坏文件按空处理并告警（原文件保留，人工可查；不拖垮启动） */
async function loadTasks(ctx) {
  const { data, ok, reason } = await readJson(ctx.tasksFile, []);
  if (!ok && reason !== 'not-found') {
    ctx.logger.warn('tasks.json 不可读，按空列表处理', { reason });
    return [];
  }
  return Array.isArray(data) ? data : [];
}

/** 读取历史文件（逐行解析 + 净化；坏行跳过） */
async function loadHistoryFromFile(ctx) {
  try {
    const text = await fs.readFile(ctx.historyFile, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(-ctx.historyMax)
      .map((line) => {
        try {
          return sanitizeHistoryEntry(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 启动加载：读 tasks.json + 预热历史缓存 */
async function initStore(ctx) {
  const tasks = await loadTasks(ctx);
  ctx.historyCache = await loadHistoryFromFile(ctx);
  return { tasks, historyCount: ctx.historyCache.length };
}

/** 单次写入（原子：写 <file>.tmp → rename） */
async function writeTasksFile(ctx, tasks) {
  try {
    await writeJsonAtomic(ctx.tasksFile, tasks);
  } catch (error) {
    ctx.logger.error('tasks.json 写盘失败', { error: error.message });
  }
}

/**
 * 立即原子落盘。
 * **必须串行**：`writeJsonAtomic` 用的是固定的 `<file>.tmp`，两个写并发会互相截断同一个临时文件，
 * rename 之后 tasks.json 里就会出现"两份 JSON 粘在一起"的残骸（实测踩过：JSON.parse 报
 * "Unexpected non-whitespace character after JSON"）。串行化后任一时刻只有一个写在跑，
 * 也与"单进程单写者"（INV-09）的模型一致。
 */
async function saveTasksNow(ctx, tasks) {
  ctx.savePending = null;
  if (ctx.saveTimer) {
    clearTimeout(ctx.saveTimer);
    ctx.saveTimer = null;
  }
  const previous = ctx.writeChain || Promise.resolve();
  const chained = previous.then(() => writeTasksFile(ctx, tasks)).catch(() => {});
  ctx.writeChain = chained;
  ctx.saveInFlight = chained;
  await chained;
  if (ctx.saveInFlight === chained) ctx.saveInFlight = null;
}

/**
 * 节流落盘：进度类高频变更走这里（契约：tasks.json ≤2 次/秒）。
 * 状态/phase 变化与终态必须用 saveTasksNow() 立即落盘，**不能等节流**（INV-10「创建即落盘」同理）。
 */
function scheduleTasksSave(ctx, tasks) {
  ctx.savePending = tasks;
  if (ctx.saveTimer) return;
  ctx.saveTimer = setTimeout(() => {
    ctx.saveTimer = null;
    const payload = ctx.savePending;
    ctx.savePending = null;
    if (payload) void saveTasksNow(ctx, payload);
  }, ctx.saveThrottleMs);
  if (typeof ctx.saveTimer.unref === 'function') ctx.saveTimer.unref();
}

/** 收尾：等写入链跑完，并把未决的节流内容立刻写出（优雅关闭时调用） */
async function flushStore(ctx) {
  if (ctx.writeChain) await ctx.writeChain;
  if (ctx.savePending) await saveTasksNow(ctx, ctx.savePending);
}

/**
 * 历史文件按条数收敛（契约：`task-history.jsonl` 保留最近 `limits.taskHistoryMax` 条）。
 * 触发条件只看行数（不再设"文件多大才整理"的门槛，否则行数会长期超过上限 —— 实测踩过）；
 * 超过就按内存缓存重写一次（200 行 ≈ 400KB，代价可控），仍用"临时文件 + rename"保证原子性。
 */
async function trimHistoryFile(ctx) {
  try {
    const lines = (await fs.readFile(ctx.historyFile, 'utf8')).split('\n').filter((line) => line.trim().length > 0);
    if (lines.length <= ctx.historyMax) return;
    const tmpPath = `${ctx.historyFile}.tmp`;
    await fs.writeFile(tmpPath, `${ctx.historyCache.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    await fs.rename(tmpPath, ctx.historyFile);
    ctx.logger.info('task-history.jsonl 已按条数收敛', { kept: ctx.historyCache.length, was: lines.length, max: ctx.historyMax });
  } catch (error) {
    ctx.logger.warn('task-history.jsonl 压缩失败（不影响运行）', { error: error.message });
  }
}

/** 终态追加一行，并同步内存缓存（超限裁剪） */
async function appendHistoryEntry(ctx, entry) {
  const clean = sanitizeHistoryEntry(entry);
  ctx.historyCache.push(clean);
  if (ctx.historyCache.length > ctx.historyMax) ctx.historyCache = ctx.historyCache.slice(-ctx.historyMax);
  try {
    await fs.mkdir(path.dirname(ctx.historyFile), { recursive: true });
    await fs.appendFile(ctx.historyFile, `${JSON.stringify(clean)}\n`, 'utf8');
    await trimHistoryFile(ctx);
  } catch (error) {
    ctx.logger.error('task-history.jsonl 写入失败', { error: error.message });
  }
}

/** 历史查询（新 → 旧）；内存缓存优先（契约 §六.5） */
function listHistory(ctx, filter = {}) {
  const limit = Number.isInteger(filter.limit) ? filter.limit : 50;
  let items = [...ctx.historyCache].reverse();
  if (filter.status) items = items.filter((item) => filter.status.includes(item.status));
  return items.slice(0, limit);
}

function getHistoryEntry(ctx, id) {
  for (let index = ctx.historyCache.length - 1; index >= 0; index -= 1) {
    if (ctx.historyCache[index].id === id) return ctx.historyCache[index];
  }
  return null;
}

/**
 * @param {{dataDir: string, historyMax?: number, saveThrottleMs?: number, logger: object}} options
 */
export function createTaskStore(options) {
  const ctx = buildContext(options);
  return {
    init: () => initStore(ctx),
    loadTasks: () => loadTasks(ctx),
    scheduleSave: (tasks) => scheduleTasksSave(ctx, tasks),
    saveNow: (tasks) => saveTasksNow(ctx, tasks),
    flush: () => flushStore(ctx),
    appendHistory: (entry) => appendHistoryEntry(ctx, entry),
    listHistory: (filter) => listHistory(ctx, filter),
    getHistoryEntry: (id) => getHistoryEntry(ctx, id),
    files: { tasksFile: ctx.tasksFile, historyFile: ctx.historyFile },
    historyMax: ctx.historyMax,
  };
}
