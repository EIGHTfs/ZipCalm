#!/usr/bin/env node
//
// M6 验收：三层黑名单 + 三端点 + 目录列表标注 + 磁盘预检 + 「跳过项不被删」
//
// 覆盖 docs/11 §九 的 5 条验收 + lead 追加的第 6 条（黑名单命中 + 删除原文件 → 跳过项必须在原地）：
//   ① 全 jpg 目录：预览提示跳过数 + 创建任务被 ALL_SOURCES_SKIPPED 拦下（422，不建任务）
//   ② 打包模式：跳过文件仍保留在原目录（且**不进包** —— 用 7z 列条目核对）
//   ③ 单独压缩模式：整源被跳过 → 不生成空压缩包
//   ④ 用户能在设置里添加/删除黑名单扩展名（PUT 全量替换 + 校验 + 生效）
//   ⑤ 磁盘剩余 < 待压 × 2 → 任务拒绝启动（**纯函数层**注入 preflightFactor=1000000，不碰真实配置）
//   ⑥ 黑名单命中 + 删除原文件 → 跳过项仍在原地、删除日志里没有它
//
// 用法：bash scripts/start.sh start && node scripts/test-m6-blacklist.mjs
// 注意：会写 storage/fs-root/m6-test 与 storage/blacklist-user.json；结束时还原用户层并清理夹具。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { compressPreflight } from '../server/core/compress/preflight.js';
import { matchEntry, resolveLayers } from '../server/core/compress/blacklist.js';
import { PROJECT_ROOT, execFileAsync, pathExists } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const DATA_DIR = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.dataDir) || './storage');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
const USER_BLACKLIST_FILE = path.join(DATA_DIR, 'blacklist-user.json');

/** 信封异常时回传的消息片段长度 / 7z 列条目超时 / 任务列表一次取多少 / 故意超长的 pattern 字符数 */
const ERROR_SNIPPET_CHARS = 120;
const ARCHIVE_LIST_TIMEOUT_MS = 30000;
const TASK_LIST_LIMIT = 100;
const OVERLONG_PATTERN_LENGTH = 200; // 超过契约上限 128，用来验证服务端确实拒绝
const HTTP_TIMEOUT_MS = 15000;
const DEFAULT_TASK_TIMEOUT_MS = 120000;
const TASK_POLL_INTERVAL_MS = 200;
const FIXTURE_API = '/m6-test';
const FIXTURE_ABS = path.join(ROOT, 'm6-test');

const reporter = createReporter();
const { check } = reporter;
let TOKEN = null;

async function api(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, ERROR_SNIPPET_CHARS) } };
  }
  return { status: response.status, json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等任务终态（done/failed/aborted/interrupted） */
async function waitTask(id, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/tasks/${id}`);
    last = json && json.data && json.data.task;
    if (last && ['done', 'failed', 'aborted', 'interrupted'].includes(last.status)) return last;
    await sleep(TASK_POLL_INTERVAL_MS);
  }
  return last;
}

/** 造夹具：mixed（2 jpg + 2 txt）、alljpg（3 jpg） */
async function prepareFixture() {
  await fsp.rm(FIXTURE_ABS, { recursive: true, force: true });
  await fsp.mkdir(path.join(FIXTURE_ABS, 'mixed'), { recursive: true });
  await fsp.mkdir(path.join(FIXTURE_ABS, 'alljpg'), { recursive: true });
  await fsp.writeFile(path.join(FIXTURE_ABS, 'mixed', 'a.jpg'), 'fake-jpeg-a');
  await fsp.writeFile(path.join(FIXTURE_ABS, 'mixed', 'b.jpg'), 'fake-jpeg-b');
  await fsp.writeFile(path.join(FIXTURE_ABS, 'mixed', 'keep-1.txt'), 'text one\n');
  await fsp.writeFile(path.join(FIXTURE_ABS, 'mixed', 'keep-2.txt'), 'text two\n');
  for (const name of ['1.jpg', '2.jpg', '3.jpg']) {
    await fsp.writeFile(path.join(FIXTURE_ABS, 'alljpg', name), `jpg-${name}`);
  }
}

/** 归档里的条目名（7z l 解析；tar 系列也用 7z l） */
async function archiveEntries(archiveAbsPath) {
  const { stdout } = await execFileAsync('7z', ['l', archiveAbsPath], { timeout: ARCHIVE_LIST_TIMEOUT_MS });
  return stdout.split('\n')
    .map((line) => line.trim())
    .filter((line) => /\d{4}-\d{2}-\d{2}/.test(line))
    .map((line) => line.split(/\s+/).pop())
    .filter(Boolean);
}

async function main() {
  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  // 用户层先清零，保证断言从已知状态出发（结束时会再还原）
  // 默认黑名单已收敛为"系统垃圾"（见 blacklist.js 注释）：本套件需要 jpg 被跳过，
  // 所以显式用**用户自定义层**加 *.jpg —— 这正好也证明"M6 第 6 条在用户规则下照样成立"。
  await api('PUT', '/blacklist/user', { patterns: ['*.jpg'], enabled: true });

  // ===== ④ 端点形状 + 添加/删除扩展名 =====
  const initial = await api('GET', '/blacklist');
  const globalPatterns = (initial.json && initial.json.data && initial.json.data.global && initial.json.data.global.patterns) || [];
  check('GET /blacklist 返回三层结构', Boolean(initial.json && initial.json.data && initial.json.data.global && initial.json.data.user), `HTTP ${initial.status}`);
  check('global 层 locked 且只含系统垃圾（jpg 等已不在默认里）', initial.json.data.global.locked === true
    && ['Thumbs.db', '.DS_Store', '@eaDir'].every((pattern) => globalPatterns.includes(pattern))
    && !globalPatterns.includes('*.jpg'), `共 ${globalPatterns.length} 条`);
  check('effectiveCount ≥ 全局默认条数', initial.json.data.effectiveCount >= globalPatterns.length, `effectiveCount=${initial.json.data.effectiveCount}`);

  const added = await api('PUT', '/blacklist/user', { patterns: ['*.jpg', '*.bak', '*.tmp'], enabled: true });
  const userPatterns = (added.json && added.json.data && added.json.data.user && added.json.data.user.patterns) || [];
  check('PUT /blacklist/user 添加扩展名生效（并把原有 *.jpg 一起替换上去）',
    userPatterns.includes('*.bak') && userPatterns.includes('*.tmp') && userPatterns.includes('*.jpg'), `patterns=${JSON.stringify(userPatterns)}`);
  const reread = await api('GET', '/blacklist');
  check('重新 GET 能读到用户层（持久化生效）', ((reread.json.data.user && reread.json.data.user.patterns) || []).includes('*.bak'));

  const badPattern = await api('PUT', '/blacklist/user', { patterns: ['/etc/passwd'] });
  check('非法 pattern（绝对路径）被拒 → VALIDATION_FAILED', badPattern.json && badPattern.json.error && badPattern.json.error.code === 'VALIDATION_FAILED', `code=${badPattern.json && badPattern.json.error && badPattern.json.error.code}`);
  const tooLong = await api('PUT', '/blacklist/user', { patterns: [`*.${'x'.repeat(OVERLONG_PATTERN_LENGTH)}`] });
  check('单条超过 128 字符被拒', tooLong.json && tooLong.json.error && tooLong.json.error.code === 'VALIDATION_FAILED');

  const removed = await api('PUT', '/blacklist/user', { patterns: ['*.jpg', '*.tmp'], enabled: true });
  check('PUT 全量替换（删除 *.bak 后只剩 *.jpg/*.tmp）',
    JSON.stringify((removed.json.data.user.patterns) || []) === '["*.jpg","*.tmp"]',
    JSON.stringify(removed.json.data.user.patterns));

  // ===== ①②③⑥ 夹具与预览 =====
  await prepareFixture();
  const previewAll = await api('POST', '/blacklist/preview', { paths: [`${FIXTURE_API}/alljpg`], extraPatterns: [] });
  const skippedAll = (previewAll.json && previewAll.json.data && previewAll.json.data.skipped) || [];
  const keptAll = (previewAll.json && previewAll.json.data && previewAll.json.data.kept) || [];
  check('预览：全 jpg 目录 3 个文件全部跳过', skippedAll.length === 3 && keptAll.length === 0, `skipped=${skippedAll.length} kept=${keptAll.length}`);
  check('预览：skipped 带 pattern/layer（user/*.jpg —— 用户自定义层）', skippedAll.every((item) => item.pattern === '*.jpg' && item.layer === 'user'), JSON.stringify(skippedAll[0] || null));
  check('预览：skipped 只有用户路径（不泄漏 absPath）', skippedAll.every((item) => typeof item.path === 'string' && item.path.startsWith('/m6-test/') && !item.absPath));

  const previewMixed = await api('POST', '/blacklist/preview', { paths: [`${FIXTURE_API}/mixed`], extraPatterns: [] });
  const skippedMixed = (previewMixed.json.data && previewMixed.json.data.skipped) || [];
  const keptMixed = (previewMixed.json.data && previewMixed.json.data.kept) || [];
  check('预览：混合目录 2 个 jpg 跳过、目录仍在 kept', skippedMixed.length === 2 && keptMixed.includes(`${FIXTURE_API}/mixed`), `skipped=${skippedMixed.length} kept=${JSON.stringify(keptMixed)}`);

  const extraPreview = await api('POST', '/blacklist/preview', { paths: [`${FIXTURE_API}/mixed`], extraPatterns: ['*.txt'] });
  const extraSkipped = (extraPreview.json.data && extraPreview.json.data.skipped) || [];
  check('任务级临时层（extraPatterns）参与预览且报 layer=task', extraSkipped.filter((item) => item.layer === 'task').length === 2, `task 层命中=${extraSkipped.filter((item) => item.layer === 'task').length}`);

  // ===== 目录列表标注 =====
  const listing = await api('GET', `/fs/list?path=${encodeURIComponent(`${FIXTURE_API}/mixed`)}`);
  const entries = (listing.json && listing.json.data && listing.json.data.entries) || [];
  const jpgEntry = entries.find((entry) => entry.name === 'a.jpg');
  const txtEntry = entries.find((entry) => entry.name === 'keep-1.txt');
  check('fs/list：jpg 标 blacklisted=true + layer=user（用户规则命中）', Boolean(jpgEntry && jpgEntry.blacklisted === true && jpgEntry.blacklistLayer === 'user'), JSON.stringify(jpgEntry || null));
  check('fs/list：txt 不标黑名单', Boolean(txtEntry && txtEntry.blacklisted === false && txtEntry.blacklistLayer === null), JSON.stringify(txtEntry || null));

  // ===== ① 全 jpg → 创建任务被拦（不建任务）=====
  const beforeCount = (await api('GET', `/tasks?limit=${TASK_LIST_LIMIT}`)).json.data.items.length;
  const allSkipped = await api('POST', '/compress/tasks', { sources: [`${FIXTURE_API}/alljpg`], mode: 'single', format: 'zip' });
  const afterCount = (await api('GET', `/tasks?limit=${TASK_LIST_LIMIT}`)).json.data.items.length;
  check('① 全 jpg 建任务 → 422 ALL_SOURCES_SKIPPED', allSkipped.status === 422 && allSkipped.json.error.code === 'ALL_SOURCES_SKIPPED', `HTTP ${allSkipped.status} code=${allSkipped.json && allSkipped.json.error && allSkipped.json.error.code}`);
  check('① 被拦时未创建任务（任务数不变）', afterCount === beforeCount, `${beforeCount} → ${afterCount}`);

  // ===== ② 打包模式：跳过不进包、留在原地 =====
  const bundle = await api('POST', '/compress/tasks', {
    sources: [`${FIXTURE_API}/mixed`], mode: 'bundle', format: 'zip',
    options: { outputDir: FIXTURE_API, blacklist: { enabled: true } },
  });
  const bundleId = bundle.json && bundle.json.data && bundle.json.data.task && bundle.json.data.task.id;
  check('② 打包模式创建成功', Boolean(bundleId), `HTTP ${bundle.status}`);
  const bundleTask = await waitTask(bundleId);
  check('② 打包任务 done', Boolean(bundleTask && bundleTask.status === 'done'), `status=${bundleTask && bundleTask.status} code=${bundleTask && bundleTask.error && bundleTask.error.code}`);
  const skippedInTask = (bundleTask && bundleTask.result && bundleTask.result.skipped) || [];
  check('② result.skipped 记录 2 个 jpg（含 path/pattern/layer）', skippedInTask.filter((item) => item.pattern === '*.jpg' && item.layer === 'user').length === 2, JSON.stringify(skippedInTask));
  check('② result.skipped 不含 absPath（契约红线）', skippedInTask.every((item) => !item.absPath));
  const bundleOut = bundleTask && bundleTask.result && bundleTask.result.packages && bundleTask.result.packages[0] && bundleTask.result.packages[0].outputPath;
  check('② 产出压缩包路径存在', Boolean(bundleOut), String(bundleOut));
  if (bundleOut) {
    const listing7z = await archiveEntries(path.join(ROOT, ...bundleOut.split('/').filter(Boolean)));
    check('② 包内不含被跳过的 jpg', listing7z.every((name) => !name.toLowerCase().endsWith('.jpg')), `entries=${JSON.stringify(listing7z)}`);
    check('② 包内含未跳过的 txt', listing7z.some((name) => name.endsWith('.txt')), `entries=${JSON.stringify(listing7z)}`);
  }
  check('② 跳过文件仍在原目录（jpg 未被删/未移走）', (await pathExists(path.join(FIXTURE_ABS, 'mixed', 'a.jpg'))) && (await pathExists(path.join(FIXTURE_ABS, 'mixed', 'b.jpg'))));

  // ===== ③ 单独压缩模式：整源跳过 → 不生成空包 =====
  const singleSkipped = await api('POST', '/compress/tasks', {
    sources: [`${FIXTURE_API}/alljpg`, `${FIXTURE_API}/mixed`], mode: 'single', format: 'zip',
    options: { outputDir: FIXTURE_API, blacklist: { enabled: true } },
  });
  const singleId = singleSkipped.json && singleSkipped.json.data && singleSkipped.json.data.task && singleSkipped.json.data.task.id;
  const singleTask = singleId ? await waitTask(singleId) : null;
  const singlePackages = (singleTask && singleTask.result && singleTask.result.packages) || [];
  check('③ 单独压缩：只为可压的源建 1 个包（alljpg 不生成空包）', singlePackages.length === 1, `packages=${singlePackages.length}`);

  // ===== ⑥ 黑名单命中 + 删除原文件 → 跳过项仍在原地 =====
  const deleteTask = await api('POST', '/compress/tasks', {
    sources: [`${FIXTURE_API}/mixed`], mode: 'bundle', format: 'zip',
    options: { outputDir: FIXTURE_API, keepOriginal: false, deleteConfirmed: true, blacklist: { enabled: true } },
  });
  const deleteId = deleteTask.json && deleteTask.json.data && deleteTask.json.data.task && deleteTask.json.data.task.id;
  const deleteDone = deleteId ? await waitTask(deleteId) : null;
  check('⑥ 压缩+删除任务 done', Boolean(deleteDone && deleteDone.status === 'done'), `status=${deleteDone && deleteDone.status}`);
  check('⑥ 被跳过的 jpg 仍在原地（M5 定时炸弹未爆）', (await pathExists(path.join(FIXTURE_ABS, 'mixed', 'a.jpg'))) && (await pathExists(path.join(FIXTURE_ABS, 'mixed', 'b.jpg'))));
  const deleteInfo = (deleteDone && deleteDone.delete) || {};
  const deleteTargets = (deleteInfo.targets || []).map((target) => target.path);
  check('⑥ 删除集合不含被跳过的 jpg', deleteTargets.every((p) => !p.toLowerCase().endsWith('.jpg')), `targets=${JSON.stringify(deleteTargets)}`);
  check('⑥ 删除集合含进包的 txt（说明删除阶段确实跑过）', deleteTargets.some((p) => p.endsWith('.txt')), `targets=${JSON.stringify(deleteTargets)}`);

  // ===== 层独立性：关 global 只关 global、关 user 只关 user（最容易回归的地方）=====
  // 这两条只在单元层可测：service 恒以 global.enabled=true 组装层（全局层按契约不可经 API 关闭），
  // 所以"关 global"的语义落在 resolveLayers 上 —— 若有人把它改成"关全局=关全部"，这里立刻红。
  // 注意 matchEntry(layers, { name }) 的参数顺序：layers 在前、条目在后（传反会恒返回 null，别误判成配置失效）。
  const globalOffLayers = resolveLayers({
    user: { enabled: true, patterns: ['*.txt'] },
    global: { enabled: false },
  });
  const jpgWhenGlobalOff = matchEntry(globalOffLayers, { name: 'Thumbs.db' });
  const txtWhenGlobalOff = matchEntry(globalOffLayers, { name: 'note.txt' });
  check('只关 global：系统垃圾（Thumbs.db）不再命中（全局层确实关了）', jpgWhenGlobalOff === null, JSON.stringify(jpgWhenGlobalOff));
  check('只关 global：user 层的 *.txt 仍然命中（关的是层，不是全部）',
    Boolean(txtWhenGlobalOff && txtWhenGlobalOff.layer === 'user' && txtWhenGlobalOff.pattern === '*.txt'),
    JSON.stringify(txtWhenGlobalOff));

  const userOffLayers = resolveLayers({
    user: { enabled: false, patterns: ['*.txt'] },
    global: { enabled: true },
  });
  const jpgWhenUserOff = matchEntry(userOffLayers, { name: 'Thumbs.db' });
  const txtWhenUserOff = matchEntry(userOffLayers, { name: 'note.txt' });
  check('只关 user：系统垃圾仍被全局层命中（层之间互相独立）',
    Boolean(jpgWhenUserOff && jpgWhenUserOff.layer === 'global'), JSON.stringify(jpgWhenUserOff));
  check('只关 user：*.txt 不再命中（用户层确实关了）', txtWhenUserOff === null, JSON.stringify(txtWhenUserOff));

  // API 层再验一遍"关 user"：PUT enabled=false 后，preview 里 *.txt 不再被跳过、jpg 仍被跳过
  await api('PUT', '/blacklist/user', { patterns: ['*.txt'], enabled: false });
  const previewUserOff = await api('POST', '/blacklist/preview', { paths: [`${FIXTURE_API}/mixed`], extraPatterns: [] });
  const skippedUserOff = (previewUserOff.json.data && previewUserOff.json.data.skipped) || [];
  const patternsUserOff = skippedUserOff.map((item) => item.pattern);
  check('API：用户层关闭后 *.txt 不再被跳过', !patternsUserOff.includes('*.txt'), `patterns=${JSON.stringify([...new Set(patternsUserOff)])}`);
  check('API：用户层关闭后 jpg 不再被跳过（默认值已收敛为系统垃圾）', !patternsUserOff.includes('*.jpg'), `patterns=${JSON.stringify([...new Set(patternsUserOff)])}`);
  await api('PUT', '/blacklist/user', { patterns: [], enabled: true }); // 还原

  // ===== 开关语义：blacklist.enabled=false → 三层全部不生效（jpg 也会被打包）=====
  const offTask = await api('POST', '/compress/tasks', {
    sources: [`${FIXTURE_API}/mixed`], mode: 'bundle', format: 'zip',
    options: { outputDir: FIXTURE_API, blacklist: { enabled: false } },
  });
  const offId = offTask.json && offTask.json.data && offTask.json.data.task && offTask.json.data.task.id;
  const offDone = offId ? await waitTask(offId) : null;
  const offOut = offDone && offDone.result && offDone.result.packages && offDone.result.packages[0] && offDone.result.packages[0].outputPath;
  const offSkipped = (offDone && offDone.result && offDone.result.skipped) || [];
  check('开关关闭：任务 done 且 skipped 为空', Boolean(offDone && offDone.status === 'done') && offSkipped.length === 0, `status=${offDone && offDone.status} skipped=${offSkipped.length}`);
  if (offOut) {
    const offEntries = await archiveEntries(path.join(ROOT, ...offOut.split('/').filter(Boolean)));
    check('开关关闭：包内含 jpg（黑名单确实不生效）', offEntries.some((name) => /mixed\/.*\.jpg$/i.test(name)), `entries=${JSON.stringify(offEntries)}`);
  } else {
    check('开关关闭：产出压缩包路径存在', false, 'no outputPath');
  }

  // ===== ⑤ 磁盘预检（纯函数层注入，不碰真实配置、不重启）=====
  const unitSources = [{
    path: `${FIXTURE_API}/mixed`, absPath: path.join(FIXTURE_ABS, 'mixed'), name: 'mixed', kind: 'dir',
  }];
  const tightPreflight = await compressPreflight(
    { config: { compress: { preflightFactor: 1e12 } }, rootAbs: ROOT, blacklistLayers: [] },
    { sources: unitSources, format: 'zip', mode: 'bundle', outputDir: FIXTURE_ABS },
  );
  check('⑤ 预检：剩余 < 待压×factor → canProceed=false + DISK_FULL',
    tightPreflight.canProceed === false && tightPreflight.blockedReason && tightPreflight.blockedReason.code === 'DISK_FULL',
    `canProceed=${tightPreflight.canProceed} code=${tightPreflight.blockedReason && tightPreflight.blockedReason.code} required=${tightPreflight.requiredBytes} free=${tightPreflight.freeBytes}`);
  const tightMessage = (tightPreflight.blockedReason && tightPreflight.blockedReason.message) || '';
  check('⑤ 明确提示里带所需/剩余字节', /需要 \d+ 字节/.test(tightMessage), tightMessage);

  // 接线验证（不依赖改 factor）：全黑名单源在**任务创建**路径同样被拦（上面的 ①），此处补一条 preflight 自身的判定
  const okPreflight = await compressPreflight(
    { config: { compress: { preflightFactor: 2 } }, rootAbs: ROOT, blacklistLayers: [] },
    { sources: unitSources, format: 'zip', mode: 'bundle', outputDir: FIXTURE_ABS },
  );
  check('⑤ 对照：同源在正常的 2 倍因子下 canProceed=true', okPreflight.canProceed === true, `code=${okPreflight.blockedReason && okPreflight.blockedReason.code}`);

  // ===== 清理：还原用户层 + 删夹具 =====
  await api('PUT', '/blacklist/user', { patterns: [], enabled: true });
  await fsp.rm(FIXTURE_ABS, { recursive: true, force: true });
  const runSummary = reporter.summary();
  if (runSummary.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`M6 验收脚本异常：${error.message}`);
  process.exitCode = 1;
});
