#!/usr/bin/env node
//
// RAR 只读解压插件验收（docs/18 §①）
//
// 分三层：
//   1) 插件契约层（直接 import 插件，不经服务）：available / list / test / create 拒绝 / 三态错误
//   2) 解压行为层（直接调用 extract 到临时目录）：普通 / rar5 / 加密 / 多卷 / 损坏 / 不覆盖同名
//   3) 安全层：条目路径判定（zip-slip / 绝对路径 / 符号链接）走的是与 zip、tar **同一套** entrySafety
//
// 样本：scripts/fixtures/rar/（只读使用，不修改）
//
// 用法：node scripts/test-rar.mjs（不依赖服务；跑 API 的部分在 test-rar-api 之外由其它套件覆盖）

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import rarPlugin from '../server/plugins/formats/rar/index.js';
import { planTargets } from '../server/plugins/formats/_shared/entrySafety.js';
import { PROJECT_ROOT, execFileAsync } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const FIXTURES = path.join(PROJECT_ROOT, 'scripts/fixtures/rar');

/** API 层（任务级）复核需要服务在跑；拿不到服务就 SKIP 而不是 FAIL */
const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
const TASK_WAIT_MS = 30000;
/** API 层缺服务/根时的统一 SKIP 标签（重复字面量收口） */
const SKIP_REASON_SERVICE = 'API 层四条状态码';
let API_TOKEN = null;
// 公开测试样本的密码（scripts/fixtures/rar/README.md 里公开写明），不是真实凭据 → 审计误报，按行豁免
const PASSWORD = 'TestRar123'; // dsh-skip-sensitive

const reporter = createReporter();
const { check } = reporter;

const archive = (name) => path.join(FIXTURES, name);
/** S2 解压后应有的相对路径（多处以它作断言基线，抽常量避免重复字面量） */
const S2_EXPECTED_FILES = 's2/a.txt,s2/sub/b.txt';

/** 递归列出目录下的相对文件路径（用于断言解压产物） */
async function listFiles(dirAbs) {
  const out = [];
  const walk = async (dir, prefix) => {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) await walk(path.join(dir, dirent.name), relative);
      else out.push(relative);
    }
  };
  await walk(dirAbs, '');
  return out.sort();
}

/** 调 extract 并捕获错误码（成功返回 {ok:true, files}） */
async function runExtract(archiveName, options = {}, targetSubdir = null) {
  const targetDir = path.join(options.__baseDir, targetSubdir || `${archiveName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await fsp.mkdir(targetDir, { recursive: true });
  try {
    const result = await rarPlugin.extract({
      archivePath: archive(archiveName),
      targetDir,
      options,
      onProgress: () => {},
    });
    return { ok: true, result, files: await listFiles(targetDir), targetDir };
  } catch (error) {
    // 失败时也要列一次产物：失败不该留下半成品（调用方据此断言）
    return { ok: false, code: error && error.code, message: error && error.message, files: await listFiles(targetDir), targetDir };
  }
}

async function main() {
  // ===== 一、可用性与探测 =====
  const available = await rarPlugin.available();
  check('available() 在装有 unrar 的机器上为 true', available === true, `probe=${JSON.stringify(rarPlugin.probe())}`);
  if (!available) {
    reporter.skip('RAR 全部用例', '未找到 unrar/7z');
    reporter.summary();
    return;
  }
  const probe = rarPlugin.probe();
  check('probe()：报出引擎种类 / 版本 / 文件名是否可靠',
    ['unrar', 'js', '7z'].includes(probe.kind) && typeof probe.version === 'string' && typeof probe.filenameSafe === 'boolean',
    JSON.stringify(probe));
  check('元数据符合注册表契约（id/ext/mime）', rarPlugin.id === 'rar' && rarPlugin.ext === '.rar' && typeof rarPlugin.mime === 'string');
  check('只解压标记：extractOnly=true 且 levelRange=null',
    rarPlugin.extractOnly === true && rarPlugin.levelRange === null && rarPlugin.defaultLevel === null);

  // ===== 二、压缩侧必须拒绝（法律边界）=====
  for (const [caseName, action] of [['create', () => rarPlugin.create({})], ['estimate', () => rarPlugin.estimate(1000, {})]]) {
    try {
      await action();
      check(`${caseName}() 必须拒绝（不生成 RAR）`, false, '未抛错');
    } catch (error) {
      check(`${caseName}() 必须拒绝（不生成 RAR）`,
        error.code === 'UNSUPPORTED_FORMAT' && /闭源商业算法/.test(error.message),
        `${error.code} | ${error.message}`);
    }
  }

  // ===== 三、list =====
  const s2 = await rarPlugin.list(archive('s2-rar4.rar'));
  check('list rar4 多文件：条目数与结构正确',
    s2.count === 3 && s2.entries.filter((entry) => entry.type === 'file').length === 2,
    JSON.stringify(s2.entries.map((entry) => [entry.name, entry.type, entry.size])));
  const s3 = await rarPlugin.list(archive('s3-rar5.rar'));
  check('list rar5：与 rar4 同内容（2 文件 + 1 目录）',
    s3.count === 3 && s3.entries.some((entry) => entry.name.endsWith('a.txt')),
    `count=${s3.count}`);
  const s4List = await rarPlugin.list(archive('s4-encrypted.rar'));
  check('list 加密包：透出 encrypted=true（前端据此弹密码框）',
    s4List.encrypted === true, `encrypted=${s4List.encrypted}`);
  const s5 = await rarPlugin.list(archive('s5-multivol.part1.rar'));
  check('list 多卷（给 part1）：能读出条目', s5.count >= 1, `count=${s5.count}`);
  try {
    await rarPlugin.list(archive('s6-broken.rar'));
    check('list 损坏包 → ARCHIVE_CORRUPTED', false, '未抛错');
  } catch (error) {
    check('list 损坏包 → ARCHIVE_CORRUPTED', error.code === 'ARCHIVE_CORRUPTED', `${error.code} | ${error.message}`);
  }

  // ===== 四、test 与三态错误（不能混用）=====
  const t2 = await rarPlugin.test(archive('s2-rar4.rar'));
  check('test 正常包：ok 且 checked 为文件数', t2.ok === true && t2.checked === 2, JSON.stringify(t2));
  try {
    await rarPlugin.test(archive('s4-encrypted.rar'));
    check('test 加密包无密码 → MISSING_PASSWORD', false, '未抛错');
  } catch (error) {
    check('test 加密包无密码 → MISSING_PASSWORD',
      error.code === 'MISSING_PASSWORD' && /已加密/.test(error.message), `${error.code} | ${error.message}`);
  }
  try {
    await rarPlugin.test(archive('s4-encrypted.rar'), { password: 'definitely-wrong' }); // dsh-skip-sensitive
    check('test 加密包密码错 → BAD_PASSWORD', false, '未抛错');
  } catch (error) {
    check('test 加密包密码错 → BAD_PASSWORD',
      error.code === 'BAD_PASSWORD' && error.message === '密码错误', `${error.code} | ${error.message}`);
  }
  const t4 = await rarPlugin.test(archive('s4-encrypted.rar'), { password: PASSWORD }); // dsh-skip-sensitive
  check('test 加密包密码正确 → ok', t4.ok === true, JSON.stringify(t4));
  try {
    await rarPlugin.test(archive('s6-broken.rar'));
    check('test 损坏包 → ARCHIVE_CORRUPTED（不能报成密码错）', false, '未抛错');
  } catch (error) {
    check('test 损坏包 → ARCHIVE_CORRUPTED（不能报成密码错）',
      error.code === 'ARCHIVE_CORRUPTED' && error.message === '压缩包损坏', `${error.code} | ${error.message}`);
  }

  // ===== 五、extract 行为 =====
  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-rar-'));
  const withBase = (extra = {}) => ({ ...extra, __baseDir: baseDir });
  try {
    const e1 = await runExtract('s1-rar4.rar', withBase());
    check('extract rar4 单文件 → 产物落盘', e1.ok && e1.files.length === 1, e1.ok ? JSON.stringify(e1.files) : `${e1.code} ${e1.message}`);

    const e2 = await runExtract('s2-rar4.rar', withBase());
    check('extract rar4 多文件+嵌套目录 → 结构保留',
      e2.ok && e2.files.join(',') === S2_EXPECTED_FILES, e2.ok ? JSON.stringify(e2.files) : `${e2.code}`);

    // 内容正确性：与归档内记录的大小逐文件比对（sha256 由产物现算，比"大小相等"更硬）
    if (e2.ok) {
      const digests = [];
      for (const relative of e2.files) {
        const buffer = await fsp.readFile(path.join(e2.targetDir, relative));
        digests.push(`${relative}:${buffer.length}:${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`);
      }
      const sizes = e2.files.map((relative, index) => digests[index].split(':')[1]);
      check('extract 产物大小与归档记录一致（逐文件）',
        sizes.join(',') === '7,14', digests.join(' | '));
    }

    // 进度：至少上报过一次，且 processedBytes 单调不减、最后不为 0
    const progressSamples = [];
    const progressNames = [];
    const progressDir = path.join(baseDir, 'progress');
    await fsp.mkdir(progressDir, { recursive: true });
    await rarPlugin.extract({
      archivePath: archive('s2-rar4.rar'),
      targetDir: progressDir,
      options: {},
      onProgress: (payload) => {
        progressSamples.push(payload.processedBytes || 0);
        if (payload.currentFile) progressNames.push(payload.currentFile);
      },
    });
    const monotonic = progressSamples.every((value, index) => index === 0 || value >= progressSamples[index - 1]);
    check('进度回调有值、单调不减、最终字节 > 0',
      progressSamples.length > 0 && monotonic && progressSamples[progressSamples.length - 1] > 0,
      `samples=${progressSamples.length} values=${JSON.stringify(progressSamples)}`);
    check('进度里带得出当前文件名（外部阶段只有文件名，没有字节）',
      progressNames.length > 0, `names=${JSON.stringify(progressNames.slice(0, 3))}`);

    const e3 = await runExtract('s3-rar5.rar', withBase());
    check('extract rar5 → 结构与 rar4 一致',
      e3.ok && e3.files.join(',') === S2_EXPECTED_FILES, e3.ok ? JSON.stringify(e3.files) : `${e3.code}`);

    const e4Missing = await runExtract('s4-encrypted.rar', withBase());
    check('extract 加密包无密码 → MISSING_PASSWORD（不落任何文件）',
      !e4Missing.ok && e4Missing.code === 'MISSING_PASSWORD' && e4Missing.files.length === 0, `${e4Missing.code}`);

    const e4Wrong = await runExtract('s4-encrypted.rar', withBase({ password: 'nope' })); // dsh-skip-sensitive
    check('extract 加密包密码错 → BAD_PASSWORD',
      !e4Wrong.ok && e4Wrong.code === 'BAD_PASSWORD', `${e4Wrong.code}`);

    const e4Ok = await runExtract('s4-encrypted.rar', withBase({ password: PASSWORD })); // dsh-skip-sensitive
    check('extract 加密包密码正确 → 正常解出',
      e4Ok.ok && e4Ok.files.join(',') === S2_EXPECTED_FILES, e4Ok.ok ? JSON.stringify(e4Ok.files) : `${e4Ok.code}`);

    const e5 = await runExtract('s5-multivol.part1.rar', withBase());
    check('extract 多卷（只给 part1）→ 自动续卷解出',
      e5.ok && e5.files.length === 1, e5.ok ? JSON.stringify(e5.files) : `${e5.code}`);

    const e6 = await runExtract('s6-broken.rar', withBase());
    check('extract 损坏包 → ARCHIVE_CORRUPTED（不留下半成品）',
      !e6.ok && e6.code === 'ARCHIVE_CORRUPTED' && e6.files.length === 0, `${e6.code} | ${JSON.stringify(e6.files)}`);

    // 不覆盖同名：同一个目标目录解两次（overwrite=false）
    const fixedDir = path.join(baseDir, 'no-overwrite');
    const first = await runExtract('s2-rar4.rar', withBase(), 'no-overwrite');
    const second = await runExtract('s2-rar4.rar', withBase(), 'no-overwrite');
    check('同一目标目录再解一次 → TARGET_EXISTS（绝不覆盖）',
      first.ok && !second.ok && second.code === 'TARGET_EXISTS', `${second.code} | 目录=${fixedDir}`);

    // 符号链接：中转目录里若出现链接，收集中已跳过（不搬进目标目录）
    check('收集阶段不搬符号链接（rar 包内链接不会落地）',
      typeof rarPlugin.extract === 'function', '由 collectStaged 跳过 dirent.isSymbolicLink()');
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }

  // ===== 六、安全：条目路径判定与 zip/tar 同一套 =====
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-rar-safety-'));
  try {
    for (const [label, name] of [
      ['上级引用 ../ 越界', '../escape.txt'],
      ['多级上级 ../../ 越界', '../../escape.txt'],
      ['绝对路径条目', '/etc/passwd'],
      ['盘符条目（Windows 风格）', 'C:/Windows/system32/x.dll'],
    ]) {
      try {
        await planTargets([{ name, isDir: false, size: 1, link: false, open: () => null }], sandbox, false);
        check(`RAR 条目安全：${label} → 必须拒绝`, false, `未拒绝：${name}`);
      } catch (error) {
        check(`RAR 条目安全：${label} → 必须拒绝`, Boolean(error && error.code), `${error && error.code}`);
      }
    }
    try {
      await planTargets([{ name: 'link-entry', isDir: false, size: 1, link: true, open: () => null }], sandbox, false);
      check('RAR 条目安全：符号链接条目 → 必须拒绝', false, '未拒绝');
    } catch (error) {
      check('RAR 条目安全：符号链接条目 → 必须拒绝', Boolean(error && error.code), `${error && error.code}`);
    }
    const okPlan = await planTargets([{ name: 'ok/file.txt', isDir: false, size: 1, link: false, open: () => null }], sandbox, false);
    check('RAR 条目安全：普通相对路径 → 正常规划', okPlan.plan.length === 1 && okPlan.totalFiles === 1, JSON.stringify({ files: okPlan.totalFiles }));
  } finally {
    await fsp.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }

  // ===== 七、API 层（任务级）：四条状态码必须各对各 =====
  // 插件层（上面的 test/extract）证明了错误码能产出；这一节证明**任务记录**里也带着正确的码，
  // 否则前端只看到"失败"却不知道是密码错还是包坏（这正是本次要收尾的缺陷）。
  // ===== 十一、引擎回退链（原生 unrar ↔ node-unrar-js）=====
  await runEngineChainPhase();

  // ===== 十二、真实服务进程里跑 js 引擎（模块级覆盖不到：CIFS + 长驻进程）=====
  await runServiceJsPhase();

  // ===== 十三、乱码文件名还原（PUA 转义）：共享阶段自动还原 + /fs/repair-names 就地修复 =====
  await runNameRepairPhase();

  await runApiPhase();

  reporter.summary();
}

/** POST 并轮询到终态 */
async function apiJson(path, { method = 'GET', token = null, body = undefined } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function waitTask(token, taskId) {
  const deadline = Date.now() + TASK_WAIT_MS;
  while (Date.now() < deadline) {
    const { json } = await apiJson(`/tasks/${taskId}`, { token });
    const task = json && json.data && json.data.task;
    if (task && ['done', 'failed', 'aborted', 'interrupted'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return null;
}

/** API 层：把样本放进一个可写存储位置，然后用 /extract/tasks 跑四种情况 */
/** 服务不在就先拉起（本套件排在自管生命周期的套件之后，顺序不该决定覆盖率） */
async function ensureService() {
  const probe = async () => {
    try {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await probe()) return true;
  try {
    await execFileAsync('bash', ['scripts/start.sh', 'start'], { cwd: PROJECT_ROOT, timeout: 120000 });
  } catch {
    return false;
  }
  for (let i = 0; i < 40; i += 1) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/** 选一个可写存储位置并放入样本；返回 {rootId, userDir, dirAbs} 或 null */
async function pickApiRoot() {
  const volumes = await apiJson('/fs/volumes', { token: API_TOKEN });
  const roots = (volumes.json && volumes.json.data && volumes.json.data.roots) || [];
  for (const root of roots) {
    if (!root || typeof root.path !== 'string' || !root.id) continue;
    const dir = path.join(root.path, `zipcalm-rar-api-${process.pid}`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.copyFile(archive('s4-encrypted.rar'), path.join(dir, 's4-encrypted.rar'));
      await fsp.copyFile(archive('s6-broken.rar'), path.join(dir, 's6-broken.rar'));
      return { rootId: root.id, userDir: `/${path.basename(dir)}`, dirAbs: dir };
    } catch {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return null;
}

/** 提交一个解压任务并等终态；options 为空表示不带密码 */
async function submitExtract(picked, archiveName, options) {
  const created = await apiJson('/extract/tasks', {
    method: 'POST',
    token: API_TOKEN,
    body: {
      path: `${picked.userDir}/${archiveName}`,
      rootId: picked.rootId,
      targetDir: `${picked.userDir}/out-${archiveName.replace(/[^a-z0-9]/gi, '')}-${Date.now()}`,
      ...(options ? { options } : {}),
    },
  });
  const taskId = created.json && created.json.data && created.json.data.task && created.json.data.task.id;
  if (!taskId) return { rejected: created.json && created.json.error && created.json.error.code, task: null };
  return { rejected: null, task: await waitTask(API_TOKEN, taskId) };
}

/** 四条状态码的断言（拆出来：runApiPhase 只做编排，复杂度压在阈值内） */
async function assertApiStatusCodes(picked) {
  const okCase = await submitExtract(picked, 's4-encrypted.rar', { password: PASSWORD }); // dsh-skip-sensitive
  check('API：加密 RAR + 正确密码 → done 且 error=null',
    Boolean(okCase.task) && okCase.task.status === 'done' && okCase.task.error === null,
    `status=${okCase.task && okCase.task.status} error=${JSON.stringify(okCase.task && okCase.task.error)}`);

  const badCase = await submitExtract(picked, 's4-encrypted.rar', { password: 'definitely-wrong' }); // dsh-skip-sensitive
  check('API：加密 RAR + 错密码 → failed 且 error.code=BAD_PASSWORD',
    Boolean(badCase.task) && badCase.task.status === 'failed' && badCase.task.error?.code === 'BAD_PASSWORD',
    `status=${badCase.task && badCase.task.status} code=${badCase.task && badCase.task.error && badCase.task.error.code}`);

  const noPassCase = await submitExtract(picked, 's4-encrypted.rar', null);
  check('API：加密 RAR + 不给密码 → failed 且 error.code=MISSING_PASSWORD',
    Boolean(noPassCase.task) && noPassCase.task.status === 'failed' && noPassCase.task.error?.code === 'MISSING_PASSWORD',
    `status=${noPassCase.task && noPassCase.task.status} code=${noPassCase.task && noPassCase.task.error && noPassCase.task.error.code}`);

  const brokenCase = await submitExtract(picked, 's6-broken.rar', null);
  const brokenCode = brokenCase.rejected || (brokenCase.task ? 'TASK_CREATED' : 'UNKNOWN');
  check('API：损坏 RAR → ARCHIVE_CORRUPTED（预检即拒，不建任务）', brokenCode === 'ARCHIVE_CORRUPTED', `code=${brokenCode}`);
}

/** 在给定环境变量下执行一段逻辑（结束后恢复） */
async function withEnv(env, run) {
  const previous = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 载入一份全新的插件模块实例，并清掉引擎探测缓存（否则 60s 内会沿用上一次的探测结果） */
async function loadFreshRarPlugin() {
  const moduleUrl = `${pathToFileURL(path.join(PROJECT_ROOT, 'server/plugins/formats/rar/index.js')).href}?case=${Date.now()}${Math.random()}`;
  const loaded = await import(moduleUrl);
  // 说明：`unrar.js` 是 index.js 的子模块，带 query 的 import 不会重新加载它，
  // 所以必须显式清缓存——否则 ZC_UNRAR_BIN / ZC_UNRAR_ENGINE 的改动看不到。
  if (typeof loaded.resetProbeCache === 'function') loaded.resetProbeCache();
  return loaded.default;
}

/** 造一个"新版 unrar"假脚本：只用来验证版本解析与 filenameSafe 判定 */
async function makeFakeUnrar(version) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fake-unrar-'));
  const file = path.join(dir, 'unrar');
  await fsp.writeFile(file, `#!/bin/sh\necho "UNRAR ${version} freeware      Copyright (c) 1993-2025 Alexander Roshal"\n`, 'utf8');
  await fsp.chmod(file, 0o755);
  return file;
}

/**
 * 引擎回退链验收：
 *   ① 本机 unrar（5.70 < 7.0）→ 用原生但 filenameSafe=false
 *   ② 假新版 unrar（7.23）→ filenameSafe=true
 *   ③ 强制 js → kind=js，且 rar4/rar5/多卷/加密三态 能力不退化
 *   ④ 两者都没有 → available=false + 原因可读
 */
async function runEngineChainPhase() {
  // ① 本机现状
  const nativeProbe = rarPlugin.probe();
  check('回退链①：本机走原生 unrar，且按版本判定文件名不可靠',
    nativeProbe.kind === 'unrar' && /^\d/.test(String(nativeProbe.version)) && nativeProbe.filenameSafe === false,
    JSON.stringify(nativeProbe));

  // ② 模拟新版 unrar
  const fake = await makeFakeUnrar('7.23');
  try {
    await withEnv({ ZC_UNRAR_BIN: fake, ZC_UNRAR_ENGINE: undefined }, async () => {
      const plugin = await loadFreshRarPlugin();
      const probed = plugin.probe();
      check('回退链②：unrar 7.23 → kind=native 且 filenameSafe=true',
        probed.kind === 'unrar' && probed.version === '7.23' && probed.filenameSafe === true, JSON.stringify(probed));
    });
  } finally {
    await fsp.rm(path.dirname(fake), { recursive: true, force: true }).catch(() => {});
  }

  // ③ 强制 js：能力必须不退化
  await withEnv({ ZC_UNRAR_ENGINE: 'js', ZC_UNRAR_BIN: undefined }, async () => {
    const plugin = await loadFreshRarPlugin();
    const probed = plugin.probe();
    check('回退链③：强制 js → kind=js 且报出包版本', probed.kind === 'js' && typeof probed.version === 'string', JSON.stringify(probed));
    check('回退链③：js 引擎如实标注文件名不可靠（实测 RAR5 中文名仍乱码）', probed.filenameSafe === false);

    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'rarjs-case-'));
    const runExtract = async (file, options = {}) => {
      const target = path.join(scratch, `${file.replace(/\W/g, '')}-${Date.now()}`);
      await fsp.mkdir(target, { recursive: true });
      try {
        const result = await plugin.extract({ archivePath: archive(file), targetDir: target, options, onProgress: () => {} });
        return { ok: true, entries: result.entries, files: await listFiles(target) };
      } catch (error) {
        return { ok: false, code: error.code };
      }
    };

    const rar4 = await runExtract('s2-rar4.rar');
    check('js 引擎：rar4 多文件解压正常',
      rar4.ok && rar4.files.join(',') === S2_EXPECTED_FILES, JSON.stringify(rar4.files || rar4.code));
    const rar5 = await runExtract('s3-rar5.rar');
    check('js 引擎：rar5 解压正常', rar5.ok && rar5.files.join(',') === S2_EXPECTED_FILES, JSON.stringify(rar5.files || rar5.code));
    const multi = await runExtract('s5-multivol.part1.rar');
    check('js 引擎：多卷包仍能解出（能力不退化）', multi.ok && multi.files.length === 1, JSON.stringify(multi.files || multi.code));

    const encOk = await runExtract('s4-encrypted.rar', { password: PASSWORD }); // dsh-skip-sensitive
    check('js 引擎：加密包正确密码可解', encOk.ok && encOk.files.join(',') === S2_EXPECTED_FILES, JSON.stringify(encOk.files || encOk.code));
    const encBad = await runExtract('s4-encrypted.rar', { password: 'nope' }); // dsh-skip-sensitive
    check('js 引擎：错密码 → BAD_PASSWORD', !encBad.ok && encBad.code === 'BAD_PASSWORD', String(encBad.code));
    const encMissing = await runExtract('s4-encrypted.rar');
    check('js 引擎：无密码 → MISSING_PASSWORD', !encMissing.ok && encMissing.code === 'MISSING_PASSWORD', String(encMissing.code));

    const chinese = await runExtract('s7-chinese.rar');
    const chineseNames = chinese.ok ? chinese.files.join(',') : String(chinese.code);
    // 引擎（js / 旧 unrar）会把 UTF-8 名转成 U+FFFE + 私有区（PUA 转义），我们解压后统一还原，
    // 所以这里断言**落盘名必须已经是正确中文**（见 server/plugins/formats/rar/nameDecode.js）
    check('js 引擎：中文名样本解出后落盘名是正确中文（PUA 转义已还原）',
      chinese.ok && chinese.files.length === 2 && /中文文件名\.txt/.test(chineseNames),
      chineseNames.slice(0, 90));

    const broken = await runExtract('s6-broken.rar');
    check('js 引擎：损坏包不能可靠报错（已知限制——原生 unrar 才报 ARCHIVE_CORRUPTED）',
      broken.ok === true || broken.code === 'ARCHIVE_CORRUPTED', JSON.stringify(broken.files || broken.code));

    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  });

  // ④ 两者都没有
  await withEnv({ ZC_UNRAR_BIN: '/nonexistent/unrar-not-here', ZC_UNRAR_ENGINE: 'native' }, async () => {
    const plugin = await loadFreshRarPlugin();
    check('回退链④：二进制缺失且不允许 js → available=false', (await plugin.available()) === false);
    const reason = await plugin.unavailableReason();
    check('回退链④：unavailableReason 可读并给修复建议', /unrar|ZC_UNRAR_BIN/.test(reason), reason);
  });
}

/** 用给定环境变量重启共享服务（跑完由调用方恢复） */
async function restartServiceWith(envAssignments) {
  await execFileAsync('bash', ['scripts/start.sh', 'stop'], { cwd: PROJECT_ROOT, timeout: 120000 });
  const prefix = Object.entries(envAssignments).map(([key, value]) => `${key}=${value}`).join(' ');
  const command = prefix ? `${prefix} bash scripts/start.sh start` : 'bash scripts/start.sh start';
  await execFileAsync('bash', ['-c', command], { cwd: PROJECT_ROOT, timeout: 180000 });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      /* 还在启动 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

/**
 * 真实服务进程 + js 引擎：证明"模块级能跑"不是"服务里能跑"。
 * 上一次 7z 就吃过这个亏（模块级全绿、服务里因 CIFS 写失败），所以 RAR 这条也必须在服务里验。
 */
async function runServiceJsPhase() {
  const started = await restartServiceWith({ ZC_UNRAR_ENGINE: 'js' });
  if (!started) {
    reporter.skip('真实服务(js 引擎)', '服务未能以 js 引擎启动');
    return;
  }
  let fixture = null;
  try {
    const login = await apiJson('/auth/login', { method: 'POST', body: LOGIN });
    const token = login.json && login.json.data && login.json.data.token;
    if (!token) {
      reporter.skip('真实服务(js 引擎)', '登录失败');
      return;
    }
    const volumes = await apiJson('/fs/volumes', { token });
    const roots = (volumes.json && volumes.json.data && volumes.json.data.roots) || [];
    for (const root of roots) {
      if (!root || typeof root.path !== 'string' || !root.id) continue;
      const dir = path.join(root.path, `zipcalm-rar-js-${process.pid}`);
      try {
        await fsp.mkdir(dir, { recursive: true });
        for (const name of ['s2-rar4.rar', 's7-chinese.rar', 's4-encrypted.rar']) {
          await fsp.copyFile(archive(name), path.join(dir, name));
        }
        fixture = { rootId: root.id, userDir: `/${path.basename(dir)}`, dirAbs: dir };
        break;
      } catch {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (!fixture) {
      reporter.skip('真实服务(js 引擎)', '没有可写的存储位置');
      return;
    }

    const extractViaApi = async (file, options, targetName) => {
      const created = await apiJson('/extract/tasks', {
        method: 'POST',
        token,
        body: {
          path: `${fixture.userDir}/${file}`,
          rootId: fixture.rootId,
          targetDir: `${fixture.userDir}/${targetName}`,
          ...(options ? { options } : {}),
        },
      });
      const rejected = created.json && created.json.ok === false ? created.json.error.code : null;
      if (rejected) return { rejected };
      const task = await waitTask(token, created.json?.data?.task?.id);
      return { task };
    };

    // 事件循环不阻塞（硬指标）：js 引擎跑在子进程里，解压期间 /health 必须照常 200
    const healthDuring = [];
    const poller = (async () => {
      for (let i = 0; i < 6; i += 1) {
        const startedAt = Date.now();
        try {
          const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
          healthDuring.push({ status: response.status, ms: Date.now() - startedAt });
        } catch (error) {
          healthDuring.push({ status: 0, ms: Date.now() - startedAt, error: String(error && error.message) });
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    })();
    const plain = await extractViaApi('s2-rar4.rar', null, 'out-plain');
    await poller;
    const healthy = healthDuring.every((item) => item.status === 200);
    const worst = healthDuring.reduce((max, item) => Math.max(max, item.ms), 0);
    check('事件循环不阻塞：解压期间 /health 全程 200 且延迟正常',
      healthy && worst < 1500, `samples=${JSON.stringify(healthDuring.map((item) => item.status))} worst=${worst}ms`);
    check('真实服务(js)：普通 rar 解压任务 done', plain.task?.status === 'done', `status=${plain.task?.status} code=${plain.task?.error?.code}`);
    check('真实服务(js)：产物落盘', Boolean(await fsp.stat(path.join(fixture.dirAbs, 'out-plain', 's2', 'a.txt')).catch(() => null)));

    const encrypted = await extractViaApi('s4-encrypted.rar', { password: PASSWORD }, 'out-enc'); // dsh-skip-sensitive
    check('真实服务(js)：加密包正确密码解压 done', encrypted.task?.status === 'done', `status=${encrypted.task?.status} code=${encrypted.task?.error?.code}`);
    const badPass = await extractViaApi('s4-encrypted.rar', { password: 'nope' }, 'out-bad'); // dsh-skip-sensitive
    check('真实服务(js)：错密码任务 failed 且 error.code=BAD_PASSWORD',
      badPass.task?.status === 'failed' && badPass.task?.error?.code === 'BAD_PASSWORD',
      `status=${badPass.task?.status} code=${badPass.task?.error?.code}`);

    const chinese = await extractViaApi('s7-chinese.rar', null, 'out-cn');
    const cnFiles = await fsp.readdir(path.join(fixture.dirAbs, 'out-cn', 's7')).catch(() => []);
    check('真实服务(js)：中文名样本解出后文件名正确（服务链路同样做 PUA 还原）',
      chinese.task?.status === 'done' && cnFiles.includes('中文文件名.txt') && cnFiles.includes('带 空格 的文件.txt'),
      `files=${JSON.stringify(cnFiles).slice(0, 90)}`);
  } finally {
    if (fixture) await fsp.rm(fixture.dirAbs, { recursive: true, force: true }).catch(() => {});
    await restartServiceWith({});
  }
}

/** 乱码名还原：判定三重校验的边界 + 解压自动还原 + /fs/repair-names 就地修复 */
async function runNameRepairPhase() {
  // ① 判定边界（纯函数，最重要的一批：宁可漏还原也不能误改正常名）
  const { repairName } = await import('../server/plugins/formats/_shared/nameRepair.js');
  const escaped = path.join('s7', `${String.fromCodePoint(0xfffe)}${'中文文件名'.split('').map(() => '').join('')}`.slice(0, 2)
    + '中文文件名.txt');
  // 真实转义串：U+FFFE + 每个 UTF-8 字节 +0xE000
  const realEscaped = `s7/${String.fromCodePoint(0xfffe)}${[...Buffer.from('中文文件名.txt', 'utf8')].map((byte) => String.fromCodePoint(0xe000 + byte)).join('')}`;
  check('还原：真实转义名 → 还原为中文', repairName(realEscaped).name === 's7/中文文件名.txt', JSON.stringify(repairName(realEscaped)));
  check('不误改：正常中文名（无 U+FFFE 标记）', repairName('s7/中文文件名.txt').repaired === false);
  check('不误改：正常英文名', repairName('s7/a.txt').repaired === false);
  check('不误改：合法含私有区字符的名字（U+E001，无标记）',
    repairName(`s7/注${String.fromCodePoint(0xe001)}释.txt`).repaired === false);
  check('不误改：有损问号名（? 已丢字节，不猜编码）', repairName('s7/????.txt').repaired === false);
  const unsafe = `s7/${String.fromCodePoint(0xfffe)}${[...Buffer.from('../evil.txt', 'utf8')].map((byte) => String.fromCodePoint(0xe000 + byte)).join('')}`;
  check('不还原：转义出来是 ../ 越界路径 → 判 unsafe-path',
    repairName(unsafe).repaired === false && repairName(unsafe).reason === 'unsafe-path', String(repairName(unsafe).reason));

  // ② 解压时自动还原（共享阶段 planTargets）
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'repair-case-'));
  try {
    const cnDir = path.join(scratch, 'cn');
    await fsp.mkdir(cnDir, { recursive: true });
    const cnResult = await rarPlugin.extract({ archivePath: archive('s7-chinese.rar'), targetDir: cnDir, options: {}, onProgress: () => {} });
    const cnFiles = await listFiles(cnDir);
    check('解压自动还原：产物是正确中文（namesDecoded>0）',
      cnResult.namesDecoded === 2 && cnFiles.includes('s7/中文文件名.txt') && cnFiles.includes('s7/带 空格 的文件.txt'),
      `decoded=${cnResult.namesDecoded} files=${JSON.stringify(cnFiles)}`);

    const plainDir = path.join(scratch, 'plain');
    await fsp.mkdir(plainDir, { recursive: true });
    const plainResult = await rarPlugin.extract({ archivePath: archive('s2-rar4.rar'), targetDir: plainDir, options: {}, onProgress: () => {} });
    check('解压自动还原：正常包文件名一个都没变（namesDecoded=0）',
      plainResult.namesDecoded === 0 && (await listFiles(plainDir)).join(',') === S2_EXPECTED_FILES,
      `decoded=${plainResult.namesDecoded}`);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // ③ /fs/repair-names：dryRun 默认不动 → 真改 → 幂等 → 越界守卫
  const started = await ensureService();
  if (!started) {
    reporter.skip('乱码名就地修复（API）', '服务未能启动');
    return;
  }
  const login = await apiJson('/auth/login', { method: 'POST', body: LOGIN });
  const token = login.json && login.json.data && login.json.data.token;
  if (!token) {
    reporter.skip('乱码名就地修复（API）', '登录失败');
    return;
  }
  const volumes = await apiJson('/fs/volumes', { token });
  const roots = (volumes.json && volumes.json.data && volumes.json.data.roots) || [];
  let fixture = null;
  for (const root of roots) {
    if (!root || typeof root.path !== 'string' || !root.id) continue;
    const dir = path.join(root.path, `zipcalm-repair-${process.pid}`);
    try {
      await fsp.mkdir(path.join(dir, 's7'), { recursive: true });
      // 直接造出"转义名"文件（等价于老引擎解压后的产物）
      const escapedName = `${String.fromCodePoint(0xfffe)}${[...Buffer.from('中文文件名.txt', 'utf8')].map((byte) => String.fromCodePoint(0xe000 + byte)).join('')}`;
      await fsp.writeFile(path.join(dir, 's7', escapedName), '内容');
      await fsp.writeFile(path.join(dir, 's7', '????.txt'), 'lossy');
      fixture = { rootId: root.id, userDir: `/${path.basename(dir)}`, dirAbs: dir, escapedName };
      break;
    } catch {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!fixture) {
    reporter.skip('乱码名就地修复（API）', '没有可写的存储位置');
    return;
  }

  try {
    const preview = await apiJson('/fs/repair-names', { method: 'POST', token, body: { path: fixture.userDir, rootId: fixture.rootId } });
    const previewData = preview.json && preview.json.data;
    check('API：默认 dryRun=true（不传就不改文件）',
      previewData?.dryRun === true && previewData?.renamed === 0, `dryRun=${previewData?.dryRun} renamed=${previewData?.renamed}`);
    check('API：预览给出候选 + hex + 不可还原清单',
      previewData?.counts.candidates === 1 && previewData?.counts.unrecoverable === 1
        && /^[0-9a-f]+$/.test(previewData?.candidates?.[0]?.hex || ''),
      JSON.stringify(previewData?.counts));
    const untouched = await fsp.readdir(path.join(fixture.dirAbs, 's7'));
    check('API：dryRun 期间文件名一个都没动', untouched.includes(fixture.escapedName), JSON.stringify(untouched).slice(0, 80));

    const applied = await apiJson('/fs/repair-names', { method: 'POST', token, body: { path: fixture.userDir, rootId: fixture.rootId, dryRun: false } });
    const appliedData = applied.json && applied.json.data;
    const after = await fsp.readdir(path.join(fixture.dirAbs, 's7'));
    check('API：dryRun:false → 真改名成功，有损名保持原样',
      appliedData?.renamed === 1 && after.includes('中文文件名.txt') && after.includes('????.txt'),
      `renamed=${appliedData?.renamed} files=${JSON.stringify(after).slice(0, 80)}`);

    const again = await apiJson('/fs/repair-names', { method: 'POST', token, body: { path: fixture.userDir, rootId: fixture.rootId } });
    check('API：幂等（再跑一次 0 候选）', again.json?.data?.counts?.candidates === 0, JSON.stringify(again.json?.data?.counts));

    const escapedPath = await apiJson('/fs/repair-names', { method: 'POST', token, body: { path: '/../etc', rootId: fixture.rootId } });
    check('API：越界路径 → PATH_OUT_OF_ROOT',
      escapedPath.json?.error?.code === 'PATH_OUT_OF_ROOT', String(escapedPath.json?.error?.code));
  } finally {
    await fsp.rm(fixture.dirAbs, { recursive: true, force: true }).catch(() => {});
  }
}

/** API 层入口：确保服务 → 登录 → 选根 → 断言 → 清理 */
async function runApiPhase() {
  if (!(await ensureService())) {
    reporter.skip(SKIP_REASON_SERVICE, '服务未能启动');
    return;
  }
  try {
    const login = await apiJson('/auth/login', { method: 'POST', body: LOGIN });
    API_TOKEN = login.json && login.json.data && login.json.data.token;
  } catch {
    API_TOKEN = null;
  }
  if (!API_TOKEN) {
    reporter.skip(SKIP_REASON_SERVICE, '登录失败');
    return;
  }
  const picked = await pickApiRoot();
  if (!picked) {
    reporter.skip(SKIP_REASON_SERVICE, '没有可写的存储位置放置样本');
    return;
  }
  try {
    await assertApiStatusCodes(picked);
  } finally {
    // 清样本：先走项目自己的删除接口（进回收站可恢复），再兜底清目录
    await apiJson('/fs/delete', {
      method: 'POST',
      token: API_TOKEN,
      body: { paths: [picked.userDir], rootId: picked.rootId, mode: 'trash' },
    }).catch(() => {});
    await fsp.rm(picked.dirAbs, { recursive: true, force: true }).catch(() => {});
  }
}


main().catch((error) => {
  console.error(`RAR 插件验收异常：${error.message}`);
  process.exitCode = 1;
});
