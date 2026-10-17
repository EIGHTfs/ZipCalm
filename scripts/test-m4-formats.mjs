#!/usr/bin/env node
//
// M4 验收脚本：四种格式（zip / tar / tar.gz / tar.zst）的压缩 + 解压 + 往返 hash + 外部工具交叉验证
//              + zip-slip 恶意样本 + 「加目录即注册」+ 复合扩展名最长匹配 + zstd 回退链 + Node 版本自检
//
// 用法：
//   bash scripts/start.sh start
//   node scripts/test-m4-formats.mjs
//
// 验证要点（M4 验收标准要求的三条硬证据）：
// - **假数据 + 每文件 hash 逐文件比对**：压缩前记录 sha256，解压后逐文件比对（正确性核心证据）；
// - **外部工具交叉验证，不自证**：`7z t`（zip）/ `tar -tf`（tar）/ `tar -tzf`（tar.gz）；
//   tar.zst 本机无 zstd 命令，故先用 Node 只做 zstd 解压、再用系统的 `tar -tf` 校验 tar 层；
// - zip-slip：zip 用手写 ZIP 记录、tar 系列用 node-tar 直接写 `../evil` 条目名。

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { hashTree, prepareFixture, writeRawTar, writeRawZip } from './helpers/archive-fixtures.mjs';
import { verifyWithExternalTools } from './helpers/m4-verify.mjs';
import { PROJECT_ROOT, execFileAsync, pathExists, taskIdOf } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';


const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);

const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.root) || './storage/fs-root');
const DATA_DIR = path.resolve(PROJECT_ROOT, (runtimeConfig.storage && runtimeConfig.storage.dataDir) || './storage');
const PLUGINS_DIR = path.join(PROJECT_ROOT, 'server', 'plugins', 'formats');
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
/**
 * 绝对路径逃逸样本的目标位置。
 * 攻击样本的**条目名本身就是绝对路径**（这是用例要考的东西），所以这里必须给出绝对路径；
 * 但用系统临时目录推导而不是写死 `/tmp`，换平台/换机器都不会失效。
 */
const ABS_PATH_ESCAPE_TARGET = path.join(os.tmpdir(), 'zc-m4-tar-abs-evil.txt');

const API_WORK = '/m4-test';
const WORK = path.join(ROOT, 'm4-test');
const FORMATS = [
  { id: 'zip', ext: '.zip', external: '7z-t' },
  { id: 'tar', ext: '.tar', external: 'tar-tf' },
  { id: 'targz', ext: '.tar.gz', external: 'tar-tzf' },
  { id: 'tarzst', ext: '.tar.zst', external: 'tar-tf-after-node-zstd' },
];

let TOKEN = null;
// 断言/跳过/汇总统一走共用报告器（输出格式与既有套件逐字一致，test-all.sh 靠它提取总结行）
/** HTTP 调用超时（毫秒）：服务僵死/半开连接时脚本不能永久挂住 */
const HTTP_TIMEOUT_MS = 15000;
/** 各场景超时：默认任务等待 / zip-slip 用例 / 子进程语法检查 / 重启服务 / 状态静置 */
const DEFAULT_TASK_TIMEOUT_MS = 180000;
const SLIP_TASK_TIMEOUT_MS = 30000;
const NODE_CHECK_TIMEOUT_MS = 20000;
const SERVICE_RESTART_TIMEOUT_MS = 90000;
const SETTLE_MS = 300;
const reporter = createReporter();
const { check, skip } = reporter;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, urlPath, body) {
  const hasBody = body !== undefined;
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
    // 超时兜底：服务僵死/半开连接时不能让脚本永久挂住
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: { ok: false, error: { code: 'NO_ENVELOPE', message: text.slice(0, 160) } } };
  }
}

const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

async function waitTask(id, timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/tasks/${id}`);
    last = json && json.data && json.data.task;
    if (last && TERMINAL.has(last.status)) return last;
    await sleep(200);
  }
  return last;
}

// ===== 夹具 / 外部校验 / 恶意样本：都在 scripts/helpers/ 下（主脚本只留流程与断言）=====
//   archive-fixtures.mjs —— 确定性假数据、树 hash、手写 zip/tar 恶意样本
//   m4-verify.mjs        —— 系统 tar/7z 的交叉验证

/** 哨兵文件一个都不该被写出（zip-slip 的核心证据；并发探一次即可） */
async function noMarkersWritten(markers) {
  const states = await Promise.all(markers.map((marker) => pathExists(marker)));
  return states.every((exists) => !exists);
}

async function zipSlipCase(format, label, archiveAbs, markers) {
  const archiveUser = archiveAbs.replace(ROOT, '').split(path.sep).join('/');
  const created = await api('POST', '/extract/tasks', { path: archiveUser, targetDir: `${archiveUser}-out` });
  const taskId = taskIdOf(created);
  const task = taskId ? await waitTask(taskId, SLIP_TASK_TIMEOUT_MS) : null;
  const code = (task && task.error && task.error.code) || (created.json && created.json.error && created.json.error.code) || null;
  const outsideClean = await noMarkersWritten(markers);
  check(`zip-slip 拒绝（${format} / ${label}）`, code === 'PATH_OUT_OF_ROOT', `code=${code || 'none'} status=${task ? task.status : created.status}`);
  check(`zip-slip 目标外无写入（${format} / ${label}）`, outsideClean, `${markers.length} 个哨兵文件均不存在=${outsideClean}`);
}

// ===== 「加目录即注册」 =====

const PROBE_DIR = path.join(PLUGINS_DIR, 'probe-format');
const PROBE_SOURCE = `// 临时探针格式包（验收「加目录即注册」用，测试结束即删）
export default {
  id: 'probe',
  name: 'PROBE',
  ext: '.probe',
  extAliases: [],
  mime: 'application/x-probe',
  levelRange: [0, 1],
  defaultLevel: 0,
  async available() { return true; },
  async estimate(bytes) { return { estimatedBytes: bytes, ratio: 1, basis: 'probe', confidence: 'low' }; },
  async create(ctx) { throw new Error('probe create 未实现（仅用于注册表验证）'); },
  async extract() { throw new Error('probe extract 未实现（仅用于注册表验证）'); },
  async list() { return { entries: [], count: 0, truncated: false }; },
  async test() { return { ok: true, checked: 0, failures: [], strategy: 'read-all' }; },
};
`;

async function formatIds() {
  const { json } = await api('GET', '/formats');
  return ((json && json.data && json.data.formats) || []).map((item) => item.id);
}

async function casePluginByDirectory() {
  await fsp.mkdir(PROBE_DIR, { recursive: true });
  await fsp.writeFile(path.join(PROBE_DIR, 'index.js'), PROBE_SOURCE, 'utf8');
  await sleep(SETTLE_MS);
  const withProbe = await formatIds();
  check('加目录即注册：放入新目录后 /formats 自动出现（未改注册代码、未重启）', withProbe.includes('probe'), `formats=${withProbe.join(',')}`);
  const probeDetail = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'probe');
  check('新格式元数据正确（ext/mime 均来自该目录）', Boolean(probeDetail && probeDetail.ext === '.probe' && probeDetail.mime === 'application/x-probe'), JSON.stringify(probeDetail && { ext: probeDetail.ext, mime: probeDetail.mime }));

  await fsp.rm(PROBE_DIR, { recursive: true, force: true });
  await sleep(SETTLE_MS);
  const withoutProbe = await formatIds();
  check('删掉目录后 /formats 自动消失', !withoutProbe.includes('probe'), `formats=${withoutProbe.join(',')}`);
}

// ===== 复合扩展名最长匹配 =====

async function caseExtensionMatching() {
  const { createRegistry } = await import(path.join(PROJECT_ROOT, 'server/core/compress/registry.js'));
  const logger = { info() {}, warn() {}, error() {} };
  const registry = createRegistry({ logger });
  await registry.discover();
  const cases = [
    ['/x.tar.gz', 'targz'],
    ['/x.tgz', 'targz'],
    ['/x.tar.zst', 'tarzst'],
    ['/x.tzst', 'tarzst'],
    ['/x.tar', 'tar'],
    ['/x.zip', 'zip'],
  ];
  for (const [file, expected] of cases) {
    // 传完整文件名：注册表按"整体后缀最长匹配"判定（x.tar.gz 必须命中 targz 而不是 tar/gz）
    const plugin = registry.byExtension(file);
    check(`扩展名匹配 ${file} → ${expected}`, Boolean(plugin && plugin.id === expected), `实际 ${plugin ? plugin.id : 'null'}`);
  }
  check('最长匹配优先：x.tar.gz 不被 .tar / .gz 抢走（除 targz 外没有更短匹配）', Boolean(registry.byExtension('.tar.gz') && registry.byExtension('.tar.gz').id === 'targz'));
}

// ===== Node 版本自检（单测 + 端到端模拟低版本）=====

async function caseNodeVersionGuard() {
  const { checkNodeVersion } = await import(path.join(PROJECT_ROOT, 'server/lib/runtime-guard.js'));
  const ok = checkNodeVersion(undefined, '22.23.3');
  const low = checkNodeVersion(undefined, '22.10.0');
  check('版本自检：满足时通过', ok.ok === true, ok.message);
  check('版本自检：不满足时给出要求与当前版本', low.ok === false && low.message.includes('22.15.0') && low.message.includes('22.10.0'), low.message.split('\n')[0]);

  // 端到端：覆盖 process.versions.node 后启动 boot.js，应退出码 1 且 stderr 说清原因
  const script = "Object.defineProperty(process.versions,'node',{value:'22.10.0'});import('" + path.join(PROJECT_ROOT, 'server/boot.js').replace(/\\/g, '/') + "');";
  try {
    await execFileAsync(process.execPath, ['-e', script], { cwd: PROJECT_ROOT, timeout: NODE_CHECK_TIMEOUT_MS });
    check('低版本端到端：拒绝启动（预期非 0 退出）', false, '居然正常退出了');
  } catch (error) {
    const stderr = String(error.stderr || '');
    check('低版本端到端：拒绝启动并说明原因', error.code !== 0 && stderr.includes('22.15.0') && stderr.includes('22.10.0'), stderr.split('\n').slice(0, 2).join(' / ').slice(0, 140));
  }
}

// ===== zstd 回退链 =====

async function restartService(env = {}) {
  const envPrefix = Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
  await execFileAsync('bash', ['-c', `${envPrefix} bash scripts/start.sh restart`], { cwd: PROJECT_ROOT, timeout: SERVICE_RESTART_TIMEOUT_MS }).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

async function caseZstdFallbackChain() {
  // ① 内置可用（默认）：已由前面的往返用例覆盖，这里只记录
  const builtin = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('zstd 首选：Node 内置可用时 tarzst available=true', Boolean(builtin && builtin.available === true), `available=${builtin && builtin.available}`);

  // ② 禁用内置 + 指向垫片 → 走"系统命令"回退，且仍能往返
  // 垫片必须放在**可执行挂载**上：工作区是 noexec（依赖装在 zipcalm-build 就是这个原因），
  // 放 storage/ 下即使有 +x 也会被 EACCES 拒绝，回退链验证会变成假阴性。
  const buildDir = path.dirname(await fsp.realpath(path.join(PROJECT_ROOT, 'node_modules')));
  const shimPath = path.join(buildDir, 'm4-tmp', 'zstd-shim');
  await fsp.mkdir(path.dirname(shimPath), { recursive: true });
  await fsp.writeFile(shimPath, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(PROJECT_ROOT, 'scripts/helpers/zstd-shim.mjs'))} "$@"\n`, 'utf8');
  await fsp.chmod(shimPath, 0o755);

  await restartService({ ZIPCALM_DISABLE_BUILTIN_ZSTD: '1', ZC_ZSTD_BIN: shimPath });
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const viaExternal = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('回退链：禁用内置 + 指定外部 zstd → available=true（走外部命令）', Boolean(viaExternal && viaExternal.available === true), `available=${viaExternal && viaExternal.available}`);

  const roundtrip = await roundTrip('tarzst', { suffix: '-ext', skipExternal: true });
  check('回退链：外部命令路径下 .tar.zst 往返 hash 一致', roundtrip.ok, roundtrip.detail);

  // ③ 禁用内置 + 外部也不存在 → 置灰 + 原因（而不是崩）
  await restartService({ ZIPCALM_DISABLE_BUILTIN_ZSTD: '1', ZC_ZSTD_BIN: '/nonexistent/zstd-not-here' });
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const unavailable = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('回退链：都不可用 → available=false 且给出原因', Boolean(unavailable && unavailable.available === false && unavailable.unavailableReason), `reason=${unavailable && String(unavailable.unavailableReason).slice(0, 80)}`);

  const rejected = await api('POST', '/compress/tasks', { sources: [`${API_WORK}/src`], mode: 'bundle', format: 'tarzst' });
  const code = rejected.json && rejected.json.error && rejected.json.error.code;
  check('不可用格式：创建任务被明确拒绝（不崩、不静默）', rejected.status === 503 && code === 'FORMAT_UNAVAILABLE', `HTTP ${rejected.status} code=${code}`);

  // ④ 恢复默认（内置）
  await restartService({});
  await api('POST', '/auth/login', LOGIN).then((r) => { TOKEN = r.json.data.token; });
  const restored = (await api('GET', '/formats')).json.data.formats.find((item) => item.id === 'tarzst');
  check('恢复默认：内置 zstd 重新可用', Boolean(restored && restored.available === true), `available=${restored && restored.available}`);
}

// ===== 单个格式的往返 =====

async function roundTrip(formatId, options = {}) {
  const suffix = options.suffix || '';
  const sourceUser = `${API_WORK}/src`;
  const before = await hashTree(path.join(WORK, 'src'));

  const compressed = await api('POST', '/compress/tasks', { sources: [sourceUser], mode: 'bundle', format: formatId, options: { outputDir: `${API_WORK}/packages` } });
  if (!compressed.json || !compressed.json.ok) return { ok: false, detail: `创建失败 ${JSON.stringify(compressed.json.error)}` };
  const task = await waitTask(compressed.json.data.task.id);
  const pkg = task && task.result && task.result.packages && task.result.packages[0];
  if (!task || task.status !== 'done' || !pkg) return { ok: false, detail: `任务 ${task && task.status} ${task && task.error && task.error.code}` };

  const archiveUser = pkg.outputPath;
  const archiveAbs = path.join(ROOT, ...archiveUser.split('/').filter(Boolean));
  const archiveOk = (await pathExists(archiveAbs)) && archiveAbs.endsWith(FORMATS.find((item) => item.id === formatId).ext);

  const targetUser = `${API_WORK}/out-${formatId}${suffix}`;
  const extracted = await api('POST', '/extract/tasks', { path: archiveUser, targetDir: targetUser });
  if (!extracted.json || !extracted.json.ok) return { ok: false, detail: `解压创建失败 ${JSON.stringify(extracted.json.error)}` };
  const extractTask = await waitTask(extracted.json.data.task.id);
  if (!extractTask || extractTask.status !== 'done') return { ok: false, detail: `解压 ${extractTask && extractTask.status} ${extractTask && extractTask.error && extractTask.error.code}` };

  const after = await hashTree(path.join(ROOT, ...targetUser.split('/').filter(Boolean)));
  const mismatched = [];
  for (const [relative, hash] of before) {
    const actual = after.get(`src/${relative}`) || after.get(relative);
    if (actual !== hash) mismatched.push(relative);
  }
  const same = mismatched.length === 0 && after.size === before.size;
  return {
    ok: same && archiveOk,
    detail: `${before.size - mismatched.length}/${before.size} 一致；产物 ${path.basename(archiveAbs)}；校验 ${pkg.verifyStrategy || '-'}`,
    archiveAbs,
    verifyStrategy: pkg.verifyStrategy,
    entries: pkg.checks,
  };
}

// ===== 主流程 =====

async function main() {
  console.log('ZipCalm M4 验收（tar / tar.gz / tar.zst 多格式 + 注册表 + 回退链 + 版本自检）');
  console.log(`API：${BASE}\n存储根：${ROOT}\n`);

  const login = await api('POST', '/auth/login', LOGIN);
  TOKEN = login.json && login.json.data && login.json.data.token;
  check('登录拿到 Bearer Token', Boolean(TOKEN));

  await prepareFixture(WORK);
  await fsp.mkdir(path.join(WORK, 'packages'), { recursive: true });
  const beforeCount = (await hashTree(path.join(WORK, 'src'))).size;
  console.log(`    假数据：${beforeCount} 个文件（确定性种子）\n`);

  // ① 四格式往返 + 外部交叉验证
  for (const format of FORMATS) {
    const roundTripResult = await roundTrip(format.id);
    check(`往返 hash 逐文件一致（${format.id}）`, roundTripResult.ok, roundTripResult.detail);
    if (roundTripResult.archiveAbs) {
      await verifyWithExternalTools({
        formatId: format.id,
        archiveAbsPath: roundTripResult.archiveAbs,
        workDir: WORK,
        report: reporter,
      });
    }
  }

  // ② zip-slip：四种格式各一组
  const evilRoot = path.join(WORK, 'evil');
  const zipEvil = path.join(evilRoot, 'zip-evil.zip');
  await writeRawZip(zipEvil, [{ name: '../zip-slip-evil.txt' }, { name: '/abs-evil.txt' }]);
  await zipSlipCase('zip', '../ 与绝对路径', zipEvil, [path.join(ROOT, 'zip-slip-evil.txt'), path.join(ROOT, 'abs-evil.txt')]);

  for (const spec of [{ id: 'tar', compression: 'none' }, { id: 'targz', compression: 'gzip' }, { id: 'tarzst', compression: 'zstd' }]) {
    const evilAbs = path.join(evilRoot, `${spec.id}-evil.${spec.compression === 'none' ? 'tar' : spec.compression === 'gzip' ? 'tar.gz' : 'tar.zst'}`);
    await writeRawTar(evilAbs, spec.compression, [
      ['../tar-slip-evil.txt', 'evil'],
      [ABS_PATH_ESCAPE_TARGET, 'evil'], // 绝对路径条目：攻击样本本体
    ]);
    await zipSlipCase(spec.id, '../ 与绝对路径', evilAbs, [path.join(WORK, 'evil', 'tar-slip-evil.txt'), ABS_PATH_ESCAPE_TARGET]);
  }

  // ③ 注册表：加目录即注册 + 复合扩展名
  await casePluginByDirectory();
  await caseExtensionMatching();

  // ④ 启动自检
  await caseNodeVersionGuard();

  // ⑤ zstd 回退链（会重启服务，放最后）
  await caseZstdFallbackChain();

  await cleanupArtefacts();

  const runSummary = reporter.summary({ withSkip: true });
  if (runSummary.fail > 0) process.exitCode = 1;
}

/** 收尾清理：测试产物（存储根下的 /m4-test）与回退链垫片；设 ZIPCALM_M4_KEEP=1 可保留 */
async function cleanupArtefacts() {
  if (process.env.ZIPCALM_M4_KEEP === '1') {
    console.log('（ZIPCALM_M4_KEEP=1：保留测试产物便于人工复核）');
    return;
  }
  await fsp.rm(WORK, { recursive: true, force: true }).catch(() => {});
  const buildDir = path.dirname(await fsp.realpath(path.join(PROJECT_ROOT, 'node_modules')));
  await fsp.rm(path.join(buildDir, 'm4-tmp'), { recursive: true, force: true }).catch(() => {});
}

main().catch(async (error) => {
  console.error(`脚本异常：${error && error.stack ? error.stack : error}`);
  // 异常退出也要把服务恢复到默认环境，避免留下"禁用内置 zstd"的实例
  await execFileAsync('bash', ['-c', 'bash scripts/start.sh restart'], { cwd: PROJECT_ROOT, timeout: SERVICE_RESTART_TIMEOUT_MS }).catch(() => {});
  process.exitCode = 1;
});
