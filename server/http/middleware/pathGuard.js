// 路径白名单中间件（M1 安全红线，INV-06）
//
// 这一层做两件事：
// 1. 把存储根与限制参数固化成 `app.fsContext`，全局只有一份（避免每个路由各自读配置）；
// 2. 提供 preHandler 工厂 `app.guardPath`：**在进入业务逻辑之前**先做形态校验 + 白名单解析，
//    把结果挂到 request.userPath / request.absPath。业务层（core/fs/*）还会再校验一次，
//    这是刻意的 defense in depth：中间件被绕过也还有兜底。
//
// 真正的算法在 server/core/fs/safePath.js（拆段拒绝 .. + 带分隔符的前缀校验 + realpath 二次校验）。

import { resolveRequestPath, resolveWithinRoot } from '../../core/fs/safePath.js';
import { DEFAULT_ROOT_ID, listRoots, resolveRoot } from '../../core/fs/roots.js';

/** 请求里的 rootId（query 优先、body 兜底）；空串视作未指定 */
function requestedRootIdOf(request) {
  const fromQuery = request.query && request.query.rootId;
  const fromBody = request.body && request.body.rootId;
  const preferred = typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : fromBody;
  return typeof preferred === 'string' && preferred.length > 0 ? preferred : undefined;
}

export async function registerPathGuard(app, { config, logger }) {
  const fsContext = {
    rootAbs: config.storage.root,
    /** 可切换的根（docs/16）：id/label/path 都是绝对路径；空数组=自动发现（由 /fs/volumes 现扫） */
    roots: Array.isArray(config.storage.roots) ? config.storage.roots : [],
    defaultRootId: DEFAULT_ROOT_ID,
    maxPathLength: config.limits.maxPathLength,
    maxPathSegmentLength: config.limits.maxPathSegmentLength,
    maxListEntries: config.limits.maxListEntries,
    defaultPageSize: config.limits.defaultPageSize,
    maxMoveItems: config.limits.maxMoveItems,
    maxDeleteItems: config.limits.maxDeleteItems,
  };

  // 启动时发现一次根（群晖共享 / 卷），让带 rootId 的请求**无需先调 /fs/volumes** 就能用；
  // 之后 /fs/volumes 每次应答会用最新结果回写这里（加共享不用重启）。
  const discovered = await listRoots({ storage: config.storage, env: process.env });
  fsContext.platform = discovered.platform;
  fsContext.mode = discovered.mode;
  fsContext.roots = discovered.roots;

  /** 用最新发现结果刷新缓存（/fs/volumes 调用后执行） */
  app.decorate('refreshRoots', (fresh) => {
    if (!fresh || !Array.isArray(fresh.roots)) return;
    fsContext.platform = fresh.platform;
    fsContext.mode = fresh.mode;
    fsContext.roots = fresh.roots;
  });

  app.decorate('fsContext', fsContext);

  /**
   * 取（或生成）本请求的上下文：按 rootId 切基准，返回 { ...fsContext, rootAbs }。
   * 有 `guardPath` 的路由已经生成过；写操作类路由（没走 guardPath）用它自己生成 ——
   * 关键点：**每个请求一份副本**，绝不像改全局 rootAbs 那样让并发请求互相污染。
   */
  app.decorate('requestContext', function requestContext(request) {
    if (request.fsContext) return request.fsContext;
    const root = resolveRoot(fsContext, requestedRootIdOf(request));
    request.rootId = root.id;
    request.rootAbs = root.absPath;
    request.fsContext = { ...fsContext, rootAbs: root.absPath };
    return request.fsContext;
  });
  app.decorate('fsGuard', {
    /** 同步形态校验（不碰磁盘） */
    resolve(raw) {
      return resolveWithinRoot(fsContext.rootAbs, raw, { maxPathLength: fsContext.maxPathLength });
    },
    /** 含符号链接二次校验（会访问磁盘） */
    async resolveReal(raw) {
      return resolveRequestPath(fsContext, raw);
    },
    /** 在**指定根**下解析（多根：压缩任务用自己的根，与默认根无关） */
    async resolveRealIn(rootAbs, raw) {
      return resolveRequestPath({ ...fsContext, rootAbs }, raw);
    },
    /** 按 rootId 取根（未知 id 抛 VALIDATION_FAILED，不静默回落） */
    root(rootId) {
      return resolveRoot(fsContext, rootId);
    },
  });

  /**
   * 生成受保护路由的 preHandler。
   * @param {{source?: 'query'|'body', required?: boolean, key?: string}} options
   */
  app.decorate('guardPath', function guardPath(options = {}) {
    const source = options.source || 'query';
    const key = options.key || 'path';
    const required = options.required !== false;

    return async function pathGuardPreHandler(request) {
      // 根先定下来：后面的白名单解析全部以它为基准
      const root = resolveRoot(fsContext, requestedRootIdOf(request));
      const requestContext = { ...fsContext, rootAbs: root.absPath };
      request.rootId = root.id;
      request.rootAbs = root.absPath;
      request.fsContext = requestContext;

      const container = source === 'body' ? request.body : request.query;
      const raw = container ? container[key] : undefined;

      if (raw === undefined || raw === null || raw === '') {
        if (!required) return;
        // 缺省视为存储根（API 规范：根为 /）
      }

      const target = raw === undefined || raw === null || raw === '' ? '/' : raw;
      const { userPath, absPath, realPath } = await resolveRequestPath(requestContext, target);

      request.userPath = userPath;
      request.absPath = absPath;
      request.realPath = realPath;
      logger.debug('path guard resolved', { userPath, requestId: request.requestId });
    };
  });
}
