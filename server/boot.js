// 启动入口（M1）
//
// 职责：加载配置 → 建日志 → 装配应用 → 监听 → 优雅退出。
// 进程管理（PID 文件、后台运行）交给 scripts/start.sh，这里保持"前台进程"语义，
// 这样 systemd/supervisor/nohup 都能直接用。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createLogger } from './lib/logger.js';
import { checkNodeVersion } from './lib/runtime-guard.js';

// 项目根 = 本文件所在目录（server/）的上一级；不写死绝对路径
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** PID 文件路径：由 start.sh 通过环境变量传入（脚本与进程"谁写 PID"只能有一个权威） */
const PID_FILE = process.env.ZIPCALM_PID_FILE || null;

/** 由进程自己写 PID：比启动器用 $! 猜更可靠（shell 里 `&` 作用于复合列表时 $! 会拿到子 shell 的 PID） */
function writePidFile() {
  if (!PID_FILE) return;
  try {
    fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`[ZipCalm] 写入 PID 文件失败：${error.message}\n`);
  }
}

/** 退出时清理 PID 文件（只删属于本进程的，避免误删新实例的） */
function removePidFile() {
  if (!PID_FILE) return;
  try {
    if (fs.existsSync(PID_FILE)) {
      const recorded = fs.readFileSync(PID_FILE, 'utf8').trim();
      if (recorded === String(process.pid)) fs.unlinkSync(PID_FILE);
    }
  } catch {
    // 清理失败不影响退出
  }
}

async function main() {
  const env = process.env;

  // ===== 0. 运行期自检（版本不够就明确拒绝启动，别等用户点压缩才炸）=====
  // 放在配置之前：这是"环境根本不满足"的问题，与配置无关，越早说清越好
  const nodeCheck = checkNodeVersion();
  if (!nodeCheck.ok) {
    process.stderr.write(`[ZipCalm] 运行环境不满足要求，已拒绝启动：\n${nodeCheck.message}\n`);
    process.exit(1);
  }

  // ===== 1. 配置 =====
  let loaded;
  try {
    loaded = await loadConfig({ projectRoot: PROJECT_ROOT, env });
  } catch (error) {
    // 配置错误必须"人话"输出到 stderr 并退出（否则用户只会看到一个堆栈）
    process.stderr.write(`[ZipCalm] 配置错误：${error.message}\n`);
    process.exit(1);
  }
  const { config, warnings, sources } = loaded;

  const logger = createLogger({ level: config.log.level });
  // 自检结果入日志（版本号 + 通过状态），便于事后核"这台机器的运行时到底够不够"
  logger.info('runtime check passed', {
    node: nodeCheck.current,
    requiredNode: nodeCheck.required,
    message: nodeCheck.message,
  });
  for (const warning of warnings) logger.warn('config warning', { message: warning });

  logger.info('config loaded', {
    sources: sources.length > 0 ? sources : ['defaults'],
    port: config.server.port,
    host: config.server.host,
    storageRoot: config.storage.root,
    logLevel: config.log.level,
  });

  // ===== 2. 装配 =====
  const { app, authStore, meta } = await buildApp({ config, logger, projectRoot: PROJECT_ROOT });
  const stopCleanup = authStore.startCleanup();

  // ===== 3. 监听 =====
  try {
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    logger.error('listen failed', { error: error.message, port: config.server.port, host: config.server.host });
    process.stderr.write(`[ZipCalm] 端口监听失败：${error.message}\n`);
    process.exit(1);
  }

  logger.info('ZipCalm server ready', { port: config.server.port, bootId: meta.bootId });

  // 监听成功后再写 PID 文件：这样"PID 文件存在"就等于"服务已就绪"
  writePidFile();

  // ===== 4. 优雅退出 =====
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    try {
      await app.close();
    } catch (error) {
      logger.error('close failed', { error: error.message });
    }
    stopCleanup();
    removePidFile();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 兜底：未捕获异常不能"静默把服务带走"（先记日志再优雅退出，让 start.sh 能重启）
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaughtException', {
      error: error.message,
      stack: String(error.stack || '').split('\n').slice(0, 4).join(' | '),
    });
    shutdown('uncaughtException');
  });
}

main();
