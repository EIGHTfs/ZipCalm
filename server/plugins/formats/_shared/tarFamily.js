// tar 系列格式包工厂（tar / tar.gz / tar.zst 共用一个实现，只是压缩层不同）
//
// 为什么要工厂：三种格式的**归档层完全相同**（node-tar 写/读 tar），差别只在外面套不套 gzip/zstd。
// 各写一份 = 三份 zip-slip 判定与三份进度逻辑，迟早漂移。这里压缩层是策略参数：
//   none  → 直通（.tar）
//   gzip  → node:zlib gzip（.tar.gz）
//   zstd  → **node:zlib 内置 zstd**（Node ≥ 22.15）；不可用时回退系统 `zstd` 命令（ZC_ZSTD_BIN 可覆盖）
//
// 安全：条目判定与写出复用 `_shared/entrySafety.js`（与 zip **同一套** zip-slip 防护）。
// 边界（INV-15）：格式包不删源文件、不做预检、不排队、不落盘任务状态。
//
// 文件分工（本文件只放契约面与装配，实现拆到 _shared/tar/ 下，单文件不超过约定行数）：
//   _shared/tar/compression.js —— 压缩层策略与 zstd 回退链
//   _shared/tar/writer.js      —— 收集条目 + 流式写出
//   _shared/tar/reader.js      —— 流式解析 + 错误映射

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';

import * as tar from 'tar';

import { ERROR_CODES, apiError } from '../../../lib/errors.js';
import { assertCreatable } from './createGuards.js';
import { planTargets } from './entrySafety.js';
import { builtinZstdUsable, findZstdBinary } from './tar/compression.js';
import { collectEntries, writeTarStream } from './tar/writer.js';
import { mapArchiveError, parseArchive, readEntryBuffer, toApiEntry } from './tar/reader.js';

/** 压得动的文本/结构化数据 vs 已压缩格式：用于 estimate 的粗估（M4 只求"够算预检分母"） */
const ALREADY_COMPRESSED = /\.(jpe?g|png|gif|webp|heic|mp4|mkv|mov|mp3|flac|zip|7z|rar|gz|bz2|xz|zst|docx|xlsx|pptx)$/i;

// ===== 契约面实现 =====
// 全部写成「模块级函数 + spec 参数」：一是审计要求单函数 ≤50 行代码，二是每个动作可独立单测。
// 工厂（文件末尾）只做装配，不含逻辑。

async function pluginAvailable(spec) {
  // node-tar 可用性就看真实用到的入口：Pack（写）/ list（读）
  if (typeof tar.Pack !== 'function' || typeof tar.list !== 'function') return false;
  if (spec.compression === 'gzip') return typeof zlib.createGzip === 'function';
  if (spec.compression === 'zstd') return builtinZstdUsable() || Boolean(findZstdBinary());
  return true;
}

async function pluginUnavailableReason(spec) {
  if (await pluginAvailable(spec)) return null;
  if (spec.compression === 'zstd') {
    return `zstd 不可用：Node 内置 zstd 需要 Node ≥ 22.15（当前 ${process.version}），且系统未找到 zstd 命令（可用 ZC_ZSTD_BIN 指定路径）`;
  }
  return `${spec.id} 依赖（node-tar / node:zlib）未正确安装`;
}

/** 粗估：tar 不压（≈1.0 + 头部开销）；gzip/zstd 按"是否已压缩格式"给经验比值 */
async function pluginEstimate(spec, inputBytes, options = {}) {
  const bytes = Number.isFinite(inputBytes) && inputBytes > 0 ? inputBytes : 0;
  const names = Array.isArray(options.sample && options.sample.names) ? options.sample.names : [];
  const ratioOf = {
    none: 1.0,
    gzip: names.length > 0 && names.every((entryName) => ALREADY_COMPRESSED.test(entryName)) ? 0.98 : 0.6,
    zstd: names.length > 0 && names.every((entryName) => ALREADY_COMPRESSED.test(entryName)) ? 0.95 : 0.5,
  }[spec.compression];
  const headerOverhead = 512 * Math.max(1, names.length || 1);
  return {
    estimatedBytes: Math.ceil(bytes * ratioOf) + (spec.compression === 'none' ? headerOverhead : 0),
    ratio: ratioOf,
    basis: 'heuristic',
    confidence: 'low',
  };
}

async function pluginCreate(spec, ctx) {
  await assertCreatable(ctx, () => pluginAvailable(spec), spec.id);
  const collected = await collectEntries(ctx);
  const level = Number.isInteger(ctx.options && ctx.options.level) ? ctx.options.level : (spec.defaultLevel || 6);
  return writeTarStream(ctx, collected, {
    compression: spec.compression,
    level,
    signal: ctx.options && ctx.options.signal,
  });
}

async function pluginList(spec, archivePath) {
  const entries = [];
  try {
    await parseArchive(archivePath, spec.compression, (entry) => {
      entries.push(toApiEntry(entry));
      entry.resume(); // 目录/不需要内容的场景要显式放流，否则解析器会卡住
    });
  } catch (error) {
    throw mapArchiveError(error, archivePath);
  }
  return { entries, count: entries.length, truncated: false };
}

/** 完整性校验：tar 没有 CRC，走契约允许的 `read-all`（逐条目读通 + 大小一致） */
async function pluginTest(spec, archivePath) {
  const failures = [];
  let checked = 0;
  try {
    await parseArchive(archivePath, spec.compression, async (entry) => {
      const info = toApiEntry(entry);
      if (info.type === 'dir') {
        entry.resume();
        return;
      }
      const buffer = await readEntryBuffer(entry);
      if (buffer.length !== info.size) {
        failures.push({ entry: info.name, reason: `解压后大小不符（期望 ${info.size}，实际 ${buffer.length}）` });
      }
      checked += 1;
    });
  } catch (error) {
    // 解析/解压失败（截断、损坏的 gzip/zstd 流）→ 归档损坏
    throw mapArchiveError(error, archivePath);
  }
  return { ok: failures.length === 0, checked, failures, strategy: 'read-all' };
}

/** 第一遍：只收集条目名与类型（**不落盘**），交给共用判定做 zip-slip + 覆盖检查 */
async function collectEntryMeta(spec, archivePath) {
  const meta = [];
  try {
    await parseArchive(archivePath, spec.compression, (entry) => {
      meta.push({
        name: entry.path || entry.name || '',
        isDir: entry.type === 'Directory',
        size: Number(entry.size || 0),
        link: entry.type === 'SymbolicLink' || entry.type === 'Link',
      });
      entry.resume();
    });
  } catch (error) {
    throw mapArchiveError(error, archivePath);
  }
  return meta;
}

/** 预先建好所有目标目录：第二遍必须**同步**接管条目流，不能在里面 await mkdir */
async function prepareTargetDirs(plan) {
  for (const plannedEntry of plan) {
    if (plannedEntry.isDir) await fsp.mkdir(plannedEntry.targetPath, { recursive: true });
    else await fsp.mkdir(path.dirname(plannedEntry.targetPath), { recursive: true });
  }
}

async function pluginExtract(spec, ctx) {
  if (!(await pluginAvailable(spec))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `${spec.id} 格式当前不可用`);
  }
  const startedAt = Date.now();
  const targetDir = path.resolve(ctx.targetDir);
  const overwrite = Boolean(ctx.options && ctx.options.overwrite);

  const meta = await collectEntryMeta(spec, ctx.archivePath);
  const planned = planTargets(meta.map((entryMeta, index) => ({ ...entryMeta, index })), targetDir, overwrite);
  await prepareTargetDirs(planned.plan);

  // 第二遍：按顺序把每个条目的数据写到判定好的目标路径
  let cursor = 0;
  await parseArchive(ctx.archivePath, spec.compression, (entry) => {
    const plannedEntry = planned.plan[cursor];
    cursor += 1;
    if (!plannedEntry || plannedEntry.isDir) {
      entry.resume();
      return null;
    }
    // 同步 attach：pipeline 立即开始消费该条目
    return pipeline(entry, fs.createWriteStream(plannedEntry.targetPath));
  });

  return {
    targetDir,
    entries: cursor,
    bytesOut: planned.totalBytes,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * tar 系列格式包工厂：只做契约面装配，不含任何逻辑。
 * @param {{id: string, name: string, ext: string, extAliases?: string[], mime: string,
 *          compression: 'none'|'gzip'|'zstd', levelRange?: [number, number], defaultLevel?: number}} spec
 */
export function createTarPlugin(spec) {
  return {
    id: spec.id,
    name: spec.name,
    ext: spec.ext,
    extAliases: spec.extAliases || [],
    mime: spec.mime,
    levelRange: spec.levelRange,
    defaultLevel: spec.defaultLevel,
    available: () => pluginAvailable(spec),
    unavailableReason: () => pluginUnavailableReason(spec),
    estimate: (inputBytes, options) => pluginEstimate(spec, inputBytes, options),
    create: (ctx) => pluginCreate(spec, ctx),
    extract: (ctx) => pluginExtract(spec, ctx),
    list: (archivePath) => pluginList(spec, archivePath),
    test: (archivePath) => pluginTest(spec, archivePath),
  };
}
