// 应用装配（Fastify 实例 + 插件与路由挂载）
//
// 层次（docs/12 §二）：http/ 只做入口（中间件 + 路由），core/ 放业务，lib/ 放工具。
// 本文件只负责"接线"，不含任何业务逻辑，便于将来换 Web 框架时只改这一处。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { createAuthStore } from './core/auth/store.js';
import { verifyPassword } from './core/auth/password.js';
import { createDeleteService } from './core/compress/deleter.js';
import { createOrchestrator } from './core/compress/orchestrator.js';
import { createRegistry } from './core/compress/registry.js';
import { createTaskManager } from './core/task/manager.js';
import { registerAuth } from './http/middleware/auth.js';
import { registerErrorHandling } from './http/middleware/error.js';
import { registerRequestLogger } from './http/middleware/logger.js';
import { registerPathGuard } from './http/middleware/pathGuard.js';
import router from './http/router.js';

/** 版本号与 package.json 保持一致（M1 阶段手写常量，发布流程建立后再自动注入） */
export const APP_VERSION = '0.1.0';

/** 请求体上限：M1 只有登录表单，1MB 足够；压缩上传在 M2 之后再评估 */
const BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * 构造密码校验函数。
 * - 优先 passwordHash（scrypt，推荐）；
 * - 允许 password 明文配置（仅本机开发用），但比较时走 sha256 + timingSafeEqual，避免长度侧信道。
 */
function createPasswordVerifier(authConfig) {
  if (authConfig.passwordHash) {
    return (plain) => verifyPassword(plain, authConfig.passwordHash);
  }
  if (authConfig.password) {
    const expected = crypto.createHash('sha256').update(String(authConfig.password)).digest();
    return async (plain) => {
      const actual = crypto.createHash('sha256').update(String(plain)).digest();
      return crypto.timingSafeEqual(expected, actual);
    };
  }
  // schema 校验已拦截这种情况，这里只是兜底
  throw new Error('auth.passwordHash 或 auth.password 必须配置其中之一');
}

/**
 * 构建 Fastify 应用（不监听端口，便于测试里直接 inject）。
 * @param {{config: object, logger: object, projectRoot: string}} options
 */
export async function buildApp(options) {
  const { config, logger, projectRoot } = options;

  const app = Fastify({
    logger: false, // 用我们自己的结构化日志（lib/logger.js），避免双份日志格式
    trustProxy: config.server.trustProxy === true,
    bodyLimit: BODY_LIMIT_BYTES,
    disableRequestLogging: true,
    genReqId: () => crypto.randomUUID(),
  });

  // Cookie 插件：Session 通道的载体（API 规范 §二）
  await app.register(cookie);

  // 顺序有讲究：请求日志 → 错误处理 → 认证 → 路径白名单 → 路由
  registerRequestLogger(app, { logger });
  registerErrorHandling(app, { logger });

  const authStore = createAuthStore({ config: config.auth, logger, dataDir: config.storage.dataDir });
  await authStore.load();
  app.decorate('authStore', authStore);

  registerAuth(app, { store: authStore, config: config.auth });
  registerPathGuard(app, { config, logger });

  // ===== M2：格式注册表 + 任务队列 + 删除服务 + 编排器 =====
  // 装配顺序有讲究：pathGuard 先（提供 fsContext），m2 后（编排器要用 rootAbs），
  // 路由最后注册（路由插件初始化时会读 app.m2）。
  const registry = createRegistry({ logger });
  await registry.discover();

  const taskManager = createTaskManager({ logger });
  const deleteService = createDeleteService({
    config,
    logger,
    logDir: config.storage.logDir,
    trashDir: config.storage.trashDir,
    projectRoot,
  });
  const orchestrator = createOrchestrator({
    config,
    logger,
    registry,
    manager: taskManager,
    deleteService,
    rootAbs: config.storage.root,
  });

  app.decorate('m2', {
    registry,
    manager: taskManager,
    orchestrator,
    deleteService,
    config,
  });

  const meta = {
    version: APP_VERSION,
    startedAt: Date.now(),
    bootId: crypto.randomUUID(),
    rootWritable: true,
  };
  app.decorate('meta', meta);

  await app.register(router, {
    prefix: '/api/v1',
    config,
    logger,
    store: authStore,
    meta,
    verifyPassword: createPasswordVerifier(config.auth),
  });

  // ===== 静态前端（可选）=====
  // web/dist 存在时同源提供，这样"浏览器访问的地址 = API 地址"，不需要代理或 CORS。
  // 前端是 hash 路由，因此只需要 '/' 与静态资源，不需要 SPA fallback。
  const distDir = path.join(projectRoot, 'web', 'dist');
  if (fs.existsSync(distDir)) {
    await app.register(fastifyStatic, { root: distDir, prefix: '/', wildcard: false });
    logger.info('static frontend enabled', { dir: path.relative(projectRoot, distDir) });
  } else {
    logger.warn('web/dist 不存在，仅提供 API（如需同源 UI，先执行 npm run build）', {
      dir: path.relative(projectRoot, distDir),
    });
  }

  return { app, authStore, meta };
}
