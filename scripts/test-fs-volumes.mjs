#!/usr/bin/env node
//
// 存储根发现验收（docs/16 §四）：平台探测 / 两模式 / 容量降级 / canSwitch
//
// 覆盖：
//   - 正常平台探测（不强制）→ platform 合法、mode 与平台匹配
//   - ZIPCALM_FORCE_PLATFORM=posix → 模式 B（卷）；=synology → 模式 C（共享）
//   - 非法强制值 → 回落到真实探测（不报错）
//   - C 模式排除 @ / # 开头的系统目录
//   - statfs 失败 → 容量 null（不报错，接口仍 200）
//
// 用法：bash scripts/start.sh start && node scripts/test-fs-volumes.mjs

import { detectPlatform, listRoots, rootStats, sidebarModeOf } from '../server/core/fs/roots.js';
import { PROJECT_ROOT } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
const HTTP_TIMEOUT_MS = 15000;

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

async function api(pathname) {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function main() {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOGIN),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }).then((response) => response.json());
  TOKEN = login && login.data && login.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  // ===== 端点形状 =====
  const volumes = await api('/fs/volumes');
  const volumesData = (volumes.json && volumes.json.data) || {};
  check('GET /fs/volumes 200 且 ok', volumes.status === 200 && volumes.json.ok === true);
  check('返回 platform / mode / roots / canSwitch 四字段',
    typeof volumesData.platform === 'string' && ['B', 'C'].includes(volumesData.mode) && Array.isArray(volumesData.roots) && typeof volumesData.canSwitch === 'boolean',
    JSON.stringify({ platform: volumesData.platform, mode: volumesData.mode, canSwitch: volumesData.canSwitch }));
  check('平台与模式匹配（群晖→C，其他→B）', sidebarModeOf(volumesData.platform) === volumesData.mode, `${volumesData.platform} → ${volumesData.mode}`);
  check('至少有一个根', volumesData.roots.length >= 1, `roots=${volumesData.roots.length}`);
  for (const root of volumesData.roots) {
    check(`根 ${root.id} 字段齐全（id/label/path/容量）`,
      typeof root.id === 'string' && typeof root.label === 'string' && typeof root.path === 'string'
      && 'totalBytes' in root && 'freeBytes' in root,
      JSON.stringify(root));
  }
  check('canSwitch 与根数量一致', volumesData.canSwitch === (volumesData.roots.length > 1), `roots=${volumesData.roots.length} canSwitch=${volumesData.canSwitch}`);
  check('C 模式排除 @ / # 开头的系统目录',
    volumesData.mode !== 'C' || volumesData.roots.every((root) => !/^[@#]/.test(root.id)),
    `mode=${volumesData.mode}`);

  // ===== 平台探测（纯函数）=====
  check('强制 posix → 模式 B', sidebarModeOf(detectPlatform({ env: { ZIPCALM_FORCE_PLATFORM: 'posix' } })) === 'B');
  check('强制 synology → 模式 C', sidebarModeOf(detectPlatform({ env: { ZIPCALM_FORCE_PLATFORM: 'synology' } })) === 'C');
  check('非法强制值 → 回落真实探测（不抛错）', ['synology', 'posix', 'windows'].includes(detectPlatform({ env: { ZIPCALM_FORCE_PLATFORM: 'nonsense' } })));

  // ===== 两模式数据源（纯函数：用本机真实卷/共享）=====
  const storageBase = { root: `${PROJECT_ROOT}/storage/fs-root`, roots: [] };
  const posixRoots = await listRoots({ storage: storageBase, env: { ZIPCALM_FORCE_PLATFORM: 'posix' } });
  check('posix 发现的是卷（/volumeN 或 /mnt|/media 一级挂载点）',
    posixRoots.roots.every((root) => /^\/volume\d+$/.test(root.path) || /^\/(mnt|media)\/[^/]+$/.test(root.path)),
    JSON.stringify(posixRoots.roots.map((root) => root.path)));
  const synoRoots = await listRoots({ storage: storageBase, env: { ZIPCALM_FORCE_PLATFORM: 'synology' } });
  check('synology 发现的是共享（/volumeN 的子目录）',
    synoRoots.roots.every((root) => /^\/volume\d+\/[^/]+$/.test(root.path) || root.id === 'default'),
    JSON.stringify(synoRoots.roots.map((root) => root.path)));
  check('synology 共享里没有 @/# 开头', synoRoots.roots.every((root) => !/^[@#]/.test(root.id)));

  // ===== SHOW_APP_ROOT 开关 =====
  const withApp = await listRoots({ storage: storageBase, env: { ZIPCALM_FORCE_PLATFORM: 'synology', ZIPCALM_SHOW_APP_ROOT: '1' } });
  check('ZIPCALM_SHOW_APP_ROOT=1 会额外列出应用存储根',
    withApp.roots.some((root) => root.id === 'default'),
    JSON.stringify(withApp.roots.map((root) => root.id)));

  // ===== 容量降级（statfs 失败不报错）=====
  const missing = await rootStats(`${PROJECT_ROOT}/storage/definitely-not-a-real-root-xyz`);
  check('statfs 不存在路径 → 容量两项为 null（不抛错）', missing.totalBytes === null && missing.freeBytes === null, JSON.stringify(missing));
  const configuredWithBad = await listRoots({
    storage: { root: storageBase.root, roots: [
      { id: 'ok', label: '正常', path: storageBase.root },
      { id: 'bad', label: '不存在', path: `${PROJECT_ROOT}/storage/definitely-not-a-real-root-xyz` },
    ] },
    env: { ZIPCALM_FORCE_PLATFORM: 'posix' },
  });
  check('配置里混有不存在的根：接口照常返回，坏根容量为 null',
    configuredWithBad.roots.length === 2
    && configuredWithBad.roots.find((root) => root.id === 'ok').totalBytes > 0
    && configuredWithBad.roots.find((root) => root.id === 'bad').totalBytes === null,
    JSON.stringify(configuredWithBad.roots.map((root) => [root.id, root.totalBytes])));

  // ===== 搜索（有界遍历；只在当前根内）=====
  const emptyQuery = await api('/fs/search?q=');
  check('搜索空 q → VALIDATION_FAILED', (emptyQuery.json.error || {}).code === 'VALIDATION_FAILED', JSON.stringify(emptyQuery.json.error));
  const found = await api('/fs/search?q=m8&limit=5&rootId=default');
  const foundData = (found.json && found.json.data) || {};
  check('搜索能找到默认根里的目录（有界遍历生效，返回 elapsedMs）',
    Array.isArray(foundData.items) && foundData.items.some((item) => item.name === 'm8-test') && Number.isFinite(foundData.elapsedMs),
    `items=${(foundData.items || []).length} elapsed=${foundData.elapsedMs}`);
  check('搜索结果不含 absPath（只回传用户路径）', (foundData.items || []).every((item) => typeof item.path === 'string' && item.path.startsWith('/') && !('absPath' in item)));
  const limited = await api('/fs/search?q=m&limit=2&rootId=default');
  check('limit 生效（结果数不超过 limit）', ((limited.json.data || {}).items || []).length <= 2, `items=${((limited.json.data || {}).items || []).length}`);

  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`存储根验收脚本异常：${error.message}`);
  process.exitCode = 1;
});
