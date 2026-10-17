#!/usr/bin/env node
//
// M5 批次①（F-01 防回退加固）回归测试：API 视图的 delete.targets 必须是契约白名单形状
//
// 背景（M5-review.md D-2 误报收回后的加固决策）：
//   审计方最初判定「absPath 经 publicTask 泄漏进 API」为现行安全 bug；运行时实证（构造最小
//   manager + 模拟 stageDelete 赋 targets）推翻该判断——上游 buildDeleteTargets 已映射好契约
//   形状，absPath 不会进 API。但 publicTask 原本是**无白名单的浅透出**，不漏靠的是"上游恰好
//   映射对了"。本测试把红线钉死（契约 v2 §2.2）：任何未来调用方绕过映射直接塞内部字段进
//   targets，API 视图也必须被剥离——防回退即防未来的误用。
//
// 用法：node scripts/test-delete-targets-redline.mjs
//
// 验证三层：
//   1. 单元层（直连 manager 模块，零 HTTP）：污染 targets（塞 absPath/内部字段）→ publicTask
//      输出必须剥离干净、形状严格 === 契约形状；
//   2. 正常路径：契约形状输入 → 原样保留（白名单不误伤合法字段）；
//   3. 反例自证（drift 纪律）：临时把 publicTask 改回"浅透出" → 本测试必须变红 → 还原后再跑必须变绿。
//
// 反例自证步骤（人工）：
//   a. 把 server/core/task/manager.js 中 publicTask 的 delete 行改回：
//      `delete: info.delete ? { ...info.delete, targets: info.delete.targets.map((t) => ({ ...t })) } : null,`
//   b. 跑本脚本 → 案例 3（污染剥离）必须 FAIL
//   c. 还原代码 → 再跑 → 全绿。只有走完 a→b→c 才承认该门禁有效。

import { createTaskManager } from '../server/core/task/manager.js';

/** 极简事件/存储桩：manager 的落盘与广播在本测试全部无副作用 */
function makeStubDeps() {
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
  };
}

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

assertCase('1. 污染 targets（塞 absPath/userPath/size 等内部字段）→ API 视图必须剥离', () => {
  const mgr = createTaskManager(makeStubDeps());
  return mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/photos/2024', name: '2024', kind: 'dir', absPath: '/real/abs/photos/2024' }],
    options: { keepOriginal: false },
  }).then((task) => {
    const rec = mgr.requireTask(task.id);
    // 模拟"未来某个调用方绕过 buildDeleteTargets"直接塞内部形状
    rec.info.delete.targets = [{
      userPath: '/photos/2024',
      absPath: '/real/abs/photos/2024',
      kind: 'dir',
      size: 1024,
    }];
    const pub = mgr.toApiTask(rec);
    const s = JSON.stringify(pub);
    if (s.includes('absPath')) throw new Error('API 视图泄漏 absPath');
    if (s.includes('/real/abs')) throw new Error('API 视图泄漏内部绝对路径');
    if (s.includes('userPath')) throw new Error('API 视图泄漏 userPath');
    const [t] = pub.delete.targets;
    const keys = Object.keys(t).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['kind', 'path', 'sizeBytes'])) {
      throw new Error(`delete.targets 形状漂移：${keys.join(',')}`);
    }
  });
});

assertCase('2. 契约形状输入 → 白名单不误伤（path/kind/sizeBytes 原样保留）', () => {
  const mgr = createTaskManager(makeStubDeps());
  return mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/a', name: 'a', kind: 'file', absPath: '/real/abs/a' }],
    options: { keepOriginal: false },
  }).then((task) => {
    const rec = mgr.requireTask(task.id);
    rec.info.delete.targets = [{ path: '/a', kind: 'file', sizeBytes: 2048 }];
    const [t] = mgr.toApiTask(rec).delete.targets;
    if (t.path !== '/a' || t.kind !== 'file' || t.sizeBytes !== 2048) {
      throw new Error(`合法字段被误伤：${JSON.stringify(t)}`);
    }
  });
});

assertCase('3. 非有限 sizeBytes → 归一为 null（防 NaN/undefined 污染 API 响应）', () => {
  const mgr = createTaskManager(makeStubDeps());
  return mgr.create({
    kind: 'compress', mode: 'single', format: 'zip',
    sources: [{ path: '/b', name: 'b', kind: 'file' }],
    options: { keepOriginal: false },
  }).then((task) => {
    const rec = mgr.requireTask(task.id);
    rec.info.delete.targets = [{ path: '/b', kind: 'file', sizeBytes: Number.NaN }];
    const [t] = mgr.toApiTask(rec).delete.targets;
    if (t.sizeBytes !== null) throw new Error(`sizeBytes 未归一：${t.sizeBytes}`);
  });
});

let pass = 0;
let fail = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
