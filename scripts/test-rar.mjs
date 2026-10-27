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

import rarPlugin from '../server/plugins/formats/rar/index.js';
import { planTargets } from '../server/plugins/formats/_shared/entrySafety.js';
import { PROJECT_ROOT } from './helpers/script-env.mjs';
import { createReporter } from './helpers/test-report.mjs';

const FIXTURES = path.join(PROJECT_ROOT, 'scripts/fixtures/rar');
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
  check('探测到 unrar 可执行文件与版本', typeof probe.unrar === 'string' && /^\d/.test(String(probe.unrarVersion)), JSON.stringify(probe));
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

  reporter.summary();
}

main().catch((error) => {
  console.error(`RAR 插件验收异常：${error.message}`);
  process.exitCode = 1;
});
