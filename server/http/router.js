// 路由注册表（docs/12 §二：http/router.js 只做装配，不写业务）
//
// 所有业务路由统一挂在 /api/v1 前缀下（契约 §一：API 版本化）。

import authRoutes from './routes/auth.js';
import blacklistRoutes from './routes/blacklist.js';
import compressRoutes from './routes/compress.js';
import fsRoutes from './routes/fs.js';
import hardlinkRoutes from './routes/hardlink.js';
import healthRoutes from './routes/health.js';
import metricsRoutes from './routes/metrics.js';
import taskRoutes from './routes/tasks.js';

export default async function router(app, options) {
  const { config, logger, store, meta, verifyPassword } = options;

  app.decorate('appLogger', logger);

  await app.register(authRoutes, { config: config.auth, store, verifyPassword });
  await app.register(fsRoutes, {});
  await app.register(compressRoutes, {});
  await app.register(blacklistRoutes, {});
  await app.register(hardlinkRoutes, {});
  await app.register(metricsRoutes, {});
  await app.register(taskRoutes, {});
  await app.register(healthRoutes, { meta });
}
