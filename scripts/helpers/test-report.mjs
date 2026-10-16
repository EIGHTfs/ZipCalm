// 验收脚本共用的「断言 + 汇总」输出器
//
// 为什么抽出来：m1~m4 与 retention 五套脚本各自抄了一份 check/skip/summary（同一结构 ≥3 处，
// 审计的 no-duplicate-code 会命中），改一处就得改五处，格式还容易漂。
//
// **输出格式与既有脚本逐字一致**（含 `PASS | 名称 | 明细`、`── 汇总 ──`、`PASS x / FAIL y`），
// 因为 `scripts/test-all.sh` 用 `grep -E 'PASS [0-9]+ /'` 从各套日志里提取总结行 —— 格式一变，
// 一键套件就报不出结果（这种"门禁被悄悄绕过"比报错更难查）。

export function createReporter() {
  const state = { pass: 0, fail: 0, skipped: 0, failures: [] };

  /** 断言：成功记 PASS，失败记 FAIL 并留下条目名（末尾汇总会列出来） */
  function check(name, ok, detail = '') {
    const suffix = detail ? ` | ${detail}` : '';
    if (ok) {
      state.pass += 1;
      console.log(`PASS | ${name}${suffix}`);
      return true;
    }
    state.fail += 1;
    state.failures.push(name);
    console.log(`FAIL | ${name}${suffix}`);
    return false;
  }

  /** 环境缺工具时跳过：不算失败，但必须写明原因，避免"静默通过" */
  function skip(name, reason) {
    state.skipped += 1;
    console.log(`SKIP | ${name} | ${reason}`);
  }

  /**
   * 打印汇总行与失败项。
   * @param {{withSkip?: boolean, failuresLabel?: string}} [options]
   *   withSkip=true 输出 `PASS x / FAIL y / SKIP z`；否则只输出 `PASS x / FAIL y`
   */
  function summary(options = {}) {
    const tail = options.withSkip ? ` / SKIP ${state.skipped}` : '';
    console.log(`\n── 汇总 ──\nPASS ${state.pass} / FAIL ${state.fail}${tail}`);
    if (state.failures.length > 0) {
      console.log(`${options.failuresLabel || '失败项'}：${state.failures.join('；')}`);
    }
    return { pass: state.pass, fail: state.fail, skipped: state.skipped, failures: [...state.failures] };
  }

  return { check, skip, summary };
}
