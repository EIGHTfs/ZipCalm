#!/usr/bin/env node
//
// M5 批次⑤（F-04 / 契约 §3.2 §3.3 硬要求 1/2/3）回归测试：
//   waitConfirm 门闩的超时/取消/不阻塞语义 + 定时器防泄漏。
//
// 职责边界说明：本测试聚焦 manager 门闩层（gate.confirmed/reason、终态、队列吞吐）。
// delete.status='skipped' + skipReason 的回填属 orchestrator awaitDeleteConfirm 职责，
// 由 m2 往返套件走真实链路覆盖（deleteConfirmed=false 场景）。
//
// 用法：node scripts/test-waiting-confirm.mjs
//
// 反例自证步骤（人工，drift 纪律）：
//   a. 把 manager.js 的 CANCELLABLE_PHASES 临时去掉 'waiting_confirm' → 案例 2 必须红
//   b. 把 waitConfirm 里的超时 setTimeout 分支禁用（timeoutMs > 0 改为 false）→ 案例 1 必须红
//   c. 还原 → 全绿

import { createTaskManager } from '../server/core/task/manager.js';

function makeDeps(confirmTimeoutMs) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    events: { publish() {}, subscriberCount: () => 0, currentSeq: () => 0 },
    store: {
      saveNow: async () => {},
      scheduleSave() {},
      appendHistory: async () => {},
      loadTasks: async () => [],
      getHistoryEntry: () => null,
      listHistory: () => [],
    },
    confirmTimeoutMs,
  };
}

/** 模拟 orchestrator 的 waiting_confirm 挂起：pump 执行 runner 后先 markWaitingConfirm 再挂起 */
async function enqueueHangingConfirm(mgr, { timeoutBehavior = 'hang' } = {}) {
  const task = await mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/a', name: 'a', kind: 'file' }],
    options: { keepOriginal: false },
  });
  const id = task.id;
  const rec = mgr.requireTask(id);
  rec.info.delete.targets = [{ path: '/a', kind: 'file', sizeBytes: 1 }];
  let gate = null;
  mgr.enqueue(id, async () => {
    mgr.markWaitingConfirm(id); // 与真实链路一致：runner 执行中进入 waiting_confirm
    gate = await mgr.waitConfirm(id);
    if (gate.confirmed === false) {
      // 模拟 orchestrator：放弃删除 → delete.status='skipped' + skipReason
      rec.info.delete.status = 'skipped';
      rec.info.delete.skipReason = gate.reason;
    }
  });
  return { id, getGate: () => gate };
}

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

assertCase('1. 超时 → gate.confirmed=false + reason=confirm_timeout（超时绝不等于确认）+ 终态 done', async () => {
  const mgr = createTaskManager(makeDeps(50));
  const { id, getGate } = await enqueueHangingConfirm(mgr);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const gate = getGate();
  if (!gate || gate.confirmed !== false) throw new Error(`超时应为放弃，实得 ${JSON.stringify(gate)}`);
  if (gate.reason !== 'confirm_timeout') throw new Error(`reason 错：${gate.reason}`);
  const task = mgr.get(id);
  if (task.status !== 'done') throw new Error(`超时后终态应为 done，实得 ${task.status}`);
  if (task.delete.status !== 'skipped') throw new Error(`delete.status 应为 skipped，实得 ${task.delete.status}`);
});

assertCase('2. waiting_confirm 可取消：取消=放弃删除 + reason=user_cancelled + 终态 done', async () => {
  const mgr = createTaskManager(makeDeps(0)); // 不超时，取消必须能救
  const { id, getGate } = await enqueueHangingConfirm(mgr);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mgr.cancel(id);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const gate = getGate();
  if (!gate || gate.confirmed !== false) throw new Error('取消应按放弃删除结算');
  if (gate.reason !== 'user_cancelled') throw new Error(`reason 错：${gate.reason}`);
  const task = mgr.get(id);
  if (task.status !== 'done') throw new Error(`取消后终态应为 done（不回滚压缩结果），实得 ${task.status}`);
  if (task.delete.status !== 'skipped') throw new Error(`delete.status 应为 skipped，实得 ${task.delete.status}`);
});

assertCase('3. 不阻塞串行队列：A 挂起确认，B 仍能 running → done（P-03 回归门禁）', async () => {
  const mgr = createTaskManager(makeDeps(0)); // 不超时：B 必须靠「不阻塞」活着
  const { id: idA } = await enqueueHangingConfirm(mgr);
  await new Promise((resolve) => setTimeout(resolve, 30)); // A 已挂起（activeId=A）

  const taskB = await mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/b', name: 'b', kind: 'file' }],
  });
  let bRan = false;
  mgr.enqueue(taskB.id, async () => { bRan = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (!bRan) throw new Error('P-03 回归：waiting_confirm 阻塞了串行队列（B 未能执行）');
  if (mgr.get(taskB.id).status !== 'done') throw new Error('B 应正常完成');
  await mgr.cancel(idA); // 清理 A
  await new Promise((resolve) => setTimeout(resolve, 100));
});

assertCase('4. 正常确认路径不受影响：resolve true → confirmed=true 透传', async () => {
  const mgr = createTaskManager(makeDeps(0));
  const task = await mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/a', name: 'a', kind: 'file' }],
    options: { keepOriginal: false },
  });
  let gate = null;
  mgr.enqueue(task.id, async () => {
    mgr.markWaitingConfirm(task.id);
    gate = await mgr.waitConfirm(task.id);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  mgr.resolveConfirm(task.id, { confirmed: true, expectedFiles: 1, expectedBytes: 1 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  if (!gate || gate.confirmed !== true) throw new Error(`正常确认被破坏：${JSON.stringify(gate)}`);
});

assertCase('5. 定时器清理：确认后无残留 confirmTimer（防泄漏）', async () => {
  const mgr = createTaskManager(makeDeps(60000));
  const task = await mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/a', name: 'a', kind: 'file' }],
    options: { keepOriginal: false },
  });
  mgr.enqueue(task.id, async () => {
    mgr.markWaitingConfirm(task.id);
    await mgr.waitConfirm(task.id);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  mgr.resolveConfirm(task.id, { confirmed: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const rec = mgr.requireTask(task.id);
  if (rec.confirmTimer !== null) throw new Error('确认后 confirmTimer 未清理（定时器泄漏）');
  if (rec.confirmResolver !== null) throw new Error('确认后 confirmResolver 未清理');
});

assertCase('6. deleting 独占：A 确认后进入执行相位前必须抢到槽位（activeId 空闲或自己）', async () => {
  const mgr = createTaskManager(makeDeps(0));
  // A：挂起确认
  const { id: idA } = await enqueueHangingConfirm(mgr);
  await new Promise((resolve) => setTimeout(resolve, 30));
  // B：占用 activeId
  const taskB = await mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/b', name: 'b', kind: 'file' }],
  });
  let slotDuringB = 'not-acquired';
  mgr.enqueue(taskB.id, async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // A 确认后，模拟 orchestrator 的 deleting 前抢位：此时 B 在跑，waitForExecutionSlot 必须等到 B 完
  const recA = mgr.requireTask(idA);
  mgr.resolveConfirm(idA, { confirmed: true });
  const slotPromise = mgr.waitForExecutionSlot(idA).then(() => { slotDuringB = 'acquired'; });
  await new Promise((resolve) => setTimeout(resolve, 50)); // B 还在跑
  if (slotDuringB === 'acquired') throw new Error('deleting 在 B 执行期间抢到槽位（独占被破坏）');
  await slotPromise; // B 完成后必须能拿到
  if (slotDuringB !== 'acquired') throw new Error('B 完成后 A 未能拿到槽位');
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
