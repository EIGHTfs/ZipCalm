#!/usr/bin/env node
//
// M8+ 硬链接去重 · 批次①（扫描）回归测试
//
// 守门人用例（docs/15 §四红线）：**伪造重复** —— 同大小 + 同头尾抽样段 + 中间不同 →
// 断言**不得**被合并。这条测试在，抽样哈希就永远当不了终判。
//
// 反例自证步骤（人工，drift 纪律）：
//   a. 把 scanner.js 终判临时改回「仅抽样」（fullHash 调用点直接用 sampleFingerprint 结果分组）
//   b. 跑本脚本 → 守门人用例必须红
//   c. 还原 → 全绿
//
// 用法：node scripts/test-hardlink-scan.mjs

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { scanHardlinkDuplicates, isAllowedExtension, groupBySize } from '../server/core/hardlink/scanner.js';

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

/** 造一个指定大小、内容由 maker 决定的文件 */
async function makeFile(dir, name, size, maker) {
  const abs = path.join(dir, name);
  const handle = await fsp.open(abs, 'w');
  try {
    let written = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (written < size) {
      const n = Math.min(chunk.length, size - written);
      const buf = maker(written, n);
      await handle.write(buf, 0, n);
      written += n;
    }
  } finally {
    await handle.close();
  }
  return abs;
}

/** 默认内容生成器：按偏移生成可复现字节 */
const defaultMaker = (offset, n) => Buffer.from(Array.from({ length: n }, (_, i) => (offset + i) % 251));

/** 伪造重复：同大小 + 头 4KB 一致 + 尾 4KB 一致 + 中间不同 */
async function makeForgedPair(dir, nameA, nameB, size = 1024 * 1024) {
  const header = Buffer.alloc(4096, 0xAB); // 容器头一致
  const footer = Buffer.alloc(4096, 0xCD); // 索引尾一致
  const makeFor = (seed) => (offset, n) => {
    // 每块独立构造：首块带 header、末块带 footer，块内其余字节按 seed 变化（保证中间不同）
    const buf = Buffer.from(Array.from({ length: n }, (_, i) => ((offset + i) * (seed % 7 + 1)) % 253));
    if (offset === 0) header.copy(buf, 0, 0, Math.min(4096, n));
    if (offset + n >= size) footer.copy(buf, n - Math.min(4096, n), 0, Math.min(4096, n));
    return buf;
  };
  const a = await makeFile(dir, nameA, size, makeFor(1));
  const b = await makeFile(dir, nameB, size, makeFor(2));
  return [a, b];
}

const EXT = ['mkv'];

assertCase('0. isAllowedExtension：大小写/点号归一', () => {
  if (!isAllowedExtension('A.MKV', EXT)) throw new Error('大写扩展名被拒');
  if (isAllowedExtension('a.txt', EXT)) throw new Error('非白名单被放行');
});

assertCase('1. 真重复 → 被合并为一组（master + 1 duplicate，savedBytes 正确）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-real-'));
  const content = Buffer.alloc(512 * 1024, 0x5A);
  const a = path.join(dir, 'same-a.mkv');
  const b = path.join(dir, 'same-b.mkv');
  await fsp.writeFile(a, content);
  await fsp.writeFile(b, content);
  const { groups, stats } = await scanHardlinkDuplicates(dir, EXT);
  if (groups.length !== 1) throw new Error(`应 1 组，实得 ${groups.length}（stats=${JSON.stringify(stats)}）`);
  const [g] = groups;
  if (g.duplicates.length !== 1) throw new Error(`duplicates 应 1，实得 ${g.duplicates.length}`);
  if (g.savedBytes !== 512 * 1024) throw new Error(`savedBytes 错：${g.savedBytes}`);
  if (g.hash === undefined || g.hash === null) throw new Error('全量哈希字段缺失');
});

assertCase('2. 【守门人】伪造重复（同大小+同头尾+中间不同）→ 不得被合并', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-forged-'));
  await makeForgedPair(dir, 'S01E01.mkv', 'S01E02.mkv');
  const { groups } = await scanHardlinkDuplicates(dir, EXT);
  if (groups.length !== 0) {
    throw new Error(`伪造重复被合并！groups=${JSON.stringify(groups)} —— 抽样哈希被当成了终判（docs/15 §二.① 数据丢失红线）`);
  }
});

assertCase('3. 符号链接 / nlink>1 / 非白名单 → 全部跳过', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-skip-'));
  const real = path.join(dir, 'real.mkv');
  await fsp.writeFile(real, Buffer.alloc(4096, 0x11));
  // 符号链接指向 real（lstat 不跟随）
  await fsp.symlink(real, path.join(dir, 'link.mkv'));
  // 第二份同内容文件 + 硬链接（nlink>1）
  const twin = path.join(dir, 'twin.mkv');
  await fsp.writeFile(twin, Buffer.alloc(4096, 0x11));
  await fsp.link(real, path.join(dir, 'hard.mkv')); // real 与 hard 同 inode，nlink=2
  // 非白名单
  await fsp.writeFile(path.join(dir, 'other.txt'), Buffer.alloc(4096, 0x11));
  const { groups, stats } = await scanHardlinkDuplicates(dir, EXT);
  if (groups.length !== 0) throw new Error(`跳过规则失效：${JSON.stringify(groups)}`);
  // real/twin 内容相同但 hard/real 是硬链接被跳过——real 只剩 1 个 → 无组
  if (stats.scanned !== 1) throw new Error(`候选数应为 1（仅 twin；real/hard 均 nlink>1 被跳），实得 ${stats.scanned}`);
});

assertCase('4. 大小不同 → size 分组前就被排除（不进哈希）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-size-'));
  await fsp.writeFile(path.join(dir, 'a.mkv'), Buffer.alloc(4096, 0x22));
  await fsp.writeFile(path.join(dir, 'b.mkv'), Buffer.alloc(8192, 0x22));
  const { groups } = await scanHardlinkDuplicates(dir, EXT);
  if (groups.length !== 0) throw new Error('不同大小被合并');
});

assertCase('5. 多组混合：真重复组与独立文件共存，互不污染', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-mix-'));
  const content = Buffer.alloc(256 * 1024, 0x77);
  await fsp.writeFile(path.join(dir, 'dup1.mkv'), content);
  await fsp.writeFile(path.join(dir, 'dup2.mkv'), content);
  await fsp.writeFile(path.join(dir, 'unique.mkv'), Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 254)));
  await makeForgedPair(dir, 'forged1.mkv', 'forged2.mkv', 256 * 1024);
  const { groups } = await scanHardlinkDuplicates(dir, EXT);
  if (groups.length !== 1) throw new Error(`应只 1 组真重复，实得 ${groups.length}: ${JSON.stringify(groups.map((g) => g.master))}`);
  if (groups[0].duplicates.length !== 1) throw new Error('重复组成员错');
});

assertCase('6. groupBySize 纯函数：单文件组被过滤', () => {
  const groups = groupBySize([
    { absPath: '/a', size: 1 }, { absPath: '/b', size: 1 }, { absPath: '/c', size: 2 },
  ]);
  if (groups.length !== 1 || groups[0].size !== 1 || groups[0].group.length !== 2) throw new Error('分组过滤错');
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
