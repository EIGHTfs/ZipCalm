// 路由注册表（docs/12 §二：http/router.js 只做装配，不写业务）
//
// 所有业务路由统一挂在 /api/v1 前缀下（契约 §一：API 版本化）。

import authRoutes from './routes/auth.js';
import fsRoutes from './routes/fs.js';
import healthRoutes from './routes/health.js';

export default async function router(app, options) {
  const { config, logger, store, meta, verifyPassword } = options;

  app.decorate('appLogger', logger);

  await app.register(authRoutes, { config: config.auth, store, verifyPassword });
  await app.register(fsRoutes, {});
  await app.register(healthRoutes, { meta });
}
