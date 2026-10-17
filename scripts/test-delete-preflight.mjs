#!/usr/bin/env node
//
// M5 批次④（F-05 + F-06）回归测试：删除前 stat 复核（INV-03 ⑤）+ deleter 入口白名单（INV-06）
//
// 用法：node scripts/test-delete-preflight.mjs
//
// 反例自证步骤（人工，drift 纪律）：
//   a. F-05：把 filterStaleDeleteTargets 中「size 不一致 → changed」的分支临时改为恒 kept
//   b. 跑本脚本 → 案例 1/2/3 必须红；还原 → 全绿
//   c. F-06：把 deleteTargets 入口的白名单复核块临时注释
//   d. 跑本脚本 → 案例 5/6/7 必须红；还原 → 全绿

import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';

import { filterStaleDeleteTargets } from '../server/core/compress/orchestrator.js';
import { createDeleteService } from '../server/core/compress/deleter.js';

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

// ===== F-05 stat 复核 =====

const TARGETS = [
  { userPath: '/a.txt', absPath: '/abs/a.txt', kind: 'file', size: 100 },
  { userPath: '/b.txt', absPath: '/abs/b.txt', kind: 'file', size: 200 },
  { userPath: '/c.txt', absPath: '/abs/c.txt', kind: 'file', size: 300 },
];
const STATS = new Map([
  ['/abs/a.txt', { sizeBytes: 100 }],
  ['/abs/b.txt', { sizeBytes: 200 }],
  ['/abs/c.txt', { sizeBytes: 300 }],
]);

assertCase('1. 全部一致 → 全部保留、零 changed', async () => {
  const { kept, changed } = await filterStaleDeleteTargets(TARGETS, STATS, async () => ({ sizeBytes: 0 }));
  // statOne 返回值不参与比对（比对基准是快照 size）——真实实现里 statOne 取当前 size；
  // 为让本案例有意义，注入与快照一致的 stat
  const statOk = async (absPath) => ({ sizeBytes: STATS.get(absPath).sizeBytes });
  const ok = await filterStaleDeleteTargets(TARGETS, STATS, statOk);
  if (ok.kept.length !== 3 || ok.changed.length !== 0) throw new Error('一致集合被误拦');
});

assertCase('2. 单条变化 → 该条 skipped(source_changed)，其余保留', async () => {
  const statOne = async (absPath) => ({ sizeBytes: absPath === '/abs/b.txt' ? 999 : STATS.get(absPath).sizeBytes });
  const { kept, changed } = await filterStaleDeleteTargets(TARGETS, STATS, statOne);
  if (kept.length !== 2 || kept.some((t) => t.absPath === '/abs/b.txt')) throw new Error('变化条目未被剔除');
  if (changed.length !== 1 || changed[0].reason !== 'source_changed') throw new Error(`changed 错：${JSON.stringify(changed)}`);
});

assertCase('3. 源已消失（stat 抛错）→ source_gone；全部变化 → kept=0（整批拒删前置条件）', async () => {
  const statOne = async (absPath) => { if (absPath === '/abs/a.txt') throw new Error('ENOENT'); return { sizeBytes: STATS.get(absPath).sizeBytes }; };
  const { changed } = await filterStaleDeleteTargets(TARGETS, STATS, statOne);
  if (changed.length !== 1 || changed[0].reason !== 'source_gone') throw new Error('source_gone 未识别');
  const allGone = await filterStaleDeleteTargets(TARGETS, STATS, async () => { throw new Error('ENOENT'); });
  if (allGone.kept.length !== 0 || allGone.changed.length !== 3) throw new Error('全部变化应 kept=0');
});

assertCase('4. 无基准（快照缺失）→ 放行（不虚构拦截）', async () => {
  const noSnap = new Map(); // 空快照
  const { kept, changed } = await filterStaleDeleteTargets(TARGETS, noSnap, async () => { throw new Error('不应被调用也不报错'); });
  if (kept.length !== 3 || changed.length !== 0) throw new Error('无基准条目应放行');
});

// ===== F-06 deleter 入口白名单（log-only 模式下驱动，验证校验与隔离；不真删文件）=====

function makeService() {
  return createDeleteService({
    config: { delete: { mode: 'log-only' } },
    logger: { info() {}, warn() {}, error() {} },
    logDir: path.join(os.tmpdir(), 'zc-test-logs'),
    trashDir: path.join(os.tmpdir(), 'zc-test-trash'),
    projectRoot: os.tmpdir(),
    rootAbs: '/abs/root',
  });
}

assertCase('5. userPath 穿越（.. 段）→ 该条 failed(PATH_OUT_OF_ROOT)，其余条目不受影响', async () => {
  const svc = makeService();
  const outcome = await svc.deleteTargets({
    taskId: 't5',
    kind: 'compress',
    reason: 'test',
    targets: [
      { userPath: '/good.txt', absPath: '/abs/root/good.txt', kind: 'file', size: 1 },
      { userPath: '/../../etc/passwd', absPath: '/etc/passwd', kind: 'file', size: 1 },
      { userPath: '/data-evil', absPath: '/abs/root/data-evil', kind: 'file', size: 1 },
    ],
  });
  if (outcome.failed.length !== 1 || outcome.failed[0].path !== '/../../etc/passwd') {
    throw new Error(`穿越条目未被隔离：${JSON.stringify(outcome.failed)}`);
  }
  // good/data-evil 应走 log-only 记账（skipped 而非 failed）
  if (outcome.skipped.length !== 2) throw new Error(`合法条目被误伤：${JSON.stringify(outcome.skipped)}`);
});

assertCase('6. absPath 与 userPath 推导不一致 → 该条 failed（交叉断言拦下）', async () => {
  const svc = makeService();
  const outcome = await svc.deleteTargets({
    taskId: 't6',
    kind: 'compress',
    reason: 'test',
    targets: [{ userPath: '/ok.txt', absPath: '/somewhere/else/ok.txt', kind: 'file', size: 1 }],
  });
  if (outcome.failed.length !== 1) throw new Error(`不一致 absPath 未被拦：${JSON.stringify(outcome.failed)}`);
});

assertCase('7. 合法一致集合 → 零 failed，走 log-only 记账', async () => {
  const svc = makeService();
  const outcome = await svc.deleteTargets({
    taskId: 't7',
    kind: 'compress',
    reason: 'test',
    targets: [{ userPath: '/ok.txt', absPath: '/abs/root/ok.txt', kind: 'file', size: 1 }],
  });
  if (outcome.failed.length !== 0 || outcome.skipped.length !== 1) {
    throw new Error(`合法集合结果错：${JSON.stringify({ failed: outcome.failed, skipped: outcome.skipped })}`);
  }
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
