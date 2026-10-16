// 压缩 / 解压 / 任务 路由（M2）
//
// 契约：docs/M0/API规范.md §3.3 端点总表 + §4.3 压缩与任务
// - 压缩与解压**共用**任务查询/取消/确认删除（`/tasks/{id}/...`），`/compress/tasks/{id}/...` 只是别名；
// - 所有入参路径都过 `app.fsGuard`（INV-06），业务层再用 core 复算一遍（defense in depth）；
// - 创建任务前先跑预检：预检不通过**不建任务**（避免"排队后秒失败"的噪音任务）。
//
// 结构：**每个端点一个 handler 函数**，参数解析单独抽出（parseCompressRequest / parseExtractRequest），
// 插件函数 compressRoutes 只做"路由表注册"这一件事。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { compressPreflight, extractPreflight } from '../../core/compress/preflight.js';
import { defaultExtractDir } from '../../core/compress/orchestrator.js';

const COMPRESS_MODES = ['single', 'bundle'];

// ===== 端点 handler =====

/** GET /formats —— 格式列表 + 可用性（UI 置灰依据） */
async function handleListFormats(app, request, reply) {
  reply.ok({ formats: await app.m2.registry.list() });
}

/** POST /compress/preflight —— 压缩预检（不建任务） */
async function handleCompressPreflight(app, request, reply) {
  const parsed = await parseCompressRequest(app, request.body || {});
  const result = await compressPreflightFor(app, parsed);
  reply.ok(result);
}

/** POST /compress/tasks —— 创建压缩任务（预检不通过则不建） */
async function handleCompressTaskCreate(app, request, reply) {
  const { manager, orchestrator, config } = app.m2;
  const parsed = await parseCompressRequest(app, request.body || {}, { enforceSourceLimit: true });

  const preflight = await compressPreflightFor(app, parsed);
  if (!preflight.canProceed) {
    throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
  }
  if (!(await app.m2.registry.isAvailable(parsed.format))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${parsed.format} 当前不可用`);
  }

  // 预检已把目录展开成 size/fileCount，直接用于进度分母
  const enriched = parsed.sources.map((source, index) => ({
    ...source,
    size: preflight.items[index] ? preflight.items[index].size : 0,
    fileCount: preflight.items[index] ? preflight.items[index].fileCount : 0,
  }));

  const task = await manager.create({
    kind: 'compress',
    mode: parsed.mode,
    format: parsed.format,
    sources: enriched,
    options: {
      level: Number.isInteger(parsed.options.level) ? parsed.options.level : config.compress.defaultLevel,
      keepOriginal: parsed.options.keepOriginal !== false,
      deleteConfirmed: parsed.options.deleteConfirmed === true,
      bundle: parsed.mode === 'bundle',
    },
    // 绝对路径只走 internal（不会出现在 API 响应里）
    internal: { outputDirAbs: parsed.outputDirAbs },
  });

  manager.enqueue(task.id, (record) => orchestrator.runCompress(record));
  reply.ok({ task: manager.get(task.id) }, 201);
}

/** POST /extract/preflight —— 解压预检（归档可读可解析 / 目标可写 / 空间） */
async function handleExtractPreflight(app, request, reply) {
  const parsed = await parseExtractRequest(app, request.body || {});
  const result = await extractPreflightFor(app, parsed);
  // 把"这个归档被识别成哪个格式"显式告诉前端：复合扩展名（x.tar.gz）的识别完全在服务端做，
  // 对话框据此展示，用户可一眼确认没被更短的 .gz 抢走
  reply.ok({ ...result, format: parsed.plugin.id, formatName: parsed.plugin.name });
}

/** POST /extract/tasks —— 创建解压任务 */
async function handleExtractTaskCreate(app, request, reply) {
  const { manager, orchestrator } = app.m2;
  const parsed = await parseExtractRequest(app, request.body || {});

  const preflight = await extractPreflightFor(app, parsed);
  if (!preflight.canProceed) {
    throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
  }
  if (!(await app.m2.registry.isAvailable(parsed.plugin.id))) {
    throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${parsed.plugin.id} 当前不可用`);
  }

  const task = await manager.create({
    kind: 'extract',
    mode: 'bundle',
    format: parsed.plugin.id,
    sources: [],
    archivePath: parsed.archive.userPath,
    targetDir: parsed.target.userPath,
    // 绝对路径只走 internal（不泄漏到 API 响应）
    internal: { archiveAbsPath: parsed.archive.realPath, targetAbsDir: parsed.target.absPath },
    options: {
      deleteArchiveAfterExtract: parsed.options.deleteArchiveAfterExtract === true,
      deleteConfirmed: parsed.options.deleteConfirmed === true,
    },
  });

  manager.enqueue(task.id, (record) => orchestrator.runExtract(record));
  reply.ok({ task: manager.get(task.id) }, 201);
}

// ===== 路由注册（只做接线；任务类端点统一在 routes/tasks.js）=====

export default async function compressRoutes(app) {
  const auth = { preHandler: [app.requireAuth] };
  const bind = (handler) => (request, reply) => handler(app, request, reply);

  app.get('/formats', auth, bind(handleListFormats));

  app.post('/compress/preflight', auth, bind(handleCompressPreflight));
  app.post('/compress/tasks', auth, bind(handleCompressTaskCreate));

  app.post('/extract/preflight', auth, bind(handleExtractPreflight));
  app.post('/extract/tasks', auth, bind(handleExtractTaskCreate));
}

// ===== 参数解析与内部工具（保持路由层"薄"：解析入参 + 调 core）=====

/** 校验并解析压缩请求（sources / format / mode / outputDir） */
async function parseCompressRequest(app, body, options = {}) {
  const { config } = app.m2;
  const sources = await resolveSources(app, body.sources);
  const format = String(body.format || config.compress.defaultFormat);
  const mode = String(body.mode || config.compress.defaultMode);

  if (!COMPRESS_MODES.includes(mode)) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'mode 只能是 single 或 bundle', { mode });
  }
  if (options.enforceSourceLimit && sources.length > config.limits.maxSourcesPerTask) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, `一次最多 ${config.limits.maxSourcesPerTask} 个源`, { count: sources.length });
  }

  const requestedOutputDir = body.options && body.options.outputDir;
  const outputDirAbs = requestedOutputDir
    ? (await resolveDirForWrite(app, requestedOutputDir, { allowRoot: true })).absPath
    : path.dirname(sources[0].absPath);

  return { sources, format, mode, outputDirAbs, options: body.options || {} };
}

/** 校验并解析解压请求（归档 + 目标目录 + 选项） */
async function parseExtractRequest(app, body) {
  const archive = await app.fsGuard.resolveReal(body.path);
  const stat = await fsStat(archive.realPath);
  if (!stat.isFile()) {
    throw apiError(ERROR_CODES.NOT_A_DIRECTORY, '解压目标必须是文件', { path: archive.userPath });
  }

  const plugin = pluginForArchive(app, archive.userPath);
  const target = body.targetDir
    ? await resolveDirForWrite(app, body.targetDir)
    : await defaultTarget(app, archive.realPath);

  return { archive, plugin, target, options: body.options || {} };
}

/** 未指定目标目录时：用"与压缩包同级的同名目录"（可能尚不存在） */
async function defaultTarget(app, archiveAbsPath) {
  const targetAbsDir = await defaultExtractDir(archiveAbsPath);
  return { userPath: relUserPath(app, targetAbsDir), absPath: targetAbsDir };
}

/** 把 body.sources（API 路径数组）解析成白名单内的实体 */
async function resolveSources(app, rawSources) {
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'sources 必须是非空数组');
  }
  const resolved = [];
  for (const raw of rawSources) {
    const { userPath, realPath } = await app.fsGuard.resolveReal(raw);
    resolved.push({
      path: userPath,
      userPath,
      absPath: realPath,
      name: userPath === '/' ? '/' : path.basename(userPath),
      kind: (await fsStat(realPath)).isDirectory() ? 'dir' : 'file',
    });
  }
  return resolved;
}

function fsStat(target) {
  return fsp.stat(target);
}

async function compressPreflightFor(app, parsed) {
  return compressPreflight(
    { config: app.m2.config, rootAbs: app.fsContext.rootAbs },
    {
      sources: parsed.sources,
      format: parsed.format,
      mode: parsed.mode,
      outputDir: parsed.outputDirAbs,
    },
  );
}

async function extractPreflightFor(app, parsed) {
  return extractPreflight(
    { config: app.m2.config, plugin: parsed.plugin },
    {
      archivePath: parsed.archive.userPath,
      archiveAbsPath: parsed.archive.realPath,
      targetDir: parsed.target.userPath,
      targetAbsDir: parsed.target.absPath,
    },
  );
}

/** 归档 → 格式包（按扩展名匹配；匹配不到报 UNSUPPORTED_FORMAT）
 *  注意：必须传**完整文件名/路径**而不是 path.extname() —— 复合扩展名如 `x.tar.gz` 的
 *  extname 只有 `.gz`，光看它匹配不到 `targz`（注册表按"整体后缀最长匹配"判定）。
 */
function pluginForArchive(app, userPath) {
  const plugin = app.m2.registry.byExtension(path.basename(userPath));
  if (!plugin) {
    throw apiError(ERROR_CODES.UNSUPPORTED_FORMAT, '不支持的压缩包格式', { path: userPath });
  }
  return plugin;
}

/** 绝对路径 → API 用户路径（内部路径不出 API） */
function relUserPath(app, absPath) {
  const root = app.fsContext.rootAbs;
  const relative = path.relative(root, absPath);
  if (relative === '') return '/';
  return `/${relative.split(path.sep).join('/')}`;
}

/**
 * 解析"写入用的目录"（outputDir / targetDir）：
 * - 允许目标**尚不存在**（解压目标、新建产物目录都会先给一个不存在的路径）；
 * - 先用 fsGuard.resolve 做形态 + 白名单前缀校验（不碰磁盘），
 *   再对**父目录**做 resolveReal（父目录必须存在，借此拦住 symlink 逃逸）。
 */
async function resolveDirForWrite(app, rawUserPath, options = {}) {
  const { userPath } = app.fsGuard.resolve(rawUserPath);
  if (userPath === '/') {
    if (options.allowRoot) return { userPath: '/', absPath: app.fsContext.rootAbs };
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'targetDir 不能是存储根目录', { path: userPath });
  }
  const parentUserPath = path.posix.dirname(userPath);
  const parent = await app.fsGuard.resolveReal(parentUserPath);
  const absPath = path.join(parent.realPath, path.posix.basename(userPath));
  if (!absPath.startsWith(parent.realPath + path.sep)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '目录超出可访问范围', { path: userPath });
  }
  return { userPath, absPath };
}
