#!/bin/bash
# 一键跑全部验收套件（自动管理服务生命周期与执行顺序）
#
# 为什么需要它：这些套件分两类，顺序搞错会产生"假失败" ——
#   · 要求服务已在跑：m1 / m2 / m3（只用 HTTP，不管服务生命周期）
#   · 自己管理服务  ：crash / probes / retention / m4（内部各自 start/stop）
# 如果先跑自管类、再跑依赖类，后者会在"服务已停"状态下整片失败。
# 本项目在验收中真踩过两次（不是产品问题，是跑法问题），故固化成脚本。
#
# 固定顺序：build → start → m1/m2/m3 → stop → crash/probes/retention/m4 → m6（m4 之后服务仍由 m4 管着，m6 用 start.sh restart 自管）
#
# 用法：
#   bash scripts/test-all.sh              # 全跑
#   bash scripts/test-all.sh m1 m4        # 只跑指定套件
# 环境变量：ZC_TEST_PORT / ZC_TEST_USER / ZC_TEST_PASSWORD（透传给各套件）

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}" || exit 1

WANT="${*:-build m1 m2 m3 crash probes retention m4 m6}"
LOGDIR="${TMPDIR:-/tmp}/zipcalm-suites"
mkdir -p "${LOGDIR}"

NAMES=()
RESULTS=()
SUMMARIES=()

has() { case " ${WANT} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

run_one() { # run_one <名字> <命令...>
  local name="$1"; shift
  local log="${LOGDIR}/${name}.log" line
  printf '  %-10s ' "${name}"
  if "$@" > "${log}" 2>&1; then
    line="$(grep -E 'PASS [0-9]+ /|built in' "${log}" | tail -1)"
    printf '✅ %s\n' "${line:-通过}"
    NAMES+=("${name}"); RESULTS+=("✅"); SUMMARIES+=("${line:-通过}")
  else
    line="$(grep -E 'PASS [0-9]+ /|FAIL|Error' "${log}" | tail -1)"
    printf '❌ %s   （日志：%s）\n' "${line:-失败}" "${log}"
    NAMES+=("${name}"); RESULTS+=("❌"); SUMMARIES+=("${line:-失败}")
  fi
}

echo "ZipCalm 验收套件 —— ${PROJECT_ROOT}"
echo

if has build; then run_one build npm run build; fi

# 依赖服务已在跑的三套：先统一起服务，跑完再停
if has m1 || has m2 || has m3; then
  bash "${SCRIPT_DIR}/start.sh" start >/dev/null 2>&1
  sleep 2
  if has m1; then run_one m1 bash "${SCRIPT_DIR}/test-invariants-m1.sh"; fi
  if has m2; then run_one m2 node "${SCRIPT_DIR}/test-m2-roundtrip.mjs"; fi
  if has m3; then run_one m3 node "${SCRIPT_DIR}/test-m3-tasks.mjs"; fi
  bash "${SCRIPT_DIR}/start.sh" stop >/dev/null 2>&1
fi

# 自己管理服务生命周期的四套
if has crash; then run_one crash bash "${SCRIPT_DIR}/test-m3-crash-recovery.sh"; fi
if has probes; then run_one probes bash "${SCRIPT_DIR}/test-acceptance-probes.sh"; fi
if has retention; then run_one retention node "${SCRIPT_DIR}/test-task-retention.mjs"; fi
if has m4; then run_one m4 node "${SCRIPT_DIR}/test-m4-formats.mjs"; fi
# M6：黑名单三层 + 端点 + 预检 + 「跳过项不被删」（自己管理服务？否 —— 依赖已启动的服务，放在 m4 之后）
if has m6; then run_one m6 node "${SCRIPT_DIR}/test-m6-blacklist.mjs"; fi

echo
echo "── 汇总 ──"
fail=0
for i in "${!NAMES[@]}"; do
  printf '  %s %-10s %s\n' "${RESULTS[$i]}" "${NAMES[$i]}" "${SUMMARIES[$i]}"
  if [ "${RESULTS[$i]}" = "❌" ]; then fail=$((fail + 1)); fi
done
echo
echo "套件 ${#NAMES[@]} 个，失败 ${fail} 个（各套件完整日志：${LOGDIR}/）"
[ "${fail}" -eq 0 ] || exit 1
