// 路径白名单（M1 的安全红线，对应 docs/M0/不变量清单.md ⭐INV-06）
//
// 契约（docs/M0/API规范.md §一）：API 收到的 `path` 一律是「相对存储根的 POSIX 路径」，根为 `/`。
// 本模块负责把它变成**进程内可用的原生绝对路径**，并保证永远落在存储根之内。
//
// 三层防护（缺一不可）：
//   ① 形态校验：拒绝 null 字节、超长、以及任何 `..` 段（含百分号编码后的 `..`）；
//   ② 归一化 + 前缀校验：path.resolve(root, ...segments) 后必须 === root 或以 root + 分隔符 开头
//      —— 必须带分隔符比较，否则 /data-evil 会被 /data 放行（docs/10 §七 记录过的真实缺陷）；
//   ③ realpath 二次校验：解析符号链接后再比一次，防止 root 内的链接指向 root 之外。
//
// 参考实现：docs/10 §二.3 `safePath.ts:35-53`（拆段拒绝 .. + startsWith 校验）、
//           `cloudcmd/server/root.js:8-18`（越界即 throw）。

import fs from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError, toApiError } from '../../lib/errors.js';

/** API 里的根路径写法 */
export const ROOT_USER_PATH = '/';

/** 安全解码一个路径段（解码失败就按原样处理，不抛错） */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * 校验并归一化用户路径（纯函数，不碰文件系统）。
 * @param {unknown} raw 原始 path 参数
 * @param {{maxPathLength?: number, maxPathSegmentLength?: number}} [options]
 *        —— 两个上限都来自配置（server/config/defaults.js 的 limits），不写死
 * @returns {{userPath: string, segments: string[]}} 归一化后的 API 路径（以 / 开头）
 */
export function normalizeUserPath(raw, options = {}) {
  const maxPathLength = options.maxPathLength || 4096;
  const maxPathSegmentLength = options.maxPathSegmentLength || 255;

  if (typeof raw !== 'string' || raw.length === 0) {
    throw apiError(ERROR_CODES.INVALID_PATH, 'path 不能为空');
  }
  if (raw.length > maxPathLength) {
    throw apiError(ERROR_CODES.INVALID_PATH, `path 超过长度上限（${maxPathLength}）`, { length: raw.length });
  }

  // 统一分隔符：Windows 风格反斜杠按 / 处理，避免 ..\..\ 之类绕过
  const unified = raw.replace(/\\/g, '/');
  if (unified.includes('\0')) {
    throw apiError(ERROR_CODES.INVALID_PATH, 'path 包含非法字符（null 字节）');
  }

  const segments = unified.split('/').filter((segment) => segment !== '' && segment !== '.');

  for (const segment of segments) {
    // ① 单段长度上限（可配）：在进入任何磁盘调用**之前**就拦掉，
    //    否则底层会抛 ENAMETOOLONG，容易冒成 500（真实修复的 bug）。
    //    用字节数比较：POSIX NAME_MAX 是字节上限，不是字符数（中文目录名一字 3 字节）。
    const segmentBytes = Buffer.byteLength(segment, 'utf8');
    if (segmentBytes > maxPathSegmentLength) {
      throw apiError(ERROR_CODES.INVALID_PATH, `path 单段超过长度上限（${maxPathSegmentLength} 字节）`, {
        segmentBytes,
        limit: maxPathSegmentLength,
      });
    }

    // ② 明文 ..
    if (segment === '..') {
      throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, 'path 不允许包含上级目录引用（..）', { segment });
    }
    // ③ 编码形态（%2e%2e / 双重编码）：解一次码后仍可能是 .. 或再次带 .. 的形式
    const decoded = decodeSegment(segment);
    if (decoded === segment) continue;
    if (decoded.includes('\0')) {
      throw apiError(ERROR_CODES.INVALID_PATH, 'path 包含非法字符（编码后的 null 字节）');
    }
    const decodedParts = decoded.split(/[\\/]/);
    if (decodedParts.includes('..')) {
      throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, 'path 包含编码后的上级目录引用（..）', { segment, decoded });
    }
  }

  return { userPath: `${ROOT_USER_PATH}${segments.join('/')}`, segments };
}

/**
 * 把用户路径解析为存储根内的绝对路径（同步、纯计算 + 前缀校验）。
 * @param {string} rootAbs 存储根（绝对路径）
 * @param {unknown} raw 用户路径
 * @param {{maxPathLength?: number}} [options]
 * @returns {{userPath: string, absPath: string, rootAbs: string}}
 */
export function resolveWithinRoot(rootAbs, raw, options = {}) {
  const root = path.resolve(rootAbs);
  const { userPath, segments } = normalizeUserPath(raw, options);

  // 关键：用 resolve(root, ...segments)，而不是 resolve(原始输入)——
  // 绝对路径输入（如 /etc/passwd）已被拆成段，因此只会落在 root 之下，永远不会解析到系统路径。
  const absPath = path.resolve(root, ...segments);

  // 前缀校验必须带路径分隔符（防止 /data-evil 被 /data 放行）
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, 'path 超出可访问范围', { userPath, absPath });
  }

  return { userPath, absPath, rootAbs: root };
}

/**
 * 解析符号链接后的二次校验（INV-06 第 9 条）。
 * @param {string} rootAbs 存储根
 * @param {string} absPath 已经过 resolveWithinRoot 的绝对路径
 * @param {{mustExist?: boolean}} [options] mustExist=false 时不存在则原样返回
 * @returns {Promise<string>} 真实路径（或原路径）
 */
export async function assertRealPathWithinRoot(rootAbs, absPath, options = {}) {
  const mustExist = options.mustExist !== false;
  const root = path.resolve(rootAbs);

  let realPath;
  try {
    realPath = await fs.realpath(absPath);
  } catch (error) {
    if (!mustExist && error && error.code === 'ENOENT') return absPath;
    throw toApiError(error);
  }

  // root 自身也可能是个符号链接（NAS 上常见），所以两边都取 realpath 再比
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    realRoot = root;
  }

  if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
    throw apiError(ERROR_CODES.PATH_OUT_OF_ROOT, '符号链接指向存储根之外', { absPath, realPath });
  }
  return realPath;
}

/**
 * 一步到位：用户路径 → 白名单内的真实绝对路径（REST 路由最常用）。
 * @param {{rootAbs: string, maxPathLength?: number}} ctx
 * @param {unknown} raw
 * @param {{mustExist?: boolean}} [options]
 */
export async function resolveRequestPath(ctx, raw, options = {}) {
  const { userPath, absPath } = resolveWithinRoot(ctx.rootAbs, raw, {
    maxPathLength: ctx.maxPathLength,
    maxPathSegmentLength: ctx.maxPathSegmentLength,
  });
  const realPath = await assertRealPathWithinRoot(ctx.rootAbs, absPath, options);
  return { userPath, absPath, realPath };
}

/** 由 API 路径取父路径（根返回 null），供前端面包屑/返回上级 */
export function parentUserPath(userPath) {
  if (!userPath || userPath === ROOT_USER_PATH) return null;
  const parent = path.posix.dirname(userPath);
  return parent === '.' ? ROOT_USER_PATH : parent;
}

/** 把绝对路径转回 API 用户路径（绝对路径只允许出现在进程内部） */
export function toUserPath(rootAbs, absPath) {
  const root = path.resolve(rootAbs);
  const relative = path.relative(root, path.resolve(absPath));
  if (relative === '') return ROOT_USER_PATH;
  return `/${relative.split(path.sep).join('/')}`;
}
