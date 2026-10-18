// 文件系统写操作（M8 前置）：mkdir / rename / move / delete
//
// 契约：docs/M0/API规范.md §4.2 的四个端点，形状严格照契约：
// - mkdir  幂等：已存在目录 → created:false；父目录不存在 → PATH_NOT_FOUND；同名文件占位 → TARGET_EXISTS
// - rename 仅同目录改名；newName 不含分隔符；冲突绝不覆盖（TARGET_EXISTS）
// - move   单次 ≤ limits.maxMoveItems；目标同名 → 整批拒绝（不做部分移动）；EXDEV → CROSS_DEVICE_UNSUPPORTED
// - delete **进回收站，不是真删**：统一走 core/compress/deleter.js（与 M5 删除原文件同一机制），
//          返回 trashBatch，可恢复；不存在的路径计入 notFound，整体仍 ok
//
// 安全：所有路径都经 safePath 白名单（resolveRequestPath，含符号链接复核），绝不直接用请求里的字符串拼路径。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { parentUserPath, resolveRequestPath } from './safePath.js';

/** rename 的新名字不允许出现的字符（分隔符与 NUL） */
const FORBIDDEN_NAME_CHARS = /[/\\\0]/;

/** 目标是否已存在（lstat；符号链接也算占用，绝不覆盖） */
async function targetExists(absPath) {
  try {
    await fsp.lstat(absPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 解析"要创建的目标"：目标本身可能不存在，所以校验的是**父目录的真实路径**（父目录的符号链接
 * 也不能指向根外），再把 basename 拼回去 —— 既守住白名单，又不会把合法的 mkdir 判死。
 * @returns {{parentAbs: string, targetAbs: string}}
 */
async function resolveCreateTarget(ctx, userPath, absPath) {
  const parentUser = parentUserPath(userPath);
  if (parentUser === null) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, '不能在存储根上再建根目录');
  }
  const parent = await resolveRequestPath(ctx, parentUser);
  const parentStat = await fsp.lstat(parent.realPath).catch(() => null);
  if (!parentStat || !parentStat.isDirectory()) {
    throw apiError(ERROR_CODES.PATH_NOT_FOUND, '父目录不存在', { path: userPath });
  }
  return { parentAbs: parent.realPath, targetAbs: path.join(parent.realPath, path.basename(absPath)) };
}

/**
 * POST /fs/mkdir
 * @param {object} ctx fsContext（rootAbs 等）
 * @param {{path?: string}} body
 */
export async function makeDirectory(ctx, body) {
  if (typeof body.path !== 'string' || body.path.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必填');
  }
  // 目标本身可以不存在（这正是 mkdir 的场景），所以 mustExist:false；真正的越界防护在下面的父目录解析
  const { userPath, absPath } = await resolveRequestPath(ctx, body.path, { mustExist: false });

  const { parentAbs, targetAbs } = await resolveCreateTarget(ctx, userPath, absPath);

  const existing = await fsp.lstat(targetAbs).catch(() => null);
  if (existing) {
    if (existing.isDirectory()) return { path: userPath, created: false }; // 幂等
    throw apiError(ERROR_CODES.TARGET_EXISTS, '同名文件已存在', { path: userPath });
  }

  try {
    await fsp.mkdir(targetAbs);
  } catch (error) {
    if (error.code === 'EEXIST') return { path: userPath, created: false };
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw apiError(ERROR_CODES.PERMISSION_DENIED, '没有权限创建目录', { path: userPath });
    }
    throw error;
  }
  return { path: userPath, created: true };
}

/** 新名字合法性（空/含分隔符/过长都在进磁盘前拦，避免冒成 500） */
function assertValidName(newName, ctx) {
  if (typeof newName !== 'string' || newName.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'newName 必填');
  }
  if (FORBIDDEN_NAME_CHARS.test(newName)) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'newName 不能包含路径分隔符', { newName });
  }
  if (newName.length > ctx.maxPathSegmentLength) {
    throw apiError(ERROR_CODES.INVALID_PATH, 'newName 超过单个路径段长度上限', { newName });
  }
}

/**
 * POST /fs/rename（仅同目录改名，绝不覆盖）
 * @returns {{path: string, oldPath: string}}
 */
export async function renameEntry(ctx, body) {
  if (typeof body.path !== 'string' || body.path.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必填');
  }
  assertValidName(body.newName, ctx);

  const { userPath, realPath } = await resolveRequestPath(ctx, body.path);
  // 目标由"源的真实父目录 + 已校验的新名字"组成：不存在的目标**不能**再走 realpath 校验
  // （那会把合法的改名判成 PATH_NOT_FOUND）；安全边界由源的真实路径 + newName 非法字符校验兜住。
  const targetAbs = path.join(path.dirname(realPath), body.newName);

  if (await targetExists(targetAbs)) {
    throw apiError(ERROR_CODES.TARGET_EXISTS, '目标名称已存在（不会覆盖）', { newName: body.newName });
  }
  const sourceStat = await fsp.lstat(realPath).catch(() => null);
  if (!sourceStat) throw apiError(ERROR_CODES.PATH_NOT_FOUND, '源路径不存在', { path: userPath });

  try {
    await fsp.rename(realPath, targetAbs);
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw apiError(ERROR_CODES.PERMISSION_DENIED, '没有权限改名', { path: userPath });
    }
    throw error;
  }
  return {
    path: path.posix.join(path.posix.dirname(userPath), body.newName),
    oldPath: userPath,
  };
}

/**
 * 整批校验：源都存在、目标目录内没有同名项（契约：目标同名整批拒绝，不做部分移动）。
 * 与执行分开是为了让"先验证后动手"这件事一眼可见。
 */
async function planMoves(ctx, body) {
  const target = await resolveRequestPath(ctx, body.targetDir);
  const targetStat = await fsp.lstat(target.absPath).catch(() => null);
  if (!targetStat || !targetStat.isDirectory()) {
    throw apiError(ERROR_CODES.PATH_NOT_FOUND, '目标目录不存在', { targetDir: body.targetDir });
  }

  const plans = [];
  for (const rawPath of body.paths) {
    const source = await resolveRequestPath(ctx, rawPath);
    const destAbs = path.join(target.realPath, path.basename(source.realPath));
    if (destAbs === source.realPath) {
      throw apiError(ERROR_CODES.TARGET_EXISTS, '源与目标相同', { path: source.userPath });
    }
    if (await targetExists(destAbs)) {
      throw apiError(ERROR_CODES.TARGET_EXISTS, '目标目录已有同名项（整批取消）', { path: source.userPath, name: path.basename(destAbs) });
    }
    plans.push({ source, destAbs, destUser: path.posix.join(target.userPath, path.basename(destAbs)) });
  }
  return plans;
}

/** 单个 rename；错误码翻译集中在这里 */
async function moveOne(plan) {
  try {
    await fsp.rename(plan.source.realPath, plan.destAbs);
  } catch (error) {
    if (error.code === 'EXDEV') {
      // 契约：跨分区不支持移动，提示改用"复制 + 删除原文件"
      throw apiError(ERROR_CODES.CROSS_DEVICE_UNSUPPORTED, '跨分区移动不支持，请改用「复制 + 删除原文件」', {
        path: plan.source.userPath,
      });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw apiError(ERROR_CODES.PERMISSION_DENIED, '没有权限移动', { path: plan.source.userPath });
    }
    throw error;
  }
}

/**
 * POST /fs/move（同步；目标同名整批拒绝，避免"搬了一半"）
 * @returns {{moved: string[], skipped: string[]}}
 */
export async function moveEntries(ctx, body) {
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'paths 必须是非空字符串数组');
  }
  if (body.paths.length > ctx.maxMoveItems) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, `单次最多移动 ${ctx.maxMoveItems} 项`, { count: body.paths.length });
  }
  if (typeof body.targetDir !== 'string' || body.targetDir.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'targetDir 必填');
  }

  const plans = await planMoves(ctx, body);
  const moved = [];
  for (const plan of plans) {
    await moveOne(plan);
    moved.push(plan.destUser);
  }
  return { moved, skipped: [] };
}

/**
 * POST /fs/delete（进回收站；复用 deleter，与 M5 删除原文件同一机制）
 * @param {object} ctx fsContext
 * @param {{paths?: string[]}} body
 * @param {{deleter: object, maxDeleteItems: number}} deps
 */
export async function deleteEntries(ctx, body, deps) {
  if (!Array.isArray(body.paths) || body.paths.length === 0) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, 'paths 必须是非空字符串数组');
  }
  if (body.paths.length > deps.maxDeleteItems) {
    throw apiError(ERROR_CODES.VALIDATION_FAILED, `单次最多删除 ${deps.maxDeleteItems} 项`, { count: body.paths.length });
  }

  const targets = [];
  const notFound = [];
  for (const rawPath of body.paths) {
    let resolved;
    try {
      resolved = await resolveRequestPath(ctx, rawPath);
    } catch (error) {
      // 契约：路径不存在不算失败，记在 notFound（幂等）。
      // 但**不能**因此跳过越界校验：先对父目录做严格解析，父目录越界仍然抛 PATH_OUT_OF_ROOT。
      if (!error || error.code !== ERROR_CODES.PATH_NOT_FOUND) throw error;
      const shape = path.posix.normalize(String(rawPath));
      const parentUser = path.posix.dirname(shape);
      await resolveRequestPath(ctx, parentUser === '.' ? '/' : parentUser); // 越界在这里抛
      notFound.push({ path: shape.startsWith('/') ? shape : `/${shape}`, missing: true });
      continue;
    }
    const stat = await fsp.lstat(resolved.absPath).catch(() => null);
    if (!stat) {
      notFound.push({ path: resolved.userPath, missing: true });
      continue;
    }
    targets.push({ userPath: resolved.userPath, absPath: resolved.absPath, size: stat.isDirectory() ? null : stat.size });
  }

  if (targets.length === 0) {
    return { deleted: [], failed: [], notFound, trashBatch: null };
  }

  const outcome = await deps.deleter.deleteTargets({
    targets,
    kind: 'manual',
    reason: 'fs_delete',
    // 手动删除显式走回收站：log-only 只记账（那是压缩后自动删除的安全默认），
    // 用在用户主动点"删除"的路径上会表现为"点了没反应"。回收站仍可恢复。
    mode: 'trash',
    // 手动删除没有"压缩成功"这个前置条件；二次确认由前端负责
    taskId: null,
  });

  const deleted = (outcome.deleted || []).map((entry) => (entry.path || entry.userPath || entry));
  const failed = (outcome.failed || []).map((entry) => ({ path: entry.path || entry.userPath, code: entry.code || ERROR_CODES.INTERNAL_ERROR }));
  // mode=log-only 时 deleter 只记账不动文件：如实返回 trashBatch=null，不假装已进回收站
  return { deleted, failed, notFound, trashBatch: outcome.batchId || null };
}
