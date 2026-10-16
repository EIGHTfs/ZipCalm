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

export function createOrchestrator(deps) {
  const { config, logger, registry, manager, deleteService, rootAbs } = deps;

  /** 等待用户确认 + 执行删除（压缩/解压共用） */
  async function runDeleteStage(record, input) {
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

  /** 压缩任务主体 */
  async function runCompress(record) {
    const info = record.info;
    const plugin = registry.require(info.format);

    if (!(await registry.isAvailable(info.format))) {
      throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${info.format} 当前不可用`);
    }

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

    manager.setPhase(info.id, 'compressing');

    // single：每个源一个包；bundle：全部源一个包
    const groups = info.mode === 'single' ? info.sources.map((source) => [source]) : [info.sources];
    const signal = manager.getAbortSignal(info.id);
    let bytesIn = 0;
    let bytesOut = 0;

    for (const [groupIndex, group] of groups.entries()) {
      const baseName = group.length === 1
        ? group[0].name
        : `${group[0].name} 等 ${group.length} 项`;

      const outputAbsPath = await uniqueTargetPath(outputDirAbs, baseName, plugin.ext);
      const tempPath = `${outputAbsPath}.part`;

      // 进度分母：本组待压字节数（来自预检统计）
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
        options: {
          level: info.options.level,
          preserveRoot: true,
          signal,
        },
        onProgress: (payload) => manager.updateProgress(info.id, payload),
      });

      // 原子落盘：.part → 正式产物（崩溃/取消不会留下"看起来正常"的半成品）
      await fsp.rename(tempPath, outputAbsPath);

      bytesIn += Number(created.bytesIn) || 0;
      bytesOut += Number(created.bytesOut) || 0;

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
    }

    // ===== 校验（INV-01：不通过就绝不删原文件）=====
    manager.setPhase(info.id, 'verifying');
    for (const pkg of info.result.packages) {
      const verification = await verifyArchive(plugin, path.join(rootAbs, ...pkg.outputPath.split('/').filter(Boolean)));
      assertVerified(verification);
      pkg.verified = true;
      pkg.verifyStrategy = verification.strategy;
      pkg.checkedEntries = verification.checked;
    }

    info.result.bytesIn = bytesIn;
    info.result.bytesOut = bytesOut;
    info.result.savedBytes = Math.max(0, bytesIn - bytesOut);
    info.result.ratio = bytesIn > 0 ? Number((bytesOut / bytesIn).toFixed(4)) : 0;
    info.result.completedAt = Date.now();

    // ===== 删除原文件（keepOriginal=false 才会走到这里）=====
    if (info.delete) {
      const targets = info.sources.map((source) => ({
        userPath: source.userPath,
        absPath: source.absPath,
        kind: source.kind,
        size: Number(source.size) || 0,
      }));
      await runDeleteStage(record, {
        targets,
        reason: 'compress_success_verified',
        confirmedAtCreate: info.options.deleteConfirmed === true,
      });
    }

    return manager.finalize(info.id, 'done');
  }

  /** 解压任务主体 */
  async function runExtract(record) {
    const info = record.info;
    const plugin = registry.require(info.format);

    if (!(await registry.isAvailable(info.format))) {
      throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${info.format} 当前不可用`);
    }

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

    manager.setPhase(info.id, 'extracting');
    manager.updateProgress(info.id, {
      totalBytes: preflight.totalBytes,
      totalFiles: preflight.entries,
      processedBytes: 0,
      processedFiles: 0,
    });

    const extracted = await plugin.extract({
      taskId: info.id,
      format: info.format,
      archivePath: record.internal.archiveAbsPath,
      targetDir: record.internal.targetAbsDir,
      options: { overwrite: false, signal: manager.getAbortSignal(info.id) },
      onProgress: (payload) => manager.updateProgress(info.id, payload),
    });

    // ===== 校验（解压侧"先校验"= 归档自身完整 + 条目数与预检一致）=====
    manager.setPhase(info.id, 'verifying');
    const verification = await verifyArchive(plugin, record.internal.archiveAbsPath);
    assertVerified(verification);

    info.result.bytesOut = extracted.bytesOut;
    info.result.entries = extracted.entries;
    info.result.durationMs = extracted.durationMs;
    info.result.verified = true;
    info.result.verifyStrategy = verification.strategy;
    info.result.completedAt = Date.now();

    // ===== 删除压缩包（deleteArchiveAfterExtract=true 才走）=====
    if (info.delete) {
      let archiveSize = 0;
      try {
        archiveSize = (await fsp.stat(record.internal.archiveAbsPath)).size;
      } catch {
        archiveSize = 0;
      }
      await runDeleteStage(record, {
        targets: [{ userPath: info.archivePath, absPath: record.internal.archiveAbsPath, kind: 'file', size: archiveSize }],
        reason: 'extract_success_verified',
        confirmedAtCreate: info.options.deleteConfirmed === true,
      });
    }

    return manager.finalize(info.id, 'done');
  }

  return { runCompress, runExtract, defaultExtractDir };
}
