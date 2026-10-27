#!/usr/bin/env node
//
// ZipCalm CLI 入口（`npx zipcalm` / 全局安装后的 `zipcalm`）
//
// 职责：**只做参数翻译**，不碰任何业务逻辑 ——
//   把命令行参数翻译成已有的 `ZIPCALM_*` 环境变量（config 侧的白名单通道），然后启动 server/boot.js。
// 不另造一套配置体系：env 是既有的"部署差异单值"通道（server/config/defaults.js 的 ENV_OVERRIDES）。
//
// 关于数据目录（本包与"从 git 仓库运行"的关键区别）：
//   - 从 git 仓库跑（NAS 部署走 scripts/start.sh → node server/boot.js）：**不经过本文件**，
//     数据仍在 `<项目根>/storage/`，行为一个字不变。
//   - 从 npm 包跑（npx / 全局安装）：包目录通常在 node_modules 里（只读、且会被升级覆盖），
//     所以本文件**显式**把 dataDir / 存储根 / 回收站 / 日志全部指到 `~/.zipcalm`。
//     这四个环境变量都传**绝对路径**，config 侧 path.resolve(projectRoot, 绝对值) = 绝对值，所以不会被包目录带偏。

import { realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `ZipCalm 压压惊 —— 在浏览器里浏览、压缩、解压

用法：
  zipcalm                    启动（默认端口 3010，数据放在 ~/.zipcalm）
  zipcalm --port 8080        换端口
  zipcalm --host 0.0.0.0     监听地址（默认 0.0.0.0）
  zipcalm --data-dir ~/mydata  指定数据目录（任务状态/日志/回收站都在这里）
  zipcalm --version          打印版本
  zipcalm --help             显示本帮助

环境变量（与命令行等价，二选一）：
  ZIPCALM_PORT / ZIPCALM_HOST / ZIPCALM_DATA_DIR
`;

/** 解析 `--key value` 形式的最小参数集（不做花哨解析，避免引入依赖） */
export function parseArgs(argv) {
  const options = { port: null, host: null, dataDir: null, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--version' || token === '-v') options.version = true;
    else if (token === '--port') options.port = Number(argv[index += 1]);
    else if (token === '--host') options.host = argv[index += 1];
    else if (token === '--data-dir') options.dataDir = argv[index += 1];
  }
  return options;
}

/** 默认数据目录：用户主目录下的 .zipcalm（不用包目录，避免写进 node_modules） */
export function defaultDataDir() {
  return path.join(os.homedir(), '.zipcalm');
}

/**
 * 把选项翻译成环境变量（**绝对路径**，config 侧不会再被 projectRoot 带偏）。
 * @returns {{env: Record<string,string>, dataDir: string}}
 */
export function buildEnv(options, baseEnv = process.env) {
  const dataDir = path.resolve(options.dataDir || baseEnv.ZIPCALM_DATA_DIR || defaultDataDir());
  const env = {
    ZIPCALM_DATA_DIR: dataDir,
    ZIPCALM_STORAGE_ROOT: path.join(dataDir, 'fs-root'),
    ZIPCALM_TRASH_DIR: path.join(dataDir, 'trash'),
    ZIPCALM_LOG_DIR: path.join(dataDir, 'logs'),
  };
  if (Number.isInteger(options.port) && options.port > 0) env.ZIPCALM_PORT = String(options.port);
  if (typeof options.host === 'string' && options.host.length > 0) env.ZIPCALM_HOST = options.host;
  return { env, dataDir };
}

/** 端口能否监听（返回 true=可用；false=被占用；其它错误抛给调用方判断） */
export function isPortFree(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/** 本机局域网地址（对外打印用；127.0.0.1 只在本机可用，不作对外地址） */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

/**
 * 首次运行引导：数据目录里没有 config.json 时，生成一份**带随机口令**的最小配置。
 *
 * 为什么必须做：仓库里那份 config.json 是 gitignore 的运行态文件（含本机口令），**不会进 npm 包**；
 * 而配置校验要求 auth.password 或 auth.passwordHash 二选一，缺了就启动失败。
 * 这里给新用户生成随机口令并打印一次 —— 比内置默认口令安全（不会所有人都是 admin/zipcalm）。
 *
 * @returns {Promise<{created: boolean, password: string|null}>}
 */
async function ensureFirstRunConfig(dataDir) {
  // 环境变量已经给了凭据（ZIPCALM_PASSWORD / ZIPCALM_PASSWORD_HASH）时不要生成配置：
  // 否则会写一个随机 passwordHash，而校验是"passwordHash 优先"，用户给的 env 口令就被忽略了。
  if (process.env.ZIPCALM_PASSWORD || process.env.ZIPCALM_PASSWORD_HASH) {
    return { created: false, password: null };
  }
  const fsp = await import('node:fs/promises');
  const configPath = path.join(dataDir, 'config.json');
  const exists = await fsp.stat(configPath).then(() => true, () => false);
  if (exists) return { created: false, password: null };

  const { hashPassword, randomToken } = await import('../server/core/auth/password.js');
  const password = randomToken(9);
  const config = { auth: { username: 'admin', passwordHash: await hashPassword(password) } };
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { created: true, password };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const { env, dataDir } = buildEnv(options);
  if (options.version) {
    // 版本从包自身 package.json 读，避免和 shared/app-version.js 漂移出两个数
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json');
    const { readFileSync } = await import('node:fs');
    process.stdout.write(`${JSON.parse(readFileSync(pkgPath, 'utf8')).version}\n`);
    return;
  }

  const port = Number(env.ZIPCALM_PORT || process.env.ZIPCALM_PORT || 3010);
  const host = env.ZIPCALM_HOST || process.env.ZIPCALM_HOST || '0.0.0.0';

  // 端口冲突给人话提示，而不是让 boot 抛栈
  const free = await isPortFree(port, host).catch(() => true);
  if (!free) {
    process.stderr.write(`端口 ${port} 已被占用；用 --port 换一个（例如 --port ${port + 1}）\n`);
    process.exit(1);
  }

  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  // 首次运行：生成带随机口令的配置（数据目录里没有 config.json 时）
  const bootstrapped = await ensureFirstRunConfig(dataDir);
  if (bootstrapped.created) {
    process.stdout.write(`已生成配置文件：${path.join(dataDir, 'config.json')}\n`);
    process.stdout.write(`  用户名：admin\n  初始密码：${bootstrapped.password}\n`);
    process.stdout.write(`  （密码只显示这一次，之后请自行保管；改密码请编辑该 config.json）\n`);
  }

  process.stdout.write(`ZipCalm 启动中…\n`);
  process.stdout.write(`  访问地址：http://${lanAddress()}:${port}\n`);
  process.stdout.write(`  数据目录：${dataDir}\n`);

  // boot.js 是"副作用脚本"（加载配置→建日志→装配→监听→处理退出），直接 import 即可
  await import('../server/boot.js');
}

// 只有被当作 CLI 直接执行时才跑 main（同时导出上面的工具函数供测试复用）
//
// 判据必须比较**真实路径**（realpath），不能只 path.resolve：
//   `npx zipcalm` / 全局安装时，npm 会在 node_modules/.bin/ 下建一个**符号链接**指向本文件，
//   于是 process.argv[1] 是链接路径、import.meta.url 是真实路径，两者字面不同但指向同一个文件。
//   用 path.resolve 比较会判成"不是直接执行"→ main() 不跑 → 进程静默 exit 0（零输出、服务不起）。
//   这就是 npx 形态彻底不可用的原因，而所有直接用 `node <真实路径>` 运行的方式都不受影响。
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    // realpath 失败（如 argv[1] 是相对路径且 cwd 已变）→ 退回字面比较
    return path.resolve(process.argv[1]) === path.resolve(self);
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    process.stderr.write(`[ZipCalm] 启动失败：${error && error.message ? error.message : error}\n`);
    process.exit(1);
  });
}
