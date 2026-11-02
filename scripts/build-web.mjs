#!/usr/bin/env node
//
// 前端构建（CIFS 兼容）：源码镜像到本地临时目录 → 用可用的 node_modules 跑 vite → 产物拷回 web/dist
//
// 为什么必须绕到本地盘（两条都是本机实测的硬限制，不是保守估计）：
//   1. 项目 `.npmrc` 设了 `bin-links=false`，安装后**没有** `node_modules/.bin/vite`，
//      所以 `vite build` 这条命令根本不存在；
//   2. 工作区是 CIFS（挂载带 noexec），即使显式 `node node_modules/vite/bin/vite.js`，
//      vite/rollup 依赖的原生模块也无法被映射执行（ERR_DLOPEN_FAILED）。
// 因此在本地盘找一份可用的 node_modules，在那里执行构建，再把 dist 拷回来。
//
// 依赖落点优先级（都不写死绝对路径）：
//   1. 环境变量 ZIPCALM_WEB_DEPS 指向的 node_modules（需含 vite）
//   2. 缓存目录 <tmpdir>/zipcalm-web-deps（首次从项目 node_modules 复制，后续复用）
//   3. 项目自身的 node_modules（先用符号链接试跑；原生模块加载失败时整包复制到缓存再试）
//
// 用法：
//   node scripts/build-web.mjs            # 等价于 npm run build:web（含 check-drift 前置校验）
//   node scripts/build-web.mjs --skip-preflight
//   ZIPCALM_WEB_DEPS=/path/to/node_modules node scripts/build-web.mjs

import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 项目根：由本脚本位置推导（脚本在 scripts/ 下） */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIR = path.join(PROJECT_ROOT, 'web');
const SHARED_DIR = path.join(PROJECT_ROOT, 'shared');
const PROJECT_DEPS = path.join(PROJECT_ROOT, 'node_modules');
const DIST_OUT = path.join(WEB_DIR, 'dist');

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

/** 关键包清单：任一缺失都说明这份 node_modules 不完整（复制中断/被裁剪） */
const REQUIRED_PACKAGES = Object.freeze(['vite', 'esbuild', 'vue', '@vitejs/plugin-vue']);

/** 判断某个 node_modules 是否可用（不是只看 vite 在不在——缺 esbuild 时构建照样起不来） */
async function hasDeps(depsDir) {
  for (const name of REQUIRED_PACKAGES) {
    try {
      await fsp.access(path.join(depsDir, name, 'package.json'));
    } catch {
      return false;
    }
  }
  return true;
}

/** 递归复制（CIFS 上保留 mtime，不保留属主/权限——保留会 EPERM） */
async function copyTree(from, to, { filter } = {}) {
  await fsp.cp(from, to, {
    recursive: true,
    dereference: true,
    force: true,
    filter,
  });
}

/** 把前端源码镜像进临时目录（root = web/，因此 web/ 与 shared/ 的相对关系必须保持一致） */
async function mirrorSources(workDir) {
  await copyTree(WEB_DIR, path.join(workDir, 'web'), {
    filter: (src) => !src.startsWith(DIST_OUT), // 旧产物不参与构建
  });
  await copyTree(SHARED_DIR, path.join(workDir, 'shared'));
  await fsp.copyFile(path.join(PROJECT_ROOT, 'package.json'), path.join(workDir, 'package.json'));
}

/** 在 workDir 里放一份 node_modules（优先符号链接，失败再复制） */
async function linkDeps(workDir, depsDir) {
  const target = path.join(workDir, 'node_modules');
  await fsp.rm(target, { force: true, recursive: true }).catch(() => {});
  try {
    await fsp.symlink(depsDir, target, 'dir');
    return;
  } catch {
    // CIFS 或不支持符号链接的环境：退回整目录复制
    await copyTree(depsDir, target);
  }
}

async function runVite(workDir, depsDir) {
  const viteEntry = path.join(depsDir, 'vite', 'bin', 'vite.js');
  const args = [viteEntry, 'build', '--config', path.join(workDir, 'web', 'vite.config.js')];
  return execFileAsync(process.execPath, args, {
    cwd: workDir,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env },
  });
}

/**
 * 把项目 node_modules 复制成缓存：布局必须是 <cacheRoot>/node_modules/<包名>。
 * 为什么不能把包直接摊在 cacheRoot 下：Node 解析依赖时按**真实路径**向上找 node_modules 目录，
 * 摊平后 vite 自己 import esbuild 会找不到（实测 ERR_MODULE_NOT_FOUND）。
 * 复制到临时目录再原子换名，避免中途失败留下"看起来有、实际缺包"的半成品缓存。
 */
async function seedDepsCache(cacheRoot) {
  const staging = `${cacheRoot}.staging-${process.pid}`;
  const target = path.join(cacheRoot, 'node_modules');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  await copyTree(PROJECT_DEPS, path.join(staging, 'node_modules'), {
    filter: (src) => !src.includes(`${path.sep}.cache${path.sep}`) && !src.endsWith(`${path.sep}.cache`),
  });
  if (!(await hasDeps(path.join(staging, 'node_modules')))) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw new Error('依赖复制不完整（缺关键包），已放弃本次缓存写入');
  }
  await fsp.rm(cacheRoot, { recursive: true, force: true });
  await fsp.rename(staging, cacheRoot);
  return target;
}

/**
 * 逐文件复制（读成缓冲再写，不保留权限/时间戳）。
 * 为什么不用 fsp.cp / fsp.copyFile：两者在 CIFS 目标上都会走 copyfile 系统调用并返回 EPERM
 * （实测：同名文件用 `cp` 命令能写、Node 的 copyFile 不行）；writeFile 只做普通写，不受影响。
 */
async function copyPlain(fromDir, toDir) {
  await fsp.mkdir(toDir, { recursive: true });
  const entries = await fsp.readdir(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      await copyPlain(from, to);
    } else {
      // 符号链接在产物里不该出现；真出现时 readFile 会跟到目标内容，正好避免在 CIFS 上建链接
      const buffer = await fsp.readFile(from);
      await fsp.writeFile(to, buffer);
    }
  }
}

/** 产物拷回项目：先删旧目录再整体复制（CIFS 上不能依赖 chmod/rename 语义） */
async function publishDist(workDir) {
  const built = path.join(workDir, 'web', 'dist');
  await fsp.access(built); // 构建没产出就直接抛，别覆盖成空目录
  await fsp.rm(DIST_OUT, { recursive: true, force: true });
  await copyPlain(built, DIST_OUT);
}

async function main() {
  const skipPreflight = process.argv.includes('--skip-preflight');

  // 1. 前置校验（与 npm run build 保持一致；失败即退出，不产出半成品）
  if (!skipPreflight) {
    process.stdout.write('[build:web] 前置校验 scripts/check-drift.js\n');
    await execFileAsync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'check-drift.js')], {
      cwd: PROJECT_ROOT,
      timeout: BUILD_TIMEOUT_MS,
    });
  }

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zipcalm-web-'));
  const cacheRoot = path.join(os.tmpdir(), 'zipcalm-web-deps');
  let cacheDeps = path.join(cacheRoot, 'node_modules');
  let ok = false;

  try {
    await mirrorSources(workDir);

    // 2. 选依赖目录
    const envDeps = process.env.ZIPCALM_WEB_DEPS;
    let depsDir = envDeps && (await hasDeps(envDeps)) ? envDeps : null;
    if (!depsDir && (await hasDeps(cacheDeps))) depsDir = cacheDeps;
    if (!depsDir) {
      if (!(await hasDeps(PROJECT_DEPS))) {
        throw new Error('找不到完整的 node_modules（需含 vite/esbuild/vue/@vitejs/plugin-vue）：请先安装依赖，或用 ZIPCALM_WEB_DEPS 指定');
      }
      depsDir = PROJECT_DEPS;
    }
    process.stdout.write(`[build:web] 依赖目录 ${depsDir}\n`);

    // 3. 先按原样构建；原生模块在 noexec 盘上会 ERR_DLOPEN_FAILED → 复制到本地缓存重试
    await linkDeps(workDir, depsDir);
    try {
      await runVite(workDir, depsDir);
    } catch (error) {
      const message = String((error && (error.stderr || error.message)) || '');
      if (!message.includes('ERR_DLOPEN_FAILED')) throw error;
      process.stdout.write('[build:web] 原生模块无法从当前依赖目录加载，复制到本地缓存后重试\n');
      cacheDeps = await seedDepsCache(cacheRoot);
      await linkDeps(workDir, cacheDeps);
      await runVite(workDir, cacheDeps);
      depsDir = cacheDeps;
    }

    // 4. 产物回写
    await publishDist(workDir);
    ok = true;
    process.stdout.write(`[build:web] 完成，产物已写入 ${path.relative(PROJECT_ROOT, DIST_OUT) || '.'}\n`);
  } finally {
    // 临时工作区无论成败都清掉（缓存目录保留，供下次复用）
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (!ok) process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[build:web] 构建失败：${error && error.message ? error.message : String(error)}\n`);
  const tail = error && error.stderr ? String(error.stderr).split('\n').slice(-12).join('\n') : '';
  if (tail) process.stderr.write(`${tail}\n`);
  process.exitCode = 1;
});
