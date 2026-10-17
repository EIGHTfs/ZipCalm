#!/usr/bin/env node
//
// M5 批次⑦（F-09）回归测试：启动对账
//   ① trash 孤儿批次（有目录无日志）→ 补写 reconciled-crash 日志行
//   ② deleting 中断任务 → delete.status='failed' + error.details.trashBatch 指引
//
// 用法：node scripts/test-boot-reconciliation.mjs
//
// 反例自证步骤（人工，drift 纪律）：
//   a. 把 reconcileAfterBoot 的孤儿补记分支临时禁用（循环体改 continue）→ 案例 1 红
//   b. 把 deleting 收敛分支临时禁用 → 案例 2 红
//   c. 还原 → 全绿

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { reconcileAfterBoot } from '../server/core/task/recovery.js';

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

async function makeEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zc-recon-'));
  return {
    dir,
    deps: {
      trashDir: path.join(dir, 'trash'),
      logDir: path.join(dir, 'logs'),
      rootAbs: path.join(dir, 'fs-root'),
      logger: { info() {}, warn() {}, error() {} },
    },
  };
}

assertCase('1. trash 孤儿批次 → 补写 reconciled-crash 日志（含批次内文件清单）', async () => {
  const { dir, deps } = await makeEnv();
  // 造一个孤儿批次：目录在、日志无
  const batchDir = path.join(deps.trashDir, 'batch-orphan-1', 'photos');
  await fsp.mkdir(batchDir, { recursive: true });
  await fsp.writeFile(path.join(batchDir, 'a.jpg'), 'x', 'utf8');
  // 另一个批次有日志（不应被补记）
  const loggedBatch = 'batch-logged-1';
  await fsp.mkdir(path.join(deps.trashDir, loggedBatch), { recursive: true });
  await fsp.mkdir(deps.logDir, { recursive: true });
  await fsp.writeFile(path.join(deps.logDir, 'delete-20260101.jsonl'), `${JSON.stringify({ batchId: loggedBatch, action: 'trashed' })}\n`, 'utf8');

  const result = await reconcileAfterBoot(deps, []);
  if (result.orphanBatches.length !== 1 || result.orphanBatches[0] !== 'batch-orphan-1') {
    throw new Error(`孤儿识别错：${JSON.stringify(result.orphanBatches)}`);
  }
  // 补记日志存在且含 batchId 与文件清单
  const logFiles = await fsp.readdir(deps.logDir);
  const all = (await Promise.all(logFiles.map((f) => fsp.readFile(path.join(deps.logDir, f), 'utf8')))).join('');
  const reconciled = all.split('\n').filter((l) => l.includes('reconciled-crash'));
  if (reconciled.length !== 1) throw new Error(`补记行数错：${reconciled.length}`);
  const entry = JSON.parse(reconciled[0]);
  if (entry.batchId !== 'batch-orphan-1') throw new Error(`补记 batchId 错：${entry.batchId}`);
  if (entry.fileCount !== 1 || !entry.files[0].includes('a.jpg')) throw new Error(`文件清单错：${JSON.stringify(entry.files)}`);
  // 有日志的批次未被补记
  if (all.includes('batch-logged-1') && all.split('\n').some((l) => l.includes('reconciled-crash') && l.includes('batch-logged-1'))) {
    throw new Error('有日志的批次被误补记');
  }
  // 孤儿文件原样保留（对账不动文件）
  if (!(await fsp.stat(path.join(batchDir, 'a.jpg')).then(() => true).catch(() => false))) {
    throw new Error('对账动了回收站文件！');
  }
});

assertCase('2. deleting 中断任务 → delete.status=failed + trashBatch 指引；其他状态不动', async () => {
  const { deps } = await makeEnv();
  const tasks = [
    { info: { id: 't-deleting', status: 'interrupted', delete: { status: 'deleting', batchId: 'batch-x' } } },
    { info: { id: 't-normal', status: 'interrupted', delete: { status: 'pending' } } },
    { info: { id: 't-nodelete', status: 'interrupted' } },
  ];
  const result = await reconcileAfterBoot(deps, tasks);
  if (result.reconciledDeletes !== 1) throw new Error(`收敛数错：${result.reconciledDeletes}`);
  const t = tasks[0].info;
  if (t.delete.status !== 'failed') throw new Error(`delete.status 应为 failed，实得 ${t.delete.status}`);
  if (t.delete.error.code !== 'INTERNAL_ERROR' || t.delete.error.details.trashBatch !== 'batch-x') {
    throw new Error(`error 指引错：${JSON.stringify(t.delete.error)}`);
  }
  if (tasks[1].info.delete.status !== 'pending') throw new Error('pending 任务被误改');
  if (tasks[2].info.delete !== undefined) throw new Error('无 delete 状态的任务被误加字段');
});

assertCase('3. 空 trash / 无日志目录 → 零孤儿零收敛（容错不炸）', async () => {
  const { deps } = await makeEnv();
  const result = await reconcileAfterBoot(deps, []);
  if (result.orphanBatches.length !== 0 || result.reconciledDeletes !== 0) {
    throw new Error(`空环境结果错：${JSON.stringify(result)}`);
  }
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
