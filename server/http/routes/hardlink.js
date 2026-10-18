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
    const result = await scanHardlinkDuplicates(resolved.absPath, extensions);

    // 响应路径统一转 userPath（绝对路径绝不进 API，INV-06 红线）
    const rootPrefix = resolved.absPath;
    const toUser = (absPath) => {
      const relative = path.posix.relative(rootPrefix.replaceAll(path.sep, '/'), absPath.replaceAll(path.sep, '/'));
      const base = resolved.userPath === '/' ? '' : resolved.userPath.replace(/\/$/, '');
      return `${base}/${relative}`;
    };
    const groups = result.groups.map((group) => ({
      ...group,
      master: toUser(group.master),
      duplicates: group.duplicates.map(toUser),
    }));

    reply.ok({
      path: resolved.userPath,
      extensions,
      groups,
      stats: result.stats,
    });
  });

  /**
   * 执行替换（批次②实现）。批次①先立参数与状态守卫：无显式 confirmed 一律 409。
   */
  app.post('/hardlink/execute', { preHandler: [app.requireAuth] }, async () => {
    throw apiError(ERROR_CODES.INVALID_STATE, '执行端点尚未开放（批次②实现）；扫描请用 POST /hardlink/scan');
  });
}

