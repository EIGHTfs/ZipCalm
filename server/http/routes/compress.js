// 压缩 / 解压 / 任务 路由（M2）
//
// 契约：docs/M0/API规范.md §3.3 端点总表 + §4.3 压缩与任务
// - 压缩与解压**共用**任务查询/取消/确认删除（`/tasks/{id}/...`），`/compress/tasks/{id}/...` 只是别名；
// - 所有入参路径都过 `app.guardPath` / `fsGuard`（INV-06），业务层再用 core 复算一遍（defense in depth）；
// - 创建任务前先跑预检：预检不通过**不建任务**（避免"排队后秒失败"的噪音任务）。

import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { defaultExtractDir } from '../../core/compress/orchestrator.js';

/** 查询串/请求体里的布尔值解析 */
function toBool(value, fallback = false) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return fallback;
}

export default async function compressRoutes(app) {
  const { registry, manager, orchestrator, config } = app.m2;

  const auth = { preHandler: [app.requireAuth] };

  // ===== 格式列表（UI 置灰依据）=====
  app.get('/formats', auth, async (request, reply) => {
    reply.ok({ formats: await registry.list() });
  });

  // ===== 压缩预检 =====
  app.post('/compress/preflight', auth, async (request, reply) => {
    const body = request.body || {};
    const sources = await resolveSources(app, body.sources);
    const format = String(body.format || config.compress.defaultFormat);
    const mode = String(body.mode || config.compress.defaultMode);
    if (!['single', 'bundle'].includes(mode)) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'mode 只能是 single 或 bundle', { mode });
    }
    const outputDirAbs = body.options && body.options.outputDir
      ? (await resolveDirForWrite(app, body.options.outputDir, { allowRoot: true })).absPath
      : path.dirname(sources[0].absPath);

    const result = await compressPreflightFor(app, sources, format, mode, outputDirAbs);
    reply.ok(result);
  });

  // ===== 创建压缩任务 =====
  app.post('/compress/tasks', auth, async (request, reply) => {
    const body = request.body || {};
    const sources = await resolveSources(app, body.sources);
    const format = String(body.format || config.compress.defaultFormat);
    const mode = String(body.mode || config.compress.defaultMode);
    if (!['single', 'bundle'].includes(mode)) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'mode 只能是 single 或 bundle', { mode });
    }
    if (sources.length > config.limits.maxSourcesPerTask) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, `一次最多 ${config.limits.maxSourcesPerTask} 个源`, { count: sources.length });
    }

    const options = body.options || {};
    const outputDirAbs = options.outputDir
      ? (await resolveDirForWrite(app, options.outputDir, { allowRoot: true })).absPath
      : path.dirname(sources[0].absPath);

    // 预检不通过 → 直接报错，不建任务（DISK_FULL 等错误码由预检给出）
    const preflight = await compressPreflightFor(app, sources, format, mode, outputDirAbs);
    if (!preflight.canProceed) {
      throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
    }
    if (!(await registry.isAvailable(format))) {
      throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${format} 当前不可用`);
    }

    // 预检已把目录展开成 size/fileCount，直接用于进度分母
    const enriched = sources.map((source, index) => ({
      ...source,
      size: preflight.items[index] ? preflight.items[index].size : 0,
      fileCount: preflight.items[index] ? preflight.items[index].fileCount : 0,
    }));

    const task = manager.create({
      kind: 'compress',
      mode,
      format,
      sources: enriched,
      options: {
        level: Number.isInteger(options.level) ? options.level : config.compress.defaultLevel,
        keepOriginal: options.keepOriginal !== false,
        deleteConfirmed: options.deleteConfirmed === true,
        bundle: mode === 'bundle',
      },
      // 绝对路径只走 internal（不会出现在 API 响应里）
      internal: { outputDirAbs },
    });

    manager.enqueue(task.id, (record) => orchestrator.runCompress(record));
    reply.ok({ task: manager.get(task.id) }, 201);
  });

  // ===== 解压预检 =====
  app.post('/extract/preflight', auth, async (request, reply) => {
    const body = request.body || {};
    const archive = await app.fsGuard.resolveReal(body.path);
    const stat = await fsStat(archive.realPath);
    if (!stat.isFile()) {
      throw apiError(ERROR_CODES.NOT_A_DIRECTORY, '解压目标必须是文件', { path: archive.userPath });
    }
    const targetAbsDir = body.targetDir ? null : await defaultExtractDir(archive.realPath);
    const plugin = pluginForArchive(app, archive.userPath);
    const target = body.targetDir
      ? await resolveDirForWrite(app, body.targetDir)
      : { userPath: relUserPath(app, targetAbsDir), absPath: targetAbsDir };

    const result = await extractPreflightFor(app, plugin, archive, target.absPath, target.userPath);
    reply.ok(result);
  });

  // ===== 创建解压任务 =====
  app.post('/extract/tasks', auth, async (request, reply) => {
    const body = request.body || {};
    const archive = await app.fsGuard.resolveReal(body.path);
    const stat = await fsStat(archive.realPath);
    if (!stat.isFile()) {
      throw apiError(ERROR_CODES.NOT_A_DIRECTORY, '解压目标必须是文件', { path: archive.userPath });
    }
    const plugin = pluginForArchive(app, archive.userPath);
    const targetAbsDir = body.targetDir ? null : await defaultExtractDir(archive.realPath);
    const target = body.targetDir
      ? await resolveDirForWrite(app, body.targetDir)
      : { userPath: relUserPath(app, targetAbsDir), absPath: targetAbsDir };

    const preflight = await extractPreflightFor(app, plugin, archive, target.absPath, target.userPath);
    if (!preflight.canProceed) {
      throw apiError(preflight.blockedReason.code, preflight.blockedReason.message);
    }
    if (!(await registry.isAvailable(plugin.id))) {
      throw apiError(ERROR_CODES.FORMAT_UNAVAILABLE, `格式 ${plugin.id} 当前不可用`);
    }

    const options = body.options || {};
    const task = manager.create({
      kind: 'extract',
      mode: 'bundle',
      format: plugin.id,
      sources: [],
      archivePath: archive.userPath,
      targetDir: target.userPath,
      // 绝对路径只走 internal（不泄漏到 API 响应）
      internal: { archiveAbsPath: archive.realPath, targetAbsDir: target.absPath },
      options: {
        deleteArchiveAfterExtract: options.deleteArchiveAfterExtract === true,
        deleteConfirmed: options.deleteConfirmed === true,
      },
    });

    manager.enqueue(task.id, (record) => orchestrator.runExtract(record));
    reply.ok({ task: manager.get(task.id) }, 201);
  });

  // ===== 任务查询 / 列表 =====
  app.get('/tasks', auth, async (request, reply) => {
    const status = typeof request.query.status === 'string' && request.query.status.length > 0
      ? request.query.status.split(',').map((item) => item.trim())
      : null;
    const limit = Number.parseInt(request.query.limit, 10);
    reply.ok(manager.list({ status, limit: Number.isInteger(limit) ? limit : 50 }));
  });

  app.get('/tasks/:id', auth, async (request, reply) => {
    const task = manager.get(request.params.id);
    if (!task) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: request.params.id });
    reply.ok({ task });
  });

  // 别名（契约 §3.3：/compress/tasks/{id} 转发到 /tasks/{id}，避免两份实现）
  app.get('/compress/tasks/:id', auth, async (request, reply) => {
    const task = manager.get(request.params.id);
    if (!task) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: request.params.id });
    reply.ok({ task });
  });

  // ===== 取消 =====
  const cancelHandler = async (request, reply) => {
    const task = manager.cancel(request.params.id);
    reply.ok({ task });
  };
  app.post('/tasks/:id/cancel', auth, cancelHandler);
  app.post('/compress/tasks/:id/cancel', auth, cancelHandler);

  // ===== 二次确认删除（**压缩删原文件 / 解压删压缩包共用**）=====
  const confirmDeleteHandler = async (request, reply) => {
    const id = request.params.id;
    const task = manager.get(id);
    if (!task) throw apiError(ERROR_CODES.TASK_NOT_FOUND, '任务不存在', { taskId: id });
    if (!task.delete) throw apiError(ERROR_CODES.INVALID_STATE, '该任务没有待删除目标', { taskId: id });
    if (task.phase !== 'waiting_confirm') {
      throw apiError(ERROR_CODES.INVALID_STATE, '当前不是待确认状态', { phase: task.phase });
    }

    const body = request.body || {};
    if (body.confirm === false) {
      manager.resolveConfirm(id, { confirmed: false });
      reply.ok({ task: manager.get(id) });
      return;
    }

    // 数量/字节比对（INV-03：弹窗数字与实际不一致就拒绝删除）
    const expectedFiles = Number.isInteger(body.expectedFiles) ? body.expectedFiles : null;
    const expectedBytes = Number.isFinite(body.expectedBytes) ? body.expectedBytes : null;
    const actualFiles = task.delete.targets.length;
    const actualBytes = task.delete.targets.reduce((sum, target) => sum + (Number(target.sizeBytes) || 0), 0);
    if (expectedFiles !== null && expectedFiles !== actualFiles) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, '待删除数量与弹窗不一致，已拒绝删除', { expectedFiles, actualFiles });
    }
    if (expectedBytes !== null && Math.abs(expectedBytes - actualBytes) > 1) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, '待删除字节数与弹窗不一致，已拒绝删除', { expectedBytes, actualBytes });
    }

    manager.resolveConfirm(id, { confirmed: true, expectedFiles, expectedBytes });
    reply.ok({ task: manager.get(id) });
  };

  app.post('/tasks/:id/confirm-delete', auth, confirmDeleteHandler);
  app.post('/compress/tasks/:id/confirm-delete', auth, confirmDeleteHandler);
}

// ===== 内部工具（保持路由层"薄"：解析入参 + 调 core）=====

import fsp from 'node:fs/promises';

import { compressPreflight, extractPreflight } from '../../core/compress/preflight.js';

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

async function compressPreflightFor(app, sources, format, mode, outputDirAbs) {
  const result = await compressPreflight({ config: app.m2.config, rootAbs: app.fsContext.rootAbs }, {
    sources,
    format,
    mode,
    outputDir: outputDirAbs,
  });
  return result;
}

/** 归档 → 格式包（按扩展名匹配；匹配不到报 UNSUPPORTED_FORMAT） */
function pluginForArchive(app, userPath) {
  const plugin = app.m2.registry.byExtension(path.extname(userPath));
  if (!plugin) {
    throw apiError(ERROR_CODES.UNSUPPORTED_FORMAT, '不支持的压缩包格式', { path: userPath });
  }
  return plugin;
}

async function extractPreflightFor(app, plugin, archive, targetAbsDir, targetUserPath) {
  return extractPreflight({ config: app.m2.config, plugin }, {
    archivePath: archive.userPath,
    archiveAbsPath: archive.realPath,
    targetDir: targetUserPath,
    targetAbsDir,
  });
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
