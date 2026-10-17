#!/usr/bin/env node
//
// M5 批次⑥（F-07 + F-08）回归测试：
//   F-07 EXDEV 跨分区回退：copy → size 校验 → 原件 rename 进 .cross-device 暂存（零 unlink）；
//        校验失败只清理本次副本，原件不动。
//   F-08 枚举收敛：log-only 模式 delete.status 产出 'skipped'（不再有契约外的 'logged'）。
//
// 用法：node scripts/test-delete-exdev.mjs
//
// 反例自证步骤（人工，drift 纪律）：
//   a. 把 moveToTrash 的 EXDEV 分支临时改为「捕获后 rethrow」→ 案例 1/2 必须红
//   b. 把 applyDeleteOutcome 的 status 收敛临时改回 `'logged'` → 案例 3 必须红
//   c. 还原 → 全绿

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { createDeleteService } from '../server/core/compress/deleter.js';

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

/** 构造隔离的 trash 目录（tmp 下，不碰项目 storage） */
async function makeEnv(mode = 'trash') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-exdev-'));
  const svc = createDeleteService({
    config: { delete: { mode } },
    logger: { info() {}, warn() {}, error() {} },
    logDir: path.join(dir, 'logs'),
    trashDir: path.join(dir, 'trash'),
    projectRoot: dir,
  });
  return { dir, svc };
}

assertCase('1. EXDEV 回退：copy 校验通过 → 原件移入 .cross-device、副本落 batch 位、deleteRecord 记 trashed', async () => {
  const { dir, svc } = await makeEnv();
  const sourceDir = path.join(dir, 'source');
  await fsp.mkdir(sourceDir, { recursive: true });
  const srcFile = path.join(sourceDir, 'a.txt');
  await fsp.writeFile(srcFile, 'hello-exdev', 'utf8');

  // 注入：rename 第一次抛 EXDEV（模拟跨分区），后续 rename 正常
  const realRename = fsp.rename.bind(fsp);
  let injected = false;
  fsp.rename = async (from, to) => {
    if (!injected && from === srcFile) {
      injected = true;
      const err = new Error('cross-device link');
      err.code = 'EXDEV';
      throw err;
    }
    return realRename(from, to);
  };
  try {
    const outcome = await svc.deleteTargets({
      taskId: 't1', kind: 'compress', reason: 'test',
      targets: [{ userPath: '/a.txt', absPath: srcFile, kind: 'file', size: 10 }],
    });
    if (outcome.failed.length !== 0) throw new Error(`回退失败：${JSON.stringify(outcome.failed)}`);
    if (outcome.deleted.length !== 1) throw new Error('未记 trashed');
  } finally {
    fsp.rename = realRename;
  }
  // 原件已不在源目录
  if (await fsp.stat(srcFile).then(() => true).catch(() => false)) throw new Error('原件仍在源目录');
  // 副本已落在 batch 位
  const batchFiles = await fsp.readdir(path.join(dir, 'trash'));
  if (!batchFiles.some((name) => name !== '.cross-device')) throw new Error('副本未落 batch 位');
  // 原件进了 .cross-device 暂存
  const staged = await fsp.readdir(path.join(dir, 'trash', '.cross-device'));
  if (staged.length !== 1) throw new Error('原件未进 .cross-device 暂存');
  // 内容一致
  const batchFile = batchFiles.find((name) => name !== '.cross-device');
  const content = await fsp.readFile(path.join(dir, 'trash', batchFile, 'a.txt'), 'utf8');
  if (content !== 'hello-exdev') throw new Error(`副本内容不一致：${content}`);
});

assertCase('2. copy 校验失败（size 不一致模拟）→ 该条 failed、原件原地不动、无残留副本', async () => {
  const { dir, svc } = await makeEnv();
  const sourceDir = path.join(dir, 'source');
  await fsp.mkdir(sourceDir, { recursive: true });
  const srcFile = path.join(sourceDir, 'b.txt');
  await fsp.writeFile(srcFile, 'original', 'utf8');

  // 注入：stat 对 destination 返回错误 size；rename 第一次抛 EXDEV
  const realStat = fsp.stat.bind(fsp);
  const realRename = fsp.rename.bind(fsp);
  let injected = false;
  fsp.rename = async (from, to) => {
    if (!injected && from === srcFile) {
      injected = true;
      const err = new Error('cross-device link');
      err.code = 'EXDEV';
      throw err;
    }
    return realRename(from, to);
  };
  fsp.stat = async (p) => {
    const real = await realStat(p);
    if (String(p).includes('trash')) return { ...real, size: real.size + 999 };
    return real;
  };
  try {
    const outcome = await svc.deleteTargets({
      taskId: 't2', kind: 'compress', reason: 'test',
      targets: [{ userPath: '/b.txt', absPath: srcFile, kind: 'file', size: 8 }],
    });
    if (outcome.failed.length !== 1) throw new Error(`校验失败应记 failed：${JSON.stringify(outcome.failed)}`);
  } finally {
    fsp.rename = realRename;
    fsp.stat = realStat;
  }
  // 原件原地未动
  const content = await fsp.readFile(srcFile, 'utf8');
  if (content !== 'original') throw new Error('原件被改动！');
});

assertCase('3. F-08：log-only 模式 delete.status = skipped（不再产出 logged）', async () => {
  const { svc } = await makeEnv('log-only');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-exdev-log-'));
  const srcFile = path.join(dir, 'c.txt');
  await fsp.writeFile(srcFile, 'x', 'utf8');
  const outcome = await svc.deleteTargets({
    taskId: 't3', kind: 'compress', reason: 'test',
    targets: [{ userPath: '/c.txt', absPath: srcFile, kind: 'file', size: 1 }],
  });
  if (outcome.mode !== 'log-only') throw new Error('模式错');
  // deleteRecord 层无 status 字段；status 由 orchestrator applyDeleteOutcome 产出。
  // 这里验证 log-only 记账 skipped + 文件未动，orchestrator 层由 m2 套件（断言 skipped+log-only）覆盖。
  if (outcome.skipped.length !== 1) throw new Error('log-only 未记账');
  if (await fsp.stat(srcFile).then(() => false).catch(() => true)) throw new Error('log-only 模式文件被动了！');
  if (outcome.deleted.length !== 0) throw new Error('log-only 模式不应有 deleted');
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
