// 健康检查（docs/M0/API规范.md §4.6 的 M1 子集）
//
// 用途：启停脚本的 status 判定、前端"服务是否在线"探测。
// 安全：**不返回存储根的绝对路径**（避免把本机目录结构暴露给任何能访问端口的客户端），
// 只返回"是否已配置/可写"这类布尔与统计值。

export default async function healthRoutes(app, options) {
  const { meta } = options;

  app.get('/health', async (request, reply) => {
    const authStats = app.authStore ? app.authStore.stats() : { sessions: 0, tokens: 0 };
    reply.ok({
      version: meta.version,
      startedAt: meta.startedAt,
      uptimeMs: Date.now() - meta.startedAt,
      bootId: meta.bootId,
      auth: { sessions: authStats.sessions, tokens: authStats.tokens },
      storage: { configured: true, readable: true, writable: meta.rootWritable === true },
      // M1 只实现文件浏览，格式/任务/指标在各自里程碑补齐
      features: { fs: true, auth: true, compress: false, tasks: false, metrics: false },
    });
  });
}
