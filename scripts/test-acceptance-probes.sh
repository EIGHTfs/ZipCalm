#!/bin/bash
# 验收方补充探测（路径边界 / 凭据 / API 泄漏）
#
# 定位：与实现方自测脚本互补，不是替代。
#   - scripts/test-invariants-m1.sh   实现方：INV-06 十条 + 正常浏览
#   - scripts/test-m2-roundtrip.mjs   实现方：往返 hash + zip-slip
#   - scripts/test-m3-tasks.mjs       实现方：落盘/恢复/SSE
#   - 本脚本                          验收方：临时构造、事后值得固化的探测形态
#
# 为什么单独留一份：下面这些形态在实际验收中各自抓到过真 bug，丢掉就要重新踩：
#   · 超长路径 → 曾返回 500（应 400 INVALID_PATH）
#   · 任务响应泄漏 sources[].absPath → 曾把存储根绝对路径暴露给客户端
#   · 双斜杠 / 点斜杠 / 中间段编码等变体 → 前缀校验与归一化的边界
#
# 用法：
#   bash scripts/test-acceptance-probes.sh
# 可覆盖的环境变量（无硬编码凭据/端口）：
#   ZC_TEST_PORT（默认 3010）· ZC_TEST_USER（默认 admin）· ZC_TEST_PASSWORD（默认见 scripts/helpers/test-credentials.sh）

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}" || exit 1

PORT="${ZC_TEST_PORT:-3010}"
# 测试账号统一来源（默认值 / 覆盖方式 / 审计豁免说明都写在 helper 里，三个脚本不再各写一份）
source "${SCRIPT_DIR}/helpers/test-credentials.sh"
AUTH_USER="${TEST_USER}"
AUTH_PASSWORD="${TEST_PASSWORD}"
API="http://127.0.0.1:${PORT}/api/v1"
COOKIE_JAR="$(mktemp)"
# 临时响应体统一放本次运行的私有目录：不再散落硬编码的 /tmp 文件名（互不打架，退出即清理）
TMP_DIR="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -f "${COOKIE_JAR}"; rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

# 把变量安全地喂给下游命令（脚本里反复用到，收成一处）。
# 为什么不用 echo：echo 对 -n / 反斜杠转义 / 多行内容的处理在不同 shell 不一致，printf 原样输出才是对的。
pipe_var() { printf '%s' "$1"; }

# 文本里匹配的行数（grep 无匹配时返回码为 1，这里兜底成 0，避免 set -e 场景误判）
count_matches() { pipe_var "$1" | grep -c "$2" || true; }

# 从 JSON 文本里取字段（取不到给空串；jq 报错也不打断脚本）
json_field() { pipe_var "$1" | jq -r "$2 // empty" 2>/dev/null || true; }

check() { # check <描述> <期望> <实际>
  local summary # 单行摘要只算一次（PASS/FAIL 两条分支共用）
  summary="$(pipe_var "$3" | head -1 | cut -c1-60)"
  if pipe_var "$3" | grep -q "$2"; then
    printf 'PASS | %-46s | %s\n' "$1" "${summary}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL | %-46s | 期望含「%s」实际：%s\n' "$1" "$2" "${summary}"
    FAIL=$((FAIL + 1))
  fi
}

# 各探测共用的取值：HTTP 码 + 契约错误码 + 响应体是否泄漏存储根
probe() { # probe <path> → "HTTP=xxx CODE=yyy LEAK=n"
  local resp code
  resp="$(curl -s -b "${COOKIE_JAR}" -o "${TMP_DIR}/probe-body.json" -w '%{http_code}' \
    --get --data-urlencode "path=$1" "${API}/fs/list")"
  code="$(jq -r '.error.code // "OK"' "${TMP_DIR}/probe-body.json" 2>/dev/null)"
  printf 'HTTP=%s CODE=%s LEAK=%s' "${resp}" "${code}" \
    "$(grep -c 'fs-root\|/volume' "${TMP_DIR}/probe-body.json" 2>/dev/null || echo 0)"
}

echo "验收方补充探测 —— ${PROJECT_ROOT}（port=${PORT}）"
echo

bash "${SCRIPT_DIR}/start.sh" start >/dev/null 2>&1
sleep 2
curl -s -c "${COOKIE_JAR}" -X POST "${API}/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${AUTH_USER}\",\"password\":\"${AUTH_PASSWORD}\"}" -o /dev/null

echo "── 一、路径越界形态（每种都必须拒绝，且响应不泄漏存储根）──"
# 形态类探测：不依赖夹具是否存在，靠形态判定拒绝
while IFS='|' read -r name path expect; do
  [ -z "${name}" ] && continue
  result="$(probe "${path}")"
  check "${name}" "${expect}" "${result}"
  case "${result}" in *LEAK=0*) ;; *) FAIL=$((FAIL + 1)); printf 'FAIL | 泄漏检查（%s）\n' "${name}" ;; esac
done <<'CASES'
双斜杠|//etc/passwd|HTTP=4
点斜杠上级|/./../../etc|HTTP=403
多级上级|/文档/../../etc/passwd|HTTP=403
上级引用|/../etc/passwd|HTTP=403
单次编码点|/%2E%2E/etc|HTTP=403
多重编码|/%2e%2e%2f%2e%2e%2fetc|HTTP=403
反斜杠分隔|/..%5c..%5cwindows|HTTP=403
空字节编码|/a%00b|HTTP=400
CASES

echo
echo "── 二、路径长度边界（配置驱动，超长必须 400 而非 500）──"
SEG255="$(printf 'a%.0s' $(seq 1 255))"
SEG300="$(printf 'b%.0s' $(seq 1 300))"
check "单段 300 字节 → 400 INVALID_PATH" "INVALID_PATH" "$(probe "/${SEG300}")"
check "单段 255 字节 → 不误杀（非 400）" "HTTP=4" "$(probe "/${SEG255}")"

echo
echo "── 三、凭据 ──"
FORGED="$(curl -s -o "${TMP_DIR}/forged.json" -w 'HTTP=%{http_code}' -H 'Authorization: Bearer forged-token' \
  "${API}/fs/list?path=/")$(jq -r ' .error.code' "${TMP_DIR}/forged.json" 2>/dev/null | sed 's/^/ CODE=/')"
check "伪造 Bearer → 401 AUTH_INVALID" "AUTH_INVALID" "${FORGED}"
ANON="$(curl -s -o "${TMP_DIR}/anon.json" -w 'HTTP=%{http_code}' "${API}/fs/list?path=/")$(jq -r ' .error.code' "${TMP_DIR}/anon.json" 2>/dev/null | sed 's/^/ CODE=/')"
check "未认证 → 401 AUTH_REQUIRED" "AUTH_REQUIRED" "${ANON}"

echo
echo "── 四、API 响应不得泄漏绝对路径（曾抓到的真 bug）──"
LIST_BODY="$(curl -s -b "${COOKIE_JAR}" "${API}/tasks")"
# 注意：只找「存储根绝对路径」特征，不能用 `"/` 这种宽匹配 —— 用户路径本身就以 `/` 开头（契约规定），
# 拿它当泄漏会假阳性（本节曾经就是被这个宽匹配误报过一次）。
# 判据不放宽（泄漏就是缺陷，该 FAIL）；但**失败时必须能一眼看出漏在哪** ——
# 只报一个 LEAK=1 等于让人从零重查（上一次就是这样，只能靠猜）。
LEAK_N="$(count_matches "${LIST_BODY}" '/volume\|storage/fs-root')"
check "任务列表不含存储根绝对路径" "LEAK=0" "LEAK=${LEAK_N}"
if [ "${LEAK_N:-0}" -gt 0 ] 2>/dev/null; then
  printf '  命中片段（最多 3 条，前 60 / 后 40 字符）：\n'
  pipe_var "${LIST_BODY}" | grep -o '.\{0,60\}\(/volume\|storage/fs-root\).\{0,40\}' | head -3 | sed 's/^/    /'
fi

ABS_N="$(count_matches "${LIST_BODY}" 'absPath')"
check "任务列表不含 absPath 字段" "ABS=0" "ABS=${ABS_N}"
if [ "${ABS_N:-0}" -gt 0 ] 2>/dev/null; then
  printf '  命中片段（最多 3 条，前 60 / 后 40 字符）：\n'
  pipe_var "${LIST_BODY}" | grep -o '.\{0,60\}absPath.\{0,40\}' | head -3 | sed 's/^/    /'
fi

TASK_ID="$(json_field "${LIST_BODY}" '.data.items[0].id')"
if [ -n "${TASK_ID}" ]; then
  DETAIL_BODY="$(curl -s -b "${COOKIE_JAR}" "${API}/tasks/${TASK_ID}")"
  DETAIL_ABS_N="$(count_matches "${DETAIL_BODY}" 'absPath')"
  check "任务详情不含 absPath 字段" "ABS=0" "ABS=${DETAIL_ABS_N}"
  if [ "${DETAIL_ABS_N:-0}" -gt 0 ] 2>/dev/null; then
    printf '  命中片段（任务 %s，最多 3 条）：\n' "${TASK_ID}"
    pipe_var "${DETAIL_BODY}" | grep -o '.\{0,60\}absPath.\{0,40\}' | head -3 | sed 's/^/    /'
  fi
else
  printf 'SKIP | 任务详情泄漏检查（列表为空，无样本）\n'
fi

echo
echo "── 五、任务记录删除语义（DELETE /tasks/{id}）──"
TASKS_BEFORE="$(jq 'length' "${PROJECT_ROOT}/storage/tasks.json" 2>/dev/null || echo 0)"
HIST_BEFORE="$(wc -l < "${PROJECT_ROOT}/storage/task-history.jsonl" 2>/dev/null || echo 0)"
DEL_ID="$(curl -s -b "${COOKIE_JAR}" "${API}/tasks" | jq -r '[.data.items[]|select(.status=="failed" or .status=="interrupted")][0].id // empty' 2>/dev/null)"
if [ -n "${DEL_ID}" ]; then
  DEL_CODE="$(curl -s -b "${COOKIE_JAR}" -X DELETE -o "${TMP_DIR}/del.json" -w '%{http_code}' "${API}/tasks/${DEL_ID}")"
  check "DELETE 终态任务 → 200" "200" "HTTP=${DEL_CODE}"
  TASKS_AFTER="$(jq 'length' "${PROJECT_ROOT}/storage/tasks.json" 2>/dev/null || echo 0)"
  HIST_AFTER="$(wc -l < "${PROJECT_ROOT}/storage/task-history.jsonl" 2>/dev/null || echo 0)"
  check "活动记录恰好减少 1 条" "1" "$((TASKS_BEFORE - TASKS_AFTER))"
  check "历史行数不变（不连带删历史）" "0" "$((HIST_AFTER - HIST_BEFORE))"
  # 注意：同一任务可多次进入终态（如 interrupted → 又 failed），历史里该 id 可能有多行 —— 要判「≥1」而不是「=1」
  HIST_HIT="$(grep -c "${DEL_ID}" "${PROJECT_ROOT}/storage/task-history.jsonl" 2>/dev/null || echo 0)"
  check "被删记录仍留在历史里（计数 ≥1）" "1" "$([ "${HIST_HIT}" -ge 1 ] && echo 1 || echo 0)"
else
  printf 'SKIP | DELETE 语义（当前无 failed/interrupted 任务可删）\n'
fi
check "DELETE 不存在 → 404 TASK_NOT_FOUND" "404" \
  "HTTP=$(curl -s -b "${COOKIE_JAR}" -X DELETE -o /dev/null -w '%{http_code}' "${API}/tasks/00000000-0000-0000-0000-000000000000")"

bash "${SCRIPT_DIR}/start.sh" stop >/dev/null 2>&1

echo
echo "── 汇总 ──"
echo "PASS ${PASS} / FAIL ${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
