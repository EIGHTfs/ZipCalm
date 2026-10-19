#!/usr/bin/env node
//
// 群晖系统回收站模块单测（server/core/fs/systemTrash.js）
//
// 只测这个模块，不碰 deleter.js / 配置 / 路由。夹具全部自建自清，且**只在自己的临时目录里**操作。
//
// 覆盖：
//   - toSharePath 的边界（/volume10 两位数卷号、@appdata、#recycle、卷根、共享根、非 /volumeN）
//   - detect() 本机可用性
//   - unlinkFile 真删一个自建文件 → ok + 原位消失
//   - unlinkFile 传 @appdata → not_in_share（**不执行**）
//   - unlinkFile 传不存在文件 → not_found
//   - unlinkFile 传目录 → is_directory（防止用错命令）
//   - rmdirDir 真删一个自建目录 → ok + 原位消失
//   - 失败路径（假二进制 /bin/false）→ command_failed 且**文件仍在**（绝不能变成真删）
//
// 用法：node scripts/test-system-trash.mjs

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detect, rmdirDir, toSharePath, unlinkFile } from '../server/core/fs/systemTrash.js';

/** 夹具放在一个真实共享里（/volume1/VirtualDSM 是本机确认可写的共享） */
const FIXTURE_ROOT = '/volume1/VirtualDSM';
const FIXTURE_NAME = `zipcalm-systemtrash-test-${process.pid}-${Date.now()}`;
const FIXTURE_DIR = path.join(FIXTURE_ROOT, FIXTURE_NAME);
/** 群晖回收站根（权限放开时可读）：夹具被删进这里后，finally 必须把那一份也清掉 */
const RECYCLE_ROOT = path.join(FIXTURE_ROOT, '#recycle');
const RECYCLE_COPY = path.join(RECYCLE_ROOT, FIXTURE_NAME);

/**
 * 清理：先删原路径，再删回收站里那份（**这是本次修的重点**）。
 * 为什么必须删回收站那份：夹具是"删进系统回收站"来验证功能的，原路径已经不存在，
 * 只删原路径等于把垃圾永久留在用户的 File Station 回收站里 —— 测试污染用户环境。
 * 两处都删不掉时**明确打印清理提示**，不静默留垃圾。
 */
async function cleanupFixture() {
  const leftovers = [];
  await fsp.rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
  try {
    if (fs.existsSync(RECYCLE_COPY)) await fsp.rm(RECYCLE_COPY, { recursive: true, force: true });
  } catch (error) {
    leftovers.push(`${RECYCLE_COPY}（${error.code || error.message}）`);
  }
  // 兜底检查：回收站里是否还有本测试前缀的条目
  try {
    for (const name of await fsp.readdir(RECYCLE_ROOT)) {
      if (name.startsWith('zipcalm-systemtrash-test-')) {
        const full = path.join(RECYCLE_ROOT, name);
        if (full !== RECYCLE_COPY) leftovers.push(full);
      }
    }
  } catch {
    // 回收站不可读：无从检查（不算失败，但下面的提示会说明）
  }
  return leftovers;
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`PASS | ${name}${detail ? ` | ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ''}`);
  }
}

let cleanupLeftovers = [];

async function main() {
  // ===== toSharePath 边界 =====
  const cases = [
    ['/volume1/VirtualDSM/photos/a.jpg', { share: 'VirtualDSM', rpath: '/photos/a.jpg' }, '普通文件'],
    ['/volume2/backup/x.tar', { share: 'backup', rpath: '/x.tar' }, '另一个卷'],
    ['/volume10/data/f', { share: 'data', rpath: '/f' }, '两位数卷号'],
    ['/volume1/@appdata/x', null, '@ 开头不是共享'],
    ['/volume1/#recycle/x', null, '# 开头不是共享'],
    ['/volume1', null, '卷根'],
    ['/volume1/VirtualDSM', null, '共享根本身不删'],
    ['/xxx/not-volume/a', null, '不在 /volumeN 下'],
    ['/volume1/VirtualDSM/DeepSeekHarness/工作区/ZipCalm/storage/trash/x', { share: 'VirtualDSM', rpath: '/DeepSeekHarness/工作区/ZipCalm/storage/trash/x' }, '深层路径'],
  ];
  for (const [input, expected, label] of cases) {
    const actual = toSharePath(input);
    check(`toSharePath ${label}（${input}）`, JSON.stringify(actual) === JSON.stringify(expected), `→ ${JSON.stringify(actual)}`);
  }

  // ===== detect =====
  const detected = detect();
  check('detect() 返回结构完整', typeof detected.available === 'boolean' && 'binary' in detected, JSON.stringify(detected));
  if (!detected.available) {
    console.log('SKIP | 本机没有 /usr/syno/bin/synorecycle，跳过真实删除相关用例（非群晖环境属预期）');
    console.log(`\nPASS ${pass} / FAIL ${fail}`);
    return;
  }
  check('detect() 在群晖上可用', detected.available === true && detected.binary === '/usr/syno/bin/synorecycle', detected.binary);

  // ===== 夹具 =====
  await fsp.mkdir(path.join(FIXTURE_DIR, 'sub'), { recursive: true });
  const targetFile = path.join(FIXTURE_DIR, 'probe.txt');
  const nestedFile = path.join(FIXTURE_DIR, 'sub', 'nested.txt');
  const targetDir = path.join(FIXTURE_DIR, 'sub');
  await fsp.writeFile(targetFile, 'zipcalm-system-trash-probe', 'utf8');

  try {
    // 1) 文件 → 系统回收站
    const unlinked = await unlinkFile(targetFile);
    check('unlinkFile 自建文件 → ok', unlinked.ok === true, JSON.stringify(unlinked));
    check('unlinkFile 后原位置确实消失', fs.existsSync(targetFile) === false);

    // 2) @appdata 下：必须在解析阶段就拒绝（不执行命令）
    const notShare = await unlinkFile('/volume1/@appdata/does-not-matter.txt');
    check('unlinkFile @appdata → not_in_share', notShare.ok === false && notShare.reason === 'not_in_share', JSON.stringify(notShare));

    // 3) 不存在的文件
    const missing = await unlinkFile(path.join(FIXTURE_DIR, 'no-such-file.txt'));
    check('unlinkFile 不存在 → not_found', missing.ok === false && missing.reason === 'not_found', JSON.stringify(missing));

    // 4) 目录误用 unlink：应拒绝（防止 --unlink 作用在目录上）
    await fsp.writeFile(nestedFile, 'nested', 'utf8');
    const wrongType = await unlinkFile(targetDir);
    check('unlinkFile 传目录 → is_directory（不执行）', wrongType.ok === false && wrongType.reason === 'is_directory', JSON.stringify(wrongType));
    check('被拒绝后目录仍在', fs.existsSync(targetDir) === true);

    // 5) 目录 → 系统回收站（--rmdir）
    const removedDir = await rmdirDir(targetDir);
    check('rmdirDir 自建目录 → ok', removedDir.ok === true, JSON.stringify(removedDir));
    check('rmdirDir 后目录确实消失', fs.existsSync(targetDir) === false);

    // 6) 失败路径：假二进制（exit 1）。**文件必须还在** —— 本模块绝不兜底删除
    const survivor = path.join(FIXTURE_DIR, 'survivor.txt');
    await fsp.writeFile(survivor, 'must-survive', 'utf8');
    const failed = await unlinkFile(survivor, { binary: '/bin/false' });
    check('synorecycle 失败 → command_failed', failed.ok === false && failed.reason === 'command_failed', JSON.stringify(failed));
    check('失败后文件仍在原地（模块内绝不 rm）', fs.existsSync(survivor) === true);
  } finally {
    cleanupLeftovers = await cleanupFixture();
  }

  // 测试卫生本身也是断言：跑完不该在回收站里留下 zipcalm-* 垃圾
  check('跑完回收站零残留（夹具已从 #recycle 清掉）', cleanupLeftovers.length === 0,
    cleanupLeftovers.length === 0 ? '' : `残留：${cleanupLeftovers.join('；')}`);
  if (cleanupLeftovers.length > 0) {
    console.log('\n⚠️  请手动清理以下残留（测试夹具已删除进回收站，但自动清理失败）：');
    for (const item of cleanupLeftovers) console.log(`   - ${item}`);
  }

  console.log(`\nPASS ${pass} / FAIL ${fail}`);
  if (fail > 0) {
    console.log(`失败项：${failures.join('；')}`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(`系统回收站单测异常：${error.message}`);
  const leftovers = await cleanupFixture();
  if (leftovers.length > 0) {
    console.log('⚠️  请手动清理以下残留：');
    for (const item of leftovers) console.log(`   - ${item}`);
  }
  process.exitCode = 1;
});
