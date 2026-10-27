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

WANT="${*:-build m1 m2 m3 crash probes retention m4 m6 m7 m8fs hlscan hlexec volumes multiroot hlhint rar}"

# 测试卫生：把删除后端固定到项目 storage/trash（进程级覆盖，不改用户 config）。
# 为什么必须：本项目目录就在共享内，auto 后端会把测试删除送进用户的 #recycle，
# 跑一次 15 套就在 File Station 里堆一堆 zipcalm-*/m8-* 垃圾（实测踩过）。
# 注意用 export：套件是子进程，必须继承（`VAR=x cmd` 只作用于那一条命令）。
export ZIPCALM_TRASH_BACKEND=project
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
# 用 restart 而不是 start：start 对"已在运行"的服务是 no-op，环境变量（如
# ZIPCALM_TRASH_BACKEND）就传不进已存在的进程，测试仍会写用户回收站。
if has m1 || has m2 || has m3; then
  bash "${SCRIPT_DIR}/start.sh" restart >/dev/null 2>&1
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
# M7：指标端点 + 环形缓冲 + /proc 降级 + 开销双口径自证 + 定时器 unref（依赖已启动的服务）
if has m7; then run_one m7 node "${SCRIPT_DIR}/test-m7-metrics.mjs"; fi
# M8 前置：fs 写端点（mkdir/rename/move/delete，删除进回收站）
if has m8fs; then run_one m8fs node "${SCRIPT_DIR}/test-m8-fs.mjs"; fi
# 存储根（docs/16）：平台探测/两模式/容量降级
if has volumes; then run_one volumes node "${SCRIPT_DIR}/test-fs-volumes.mjs"; fi
# 多根：rootId 切换 / INV-06 反证 / 并发不串根（自己以 posix+SHOW_APP_ROOT 重启，结束时还原）
if has multiroot; then run_one multiroot node "${SCRIPT_DIR}/test-multiroot.mjs"; fi
# 硬链接去重·扫描：size 分组 → 抽样快筛 → 全量哈希终判；含「伪造重复」守门人（同大小+同头尾+中间不同 → 不得合并）
if has hlscan; then run_one hlscan node "${SCRIPT_DIR}/test-hardlink-scan.mjs"; fi
# 硬链接预检提示（docs/18 §③）：纯函数层 + /compress/preflight 的 zip/tar 差异
if has hlhint; then run_one hlhint node "${SCRIPT_DIR}/test-hardlink-hint.mjs"; fi
# RAR 只读解压插件（docs/18 §①）：契约/三态错误/解压行为/条目安全
if has rar; then run_one rar node "${SCRIPT_DIR}/test-rar.mjs"; fi
# 硬链接去重·执行：rename→link→unlink 三步替换 + link 失败回滚 + 执行前全量复核 + 日志
if has hlexec; then run_one hlexec node "${SCRIPT_DIR}/test-hardlink-execute.mjs"; fi

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
