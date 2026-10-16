// 单条目详情（M1：GET /api/v1/fs/stat）
//
// 与 list 共用同一套白名单（core/fs/safePath.js），因此不存在"list 安全、stat 漏了"的缺口。
// 目录额外返回 childCount（只数一层，用于前端"进入前先看有多少项"）。

import fs from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError, toApiError } from '../../lib/errors.js';
import { ROOT_USER_PATH, resolveRequestPath } from './safePath.js';

/** 入口类型判定（不跟随符号链接） */
function entryType(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/**
 * 取单条目详情。
 * @param {{rootAbs: string, maxPathLength?: number}} ctx
 * @param {string} rawPath 用户路径（必须存在；根路径也可，返回存储根本身的信息）
 */
export async function statEntry(ctx, rawPath) {
  const { userPath, realPath } = await resolveRequestPath(
    {
      rootAbs: ctx.rootAbs,
      maxPathLength: ctx.maxPathLength,
      maxPathSegmentLength: ctx.maxPathSegmentLength,
    },
    rawPath,
  );

  let stat;
  try {
    stat = await fs.lstat(realPath);
  } catch (error) {
    throw toApiError(error);
  }

  const type = entryType(stat);
  const entry = {
    name: userPath === ROOT_USER_PATH ? '/' : path.basename(userPath),
    path: userPath,
    type,
    size: type === 'file' ? stat.size : 0,
    mtime: Math.trunc(stat.mtimeMs),
    readable: true,
    extension: type === 'file' ? path.extname(userPath) : '',
    enterable: type === 'dir',
  };

  try {
    await fs.access(realPath, fs.constants.R_OK);
  } catch {
    entry.readable = false;
  }

  if (type === 'symlink') {
    try {
      const target = await fs.stat(realPath); // 跟随链接（白名单已校验过 realpath）
      entry.enterable = target.isDirectory();
      entry.linkTarget = await fs.readlink(realPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        entry.enterable = false;
        entry.broken = true;
      } else {
        throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '符号链接无法解析', { path: userPath });
      }
    }
  }

  if (type === 'dir') {
    try {
      const children = await fs.readdir(realPath);
      entry.childCount = children.length;
    } catch (error) {
      throw toApiError(error);
    }
  }

  return entry;
}
