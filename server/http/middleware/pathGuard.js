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

export function registerPathGuard(app, { config, logger }) {
  const fsContext = {
    rootAbs: config.storage.root,
    maxPathLength: config.limits.maxPathLength,
    maxPathSegmentLength: config.limits.maxPathSegmentLength,
    maxListEntries: config.limits.maxListEntries,
    defaultPageSize: config.limits.defaultPageSize,
  };

  app.decorate('fsContext', fsContext);
  app.decorate('fsGuard', {
    /** 同步形态校验（不碰磁盘） */
    resolve(raw) {
      return resolveWithinRoot(fsContext.rootAbs, raw, { maxPathLength: fsContext.maxPathLength });
    },
    /** 含符号链接二次校验（会访问磁盘） */
    async resolveReal(raw) {
      return resolveRequestPath(fsContext, raw);
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
      const container = source === 'body' ? request.body : request.query;
      const raw = container ? container[key] : undefined;

      if (raw === undefined || raw === null || raw === '') {
        if (!required) return;
        // 缺省视为存储根（API 规范：根为 /）
      }

      const target = raw === undefined || raw === null || raw === '' ? '/' : raw;
      const { userPath, absPath, realPath } = await resolveRequestPath(fsContext, target);

      request.userPath = userPath;
      request.absPath = absPath;
      request.realPath = realPath;
      logger.debug('path guard resolved', { userPath, requestId: request.requestId });
    };
  });
}
