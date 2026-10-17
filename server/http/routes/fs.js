// 文件浏览路由（M1：docs/M0/API规范.md §4.2 的 fs/list 与 fs/stat）
//
// 安全约定：所有涉及路径的端点都挂 `app.guardPath()`（中间件层白名单）+
// 业务层（core/fs/*）再次校验 —— defense in depth。
//
// 响应字段严格照契约：list → {path,parent,entries,total,truncated,...}；
// stat → 单条目对象。**不出现在响应里的绝对路径**（进程内部字段不返回）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { listDirectory } from '../../core/fs/list.js';
import { statEntry } from '../../core/fs/stat.js';

/** 查询串里的数字参数解析（非法值→undefined，由 core 用默认值） */
function toInt(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function toBool(value) {
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

export default async function fsRoutes(app) {
  app.get('/fs/list', { preHandler: [app.requireAuth, app.guardPath({ source: 'query' })] }, async (request, reply) => {
    const query = request.query || {};
    // 黑名单层（用户层有缓存，逐请求解析成本可忽略）；契约 §4.2 的 blacklisted/blacklistLayer 由服务端算
    const blacklistLayers = await app.blacklist.layersFor({ enabled: true, taskPatterns: [] });
    const listing = await listDirectory(app.fsContext, {
      blacklistLayers,
      // 用中间件已校验过的 userPath 再走一遍 core（core 内部仍会完整校验）
      path: request.userPath,
      sort: query.sort,
      order: query.order,
      showHidden: toBool(query.showHidden),
      limit: toInt(query.limit),
      offset: toInt(query.offset),
    });
    reply.ok(listing);
  });

  app.get('/fs/stat', { preHandler: [app.requireAuth, app.guardPath({ source: 'query' })] }, async (request, reply) => {
    if (request.userPath === undefined) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必填');
    }
    const blacklistLayers = await app.blacklist.layersFor({ enabled: true, taskPatterns: [] });
    const entry = await statEntry(app.fsContext, request.userPath, { blacklistLayers });
    reply.ok(entry);
  });
}
