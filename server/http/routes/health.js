// 健康检查（docs/M0/API规范.md §4.6 的 M1 子集）
//
// 用途：启停脚本的 status 判定、前端"服务是否在线"探测。
// 安全：**不返回存储根的绝对路径**（避免把本机目录结构暴露给任何能访问端口的客户端），
// 只返回"是否已配置/可写"这类布尔与统计值。

export default async function healthRoutes(app, options) {
  const { meta } = options;

  app.get('/health', async (request, reply) => {
    const authStats = app.authStore ? app.authStore.stats() : { sessions: 0, tokens: 0 };
    const taskStats = app.tasks ? app.tasks.manager.stats() : { total: 0, active: null, waiting: 0, subscribers: 0, seq: 0 };
    reply.ok({
      version: meta.version,
      startedAt: meta.startedAt,
      uptimeMs: Date.now() - meta.startedAt,
      bootId: app.tasks ? app.tasks.manager.bootId : meta.bootId,
      auth: { sessions: authStats.sessions, tokens: authStats.tokens },
      storage: { configured: true, readable: true, writable: meta.rootWritable === true },
      tasks: {
        total: taskStats.total,
        active: taskStats.active,
        waiting: taskStats.waiting,
        subscribers: taskStats.subscribers,
        seq: taskStats.seq,
      },
      // M2 已实现压缩/解压；M3 补齐任务系统；指标看板在 M7
      features: { fs: true, auth: true, compress: true, tasks: true, metrics: true },
    });
  });
}
