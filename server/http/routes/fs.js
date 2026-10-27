// 文件浏览路由（M1：docs/M0/API规范.md §4.2 的 fs/list 与 fs/stat）
//
// 安全约定：所有涉及路径的端点都挂 `app.guardPath()`（中间件层白名单）+
// 业务层（core/fs/*）再次校验 —— defense in depth。
//
// 响应字段严格照契约：list → {path,parent,entries,total,truncated,...}；
// stat → 单条目对象。**不出现在响应里的绝对路径**（进程内部字段不返回）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';
import { listDirectory } from '../../core/fs/list.js';
import { listRoots } from '../../core/fs/roots.js';
import { searchFiles } from '../../core/fs/search.js';
import { deleteEntries, makeDirectory, moveEntries, renameEntry } from '../../core/fs/writeOps.js';
import { repairNamesInDirectory } from '../../core/fs/repairNames.js';
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
  /**
   * 存储根列表（docs/16 §三.2）：平台 + 模式 + 根列表 + 容量。
   * 两种数据源（卷 / 共享）由 roots.js 按平台决定；statfs 失败只让容量为 null，不报错。
   */
  app.get('/fs/volumes', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const storage = app.m2.config.storage;
    const rootsPayload = await listRoots({ storage, env: process.env });
    // 回写缓存：新增/删除共享后，带 rootId 的请求不必等重启就能用
    if (typeof app.refreshRoots === 'function') app.refreshRoots(rootsPayload);
    // 配置里显式给了 roots 时，把它们的 label 一并带上（自动发现的 label 已在 roots.js 里定好）
    reply.ok(rootsPayload);
  });

  app.get('/fs/list', { preHandler: [app.requireAuth, app.guardPath({ source: 'query' })] }, async (request, reply) => {
    const query = request.query || {};
    // 黑名单层（用户层有缓存，逐请求解析成本可忽略）；契约 §4.2 的 blacklisted/blacklistLayer 由服务端算
    const blacklistLayers = await app.blacklist.layersFor({ enabled: true, taskPatterns: [] });
    const listing = await listDirectory(app.requestContext(request), {
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

  // ===== 写操作（M8 右键菜单/快捷键/拖拽的后端支撑，形状照 API 规范 §4.2）=====
  // 路径校验在这里**不做 preHandler**：四个端点都可能是"源 + 目标"或数组路径，
  // 统一交给 core/fs/writeOps 逐条走 safePath（含符号链接复核），避免半套校验。
  app.post('/fs/mkdir', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await makeDirectory(app.requestContext(request), request.body || {}));
  });

  app.post('/fs/rename', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await renameEntry(app.requestContext(request), request.body || {}));
  });

  app.post('/fs/move', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await moveEntries(app.requestContext(request), request.body || {}));
  });

  // 批量修复乱码文件名（U+FFFE + 私有区字节转义 → 原名）。dryRun 默认 true，不显式传 false 只出清单。
  app.post('/fs/repair-names', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await repairNamesInDirectory(app.requestContext(request), request.body || {}));
  });
  app.post('/fs/delete', { preHandler: [app.requireAuth] }, async (request, reply) => {
    reply.ok(await deleteEntries(app.requestContext(request), request.body || {}, {
      // 与 M5 删除原文件同一机制：进回收站（delete.mode 决定是 trash 还是 log-only 记账）
      deleter: app.m2.deleteService,
      maxDeleteItems: app.fsContext.maxDeleteItems,
      // 删除任务的 INV-06 复核基准跟随本次请求的根（多根下不能用全局默认根）
      rootAbs: app.requestContext(request).rootAbs,
    }));
  });

  /**
   * 文件名搜索（有界遍历：深度 6 / 结果 500 / 3s）：只在当前根内、不跟随符号链接、跳过黑名单目录。
   * 未给 q 或为空 → 400（前端"未输入不请求"）。
   */
  app.get('/fs/search', { preHandler: [app.requireAuth] }, async (request, reply) => {
    const context = app.requestContext(request);
    const layers = await app.blacklist.layersFor({ enabled: true, taskPatterns: [] });
    const searchPayload = await searchFiles(context, request.query.q, { limit: request.query.limit, layers });
    reply.ok(searchPayload);
  });

  app.get('/fs/stat', { preHandler: [app.requireAuth, app.guardPath({ source: 'query' })] }, async (request, reply) => {
    if (request.userPath === undefined) {
      throw apiError(ERROR_CODES.VALIDATION_FAILED, 'path 必填');
    }
    const blacklistLayers = await app.blacklist.layersFor({ enabled: true, taskPatterns: [] });
    const entry = await statEntry(app.requestContext(request), request.userPath, { blacklistLayers });
    reply.ok(entry);
  });
}
