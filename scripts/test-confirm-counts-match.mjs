#!/usr/bin/env node
//
// M5 批次②（F-02）回归测试：确认数字复核 files+bytes 双维度（INV-03）
//
// 背景（M5-review P-02 + D-2 误报更正后的最终口径）：
//   路由层 parseExpectedCounts（server/http/routes/tasks.js）本来就比对双维且字段读法正确；
//   缺口在 orchestrator 执行前只比 files。修复：orchestrator 补 assertExpectedCountsMatch
//   （导出面），作为删除执行前的**权威防线**；路由层保留作同步 fast-fail（双层不冗余）。
//
// 用法：node scripts/test-confirm-counts-match.mjs
//
// 反例自证步骤（人工，drift 纪律）：
//   a. 临时把 orchestrator.js 中 bytes 分支的条件改为 `Number.isFinite(gate.expectedBytes) && false`
//   b. 跑本脚本 → 案例 2（bytes 不符拒绝）必须 FAIL
//   c. 还原 → 再跑 → 全绿。走完 a→b→c 才承认该门禁有效。

import { assertExpectedCountsMatch } from '../server/core/compress/orchestrator.js';

const TARGETS = [
  { path: '/a', kind: 'file', sizeBytes: 100 },
  { path: '/b', kind: 'file', sizeBytes: 250 },
];

const cases = [];
function assertCase(name, fn) { cases.push({ name, fn }); }

/** 断言抛出指定契约错误码；不抛或码不符都算失败 */
async function expectReject(name, gate, targets, wantCode) {
  try {
    await assertExpectedCountsMatch(gate, targets);
    throw new Error('应当拒绝却放行了');
  } catch (error) {
    if (error.message === '应当拒绝却放行了') throw error;
    if (error.code !== wantCode) throw new Error(`错误码不符：期望 ${wantCode} 实得 ${error.code}`);
  }
}

assertCase('1. files/bytes 都对 → 放行（含容差 ±1 边界）', async () => {
  await assertExpectedCountsMatch({ expectedFiles: 2, expectedBytes: 350 }, TARGETS);
  await assertExpectedCountsMatch({ expectedFiles: 2, expectedBytes: 349 }, TARGETS); // 容差边界
  await assertExpectedCountsMatch({ expectedFiles: 2, expectedBytes: 351 }, TARGETS);
});

assertCase('2. bytes 不符（差 > 1）→ VALIDATION_FAILED 拒绝', async () => {
  await expectReject('bytes 错', { expectedFiles: 2, expectedBytes: 999 }, TARGETS, 'VALIDATION_FAILED');
});

assertCase('3. files 不符 → VALIDATION_FAILED 拒绝（原有守卫不回退）', async () => {
  await expectReject('files 错', { expectedFiles: 3, expectedBytes: 350 }, TARGETS, 'VALIDATION_FAILED');
});

assertCase('4. 期望值缺省（null/undefined）→ 不比对即放行（与路由层口径一致）', async () => {
  await assertExpectedCountsMatch({}, TARGETS);
  await assertExpectedCountsMatch({ expectedFiles: null, expectedBytes: null }, TARGETS);
});

assertCase('5. sizeBytes 缺失的条目按 0 计（不 NaN 污染比对）', async () => {
  await assertExpectedCountsMatch({ expectedFiles: 1, expectedBytes: 0 }, [{ path: '/c', kind: 'file' }]);
  await expectReject('NaN 条目', { expectedFiles: 1, expectedBytes: 50 }, [{ path: '/c', kind: 'file' }], 'VALIDATION_FAILED');
});

let pass = 0; let fail = 0;
for (const { name, fn } of cases) {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { fail += 1; console.error(`FAIL ${name}: ${e.message}`); }
}
console.log(`\nPASS ${pass} / ${cases.length}  FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
