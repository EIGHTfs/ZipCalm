// 压缩/解压编排（M2）
//
// 一条管道同时服务两种任务（docs/11 M2「范围说明」）：
//
//   precheck → scanning → compressing|extracting → verifying → [waiting_confirm] → deleting → done
//
// 关键不变量：
// - **INV-01：删除前必须校验通过**。verify 不通过 → VERIFY_FAILED，且绝不进入 deleting；
// - INV-08：产物命名绝不覆盖（同名加 " (1)"），临时产物 `.part` 由本层原子 rename 成正式产物；
// - 删除动作统一走 deleteService（受 `delete.mode` 约束：log-only 默认只记日志）。
//
// 结构：**每个阶段一个模块级函数**（预检 / 打包 / 校验 / 解压 / 删除），
// 任务主体 `runCompressTask` / `runExtractTask` 只做阶段编排与结果汇总；
// 阶段函数通过 `deps` 显式取依赖（config/logger/registry/manager/deleteService/rootAbs），不使用闭包捕获。
//
// 边界（M2 简化）：任务与历史只在内存（M3 落盘）、SSE 未实现（前端轮询）、黑名单未接入（M6）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { pathExists } from '../../lib/fs-probe.js';
import { matchEntry } from './blacklist.js';
import { toUserPath } from '../fs/safePath.js';
import { compressPreflight, extractPreflight } from './preflight.js';
import { assertVerified, verifyArchive } from './verify.js';

/** 产物命名：不覆盖已有文件（docs/M0 数据模型 §9.2；上限 1000 次尝试防病态目录死循环） */
async function uniqueTargetPath(dirAbs, baseName, ext) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`;
    const candidate = path.join(dirAbs, `${baseName}${suffix}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw apiError(ERROR_CODES.TARGET_EXISTS, '同名产物过多，无法生成不冲突的文件名', { file: `${baseName}${ext}` });
}

/** 默认解压目标目录：与压缩包同级的同名目录（已存在则加 " (n)"，避免与既有目录混在一起） */
export async function defaultExtractDir(archiveAbsPath) {
  const dir = path.dirname(archiveAbsPath);
  // 复合扩展名要整体去掉（`x.tar.gz` → `x`，而不是 `x.tar`）
  const base = path.basename(archiveAbsPath).replace(/\.(tar\.(gz|zst)|tar|zip|tgz|tzst)$/i, '');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`;
    const candidate = path.join(dir, `${base}${suffix}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw apiError(ERROR_CODES.TARGET_EXISTS, '无法生成不冲突的解压目录', { base });
}

/** 归档绝对路径 → 校验用路径（产物用 userPath 记录，这里换回本地路径） */

/**
 * 本次任务使用的存储根：**任务自己的根优先**（多根下在哪个卷/共享下建的任务，就用哪个根）。
 * 为什么不能用 deps.rootAbs：那样在 /volume1 下建的任务，产物路径与删除复核会按 fs-root 算（INV-06 会误判）。
 */
function rootAbsOf(record, deps) {
  return (record && record.internal && record.internal.rootAbs) || deps.rootAbs;
}

function archiveAbsOf(rootAbs, userPath) {
  return path.join(rootAbs, ...userPath.split('/').filter(Boolean));
}

// ===== 阶段一：删除（压缩删原文件 / 解压删压缩包共用）=====

/**
 * 从格式包 create() 返回的 entryPaths（契约 v2 §3.4 条款 10：实际进包条目的**源绝对路径**，
 * 进程内使用不进 API）构造删除集合。
 *
 * INV-02 语义：targets = 进包条目 − skipped。**禁止**用「全部源条目」当删除集合（P-01 定时炸弹），
 * **禁止**用包内路径反推源路径（lead 确认的第一手事实原则：collectEntries 收集时 absPath 就在手上）。
 *
 * @param {string[]} entryPaths 格式包返回的实际进包 absPath 清单
 * @param {string[]} skippedAbsPaths 被跳过条目的 absPath（M6 起由黑名单命中项填充；打包阶段就不进包，本参数是删除集合的第二道防线）
 * @param {Map<string,{sizeBytes:number,mtimeMs:number,ino:number}>} [entryStats] 批次④ stat 复核快照（同一次 walk 顺手记录；缺省按 null sizeBytes）
 * @param {(absPath: string) => string} toUserPathOf absPath → userPath 单向转换（orchestrator 持有 root）
 * @returns {{targets: Array<{userPath,absPath,kind,size}>, excluded: number}} 命中集合与被差集排除数
 */
export function buildDeleteTargetsFromEntries(entryPaths, skippedAbsPaths, entryStats, toUserPathOf) {
  const skipped = new Set(skippedAbsPaths || []);
  const targets = [];
  let excluded = 0;
  for (const absPath of entryPaths || []) {
    if (skipped.has(absPath)) {
      excluded += 1;
      continue;
    }
    const stat = entryStats ? entryStats.get(absPath) : null;
    targets.push({
      userPath: toUserPathOf(absPath),
      absPath,
      kind: 'file',
      size: stat ? stat.sizeBytes : 0,
    });
  }
  return { targets, excluded };
}

/**
 * 删除执行前的 stat 复核（契约 INV-03 ⑤）：确认后逐条 stat，与进包时记录的 size 比对；
 * 变化条目跳过（不删），**全部变化 → 整批拒删**（目录被动过，保守处理）。
 *
 * 快照来源：进包清单建立时的 entryStats（sizeBytes），由 collectEntries 阶段记录；
 * 快照缺失（size=null）的条目视为「无基准可查」→ 放行（当前 zip/tar 的 size 都有记录）。
 *
 * @param {Array<{userPath,absPath,kind,size}>} targets 内部形状删除集合
 * @param {Map<string,{sizeBytes:number}>} [entryStats] 进包时快照
 * @param {() => Promise<{sizeBytes: number|null, mtimeMs: number, ino: number}>} statOne 单条 stat（注入便于测试）
 * @returns {Promise<{kept: Array, changed: Array<{userPath,absPath,reason}>}>}
 */
export async function filterStaleDeleteTargets(targets, entryStats, statOne) {
  const kept = [];
  const changed = [];
  for (const target of targets || []) {
    let current = null;
    try {
      current = await statOne(target.absPath);
    } catch {
      current = null; // ENOENT / 权限等：源已不在或不可读 → 视为已变化
    }
    const baseline = entryStats ? entryStats.get(target.absPath) : null;
    // 无基准（快照缺失）→ 无法判定变化，放行（不虚构拦截）
    if (!baseline || baseline.sizeBytes === null || baseline.sizeBytes === undefined) {
      kept.push(target);
      continue;
    }
    if (!current || Number(current.sizeBytes) !== Number(baseline.sizeBytes)) {
      changed.push({ userPath: target.userPath, absPath: target.absPath, reason: current ? 'source_changed' : 'source_gone' });
      continue;
    }
    kept.push(target);
  }
  return { kept, changed };
}

/** 把 API 用户路径的删除目标转成删除服务入参形状 */
function buildDeleteTargets(input) {
  return input.targets.map((target) => ({
    path: target.userPath,
    kind: target.kind || 'file',
    sizeBytes: Number.isFinite(target.size) ? target.size : null,
  }));
}

/** 字节比对容差（与路由层 parseExpectedCounts 同口径）：目录 size 估算与磁盘块对齐允许 ±1 */
const EXPECTED_BYTES_TOLERANCE = 1;

/**
 * 确认数字复核（INV-03：expectedFiles 与 expectedBytes 双维度）。
 *
 * 双层防线设计（M5-fix-plan F-02）：路由层 parseExpectedCounts 已做同步 fast-fail（给 4xx 体验）；
 * 这里是**权威防线**——在删除执行前的最后一刻再比一次，覆盖"路由校验通过后、执行前"窗口内
 * 待删集合发生变化（如 stat 复核剔除条目）的情况。两层口径一致，不冗余。
 */
export function assertExpectedCountsMatch(gate, targets) {
  const actualFiles = targets.length;
  if (Number.isInteger(gate.expectedFiles) && gate.expectedFiles !== actualFiles) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, '确认弹窗与实际待删数量不一致，已中止删除', {
      expectedFiles: gate.expectedFiles,
      actualFiles,
    });
  }
  if (Number.isFinite(gate.expectedBytes)) {
    const actualBytes = targets.reduce((sum, target) => sum + (Number(target.sizeBytes) || 0), 0);
    if (Math.abs(gate.expectedBytes - actualBytes) > EXPECTED_BYTES_TOLERANCE) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, '确认弹窗与实际待删字节数不一致，已中止删除', {
        expectedBytes: gate.expectedBytes,
        actualBytes,
      });
    }
  }
}

/**
 * 等二次确认（创建时已确认则直接放行）。
 * @returns {Promise<boolean>} true = 可以删；false = 用户放弃（调用方据此跳过删除，原文件不动）
 */
async function awaitDeleteConfirm(manager, logger, info, skipConfirm) {
  if (skipConfirm) {
    info.delete.confirmed = true;
    info.delete.confirmedAt = Date.now();
    return true;
  }

  manager.markWaitingConfirm(info.id);
  const gate = await manager.waitConfirm(info.id);
  if (gate.confirmed !== true) {
    info.delete.status = 'skipped';
    info.delete.confirmed = false;
    info.delete.deletedAt = Date.now();
    // 契约 §3.2/§3.3：放弃原因区分 user_cancelled（用户取消）/ confirm_timeout（超时）；
    // 两者任务终态都是 done（不回滚压缩结果）——runner 正常返回，由调用方 finalize('done')。
    const reason = gate.reason === 'confirm_timeout' ? 'confirm_timeout' : 'user_cancelled';
    info.delete.skipReason = reason;
    logger.info('删除确认未达成，原文件/压缩包保持不动', { taskId: info.id, reason });
    return false;
  }
  assertExpectedCountsMatch(gate, info.delete.targets);
  info.delete.confirmed = true;
  info.delete.confirmedAt = gate.at || Date.now();
  return true;
}

/** 把删除结果回填到任务 info.delete（字段名与契约一致） */
function applyDeleteOutcome(info, deleteOutcome) {
  info.delete.mode = deleteOutcome.mode;
  info.delete.batchId = deleteOutcome.batchId;
  info.delete.logFile = deleteOutcome.logFile;
  info.delete.deleted = deleteOutcome.deleted;
  info.delete.skipped = deleteOutcome.skipped;
  info.delete.failed = deleteOutcome.failed;
  info.delete.deletedAt = Date.now();
  info.delete.status = deleteOutcome.failed.length > 0
    ? 'failed'
    // F-08（契约 §2.2 枚举收敛）：log-only 模式映射回 skipped（reason 标 log-only），
    // 'logged' 是契约外枚举值，不再产出；log-only 的记账细节在删除日志（action=skipped-log-only）
    : 'skipped';
  info.delete.error = deleteOutcome.failed.length > 0
    ? { code: deleteOutcome.failed[0].code, message: '删除失败' }
    : null;
}

/**
 * 契约 §9.5 集合差异复核：targets ⊆ 进包条目 − skipped，差异非空 → 抛 INVALID_STATE（整批拒删）。
 *
 * 与构造侧（buildDeleteTargetsFromEntries）**独立实现**，互为对方漂移的检测线：
 * 构造侧改坏（如被改回"全部 sources"）时，这里会拦住并拒绝删除——本函数导出供单元测试
 * 做反例自证（禁用复核 → 污染集合不再被拦 → 测试红）。
 *
 * @param {Array<{userPath,absPath,kind,size}>} targets 待删集合
 * @param {string[]} entryAbsPaths 调用方声明的进包清单（absPath 坐标系）
 * @param {string[]} [skippedAbsPaths] 被跳过条目（同样不允许进删除集合）
 * @returns {{violations: Array<{userPath,absPath}>}} 差异明细（空数组 = 通过）
 */
export function checkDeleteSetAgainstEntries(targets, entryAbsPaths, skippedAbsPaths = []) {
  const allowed = new Set(entryAbsPaths);
  const skippedAbs = new Set(skippedAbsPaths);
  return {
    violations: (targets || []).filter((t) => !allowed.has(t.absPath) || skippedAbs.has(t.absPath))
      .map((t) => ({ userPath: t.userPath, absPath: t.absPath })),
  };
}

/**
 * 执行删除阶段：集合差异复核（契约 §9.5）→ 等二次确认 → 调删除服务 → 回填删除状态。
 * 前置条件：调用方**必须**已经通过校验（INV-01）。
 */
async function stageDelete(record, input, deps) {
  const { manager, logger, deleteService } = deps;
  const rootAbs = rootAbsOf(record, deps);
  const info = record.info;
  if (!info.delete) return null;

  info.delete.targets = buildDeleteTargets(input);

  // 契约 §9.5：删除前复核 targets ⊆ 进包条目 − skipped，差异非空 → 拒绝删除整批并记日志。
  // 注意：复核对象是 **input.targets（内部形状，含 absPath）**——info.delete.targets 已被
  // buildDeleteTargets 映射成契约形状（丢了 absPath），坐标系必须与 entryAbsPaths 一致。
  const { violations } = checkDeleteSetAgainstEntries(input.targets, input.entryAbsPaths, input.skippedAbsPaths || []);
  if (input.entryAbsPaths && violations.length > 0) {
    logger.error('删除集合与进包清单存在差异，整批拒绝删除（契约 §9.5）', {
      taskId: info.id,
      violations: violations.map((v) => v.userPath),
    });
    throw apiError(ERROR_CODES.INVALID_STATE, '删除集合与实际进包条目不一致，已拒绝删除', {
      violationCount: violations.length,
      violations: violations.slice(0, 5).map((v) => v.userPath),
    });
  }

  const confirmed = await awaitDeleteConfirm(manager, logger, info, input.confirmedAtCreate === true);
  if (!confirmed) return null;

  // INV-03 ⑤：确认后、删除前的最后一道复核——逐条 stat 与进包时快照比对，
  // 变化条目跳过（reason=source_changed/source_gone），全部变化 → 整批拒删（保守）。
  if (input.entryStats) {
    const statOne = async (absPath) => {
      const stat = await fsp.stat(absPath);
      return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    };
    const { kept, changed } = await filterStaleDeleteTargets(input.targets, input.entryStats, statOne);
    if (changed.length > 0) {
      logger.warn('删除前 stat 复核发现源变动', { taskId: info.id, changed: changed.map((c) => ({ path: c.userPath, reason: c.reason })) });
      if (kept.length === 0) {
        throw apiError(ERROR_CODES.INVALID_STATE, '全部待删条目在确认后发生变动，已整批拒绝删除', {
          changed: changed.slice(0, 5).map((c) => c.userPath),
        });
      }
      info.delete.skipped = [...(info.delete.skipped || []), ...changed.map((c) => ({ path: c.userPath, reason: c.reason }))];
      input.targets = kept;
    }
  }

  // deleting 是真正的执行相位（rename/移入回收站），必须与后续任务的压缩互斥：
  // 让位后 activeId 可能属于 B；source 重叠时 B 正在读的文件不能被 A 移走。
  // 等待发生在 runner 内部（确认 HTTP 请求不挂起）；拿到槽位后才进入 deleting。
  await manager.waitForExecutionSlot(info.id);
  manager.setPhase(info.id, 'deleting');
  info.delete.status = 'deleting';
  const deleteOutcome = await deleteService.deleteTargets({
    // INV-06 复核基准：任务自己的根（多根下不能用服务默认根）
    rootAbs,
    taskId: info.id,
    kind: info.kind,
    reason: input.reason,
    targets: input.targets,
  });

  applyDeleteOutcome(info, deleteOutcome);
  return deleteOutcome;
}

// ===== 阶段二：压缩 =====

/** 压缩预检：权限 + 2 倍空间 + 输出目录；不通过直接抛契约错误码（任务随后 failed） */
async function stageCompressPrecheck(record, deps) {
  const { config, manager } = deps;
  const rootAbs = rootAbsOf(record, deps);
  const info = record.info;

  manager.setPhase(info.id, 'precheck');
  const outputDirAbs = record.internal.outputDirAbs || path.dirname(info.sources[0].absPath);
  // 黑名单层：与创建任务时的预检用同一套解析（enabled=false 表示整条黑名单关掉）
  const blacklistLayers = await resolveBlacklistLayers(deps, info);
  const preflight = await compressPreflight(
    { config, rootAbs, blacklistLayers },
    { sources: info.sources, format: info.format, mode: info.mode, outputDir: outputDirAbs },
  );
  if (!preflight.canProceed) {
    throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
  }

  info.result = {
    preflight: {
      totalBytes: preflight.totalBytes,
      requiredBytes: preflight.requiredBytes,
      freeBytes: preflight.freeBytes,
      preflightFactor: preflight.preflightFactor,
    },
    packages: [],
    // 对外视图（只有用户路径）。**运行期以打包器回报为准**：预检只是预测，
    // 若这里也预填一次、打包时再 push 一次，就会得到翻倍重复的 skipped（实测踩过）。
    skipped: [],
  };
  // 内部视图：absPath 只放 internal（删除集合要用它，API 响应不出现）
  record.internal.skippedEntries = [];
  return outputDirAbs;
}

/** 解析黑名单层（deps.blacklist 缺失时按"不启用"处理：不自造隐式保护） */
async function resolveBlacklistLayers(deps, info) {
  if (!deps.blacklist) return [];
  const options = (info.options && info.options.blacklist) || {};
  return deps.blacklist.layersFor({
    enabled: options.enabled !== false,
    taskPatterns: Array.isArray(options.extraPatterns) ? options.extraPatterns : [],
  });
}

/** 命中判定函数（供格式包在收集条目时调用）：返回 {pattern, layer} 或 null */
function shouldSkipMatcher(layers) {
  if (!layers || layers.length === 0) return null;
  return (entry) => matchEntry(layers, entry);
}

/** 按模式分组：single=每个源一个包；bundle=全部源一个包 */
function groupSourcesForCompress(info) {
  return info.mode === 'single' ? info.sources.map((source) => [source]) : [info.sources];
}

/**
 * 通用能力装配循环（docs/19 图 1 ★）：编排层不认识任何具体能力——
 * 「格式声明 ∩ 能力 appliesTo」的交集决定哪些能力参与本次压缩；每个能力用
 * prepareCreate() 把自己的参数翻译成格式插件的 create 选项（archiverFormat / extra）。
 *
 * 用户启用入口也走通用形态：options.capabilities = { <capId>: {…参数} }（由 HTTP 层
 * 校验后写入）。交集为空 → 返回空数组，装配循环零动作。
 *
 * @returns {Array<{id, cap, params}>} 本次压缩实际启用的能力（verify 阶段复用）
 */
function assembleCapabilities(record, deps, plugin) {
  const { capRegistry } = deps;
  const info = record.info;
  const declared = Array.isArray(plugin.capabilities) ? plugin.capabilities : [];
  const userEnabled = info.options && typeof info.options.capabilities === 'object' ? info.options.capabilities : {};
  const assembled = [];
  for (const capId of declared) {
    const cap = capRegistry && capRegistry.get(capId);
    if (!cap) continue; // 声明了但能力未加载：按「无此能力」处理（前端不展示，用户不会传参）
    if (!cap.appliesTo.includes(plugin.id)) continue;
    const rawParams = userEnabled[capId];
    if (rawParams === undefined) continue; // 用户未启用该能力
    const verdict = cap.validateParams(rawParams, { formatId: plugin.id });
    if (!verdict.ok) {
      throw apiError(verdict.error.code, verdict.error.message, verdict.error.details);
    }
    assembled.push({ id: capId, cap, params: verdict.value });
  }
  return assembled;
}

/** 单个包的名字：单源用源名，多源用「首个源名 等 N 项」 */
function packageBaseName(group) {
  return group.length === 1 ? group[0].name : `${group[0].name} 等 ${group.length} 项`;
}

/** 压缩一个包：写 .part → 原子 rename → 记账到 result.packages */
async function compressOnePackage(record, deps, plugin, group, groupIndex, outputDirAbs) {
  const { manager, logger } = deps;
  const rootAbs = rootAbsOf(record, deps);
  const info = record.info;

  const outputAbsPath = await uniqueTargetPath(outputDirAbs, packageBaseName(group), plugin.ext);
  const tempPath = `${outputAbsPath}.part`;

  // 上次中断遗留的 .part 必须让路：改名保留（INV-10 留证据）而不是沿用或直接删，
  // 否则本次 create() 会因 TARGET_EXISTS 失败 —— "保留 .part" 与 "可重试" 才能同时成立。
  if (await pathExists(tempPath)) {
    const archived = `${tempPath}.interrupted-${Date.now()}`;
    await fsp.rename(tempPath, archived);
    logger.warn('发现遗留 .part，已改名保留以便重试', { taskId: info.id, archived: path.basename(archived) });
  }

  // 进度分母：本组待压字节数/文件数（来自预检统计）
  const groupBytes = group.reduce((sum, source) => sum + (Number(source.sizeBytes) || 0), 0);
  const groupFiles = group.reduce((sum, source) => sum + (Number(source.fileCount) || 0), 0);
  manager.updateProgress(info.id, { totalBytes: groupBytes, totalFiles: groupFiles, processedBytes: 0, processedFiles: 0 });

  const layers = await resolveBlacklistLayers(deps, info);
  // 通用能力装配循环（docs/19 图 1）：prepareCreate 的产物并进 create 选项——
  // archiverFormat 决定 archiver 工厂形态，archiverExtra 是能力专属参数（透传给引擎）。
  const assembledCapabilities = assembleCapabilities(record, deps, plugin);
  const capabilityOptions = {};
  for (const { cap, params } of assembledCapabilities) {
    const translated = cap.prepareCreate({ params, formatId: info.format });
    capabilityOptions.archiverFormat = translated.archiverFormat;
    capabilityOptions.archiverExtra = { ...(capabilityOptions.archiverExtra || {}), ...translated.extra };
  }
  // 能力参数存 internal（含明文，仅进程内存；PW-1：store.js 落盘时剔除，verify 阶段复用）
  record.internal.capabilityParams = assembledCapabilities.map((item) => ({ id: item.id, params: item.params }));
  const created = await plugin.create({
    taskId: info.id,
    format: info.format,
    mode: info.mode,
    sources: group,
    outputPath: outputAbsPath,
    tempPath,
    options: {
      level: info.options.level,
      preserveRoot: true,
      signal: manager.getAbortSignal(info.id),
      // 格式包在"收集条目"阶段就跳过命中项（省 CPU/磁盘，且它们不会进 entryPaths → 不会被删）
      shouldSkip: shouldSkipMatcher(layers),
      ...capabilityOptions,
    },
    onProgress: (payload) => manager.updateProgress(info.id, payload),
  });

  // 汇总本次包的黑名单跳过项：对外 userPath、对内 absPath（删除集合要用）
  for (const skippedEntry of created.skipped || []) {
    record.internal.skippedEntries.push(skippedEntry);
    info.result.skipped.push({
      path: toUserPath(rootAbs, skippedEntry.absPath),
      pattern: skippedEntry.pattern,
      layer: skippedEntry.layer,
    });
  }

  // 原子落盘：.part → 正式产物（崩溃/取消不会留下"看起来正常"的半成品）
  await fsp.rename(tempPath, outputAbsPath);

  info.result.packages.push({
    sourceIndex: groupIndex,
    sourcePath: group[0].path,
    outputPath: toUserPath(rootAbs, outputAbsPath),
    bytesOut: Number(created.bytesOut) || 0,
    entries: created.entries,
    durationMs: created.durationMs,
    verified: false,
    verifyStrategy: null,
  });

  return {
    bytesIn: Number(created.bytesIn) || 0,
    bytesOut: Number(created.bytesOut) || 0,
    // 契约 v2 §3.4 条款 10：格式包回报的实际进包条目（源绝对路径）——INV-02 删除集合依据
    entryPaths: Array.isArray(created.entryPaths) ? created.entryPaths : [],
  };
}

/** 打包阶段：逐个包执行，返回累计字节数 */
async function stageCompressPackages(record, deps, plugin, outputDirAbs) {
  const { manager } = deps;
  manager.setPhase(record.info.id, 'compressing');

  let bytesIn = 0;
  let bytesOut = 0;
  const createdPackages = [];
  for (const [groupIndex, group] of groupSourcesForCompress(record.info).entries()) {
    const created = await compressOnePackage(record, deps, plugin, group, groupIndex, outputDirAbs);
    createdPackages.push(created);
    bytesIn += created.bytesIn;
    bytesOut += created.bytesOut;
  }
  return { bytesIn, bytesOut, createdPackages };
}

/** 校验阶段（INV-01）：逐个产物做完整性校验，任一不通过即抛 VERIFY_FAILED */
async function stageVerifyPackages(record, deps, plugin) {
  const { manager } = deps;
  const rootAbs = rootAbsOf(record, deps);
  manager.setPhase(record.info.id, 'verifying');

  // 加密包不走通用 CRC 校验：那一步没有密码，读条目会直接报 MISSING_PASSWORD，
  // 结果必然是「校验未通过」（假阴性）。改由能力自测覆盖 —— cap.verify() 的定义
  // 就是「用同一密码试解一次」，强度等价（真要校验 CRC 也必须先解密）。
  // 注意：这里只要求「有启用的能力」，能力自测失败会在 stageCapabilityVerify 抛 VERIFY_FAILED。
  const capabilityCovered = Array.isArray(record.internal.capabilityParams)
    && record.internal.capabilityParams.length > 0;

  for (const pkg of record.info.result.packages) {
    if (capabilityCovered) {
      pkg.verified = true;
      pkg.verifyStrategy = 'capability';
      pkg.checkedEntries = 0;
      continue;
    }
    const verification = await verifyArchive(plugin, archiveAbsOf(rootAbs, pkg.outputPath));
    assertVerified(verification);
    pkg.verified = true;
    pkg.verifyStrategy = verification.strategy;
    pkg.checkedEntries = verification.checked;
  }
}

/**
 * 能力自测阶段（PW-2）：装配循环里启用的能力逐个 verify——
 * 任一失败抛 VERIFY_FAILED（任务 failed，INV-01 拦住删除，原文件一个不删）。
 * 通用形态：编排层不知道能力具体自测什么（加密包是"同密码试解"，未来能力自测各自定义）。
 */
async function stageCapabilityVerify(record, deps) {
  const capabilityParams = record.internal.capabilityParams || [];
  if (capabilityParams.length === 0) return;
  const { manager } = deps;
  const rootAbs = rootAbsOf(record, deps);
  const info = record.info;

  for (const { id, params } of capabilityParams) {
    const cap = deps.capRegistry.get(id);
    if (!cap || typeof cap.verify !== 'function') continue;
    for (const pkg of info.result.packages) {
      const verdict = await cap.verify({
        archivePath: archiveAbsOf(rootAbs, pkg.outputPath),
        params,
        formatApi: null,
      });
      if (!verdict.ok) {
        throw apiError(ERROR_CODES.VERIFY_FAILED, `能力 ${id} 自测未通过：${verdict.error || '未知原因'}`, {
          capability: id,
          package: pkg.outputPath,
        });
      }
    }
  }
  // 脱敏后写入 options（PW-1：明文只在内存 internal；对外只有布尔+方法名）
  for (const { id, params } of capabilityParams) {
    const cap = deps.capRegistry.get(id);
    if (!cap) continue;
    const redacted = cap.redact(params);
    info.options.capabilities = info.options.capabilities || {};
    info.options.capabilities[id] = { ...redacted };
  }
}

/** 汇总压缩结果（字节数、节省量、比率、完成时间） */
function summarizeCompressResult(record, bytesIn, bytesOut) {
  const info = record.info;
  info.result.bytesIn = bytesIn;
  info.result.bytesOut = bytesOut;
  info.result.savedBytes = Math.max(0, bytesIn - bytesOut);
  info.result.ratio = bytesIn > 0 ? Number((bytesOut / bytesIn).toFixed(4)) : 0;
  info.result.completedAt = Date.now();
}

/** 压缩任务主体：只做阶段编排 */
async function runCompressTask(record, deps) {
  const { registry, manager } = deps;
  const rootAbs = rootAbsOf(record, deps);
  const info = record.info;
  const plugin = registry.require(info.format);

  if (!(await registry.isAvailable(info.format))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${info.format} 当前不可用`);
  }

  const outputDirAbs = await stageCompressPrecheck(record, deps);
  const { bytesIn, bytesOut, createdPackages } = await stageCompressPackages(record, deps, plugin, outputDirAbs);
  await stageVerifyPackages(record, deps, plugin);
  await stageCapabilityVerify(record, deps); // PW-2：能力自测（加密包同密码试解），失败 → failed 且不删原文件
  summarizeCompressResult(record, bytesIn, bytesOut);

  // 删除原文件：仅当 keepOriginal=false（管理器已据此建好 delete 状态）。
  // 删除集合 = 实际进包条目（created.entryPaths，第一手事实）− skipped（INV-02），
  // 绝不用 info.sources 全量（未进包条目删了就是静默数据丢失）。
  if (info.delete) {
    const allEntryPaths = createdPackages.flatMap((pkg) => pkg.entryPaths || []);
    // skipped 的 absPath 只在 internal（对外 result.skipped 只有 userPath，契约 §2.2 红线）
    const skippedAbsPaths = (record.internal.skippedEntries || []).map((item) => item.absPath).filter(Boolean);
    // 进包时快照（INV-03 ⑤ 的基准）：collectEntries 已对每个文件 stat 过（size 记录在条目上），
    // 这里原样带出作为删除前复核的比对基准，不做第二次 walk。
    const entryStats = new Map(createdPackages.flatMap((pkg) => pkg.entryStats || []));
    const { targets } = buildDeleteTargetsFromEntries(allEntryPaths, skippedAbsPaths, entryStats, (absPath) => toUserPath(rootAbs, absPath));
    await stageDelete(record, {
      targets,
      reason: 'compress_success_verified',
      confirmedAtCreate: info.options.deleteConfirmed === true,
      // §9.5 复核依据：调用方声明的进包清单与 skipped（absPath 坐标系，与 targets 同源）
      entryAbsPaths: allEntryPaths,
      skippedAbsPaths,
      entryStats,
    }, deps);
  }

  return manager.finalize(info.id, 'done');
}

// ===== 阶段三：解压 =====

/** 解压预检：归档可读可解析 + 目标目录可写 + 空间（解压后 × factor） */
async function stageExtractPrecheck(record, deps, plugin) {
  const { config, manager } = deps;
  const info = record.info;

  manager.setPhase(info.id, 'precheck');
  const preflight = await extractPreflight(
    { config, plugin },
    {
      archivePath: info.archivePath,
      archiveAbsPath: record.internal.archiveAbsPath,
      targetDir: info.targetDir,
      targetAbsDir: record.internal.targetAbsDir,
    },
  );
  if (!preflight.canProceed) {
    throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
  }

  info.result = {
    preflight: {
      totalBytes: preflight.totalBytes,
      requiredBytes: preflight.requiredBytes,
      freeBytes: preflight.freeBytes,
      preflightFactor: preflight.preflightFactor,
      entries: preflight.entries,
    },
    packages: [],
    skipped: [],
  };
  return preflight;
}

/** 写出阶段：调格式包 extract（zip-slip 预扫描在格式包内、写盘之前完成） */
async function stageExtractWrite(record, deps, plugin) {
  const { manager } = deps;
  const info = record.info;

  manager.setPhase(info.id, 'extracting');
  return plugin.extract({
    taskId: info.id,
    format: info.format,
    archivePath: record.internal.archiveAbsPath,
    targetDir: record.internal.targetAbsDir,
    options: { overwrite: false, signal: manager.getAbortSignal(info.id) },
    onProgress: (payload) => manager.updateProgress(info.id, payload),
  });
}

/** 校验阶段（解压侧"先校验"）：归档自身必须完整，否则绝不进入删除 */
async function stageVerifyArchive(record, deps, plugin) {
  const { manager } = deps;
  manager.setPhase(record.info.id, 'verifying');
  const verification = await verifyArchive(plugin, record.internal.archiveAbsPath);
  assertVerified(verification);
  return verification;
}

/** 解压任务主体：只做阶段编排 */
async function runExtractTask(record, deps) {
  const { registry, manager } = deps;
  const info = record.info;
  const plugin = registry.require(info.format);

  if (!(await registry.isAvailable(info.format))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${info.format} 当前不可用`);
  }

  const preflight = await stageExtractPrecheck(record, deps, plugin);
  manager.updateProgress(info.id, {
    totalBytes: preflight.totalBytes,
    totalFiles: preflight.entries,
    processedBytes: 0,
    processedFiles: 0,
  });

  const extracted = await stageExtractWrite(record, deps, plugin);
  const verification = await stageVerifyArchive(record, deps, plugin);

  info.result.bytesOut = extracted.bytesOut;
  info.result.entries = extracted.entries;
  info.result.durationMs = extracted.durationMs;
  info.result.verified = true;
  info.result.verifyStrategy = verification.strategy;
  info.result.completedAt = Date.now();

  // 删除压缩包：仅当 deleteArchiveAfterExtract=true
  if (info.delete) {
    let archiveSize = 0;
    try {
      archiveSize = (await fsp.stat(record.internal.archiveAbsPath)).size;
    } catch {
      archiveSize = 0;
    }
    await stageDelete(record, {
      targets: [{ userPath: info.archivePath, absPath: record.internal.archiveAbsPath, kind: 'file', size: archiveSize }],
      reason: 'extract_success_verified',
      confirmedAtCreate: info.options.deleteConfirmed === true,
    }, deps);
  }

  return manager.finalize(info.id, 'done');
}

/**
 * 创建编排器：把 deps 绑定到阶段函数上，对外只暴露两个任务入口。
 * @param {{config: object, logger: object, registry: object, manager: object, deleteService: object, rootAbs: string}} deps
 */
export function createOrchestrator(deps) {
  return {
    runCompress: (record) => runCompressTask(record, deps),
    runExtract: (record) => runExtractTask(record, deps),
    defaultExtractDir,
  };
}
