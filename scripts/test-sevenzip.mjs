#!/usr/bin/env node
//
// 7z 格式包验收（docs/18 7z 条目）
//
// 三层：
//   1) 插件层：available/probe（用哪个引擎）、create/list/test/extract、压缩级别、加密三态
//   2) 安全层：条目路径判定（zip-slip / 绝对路径 / 符号链接 / 不覆盖）走共享 entrySafety
//   3) API 层：/formats 里 7z 出现且**不是** extractOnly（RAR 仍是）、建任务 → 产物落盘 → 解压回读
//
// 用法：node scripts/test-sevenzip.mjs（API 层需服务在跑；不在则 SKIP 该层）

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import sevenZip from '../server/plugins/formats/sevenzip/index.js';
import { resetProbeCache } from '../server/plugins/formats/sevenzip/engine.js';
import { planTargets } from '../server/plugins/formats/_shared/entrySafety.js';
import { PROJECT_ROOT, execFileAsync } from './helpers/script-env.mjs';
import { loadRuntimeConfig } from './helpers/test-config.mjs';
import { createReporter } from './helpers/test-report.mjs';

const runtimeConfig = await loadRuntimeConfig(PROJECT_ROOT);
const PORT = process.env.ZIPCALM_PORT || (runtimeConfig.server && runtimeConfig.server.port) || 3010;
const BASE = process.env.ZIPCALM_BASE || `http://127.0.0.1:${PORT}/api/v1`;
const LOGIN = { username: process.env.ZIPCALM_TEST_USER || 'admin', password: process.env.ZIPCALM_TEST_PASSWORD || 'zipcalm' };
const TASK_WAIT_MS = 60000;
/** 级别对比用的重复文本行数（放大到能看出 -mx0 与 -mx9 的体积差） */
const LEVEL_PROBE_LINES = 5000;
/** 测试夹具的源目录名（多处复用，避免重复字面量） */
const FIXTURE_SRC_NAME = 'src with space';
const ZIP7_PASSWORD = 'SevenZip123'; // 测试用固定密码（非真实凭据） // dsh-skip-sensitive

const reporter = createReporter();
const { check } = reporter;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

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

/** 用系统 7z 独立验证产物（不经我们的代码） */
async function runNative(args) {
  try {
    const { stdout } = await execFileAsync('/bin/7z', args, { timeout: 120000 });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code || 1, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function apiJson(pathname, { method = 'GET', token = null, body = undefined } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
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

async function ensureService() {
  const probe = async () => {
    try {
      return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) })).ok;
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

async function main() {
  // ===== 一、引擎与可用性 =====
  const available = await sevenZip.available();
  check('available() 为 true（本机有系统 7z）', available === true);
  if (!available) {
    reporter.skip('7z 全部用例', await sevenZip.unavailableReason());
    reporter.summary();
    return;
  }
  const probe = sevenZip.probe();
  check('三级回退①：走系统二进制且能报出版本',
    probe.kind === 'native' && typeof probe.bin === 'string' && /^\d/.test(String(probe.version)),
    `kind=${probe.kind} bin=${probe.bin} version=${probe.version} wasm=${probe.wasmPackage}`);
  check('元数据：双向格式（无 extractOnly）、级别 0-9、默认 5',
    sevenZip.extractOnly !== true && JSON.stringify(sevenZip.levelRange) === '[0,9]' && sevenZip.defaultLevel === 5,
    JSON.stringify({ extractOnly: sevenZip.extractOnly, levelRange: sevenZip.levelRange, defaultLevel: sevenZip.defaultLevel }));

  const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-7z-'));
  const srcDir = path.join(baseDir, FIXTURE_SRC_NAME);
  const cnDir = path.join(baseDir, '中文目录');
  try {
    await fsp.mkdir(path.join(srcDir, 'sub'), { recursive: true });
    await fsp.mkdir(cnDir, { recursive: true });
    await fsp.writeFile(path.join(srcDir, 'a.txt'), 'hello-7z');
    await fsp.writeFile(path.join(srcDir, 'sub', 'b.txt'), 'nested-content');
    await fsp.writeFile(path.join(srcDir, 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 7));
    await fsp.writeFile(path.join(cnDir, '中文 文件名.txt'), '中文内容');

    // ===== 二、压缩 + 独立校验 =====
    const archive = path.join(baseDir, 'out.7z');
    const created = await sevenZip.create({
      sources: [{ absPath: srcDir, name: FIXTURE_SRC_NAME, kind: 'dir' }],
      tempPath: archive,
      options: { level: 5 },
      onProgress: () => {},
    });
    check('create：进包条目数与源一致、返回 entryPaths',
      created.entryPaths.length === 3 && created.skippedSymlinks === 0,
      `entries=${created.entryPaths.length} bytesIn=${created.bytesIn}`);

    const nativeList = await runNative(['l', '-slt', archive]);
    check('系统 7z 能列出产物（独立验证，不经我们的代码）',
      nativeList.code === 0 && nativeList.stdout.includes('src with space/a.txt'), `exit=${nativeList.code}`);
    const nativeTest = await runNative(['t', '-y', archive]);
    check('系统 7z t 校验通过', nativeTest.code === 0, `exit=${nativeTest.code}`);

    const listed = await sevenZip.list(archive);
    check('list：条目数正确且不误报加密',
      listed.count === 3 && listed.encrypted === false, `count=${listed.count} encrypted=${listed.encrypted}`);

    // ===== 三、解压回读 + 内容一致（逐文件 sha256）=====
    const outDir = path.join(baseDir, 'out-dir');
    await fsp.mkdir(outDir, { recursive: true });
    const extracted = await sevenZip.extract({ archivePath: archive, targetDir: outDir, options: {}, onProgress: () => {} });
    const files = await listFiles(outDir);
    check('extract：目录结构保留（含带空格目录名）',
      files.join(',') === 'src with space/a.txt,src with space/big.bin,src with space/sub/b.txt',
      JSON.stringify(files));
    const original = await fsp.readFile(path.join(srcDir, 'sub', 'b.txt'));
    const restored = await fsp.readFile(path.join(outDir, FIXTURE_SRC_NAME, 'sub', 'b.txt'));
    check('extract：内容逐字节一致（sha256）', sha256(original) === sha256(restored), `entries=${extracted.entries}`);

    // ===== 四、压缩级别真的透传（-mx0 vs -mx9 体积应有明显差异）=====
    const lv0 = path.join(baseDir, 'lv0.7z');
    const lv9 = path.join(baseDir, 'lv9.7z');
    const textSrc = path.join(baseDir, 'textsrc');
    await fsp.mkdir(textSrc, { recursive: true });
    await fsp.writeFile(path.join(textSrc, 'repeat.txt'), 'zipcalm-7z-level-probe\n'.repeat(LEVEL_PROBE_LINES));
    await sevenZip.create({ sources: [{ absPath: textSrc, name: 'textsrc', kind: 'dir' }], tempPath: lv0, options: { level: 0 }, onProgress: () => {} });
    await sevenZip.create({ sources: [{ absPath: textSrc, name: 'textsrc', kind: 'dir' }], tempPath: lv9, options: { level: 9 }, onProgress: () => {} });
    const [size0, size9] = await Promise.all([fsp.stat(lv0), fsp.stat(lv9)]);
    check('压缩级别透传：-mx0 与 -mx9 产物大小明显不同',
      size0.size > size9.size * 2, `mx0=${size0.size} mx9=${size9.size}`);

    // ===== 五、中文名 + 空格名 =====
    const cnArchive = path.join(baseDir, 'cn.7z');
    await sevenZip.create({ sources: [{ absPath: cnDir, name: '中文目录', kind: 'dir' }], tempPath: cnArchive, options: { level: 5 }, onProgress: () => {} });
    const cnOut = path.join(baseDir, 'cn-out');
    await fsp.mkdir(cnOut, { recursive: true });
    await sevenZip.extract({ archivePath: cnArchive, targetDir: cnOut, options: {}, onProgress: () => {} });
    const cnFiles = await listFiles(cnOut);
    check('中文目录名 + 中文/空格文件名往返不乱码',
      cnFiles.join(',') === '中文目录/中文 文件名.txt', JSON.stringify(cnFiles));

    // ===== 六、加密三态 =====
    const encArchive = path.join(baseDir, 'enc.7z');
    await sevenZip.create({
      sources: [{ absPath: srcDir, name: FIXTURE_SRC_NAME, kind: 'dir' }],
      tempPath: encArchive,
      options: { level: 5, password: ZIP7_PASSWORD },
      onProgress: () => {},
    });
    const encProbe = await sevenZip.probeEncryption(encArchive);
    check('加密包：probeEncryption 返回 encrypted=true', encProbe.encrypted === true, `encrypted=${encProbe.encrypted} isAes=${encProbe.isAes}`);
    for (const [label, call, expected] of [
      ['无密码', () => sevenZip.test(encArchive), 'MISSING_PASSWORD'],
      ['错密码', () => sevenZip.test(encArchive, { password: 'wrong-pass' }), 'BAD_PASSWORD'], // dsh-skip-sensitive
    ]) {
      try {
        await call();
        check(`加密包 ${label} → ${expected}`, false, '未抛错');
      } catch (error) {
        check(`加密包 ${label} → ${expected}`, error.code === expected, `${error.code} | ${error.message}`);
      }
    }
    const encOk = await sevenZip.test(encArchive, { password: ZIP7_PASSWORD });
    check('加密包 正确密码 → test 通过', encOk.ok === true, JSON.stringify(encOk));
    const encVerified = await sevenZip.verifyWithPassword(encArchive, ZIP7_PASSWORD);
    check('verifyWithPassword：正确密码返回 ok（供编排层校验阶段使用）', encVerified.ok === true, JSON.stringify(encVerified));
    const encVerifiedBad = await sevenZip.verifyWithPassword(encArchive, 'wrong-pass');
    check('verifyWithPassword：错密码带 BAD_PASSWORD（不收敛成 VERIFY_FAILED）',
      encVerifiedBad.ok === false && encVerifiedBad.code === 'BAD_PASSWORD', JSON.stringify(encVerifiedBad));

    // ===== 七、损坏包 =====
    const brokenPath = path.join(baseDir, 'broken.7z');
    const goodBuffer = await fsp.readFile(archive);
    await fsp.writeFile(brokenPath, goodBuffer.subarray(0, 60));
    try {
      await sevenZip.test(brokenPath);
      check('损坏包 → ARCHIVE_CORRUPTED', false, '未抛错');
    } catch (error) {
      check('损坏包 → ARCHIVE_CORRUPTED', error.code === 'ARCHIVE_CORRUPTED', `${error.code} | ${error.message}`);
    }

    // ===== 八、三级回退 =====
    process.env.ZC_7Z_BIN = '/nonexistent/7z-does-not-exist';
    resetProbeCache();
    const degraded = await sevenZip.available();
    const degradedReason = await sevenZip.unavailableReason();
    check('回退③：ZC_7Z_BIN 指向不存在且无 WASM 引擎 → available=false',
      degraded === false, `available=${degraded}`);
    check('回退③：unavailableReason 可读且给修复建议',
      /7z|ZC_7Z_BIN/.test(degradedReason), degradedReason);
    delete process.env.ZC_7Z_BIN;
    resetProbeCache();
    check('恢复默认后 available 回到 true', (await sevenZip.available()) === true);

    // ===== 九、安全：条目路径判定（与 zip/tar/rar 同一套）=====
    const sandbox = path.join(baseDir, 'safety');
    await fsp.mkdir(sandbox, { recursive: true });
    for (const [label, name] of [['../ 越界', '../escape.txt'], ['多级越界', '../../escape.txt'], ['绝对路径', '/etc/passwd']]) {
      try {
        await planTargets([{ name, isDir: false, size: 1, link: false, open: () => null }], sandbox, false);
        check(`条目安全：${label} → 必须拒绝`, false, '未拒绝');
      } catch (error) {
        check(`条目安全：${label} → 必须拒绝`, Boolean(error && error.code), `${error && error.code}`);
      }
    }
    try {
      await planTargets([{ name: 'link', isDir: false, size: 1, link: true, open: () => null }], sandbox, false);
      check('条目安全：符号链接 → 必须拒绝', false, '未拒绝');
    } catch (error) {
      check('条目安全：符号链接 → 必须拒绝', Boolean(error && error.code), `${error && error.code}`);
    }
    // 不覆盖同名：同一目标目录解两次
    const twiceDir = path.join(baseDir, 'twice');
    await fsp.mkdir(twiceDir, { recursive: true });
    await sevenZip.extract({ archivePath: archive, targetDir: twiceDir, options: {}, onProgress: () => {} });
    try {
      await sevenZip.extract({ archivePath: archive, targetDir: twiceDir, options: {}, onProgress: () => {} });
      check('不覆盖同名：同目录再解一次 → TARGET_EXISTS', false, '未抛错');
    } catch (error) {
      check('不覆盖同名：同目录再解一次 → TARGET_EXISTS', error.code === 'TARGET_EXISTS', `${error.code}`);
    }
  } finally {
    await fsp.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }

  // ===== 十、API 层：格式列表与端到端任务 =====
  await runApiPhase();

  reporter.summary();
}

/** API 层：/formats 里的 7z 与 RAR 语义、建任务 → 产物 → 解压回读 */
async function runApiPhase() {
  if (!(await ensureService())) {
    reporter.skip('API 层 7z 端到端', '服务未能启动');
    return;
  }
  const login = await apiJson('/auth/login', { method: 'POST', body: LOGIN });
  const token = login.json && login.json.data && login.json.data.token;
  if (!token) {
    reporter.skip('API 层 7z 端到端', '登录失败');
    return;
  }

  const formats = await apiJson('/formats', { token });
  const list = (formats.json && formats.json.data && formats.json.data.formats) || [];
  const sevenItem = list.find((item) => item.id === '7z');
  const rarItem = list.find((item) => item.id === 'rar');
  check('API：/formats 含 7z 且不是 extractOnly（应出现在压缩列表）',
    Boolean(sevenItem) && sevenItem.extractOnly !== true && sevenItem.available === true,
    JSON.stringify(sevenItem && { available: sevenItem.available, extractOnly: sevenItem.extractOnly }));
  check('API：RAR 仍是 extractOnly（压缩列表里不能出现）',
    Boolean(rarItem) && rarItem.extractOnly === true, `extractOnly=${rarItem && rarItem.extractOnly}`);

  // 选一个可写存储位置做端到端
  const volumes = await apiJson('/fs/volumes', { token });
  const roots = (volumes.json && volumes.json.data && volumes.json.data.roots) || [];
  let picked = null;
  for (const root of roots) {
    if (!root || typeof root.path !== 'string' || !root.id) continue;
    const dir = path.join(root.path, `zipcalm-7z-api-${process.pid}`);
    try {
      await fsp.mkdir(path.join(dir, 'src'), { recursive: true });
      await fsp.writeFile(path.join(dir, 'src', 'e2e.txt'), 'sevenzip-e2e');
      picked = { rootId: root.id, userDir: `/${path.basename(dir)}`, dirAbs: dir };
      break;
    } catch {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!picked) {
    reporter.skip('API 层 7z 端到端', '没有可写的存储位置');
    return;
  }

  try {
    const created = await apiJson('/compress/tasks', {
      method: 'POST',
      token,
      body: {
        sources: [`${picked.userDir}/src`],
        format: '7z',
        mode: 'bundle',
        rootId: picked.rootId,
        options: { keepOriginal: true, level: 5 },
      },
    });
    const createTask = await waitTask(token, created.json?.data?.task?.id);
    check('API：用 7z 建压缩任务 → done',
      Boolean(createTask) && createTask.status === 'done',
      `status=${createTask && createTask.status} code=${createTask && createTask.error && createTask.error.code}`);

    const producedPath = path.join(picked.dirAbs, 'src.7z');
    const produced = await fsp.stat(producedPath).catch(() => null);
    check('API：7z 产物落盘', Boolean(produced) && produced.size > 0, producedPath);

    const extractTask = await apiJson('/extract/tasks', {
      method: 'POST',
      token,
      body: {
        path: `${picked.userDir}/src.7z`,
        rootId: picked.rootId,
        targetDir: `${picked.userDir}/out`,
      },
    });
    const extractDone = await waitTask(token, extractTask.json?.data?.task?.id);
    check('API：解压自家 7z → done',
      Boolean(extractDone) && extractDone.status === 'done',
      `status=${extractDone && extractDone.status} code=${extractDone && extractDone.error && extractDone.error.code}`);
    const roundTrip = await fsp.readFile(path.join(picked.dirAbs, 'out', 'src', 'e2e.txt'), 'utf8').catch(() => null);
    check('API：解压内容与源一致', roundTrip === 'sevenzip-e2e', String(roundTrip));
  } finally {
    await apiJson('/fs/delete', {
      method: 'POST',
      token,
      body: { paths: [picked.userDir], rootId: picked.rootId, mode: 'trash' },
    }).catch(() => {});
    await fsp.rm(picked.dirAbs, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`7z 验收异常：${error.message}`);
  process.exitCode = 1;
});
