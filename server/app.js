// 应用装配（Fastify 实例 + 插件与路由挂载）
//
// 层次（docs/12 §二）：http/ 只做入口（中间件 + 路由），core/ 放业务，lib/ 放工具。
// 本文件只负责"接线"，不含任何业务逻辑，便于将来换 Web 框架时只改这一处。
//
// 结构：每个装配步骤是一个**模块级小函数**（实例 / 观测 / 安全 / 任务层 / 压缩层 / 前端 / 关停钩子），
// buildApp 只按顺序把它们串起来 —— 顺序本身有讲究（见各步骤注释）。

import crypto from 'node:crypto';
import path from 'node:path';

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';

import { pathExists } from './lib/fs-probe.js';
import { createAuthStore } from './core/auth/store.js';
import { verifyPassword } from './core/auth/password.js';
import { createDeleteService } from './core/compress/deleter.js';
import { createOrchestrator } from './core/compress/orchestrator.js';
import { createRegistry } from './core/compress/registry.js';
import { createTaskEvents } from './core/task/events.js';
import { createTaskManager } from './core/task/manager.js';
import { createTaskStore } from './core/task/store.js';
import { registerAuth } from './http/middleware/auth.js';
import { registerErrorHandling } from './http/middleware/error.js';
import { registerRequestLogger } from './http/middleware/logger.js';
import { registerPathGuard } from './http/middleware/pathGuard.js';
import router from './http/router.js';
import { APP_VERSION } from '../shared/app-version.js';

/** 版本号：与 web 共用 shared/app-version.js 一处定义（避免两处各写一个后漂移） */
export { APP_VERSION };

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

function createFastifyInstance(config) {
  return Fastify({
    logger: false, // 用我们自己的结构化日志（lib/logger.js），避免双份日志格式
    trustProxy: config.server.trustProxy === true,
    bodyLimit: BODY_LIMIT_BYTES,
    disableRequestLogging: true,
    genReqId: () => crypto.randomUUID(),
  });
}

/**
 * 容错 JSON 解析：**空 body 视为无请求体**，而不是 400。
 * Fastify 默认对"声明了 application/json 但 body 为空"的请求直接回 400
 * （FST_ERR_CTP_EMPTY_JSON_BODY），这对 `DELETE /tasks/{id}` 这类天然无 body 的请求很不友好 ——
 * 客户端只要习惯性带上 Content-Type: application/json 就会被拒。
 */
function registerTolerantJsonParser(app) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === undefined || body === null || body === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      error.statusCode = 400;
      done(error, undefined);
    }
  });
}

/** 认证与路径白名单：authStore 先加载；pathGuard 提供 fsContext（后续所有层都依赖它） */
async function registerSecurityLayer(app, { config, logger }) {
  const authStore = createAuthStore({ config: config.auth, logger, dataDir: config.storage.dataDir });
  await authStore.load();
  app.decorate('authStore', authStore);

  registerAuth(app, { store: authStore, config: config.auth });
  registerPathGuard(app, { config, logger });
  return authStore;
}

/**
 * M3 任务层：落盘 store → 事件总线 → 管理器（含启动恢复）。
 * 恢复必须在路由挂载前完成：这样第一个请求看到的就已是 interrupted 终态（INV-10）。
 */
async function createTaskLayer({ config, logger }) {
  const store = createTaskStore({
    dataDir: config.storage.dataDir,
    historyMax: config.limits.taskHistoryMax,
    logger,
  });
  await store.init();

  const events = createTaskEvents({ retention: config.limits.sseRetention, logger });
  const manager = createTaskManager({
    logger,
    store,
    events,
    // 任务活动记录保留策略（failed/interrupted 的上限，来自配置、不写死）
    retention: {
      max: config.limits.taskRetentionMax,
      days: config.limits.taskRetentionDays,
    },
  });
  const recovery = await manager.recover();
  logger.info('任务状态已加载', { ...recovery, bootId: manager.bootId });

  return { store, events, manager };
}

/** M2 压缩层：格式注册表 → 删除服务 → 编排器（编排器要用 rootAbs，必须在 pathGuard 之后） */
async function createCompressLayer({ config, logger, projectRoot, manager }) {
  const registry = createRegistry({ logger });
  await registry.discover();

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
    manager,
    deleteService,
    rootAbs: config.storage.root,
  });

  return { registry, deleteService, orchestrator };
}

/**
 * 优雅关闭分两步（顺序很关键）：
 * - preClose：Fastify 关闭服务器**之前**的钩子，用来结束 SSE 长连接 ——
 *   否则服务器会一直等这些 hijack 的连接，导致优雅停止超时被 KILL；
 * - onClose：服务器关闭后收尾，把节流中的任务状态落盘（避免丢最后 500ms 的进度）。
 */
function registerShutdownHooks(app, { sseClients, manager, authStore }) {
  app.addHook('preClose', async () => {
    for (const response of sseClients) {
      try {
        response.end();
      } catch {
        /* 连接可能已断 */
      }
    }
    sseClients.clear();
  });

  app.addHook('onClose', async () => {
    await manager.flush();
    // 认证存储同样要收尾：刚签发的 token 若还压在 50ms 节流里，不 flush 就会随进程一起丢（重启后客户端突然 401）
    if (authStore && typeof authStore.flush === 'function') await authStore.flush();
  });
}

/** 静态前端（可选）：web/dist 存在时同源提供，浏览器地址即 API 地址，无需代理或 CORS */
async function registerFrontend(app, { projectRoot, logger }) {
  const distDir = path.join(projectRoot, 'web', 'dist');
  if (await pathExists(distDir)) {
    await app.register(fastifyStatic, { root: distDir, prefix: '/', wildcard: false });
    logger.info('static frontend enabled', { dir: path.relative(projectRoot, distDir) });
    return;
  }
  logger.warn('web/dist 不存在，仅提供 API（如需同源 UI，先执行 npm run build）', {
    dir: path.relative(projectRoot, distDir),
  });
}

/**
 * 装配 M2（压缩/解压）与 M3（任务）两层，并把它们挂到 app 上。
 * 单独成函数是为了让 buildApp 只保留"顺序"这一件事（每层内部各有自己的依赖顺序）。
 */
async function attachCompressAndTaskLayers(app, { config, logger, projectRoot }) {
  const taskLayer = await createTaskLayer({ config, logger });
  const compressLayer = await createCompressLayer({
    config,
    logger,
    projectRoot,
    manager: taskLayer.manager,
  });

  app.decorate('m2', {
    registry: compressLayer.registry,
    manager: taskLayer.manager,
    orchestrator: compressLayer.orchestrator,
    deleteService: compressLayer.deleteService,
    config,
  });

  // M3 的任务三件套（路由与 /health 都从这里取；store/events 不进 API 响应）
  // sseClients：活跃的 SSE 响应集合，关停时统一 end()，否则长连接会让优雅停止超时
  const sseClients = new Set();
  app.decorate('tasks', {
    store: taskLayer.store,
    events: taskLayer.events,
    manager: taskLayer.manager,
    sseClients,
  });

  return { taskLayer, sseClients };
}

/**
 * 构建 Fastify 应用（不监听端口，便于测试里直接 inject）。
 * @param {{config: object, logger: object, projectRoot: string}} options
 */
export async function buildApp(options) {
  const { config, logger, projectRoot } = options;

  const app = createFastifyInstance(config);
  await app.register(cookie);
  registerTolerantJsonParser(app);

  // 顺序有讲究：请求日志 → 错误处理 → 认证 → 路径白名单 → 任务/压缩层 → 路由
  registerRequestLogger(app, { logger });
  registerErrorHandling(app, { logger });
  const authStore = await registerSecurityLayer(app, { config, logger });

  const { taskLayer, sseClients } = await attachCompressAndTaskLayers(app, { config, logger, projectRoot });
  registerShutdownHooks(app, { sseClients, manager: taskLayer.manager, authStore });

  const meta = {
    version: APP_VERSION,
    startedAt: Date.now(),
    bootId: taskLayer.manager.bootId,
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

  await registerFrontend(app, { projectRoot, logger });

  return { app, authStore, meta };
}
