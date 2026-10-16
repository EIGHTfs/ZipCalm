// 归档完整性校验（INV-01：**删除前必须校验通过**）
//
// 契约（docs/M0/插件契约.md §3.6）：格式包提供 test()，返回 {ok, checked, failures, strategy}。
// 本模块只做两件事：调用 test()；把"不通过"翻译成契约错误码 VERIFY_FAILED（422）。
// 关键不变量：**校验未通过 → 绝不进入删除阶段**（INV-01）。

import { ERROR_CODES, apiError } from '../../lib/errors.js';

/**
 * @param {object} plugin 格式包（须实现 test）
 * @param {string} archivePath 归档绝对路径
 * @returns {Promise<{ok: boolean, strategy: string|null, checked: number, failures: Array}>}
 */
/** 把格式包 test() 的返回值规整成契约形状（缺字段一律给安全默认） */
function normalizeTestResult(testResult) {
  const failures = testResult && Array.isArray(testResult.failures) ? testResult.failures : [];
  return {
    ok: Boolean(testResult && testResult.ok === true),
    strategy: (testResult && testResult.strategy) || null,
    checked: Number((testResult && testResult.checked) || 0),
    failures: failures.slice(0, 20),
  };
}

export async function verifyArchive(plugin, archivePath) {
  if (!plugin || typeof plugin.test !== 'function') {
    throw apiError(ERROR_CODES.INTERNAL_ERROR, '格式包未实现完整性校验（test）', { format: plugin && plugin.id });
  }
  return normalizeTestResult(await plugin.test(archivePath, {}));
}

/**
 * 校验不通过就抛 VERIFY_FAILED（调用方据此把任务置 failed 并**放弃删除**）。
 * 注意：失败明细里可能含归档内部条目名（不是本机绝对路径），可以安全外露。
 */
export function assertVerified(verification) {
  if (verification.ok) return verification;
  throw apiError(ERROR_CODES.VERIFY_FAILED, '压缩包校验未通过，已中止后续删除', {
    checked: verification.checked,
    failureCount: verification.failures.length,
    failures: verification.failures.slice(0, 5),
    strategy: verification.strategy,
  });
}
