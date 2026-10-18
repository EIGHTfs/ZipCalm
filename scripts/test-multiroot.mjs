#!/usr/bin/env node
//
// 多根验收（docs/16 §四）：rootId 切换 / INV-06 不被绕过 / 并发不串根 / 跨根不可达
//
// 本套件自己管理服务：以 `ZIPCALM_FORCE_PLATFORM=posix ZIPCALM_SHOW_APP_ROOT=1` 重启，
// 保证根列表确定（默认根 `default` + /volumeN），结束后**还原默认环境**重启。
//
// 最关键的两条：
//   1. INV-06 反证：换根只是换基准，`..` / 绝对路径 / 越界符号链接照旧拒绝；
//   2. 并发不串根：同时用两个不同 rootId 发请求，各自基准互不污染（这正是"按请求复制 ctx"要防的）。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { PROJECT_ROOT, execFileAsync, pathExists } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT_ABS = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };

const HTTP_TIMEOUT_MS = 15000;
const SERVICE_RESTART_TIMEOUT_MS = 90000;
const HEALTH_WAIT_TIMEOUT_MS = 30000;
const HEALTH_POLL_MS = 250;
const CONCURRENCY = 16;
const MARKER_NAME = 'root-marker.txt';

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

async function api(method, pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({ ok: false, error: { code: 'NO_ENVELOPE' } }));
  return { status: response.status, json };
}

const errorCode = (result) => (result.json && result.json.error && result.json.error.code) || null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealthy() {
  const deadline = Date.now() + HEALTH_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // 服务正在重启
    }
    await sleep(HEALTH_POLL_MS);
  }
  return false;
}

async function restartService(extraEnv) {
  await execFileAsync('bash', ['scripts/start.sh', 'restart'], {
    cwd: PROJECT_ROOT,
    timeout: SERVICE_RESTART_TIMEOUT_MS,
    env: { ...process.env, ...extraEnv },
  });
  return waitHealthy();
}

async function main() {
  // 夹具：默认根里放一个**只存在于默认根**的标记文件
  await fsp.writeFile(path.join(ROOT_ABS, MARKER_NAME), 'only-in-default-root');
  // 越界符号链接（指向 /etc）：INV-06 的 realpath 复核应该拒绝
  const escapeLink = path.join(ROOT_ABS, 'escape-link');
  await fsp.rm(escapeLink, { force: true });
  await fsp.symlink('/etc', escapeLink, 'dir');

  const started = await restartService({ ZIPCALM_FORCE_PLATFORM: 'posix', ZIPCALM_SHOW_APP_ROOT: '1' });
  check('服务以 posix + SHOW_APP_ROOT 重启成功', started);
  try {
    const login = await api('POST', '/auth/login', LOGIN);
    TOKEN = login.json && login.json.data && login.json.data.token;
    check('登录拿到 Bearer Token', Boolean(TOKEN));

    // ===== 根列表确定：default + 至少一个卷 =====
    const volumes = await api('GET', '/fs/volumes');
    const roots = (volumes.json && volumes.json.data && volumes.json.data.roots) || [];
    const ids = roots.map((root) => root.id);
    check('B 模式下根列表含 default 与至少一个卷', ids.includes('default') && ids.some((id) => id.startsWith('volume')), JSON.stringify(ids));

    // ===== rootId 切换 =====
    const defaultList = await api('GET', `/fs/list?path=%2F&rootId=default`);
    const volumeId = ids.find((id) => id.startsWith('volume'));
    const volumeList = await api('GET', `/fs/list?path=%2F&rootId=${encodeURIComponent(volumeId)}`);
    check('rootId=default 能列出内容', defaultList.status === 200 && Boolean(defaultList.json.data), `code=${errorCode(defaultList)}`);
    check(`rootId=${volumeId} 切根后独立列出（互不是同一目录）`,
      volumeList.status === 200
      ? !volumeList.json.data.entries.some((entry) => entry.name === MARKER_NAME)
      : errorCode(volumeList) === 'PERMISSION_DENIED' || errorCode(volumeList) === 'PATH_NOT_FOUND',
      `status=${volumeList.status} code=${errorCode(volumeList)}`);
    check('默认根能看到标记文件', defaultList.json.data.entries.some((entry) => entry.name === MARKER_NAME));

    // ===== 未知 rootId =====
    const unknown = await api('GET', '/fs/list?path=%2F&rootId=nope');
    check('未知 rootId → VALIDATION_FAILED（不静默回落默认根）', errorCode(unknown) === 'VALIDATION_FAILED', `code=${errorCode(unknown)}`);

    // ===== INV-06 反证：换根不绕过 =====
    for (const rootId of ['default', volumeId]) {
      const escapeDotDot = await api('GET', `/fs/list?path=%2F..%2Fetc&rootId=${encodeURIComponent(rootId)}`);
      check(`[${rootId}] .. 越界仍被拒（PATH_OUT_OF_ROOT）`, errorCode(escapeDotDot) === 'PATH_OUT_OF_ROOT', `code=${errorCode(escapeDotDot)}`);
      const bare = await api('GET', `/fs/list?path=${encodeURIComponent('/../etc/passwd')}&rootId=${encodeURIComponent(rootId)}`);
      check(`[${rootId}] 编码后的绝对越界仍被拒`, ['PATH_OUT_OF_ROOT', 'INVALID_PATH', 'VALIDATION_FAILED'].includes(errorCode(bare)), `code=${errorCode(bare)}`);
    }
    const symlinkEscape = await api('GET', `/fs/stat?path=%2Fescape-link&rootId=default`);
    check('越界符号链接（→/etc）仍被 INV-06 拦下（PATH_OUT_OF_ROOT）', errorCode(symlinkEscape) === 'PATH_OUT_OF_ROOT', `code=${errorCode(symlinkEscape)}`);

    // ===== 跨根不可达 =====
    const crossRoot = await api('GET', `/fs/stat?path=${encodeURIComponent(`/../${volumeId}/`)}&rootId=default`);
    check('用 ../ 拼另一个根的路径 → 仍越界（跨根不因换基准而可达）', errorCode(crossRoot) === 'PATH_OUT_OF_ROOT', `code=${errorCode(crossRoot)}`);

    // ===== 并发不串根 =====
    const requests = [];
    for (let index = 0; index < CONCURRENCY; index += 1) {
      const asDefault = index % 2 === 0;
      const url = asDefault
        ? `/fs/list?path=%2F&rootId=default`
        : `/fs/list?path=%2F&rootId=${encodeURIComponent(volumeId)}`;
      requests.push(api('GET', url).then((result) => ({ asDefault, result })));
    }
    const settled = await Promise.all(requests);
    const defaultOk = settled.filter((item) => item.asDefault);
    const volumeOk = settled.filter((item) => !item.asDefault);
    const defaultAllGood = defaultOk.every((item) => item.result.status === 200
      && item.result.json.data.entries.some((entry) => entry.name === MARKER_NAME));
    const volumeNeverLeaks = volumeOk.every((item) => !(item.result.status === 200
      && item.result.json.data.entries.some((entry) => entry.name === MARKER_NAME)));
    check('并发（16 个）用不同 rootId：默认根的请求全部命中默认根内容', defaultAllGood, `${defaultOk.length} 个请求`);
    check('并发请求里卷根的响应从不出现默认根的内容（基准不串）', volumeNeverLeaks, `${volumeOk.length} 个请求`);

    // ===== 写操作按请求根：delete 用错根 → notFound（不会误删）=====
    const wrongDelete = await api('POST', '/fs/delete', { paths: [`/${MARKER_NAME}`], rootId: volumeId });
    check('用卷根删默认根的文件 → 记 notFound（不会跨根误删）',
      wrongDelete.status === 200 && ((wrongDelete.json.data && wrongDelete.json.data.notFound) || []).length === 1,
      JSON.stringify(wrongDelete.json.data || wrongDelete.json.error));
    check('标记文件仍在默认根里', await pathExists(path.join(ROOT_ABS, MARKER_NAME)));
  } finally {
    // 还原默认环境（其它套件依赖默认配置）
    await restartService({ ZIPCALM_FORCE_PLATFORM: '', ZIPCALM_SHOW_APP_ROOT: '' });
    await fsp.rm(path.join(ROOT_ABS, MARKER_NAME), { force: true });
    await fsp.rm(path.join(ROOT_ABS, 'escape-link'), { force: true });
  }

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`多根验收脚本异常：${error.message}`);
  process.exitCode = 1;
});
