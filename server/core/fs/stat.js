// 单条目详情（M1：GET /api/v1/fs/stat）
//
// 与 list 共用同一套白名单（core/fs/safePath.js），因此不存在"list 安全、stat 漏了"的缺口。
// 目录额外返回 childCount（只数一层，用于前端"进入前先看有多少项"）。
//
// 结构：基础字段 → 符号链接补充 → 目录补充，三步各一小函数；
// statEntry 只负责串起来，不再把三类信息混在一个函数里。

import fs from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError, toApiError } from '../../lib/errors.js';
import { matchEntry } from '../compress/blacklist.js';
import { ROOT_USER_PATH, resolveRequestPath } from './safePath.js';

/** 入口类型判定（不跟随符号链接） */
function entryType(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** 基础字段（含可读性探测） */
async function buildBaseEntry(userPath, realPath, stat) {
  const type = entryType(stat);
  let readable = true;
  try {
    await fs.access(realPath, fs.constants.R_OK);
  } catch {
    readable = false;
  }
  return {
    name: userPath === ROOT_USER_PATH ? '/' : path.basename(userPath),
    path: userPath,
    type,
    size: type === 'file' ? stat.size : 0,
    mtime: Math.trunc(stat.mtimeMs),
    readable,
    extension: type === 'file' ? path.extname(userPath) : '',
    enterable: type === 'dir',
  };
}

/** 符号链接补充：跟随链接判定可进入性，并给出链接目标（悬空链接标记 broken） */
async function applySymlinkInfo(entry, realPath, userPath) {
  try {
    const target = await fs.stat(realPath); // 跟随链接（白名单已校验过 realpath）
    entry.enterable = target.isDirectory();
    entry.linkTarget = await fs.readlink(realPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      entry.enterable = false;
      entry.broken = true;
      return;
    }
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '符号链接无法解析', { path: userPath });
  }
}

/** 目录补充：只数一层子项数量 */
async function applyDirInfo(entry, realPath) {
  try {
    const children = await fs.readdir(realPath);
    entry.childCount = children.length;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * 取单条目详情。
 * @param {{rootAbs: string, maxPathLength?: number}} ctx
 * @param {string} rawPath 用户路径（必须存在；根路径也可，返回存储根本身的信息）
 */
/**
 * 单条目详情。
 * @param {object} ctx fsContext
 * @param {string} rawPath 用户路径
 * @param {{blacklistLayers?: Array}} [options] 黑名单层（契约 §4.2：blacklisted/blacklistLayer 由服务端算）
 */
export async function statEntry(ctx, rawPath, options = {}) {
  const { userPath, realPath } = await resolveRequestPath(
    {
      rootAbs: ctx.rootAbs,
      maxPathLength: ctx.maxPathLength,
      maxPathSegmentLength: ctx.maxPathSegmentLength,
    },
    rawPath,
  );

  let fileStat;
  try {
    fileStat = await fs.lstat(realPath);
  } catch (error) {
    throw toApiError(error);
  }

  const entry = await buildBaseEntry(userPath, realPath, fileStat);
  if (entry.type === 'symlink') await applySymlinkInfo(entry, realPath, userPath);
  if (entry.type === 'dir') await applyDirInfo(entry, realPath);

  const layers = Array.isArray(options.blacklistLayers) ? options.blacklistLayers : [];
  const hit = layers.length > 0
    ? matchEntry(layers, { name: path.basename(userPath), segments: userPath.split('/').filter(Boolean) })
    : null;
  entry.blacklisted = Boolean(hit);
  entry.blacklistLayer = hit ? hit.layer : null;
  return entry;
}
