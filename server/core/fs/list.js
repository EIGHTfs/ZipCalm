// 目录遍历（M1 的文件浏览核心）
//
// 约定（docs/12 §二：core/ 放业务、http/ 只做入口）：
// - 入参是「已解析好白名单的 ctx」+ 用户路径；
// - 出参是 API 规范 §4.2 的 list 载荷：{ path, parent, entries[], total, truncated }；
// - 一律用 fs.promises（异步，不阻塞事件循环）；符号链接不跟随，只用 lstat 取元信息。

import fs from 'node:fs/promises';
import path from 'node:path';

import { ERROR_CODES, apiError, toApiError } from '../../lib/errors.js';
import { ROOT_USER_PATH, parentUserPath, resolveRequestPath } from './safePath.js';

/** 并发上限：readable 探测这类"每条目一次系统调用"的操作要限流，避免几万条目打爆 IO */
const PROBE_CONCURRENCY = 32;

const SORT_KEYS = new Set(['name', 'size', 'mtime']);
const SORT_ORDERS = new Set(['asc', 'desc']);

/** 简易并发池：按 limit 分批执行 worker */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 判断条目是否可读（R_OK）；探测失败按不可读处理，不抛错 */
async function probeReadable(absPath) {
  try {
    await fs.access(absPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** 符号链接是否指向存储根之内（越界的链接不进不去） */
async function probeSymlinkEnterable(entryAbsPath) {
  try {
    const real = await fs.realpath(entryAbsPath);
    const stat = await fs.stat(real);
    return { enterable: stat.isDirectory(), realPath: real };
  } catch {
    return { enterable: false, realPath: null };
  }
}

/**
 * 列出目录内容。
 * @param {{rootAbs: string, maxPathLength?: number, maxListEntries?: number, defaultPageSize?: number}} ctx
 * @param {{path?: string, sort?: string, order?: string, showHidden?: boolean, limit?: number, offset?: number}} query
 */
export async function listDirectory(ctx, query = {}) {
  const maxListEntries = ctx.maxListEntries || 5000;
  const defaultPageSize = ctx.defaultPageSize || 200;

  const sort = SORT_KEYS.has(query.sort) ? query.sort : 'name';
  const order = SORT_ORDERS.has(query.order) ? query.order : 'asc';
  const showHidden = query.showHidden === true || query.showHidden === 'true';
  const limit = Number.isInteger(query.limit) && query.limit > 0 ? Math.min(query.limit, maxListEntries) : defaultPageSize;
  const offset = Number.isInteger(query.offset) && query.offset > 0 ? query.offset : 0;

  // ① 白名单（含符号链接二次校验）
  const { userPath, realPath } = await resolveRequestPath(ctx, query.path ?? ROOT_USER_PATH);

  // ② 必须是目录
  let dirStat;
  try {
    dirStat = await fs.stat(realPath);
  } catch (error) {
    throw toApiError(error);
  }
  if (!dirStat.isDirectory()) {
    throw apiError(ERROR_CODES.NOT_A_DIRECTORY, '目标不是目录', { path: userPath });
  }

  // ③ 枚举条目（withFileTypes 省一次 stat；但符号链接与 size/mtime 仍需 lstat）
  let dirents;
  try {
    dirents = await fs.readdir(realPath, { withFileTypes: true });
  } catch (error) {
    throw toApiError(error);
  }

  const visible = dirents.filter((dirent) => showHidden || !dirent.name.startsWith('.'));

  const entries = (
    await mapWithLimit(visible, PROBE_CONCURRENCY, async (dirent) => {
      const entryAbs = path.join(realPath, dirent.name);
      let stat;
      try {
        stat = await fs.lstat(entryAbs);
      } catch {
        return null; // 竞态：枚举后被删除，直接跳过而不是让整次列目录失败
      }

      const isSymlink = stat.isSymbolicLink();
      const type = isSymlink ? 'symlink' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';

      // 符号链接不跟随：只额外探测"能不能进"（越界链接 enterable=false）
      let enterable = type === 'dir';
      if (isSymlink) {
        const probe = await probeSymlinkEnterable(entryAbs);
        enterable = probe.enterable;
      }

      return {
        name: dirent.name,
        path: userPath === ROOT_USER_PATH ? `/${dirent.name}` : `${userPath}/${dirent.name}`,
        type,
        size: type === 'file' ? stat.size : 0,
        mtime: Math.trunc(stat.mtimeMs),
        readable: await probeReadable(entryAbs),
        extension: type === 'file' ? path.extname(dirent.name) : '',
        enterable,
      };
    })
  ).filter(Boolean);

  // ④ 排序：目录优先，然后按 key（与主流文件管理器一致）
  const direction = order === 'desc' ? -1 : 1;
  const typeRank = (entry) => (entry.type === 'dir' ? 0 : entry.type === 'symlink' ? 1 : 2);
  entries.sort((a, b) => {
    if (typeRank(a) !== typeRank(b)) return typeRank(a) - typeRank(b);
    if (sort === 'size') return (a.size - b.size) * direction;
    if (sort === 'mtime') return (a.mtime - b.mtime) * direction;
    return a.name.localeCompare(b.name, 'zh-CN') * direction;
  });

  const total = entries.length;
  const page = entries.slice(offset, offset + limit);

  return {
    path: userPath,
    parent: parentUserPath(userPath),
    entries: page,
    total,
    truncated: total > offset + page.length,
    sort,
    order,
    offset,
    limit,
  };
}
