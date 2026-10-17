#!/usr/bin/env node
//
// M5 批次③（F-03 / INV-02）回归测试：删除集合精确性
//
// 验证：delete.targets = 实际进包条目（entryPaths，第一手事实）− skipped，绝不含未进包条目；
// stageDelete 的 §9.5 集合差异复核（targets ⊆ entryAbsPaths − skippedAbsPaths）拦截构造漂移。
//
// 用法：node scripts/test-delete-set-precision.mjs
//
// 反例自证步骤（人工，drift 纪律）——**在复核器单元层闭环**（集成层在 M6 黑名单接入前
// skipped 恒空、源条目全进包，两个集合恰好相等，反例无法自然构造——已在 2026-10-17 实测确认）：
//   a. 临时禁用 stageDelete 内的复核调用（把 checkDeleteSetAgainstEntries 调用处条件改为 && false）
//   b. 跑本脚本 → 案例 5/6（污染拦截）必须 FAIL
//   c. 还原 → 全绿。
// 同时保留集成级反例步骤（M6 接黑名单后可自然触发）：
//   a'. 把 runCompressTask 的 targets 构造改回「info.sources 全量映射」
//   b'. 跑 scripts/test-m2-roundtrip.mjs + 伪造 skipped → targets 含未进包条目 → 复核抛 INVALID_STATE
//   c'. 还原 → 全绿。

import { buildDeleteTargetsFromEntries, checkDeleteSetAgainstEntries } from '../server/core/compress/orchestrator.js';

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

/** 100 个源条目的 absPath 清单 */
const ENTRY_PATHS = Array.from({ length: 100 }, (_, i) => `/real/abs/src/file-${String(i).padStart(3, '0')}.txt`);
/** 2 个被黑名单跳过（未进包） */
const SKIPPED = [ENTRY_PATHS[10], ENTRY_PATHS[42]];
const toUserPathOf = (absPath) => absPath.replace('/real/abs', '');

assertCase('1. 100 进包 + 2 skipped → targets=98 且不含被跳过路径', () => {
  const { targets, excluded } = buildDeleteTargetsFromEntries(ENTRY_PATHS, SKIPPED, null, toUserPathOf);
  if (targets.length !== 98) throw new Error(`targets 数量错：${targets.length}（期望 98）`);
  if (excluded !== 2) throw new Error(`排除数错：${excluded}`);
  for (const skippedAbs of SKIPPED) {
    if (targets.some((t) => t.absPath === skippedAbs)) throw new Error(`被跳过条目混入删除集合：${skippedAbs}`);
  }
});

assertCase('2. 集合完备性：skipped.length + targets.length === 源条目总数（INV-02 断言）', () => {
  const { targets, excluded } = buildDeleteTargetsFromEntries(ENTRY_PATHS, SKIPPED, null, toUserPathOf);
  if (excluded + targets.length !== ENTRY_PATHS.length) throw new Error('集合不完备');
});

assertCase('3. 契约内形状映射：{userPath, absPath, kind, size}，userPath 为 absPath 单向转换', () => {
  const [t] = buildDeleteTargetsFromEntries(['/real/abs/a.txt'], [], null, toUserPathOf).targets;
  if (t.userPath !== '/a.txt' || t.absPath !== '/real/abs/a.txt' || t.kind !== 'file') {
    throw new Error(`形状/映射错：${JSON.stringify(t)}`);
  }
});

assertCase('4. entryPaths 缺失/空 → 零 targets（宁可不删，绝不猜测）', () => {
  const a = buildDeleteTargetsFromEntries([], [], null, toUserPathOf);
  const b = buildDeleteTargetsFromEntries(undefined, [], null, toUserPathOf);
  if (a.targets.length !== 0 || b.targets.length !== 0) throw new Error('空清单不应产生删除目标');
});

assertCase('5. §9.5 复核器：污染集合（含未进包条目）→ 拦截并报差异', () => {
  const polluted = [
    { userPath: '/in.txt', absPath: '/real/abs/in.txt', kind: 'file', size: 1 },
    { userPath: '/evil.txt', absPath: '/real/abs/evil.txt', kind: 'file', size: 2 }, // 不在进包清单
  ];
  const { violations } = checkDeleteSetAgainstEntries(polluted, ['/real/abs/in.txt'], []);
  if (violations.length !== 1 || violations[0].absPath !== '/real/abs/evil.txt') {
    throw new Error(`复核器未拦住污染条目：${JSON.stringify(violations)}`);
  }
});

assertCase('6. §9.5 复核器：skipped 条目混入 → 同样拦截', () => {
  const { violations } = checkDeleteSetAgainstEntries(
    [{ userPath: '/skip.txt', absPath: ENTRY_PATHS[10], kind: 'file', size: 0 }],
    ENTRY_PATHS,
    SKIPPED,
  );
  if (violations.length !== 1) throw new Error('skipped 条目未被拦截');
});

assertCase('7. §9.5 复核器：合法集合 → 零差异放行', () => {
  const { targets } = buildDeleteTargetsFromEntries(ENTRY_PATHS, SKIPPED, null, toUserPathOf);
  const { violations } = checkDeleteSetAgainstEntries(targets, ENTRY_PATHS, SKIPPED);
  if (violations.length !== 0) throw new Error(`合法集合误报：${JSON.stringify(violations.slice(0, 2))}`);
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
