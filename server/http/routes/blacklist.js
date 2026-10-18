// 黑名单端点（docs/M0/API规范.md §4.5，形状严格照契约，不自创字段）
//
// - GET  /blacklist            三层读取（global / user / effectiveCount）
// - PUT  /blacklist/user       用户层全量替换（幂等；校验单条 ≤128、总数 ≤200、拒绝对路径与 /）
// - POST /blacklist/preview    { paths[], extraPatterns[] } → data.skipped[{path,pattern,layer}] + data.kept[]
//
// 三个端点都需要登录（黑名单属于用户设置）；匹配与判定全在服务端（docs/09 §五）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { matchEntry } from '../../core/compress/blacklist.js';
import { collectFilesUnder } from '../../core/compress/sourceWalk.js';

/**
 * 单个源的预览：返回该源命中的文件与"是否还有可压的文件"。
 * 抽出来是为了让路由本体只做"解析参数 → 逐个源调用 → 拼响应"（单函数不超 50 行）。
 */
async function previewOneSource(app, rawPath, layers) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'paths 里每一项都必须是非空字符串');
  }
  const resolved = await app.fsGuard.resolveReal(rawPath);
  const files = await collectFilesUnder(resolved.absPath);
  const skipped = [];
  let keptFiles = 0;
  for (const file of files) {
    const hit = matchEntry(layers, { name: file.name, segments: file.segments });
    if (hit) skipped.push({ path: joinUserPath(resolved.userPath, file.relative), pattern: hit.pattern, layer: hit.layer });
    else keptFiles += 1;
  }
  return { skipped, keptFiles, userPath: resolved.userPath, fileCount: files.length };
}

/**
 * 预览多源：解析参数 → 逐个源判定 → 汇总 skipped/kept。
 * 放在模块作用域（而非路由闭包里）是为了让路由表只做挂载，也让两段逻辑各自可读、可单测。
 */
async function previewManySources(app, body) {
  const rawPaths = body.paths;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'paths 必须是非空字符串数组');
  }

  const taskPatterns = Array.isArray(body.extraPatterns) ? body.extraPatterns : [];
  const layers = await app.blacklist.layersFor({ enabled: true, taskPatterns });
  const skipped = [];
  const kept = [];

  for (const rawPath of rawPaths) {
    const one = await previewOneSource(app, rawPath, layers);
    skipped.push(...one.skipped);
    // 空目录/不可读：不算"跳过"，如实放进 kept（真正原因由压缩预检去报）；
    // 有文件留下也算 kept；整源都被跳过时不放进 kept（前端据此提示"该目录没有可压缩文件"）
    if (one.fileCount === 0 || one.keptFiles > 0) kept.push(one.userPath);
  }

  return { skipped, kept };
}

export default async function blacklistRoutes(app) {
  /** 三层读取：global 恒 locked（不可改/不可删），user 来自 storage/blacklist-user.json */
  app.get('/blacklist', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await app.blacklist.snapshot());
  });

  /** 用户层全量替换（幂等）：契约 §4.5 的校验规则由 blacklist.validatePatterns 统一实现 */
  app.put('/blacklist/user', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const body = request.body || {};
    if (!Array.isArray(body.patterns)) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'patterns 必须是字符串数组');
    }
    try {
      const user = await app.blacklist.replaceUser({ patterns: body.patterns, enabled: body.enabled !== false });
      reply.ok({ user });
    } catch (error) {
      // validatePatterns 抛的是带 validation 标记的普通 Error：翻译成契约错误码
      throw apiError(ERROR_CODES.VALIDATION_FAILED, error.message);
    }
  });

  /**
   * 命中预览：压缩设置抽屉用它显示「X 个文件已跳过（已压缩格式）」。
   * 契约：data.skipped[] = { path, pattern, layer }（**userPath**，绝不带 absPath）；data.kept[] 只给路径。
   * 路径校验逐个走 fsGuard.resolveReal（与 fs 路由同一套白名单 + 符号链接复核）。
   */
  app.post('/blacklist/preview', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await previewManySources(app, request.body || {}));
  });
}

/** 用户路径拼接（POSIX 风格，避免 path.join 在 Windows 上换成反斜杠） */
function joinUserPath(base, relative) {
  if (!relative) return base;
  const prefix = base === '/' ? '' : base.replace(/\/$/, '');
  return `${prefix}/${relative}`;
}
