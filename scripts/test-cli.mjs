#!/usr/bin/env node
//
// CLI 入口（`bin/zipcalm.js`）的单元测试
//
// 为什么需要这一套：npm 包的主要用法是 `npx zipcalm` / 全局安装后敲 `zipcalm`，
// 而这两种形态下 npm 都会在 `node_modules/.bin/` 建一个**符号链接**指向 bin 文件。
// 早先的"是否被直接执行"判据只比较 path.resolve 的字面路径，符号链接调用时
// argv[1]（链接路径）与 import.meta.url（真实路径）不相等 → main() 不跑 →
// 进程**静默 exit 0、零输出、服务不起**。所有测试与手工验证都用 `node <真实路径>`，
// 所以这个 bug 一路没被发现，直到真的从 registry 装包跑 npx 才暴露。
//
// 覆盖：
//   ① 参数解析（--port / --host / --data-dir / --help / --version）
//   ② 默认数据目录落在 ~/.zipcalm
//   ③ buildEnv 产出四个**绝对路径**环境变量（config 侧不会再被 projectRoot 带偏）
//   ④ 直接执行（node <真实路径>）能跑出东西 ← 现状保护
//   ⑤ **符号链接执行能跑出东西** ← 本套件存在的理由
//   ⑥ 端口被占用时给人话提示并退出码非 0（不是抛栈）

import { execFile, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createReporter } from './helpers/test-report.mjs';

const execFileAsync = promisify(execFile);
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(SELF_DIR, '../bin/zipcalm.js');

const reporter = createReporter('cli');
const { check } = reporter;

/** 用子进程跑一次 CLI，拿到 stdout/stderr/退出码（不真正起服务时用 --version 走短路） */
async function runCli(entryPath, args = []) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [entryPath, ...args], { timeout: 30000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? -1, stdout: error.stdout || '', stderr: error.stderr || String(error.message) };
  }
}

async function caseParseArgs() {
  const { parseArgs, defaultDataDir, buildEnv } = await import('../bin/zipcalm.js');

  const parsed = parseArgs(['--port', '8080', '--host', '127.0.0.1', '--data-dir', '/tmp/zc']);
  check('参数解析：--port/--host/--data-dir 都能取到', parsed.port === 8080 && parsed.host === '127.0.0.1' && parsed.dataDir === '/tmp/zc',
    JSON.stringify(parsed));
  check('参数解析：--help / --version 能识别', parseArgs(['--help']).help === true && parseArgs(['-v']).version === true);

  const expectedDefault = path.join(os.homedir(), '.zipcalm');
  check('默认数据目录 = ~/.zipcalm（不落在包目录里）', defaultDataDir() === expectedDefault, defaultDataDir());

  const { env, dataDir } = buildEnv({ port: 8080, host: null, dataDir: null }, {});
  const fourAbsolute = ['ZIPCALM_DATA_DIR', 'ZIPCALM_STORAGE_ROOT', 'ZIPCALM_TRASH_DIR', 'ZIPCALM_LOG_DIR']
    .every((key) => typeof env[key] === 'string' && path.isAbsolute(env[key]));
  check('buildEnv：四个路径都是绝对路径（config 侧 path.resolve 不会被带偏）', fourAbsolute,
    `dataDir=${dataDir} 变量数=${Object.keys(env).length}`);
}

async function caseVersionDirect() {
  const result = await runCli(BIN_PATH, ['--version']);
  const version = String(result.stdout).trim();
  check('直接执行（node <真实路径>）能打印版本', result.code === 0 && /^\d+\.\d+\.\d+/.test(version), `code=${result.code} out=${version || '(空)'}`);
}

async function caseVersionThroughSymlink() {
  // 模拟 npx / 全局安装的形态：.bin/ 下是指向 bin 文件的符号链接
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-cli-'));
  const linkPath = path.join(workDir, 'zipcalm');
  await fsp.symlink(BIN_PATH, linkPath);
  try {
    const result = await runCli(linkPath, ['--version']);
    const version = String(result.stdout).trim();
    const ok = result.code === 0 && /^\d+\.\d+\.\d+/.test(version);
    check(
      '符号链接执行（npx/.bin 形态）能打印版本 —— 不得静默 exit 0',
      ok,
      ok ? `version=${version}` : `code=${result.code} out=${JSON.stringify(version)} stderr=${JSON.stringify(String(result.stderr).slice(0, 80))}`,
    );
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

async function casePortInUse() {
  // 占住一个端口，再让 CLI 用它 → 应给人话提示且退出码非 0
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
  const { port } = blocker.address();
  try {
    const result = await runCli(BIN_PATH, ['--port', String(port)]);
    const text = `${result.stdout || ''}${result.stderr || ''}`;
    check('端口被占用：提示「已被占用」且退出码非 0（不是抛栈）',
      result.code !== 0 && /已被占用/.test(text), `code=${result.code} text=${JSON.stringify(text.slice(0, 80))}`);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
}

async function main() {
  const info = await runCli(BIN_PATH, ['--version']);
  console.log(`# CLI 入口：${BIN_PATH}`);
  console.log(`# 当前版本：${String(info.stdout).trim() || '(取不到)'}`);

  await caseParseArgs();
  await caseVersionDirect();
  await caseVersionThroughSymlink();
  await casePortInUse();

  reporter.summary();
}

main().catch((error) => {
  console.error(`[test-cli] 运行失败：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
