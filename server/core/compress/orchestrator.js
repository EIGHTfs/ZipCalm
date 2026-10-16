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
import { toUserPath } from '../fs/safePath.js';
import { compressPreflight, extractPreflight } from './preflight.js';
import { assertVerified, verifyArchive } from './verify.js';

/** 产物命名：不覆盖已有文件（docs/M0 数据模型 §9.2；上限 1000 次尝试防病态目录死循环） */
async function uniqueTargetPath(dirAbs, baseName, ext) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`;
    const candidate = path.join(dirAbs, `${baseName}${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw apiError(ERROR_CODES.TARGET_EXISTS, '同名产物过多，无法生成不冲突的文件名', { file: `${baseName}${ext}` });
}

/** 默认解压目标目录：与压缩包同级的同名目录（已存在则加 " (n)"，避免与既有目录混在一起） */
export async function defaultExtractDir(archiveAbsPath) {
  const dir = path.dirname(archiveAbsPath);
  const base = path.basename(archiveAbsPath).replace(/\.zip$/i, '');
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const suffix = attempt === 0 ? '' : ` (${attempt})`;
    const candidate = path.join(dir, `${base}${suffix}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw apiError(ERROR_CODES.TARGET_EXISTS, '无法生成不冲突的解压目录', { base });
}

/** 归档绝对路径 → 校验用路径（产物用 userPath 记录，这里换回本地路径） */
function archiveAbsOf(rootAbs, userPath) {
  return path.join(rootAbs, ...userPath.split('/').filter(Boolean));
}

// ===== 阶段一：删除（压缩删原文件 / 解压删压缩包共用）=====

/**
 * 执行删除阶段：等二次确认（除非创建时已确认）→ 调删除服务 → 回填删除状态。
 * 前置条件：调用方**必须**已经通过校验（INV-01）。
 */
async function stageDelete(record, input, deps) {
  const { manager, logger, deleteService } = deps;
  const info = record.info;
  if (!info.delete) return null;

  info.delete.targets = input.targets.map((target) => ({
    path: target.userPath,
    kind: target.kind || 'file',
    sizeBytes: Number.isFinite(target.size) ? target.size : null,
  }));

  const skipConfirm = input.confirmedAtCreate === true;
  if (!skipConfirm) {
    manager.markWaitingConfirm(info.id);
    const gate = await manager.waitConfirm(info.id);
    if (gate.confirmed !== true) {
      info.delete.status = 'skipped';
      info.delete.confirmed = false;
      info.delete.deletedAt = Date.now();
      logger.info('用户放弃删除，原文件/压缩包保持不动', { taskId: info.id });
      return null;
    }
    if (Number.isInteger(gate.expectedFiles) && gate.expectedFiles !== info.delete.targets.length) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, '确认弹窗与实际待删数量不一致，已中止删除', {
        expectedFiles: gate.expectedFiles,
        actualFiles: info.delete.targets.length,
      });
    }
    info.delete.confirmed = true;
    info.delete.confirmedAt = gate.at || Date.now();
  } else {
    info.delete.confirmed = true;
    info.delete.confirmedAt = Date.now();
  }

  manager.setPhase(info.id, 'deleting');
  info.delete.status = 'deleting';

  const result = await deleteService.deleteTargets({
    taskId: info.id,
    kind: info.kind,
    reason: input.reason,
    targets: input.targets,
  });

  info.delete.mode = result.mode;
  info.delete.batchId = result.batchId;
  info.delete.logFile = result.logFile;
  info.delete.deleted = result.deleted;
  info.delete.skipped = result.skipped;
  info.delete.failed = result.failed;
  info.delete.deletedAt = Date.now();
  info.delete.status = result.failed.length > 0
    ? 'failed'
    : (result.mode === 'log-only' ? 'logged' : 'deleted');
  info.delete.error = result.failed.length > 0 ? { code: result.failed[0].code, message: '删除失败' } : null;
  return result;
}

// ===== 阶段二：压缩 =====

/** 压缩预检：权限 + 2 倍空间 + 输出目录；不通过直接抛契约错误码（任务随后 failed） */
async function stageCompressPrecheck(record, deps) {
  const { config, manager, rootAbs } = deps;
  const info = record.info;

  manager.setPhase(info.id, 'precheck');
  const outputDirAbs = record.internal.outputDirAbs || path.dirname(info.sources[0].absPath);
  const preflight = await compressPreflight(
    { config, rootAbs },
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
    skipped: [],
  };
  return outputDirAbs;
}

/** 按模式分组：single=每个源一个包；bundle=全部源一个包 */
function groupSourcesForCompress(info) {
  return info.mode === 'single' ? info.sources.map((source) => [source]) : [info.sources];
}

/** 单个包的名字：单源用源名，多源用「首个源名 等 N 项」 */
function packageBaseName(group) {
  return group.length === 1 ? group[0].name : `${group[0].name} 等 ${group.length} 项`;
}

/** 压缩一个包：写 .part → 原子 rename → 记账到 result.packages */
async function compressOnePackage(record, deps, plugin, group, groupIndex, outputDirAbs) {
  const { manager, rootAbs } = deps;
  const info = record.info;

  const outputAbsPath = await uniqueTargetPath(outputDirAbs, packageBaseName(group), plugin.ext);
  const tempPath = `${outputAbsPath}.part`;

  // 进度分母：本组待压字节数/文件数（来自预检统计）
  const groupBytes = group.reduce((sum, source) => sum + (Number(source.size) || 0), 0);
  const groupFiles = group.reduce((sum, source) => sum + (Number(source.fileCount) || 0), 0);
  manager.updateProgress(info.id, { totalBytes: groupBytes, totalFiles: groupFiles, processedBytes: 0, processedFiles: 0 });

  const created = await plugin.create({
    taskId: info.id,
    format: info.format,
    mode: info.mode,
    sources: group,
    outputPath: outputAbsPath,
    tempPath,
    options: { level: info.options.level, preserveRoot: true, signal: manager.getAbortSignal(info.id) },
    onProgress: (payload) => manager.updateProgress(info.id, payload),
  });

  // 原子落盘：.part → 正式产物（崩溃/取消不会留下"看起来正常"的半成品）
  await fsp.rename(tempPath, outputAbsPath);

  info.result.packages.push({
    sourceIndex: groupIndex,
    sourcePath: group[0].userPath,
    outputPath: toUserPath(rootAbs, outputAbsPath),
    bytesOut: Number(created.bytesOut) || 0,
    entries: created.entries,
    durationMs: created.durationMs,
    verified: false,
    verifyStrategy: null,
  });

  return { bytesIn: Number(created.bytesIn) || 0, bytesOut: Number(created.bytesOut) || 0 };
}

/** 打包阶段：逐个包执行，返回累计字节数 */
async function stageCompressPackages(record, deps, plugin, outputDirAbs) {
  const { manager } = deps;
  manager.setPhase(record.info.id, 'compressing');

  let bytesIn = 0;
  let bytesOut = 0;
  for (const [groupIndex, group] of groupSourcesForCompress(record.info).entries()) {
    const created = await compressOnePackage(record, deps, plugin, group, groupIndex, outputDirAbs);
    bytesIn += created.bytesIn;
    bytesOut += created.bytesOut;
  }
  return { bytesIn, bytesOut };
}

/** 校验阶段（INV-01）：逐个产物做完整性校验，任一不通过即抛 VERIFY_FAILED */
async function stageVerifyPackages(record, deps, plugin) {
  const { manager, rootAbs } = deps;
  manager.setPhase(record.info.id, 'verifying');

  for (const pkg of record.info.result.packages) {
    const verification = await verifyArchive(plugin, archiveAbsOf(rootAbs, pkg.outputPath));
    assertVerified(verification);
    pkg.verified = true;
    pkg.verifyStrategy = verification.strategy;
    pkg.checkedEntries = verification.checked;
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
  const info = record.info;
  const plugin = registry.require(info.format);

  if (!(await registry.isAvailable(info.format))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${info.format} 当前不可用`);
  }

  const outputDirAbs = await stageCompressPrecheck(record, deps);
  const { bytesIn, bytesOut } = await stageCompressPackages(record, deps, plugin, outputDirAbs);
  await stageVerifyPackages(record, deps, plugin);
  summarizeCompressResult(record, bytesIn, bytesOut);

  // 删除原文件：仅当 keepOriginal=false（管理器已据此建好 delete 状态）
  if (info.delete) {
    const targets = info.sources.map((source) => ({
      userPath: source.userPath,
      absPath: source.absPath,
      kind: source.kind,
      size: Number(source.size) || 0,
    }));
    await stageDelete(record, {
      targets,
      reason: 'compress_success_verified',
      confirmedAtCreate: info.options.deleteConfirmed === true,
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
