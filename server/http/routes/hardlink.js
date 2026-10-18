// 硬链接去重端点（docs/15 §三）
//
// - POST /hardlink/scan     扫描重复分组（**默认 dry-run，不动任何文件**——本端点本身永不改文件）
//   请求：{ path: string, extensions?: string[] }
//   响应：data.groups[] = { size, hash, master, duplicates[], savedBytes } + data.stats
//   路径全部走 fsGuard.resolveReal（INV-06 白名单 + 符号链接复核）；响应里只出 userPath。
//
// - POST /hardlink/execute  批次②实现（执行替换，需显式 confirmed）——本文件先放参数守卫与
//   409 占位，避免批次①就开执行面。
//
// 风险纪律（docs/15 §四）：风险与 M5 同级 → 扫描只读、扩展名白名单、日志（批次②）。

import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { executeHardlinkGroups } from '../../core/hardlink/executor.js';
import { scanHardlinkDuplicates } from '../../core/hardlink/scanner.js';

/** 扩展名默认白名单（docs/15 §三.前端：mp4/mkv/avi/mov/iso/zip/7z） */
const DEFAULT_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'iso', 'zip', '7z'];
/** 扩展名条目上限（防异常请求撑爆配置面） */
const MAX_EXTENSIONS = 64;

/** 解析并归一化扩展名白名单（小写、去点、去空、限数） */
function normalizeExtensions(raw) {
  if (raw === undefined || raw === null) return DEFAULT_EXTENSIONS;
  if (!Array.isArray(raw)) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'extensions 必须是字符串数组', { got: typeof raw });
  }
  const cleaned = [...new Set(raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean))];
  if (cleaned.length === 0 || cleaned.length > MAX_EXTENSIONS) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, `extensions 需要 1~${MAX_EXTENSIONS} 个有效条目`, { got: cleaned.length });
  }
  return cleaned;
}

export default async function hardlinkRoutes(app) {
  /**
   * 扫描重复分组（只读；永不改文件）。
   * docs/15：默认 dry-run 语义 = 本端点天然只读；「执行」是独立端点（批次②）且需显式确认。
   */
  app.post('/hardlink/scan', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = request.body || {};
    if (typeof body.path !== 'string' || body.path.length === 0) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必须是非空字符串');
    }
    const extensions = normalizeExtensions(body.extensions);
    // 白名单 + 符号链接复核（INV-06，与 fs 路由同源）
    const resolved = await app.fsGuard.resolveReal(body.path);
    const scanPayload = await scanHardlinkDuplicates(resolved.absPath, extensions);

    // 响应路径统一转 userPath（绝对路径绝不进 API，INV-06 红线）
    const rootPrefix = resolved.absPath;
    const toUser = (absPath) => {
      const relative = path.posix.relative(rootPrefix.replaceAll(path.sep, '/'), absPath.replaceAll(path.sep, '/'));
      const base = resolved.userPath === '/' ? '' : resolved.userPath.replace(/\/$/, '');
      return `${base}/${relative}`;
    };
    const groups = scanPayload.groups.map((group) => ({
      ...group,
      master: toUser(group.master),
      duplicates: group.duplicates.map(toUser),
    }));

    reply.ok({
      path: resolved.userPath,
      extensions,
      groups,
      stats: scanPayload.stats,
    });
  });

  /**
   * 执行替换（批次②）：对 scan 产出的分组执行 rename→link→unlink 三步替换。
   * 请求：{ path, extensions?, groups: [{size, hash, master, duplicates[]}]（userPath 坐标系，必须来自 scan 响应）, confirmed: true }
   * 守卫链：confirmed 显式 true → 组路径逐一过白名单并限定在扫描根下 → 服务端重新全量哈希复核
   * （不信任客户端判定，扫描到执行之间文件可能变化；不一致整组跳过）→ 三步替换
   * （EXDEV/EEXIST/EPERM/ENOSPC 单条隔离，失败回滚 rename）。每条落 hardlink-*.jsonl。
   */
  app.post('/hardlink/execute', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = request.body || {};
    if (body.confirmed !== true) {
      throw apiError(ERROR_CODES.INVALID_STATE, '执行需要显式确认（confirmed=true）；先跑 scan 看预览');
    }
    if (typeof body.path !== 'string' || body.path.length === 0) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必须是非空字符串');
    }
    if (!Array.isArray(body.groups) || body.groups.length === 0) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'groups 必须是非空数组（来自 scan 响应）');
    }
    const extensions = normalizeExtensions(body.extensions);
    const resolved = await app.fsGuard.resolveReal(body.path);

    // 组路径白名单复核（INV-06：执行面是写路径，比 scan 更严——逐个 resolveReal 并限定在扫描根下）
    const resolveGroup = async (group) => {
      if (!group || typeof group.master !== 'string' || !Array.isArray(group.duplicates) || group.duplicates.length === 0) {
        throw apiError(ERROR_CODES.VALIDATION_FAILED, 'groups 每项需要 master 与非空 duplicates');
      }
      const toAbs = async (userPath) => {
        const resolvedEntry = await app.fsGuard.resolveReal(userPath);
        const rel = path.relative(resolved.absPath, resolvedEntry.absPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '分组路径不在扫描根下', { userPath });
        }
        return item.absPath;
      };
      return {
        size: Number(group.size) || 0,
        master: await toAbs(group.master),
        duplicates: await Promise.all(group.duplicates.map(toAbs)),
      };
    };
    const resolvedGroups = await Promise.all(body.groups.map(resolveGroup));

    const executeOutcome = await executeHardlinkGroups(
      { logDir: app.hardlinkLogDir, logger: app.appLogger },
      resolvedGroups,
      { confirmed: true },
    );

    // 响应路径转回 userPath（内部 absPath 绝不进 API）
    const toUser = (absPath) => {
      const rel = path.relative(resolved.absPath, absPath).split(path.sep).join('/');
      const base = resolved.userPath === '/' ? '' : resolved.userPath.replace(/\/$/, '');
      return `${base}/${rel}`;
    };
    reply.ok({
      executed: executeOutcome.executed,
      savedBytes: executeOutcome.savedBytes,
      failed: executeOutcome.failed.map((item) => ({ duplicate: toUser(item.duplicate), code: item.code })),
      skippedGroups: executeOutcome.skippedGroups.map((item) => ({ master: toUser(item.master), reason: item.reason })),
    });
  });
}

