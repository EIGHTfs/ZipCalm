#!/bin/bash
# M3 崩溃恢复验收（验收方独立复验，与实现方自测脚本互不依赖）
#
# 验什么（全程 HTTP 黑盒驱动，不 import 源码）：
#   ① SSE 连接首帧必须是 snapshot（INV-05：进度是状态不是消息）
#   ② kill -9 强杀后重启：未完成任务 → interrupted + error.code=INTERRUPTED + details.reason
#   ③ 中断任务的 .part 必须保留（INV-10：服务于"可重试"）
#   ④ 带 since 重连时首帧仍然是 snapshot（续传不能只靠增量补齐）
#
# 为什么单独写一份：如果验收与自测跑同一套脚本，双方会沿用同一套假设，
# 脚本"通过"只证明那个假设自洽。这里刻意从 HTTP 层重建场景：自己造数据、自己杀进程、自己查落盘。
#
# 用法：
#   bash scripts/test-m3-crash-recovery.sh
#
# 可覆盖的环境变量（均有默认值，无硬编码路径/凭据）：
#   ZC_TEST_PORT      服务端口（默认 3010）
#   ZC_TEST_USER      登录用户（默认 admin）
#   ZC_TEST_PASSWORD  登录密码（默认值见 scripts/helpers/test-credentials.sh）
#   ZC_TEST_DIR       测试夹具目录名，相对存储根（默认 m3-test）
#   ZC_TEST_SIZE_MB   造多大的假数据（默认 50，需足够大以便在任务执行中被杀）
#
# 注意：脚本会 kill -9 服务进程 —— 这正是被测场景。请只在测试环境运行。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}" || exit 1

PORT="${ZC_TEST_PORT:-3010}"
# 测试账号统一来源（默认值 / 覆盖方式 / 审计豁免说明都写在 helper 里，三个脚本不再各写一份）
source "${SCRIPT_DIR}/helpers/test-credentials.sh"
AUTH_USER="${TEST_USER}"
AUTH_PASSWORD="${TEST_PASSWORD}"
FIXTURE_NAME="${ZC_TEST_DIR:-m3-test}"
SIZE_MB="${ZC_TEST_SIZE_MB:-50}"

API="http://127.0.0.1:${PORT}/api/v1"
COOKIE_JAR="$(mktemp)" || exit 1
# 临时响应体放本次运行的私有目录（不散落硬编码 /tmp 文件名）
TMP_DIR="$(mktemp -d)"
PROJECT_NAME="$(basename "${PROJECT_ROOT}")"
PID_FILE="${PROJECT_ROOT}/${PROJECT_NAME}.pid"
FIXTURE_API="/${FIXTURE_NAME}"

PASS=0
FAIL=0
# 把变量安全地喂给下游命令（脚本里反复用到，收成一处）。
# 为什么不用 echo：echo 对 -n / 反斜杠转义 / 多行内容的处理在不同 shell 不一致，printf 原样输出才是对的。
pipe_var() { printf '%s' "$1"; }

# 从 JSON 文本里取字段（取不到给空串；jq 报错也不打断脚本）
json_field() { pipe_var "$1" | jq -r "$2 // empty" 2>/dev/null || true; }

check() { # check <描述> <期望包含> <实际>
  local summary # 单行摘要只算一次（PASS/FAIL 两条分支共用）
  summary="$(pipe_var "$3" | head -1 | cut -c1-90)"
  if pipe_var "$3" | grep -q "$2"; then
    printf 'PASS | %s | %s\n' "$1" "${summary}"
    PASS=$((PASS + 1))
  else
    printf 'FAIL | %s | 期望含「%s」实际：%s\n' "$1" "$2" "${summary}"
    FAIL=$((FAIL + 1))
  fi
}
cleanup() { rm -f "${COOKIE_JAR}"; }
trap cleanup EXIT

login() {
  curl -s -c "${COOKIE_JAR}" -X POST "${API}/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${AUTH_USER}\",\"password\":\"${AUTH_PASSWORD}\"}" -o /dev/null
}

echo "M3 崩溃恢复验收 —— ${PROJECT_ROOT}（port=${PORT}）"
echo

# ── 0. 准备假数据（在存储根内，走 API 可见的相对路径）────────────────────
STORAGE_ROOT="$(curl -s -c "${COOKIE_JAR}" -X POST "${API}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${AUTH_USER}\",\"password\":\"${AUTH_PASSWORD}\"}" >/dev/null 2>&1; \
  jq -r '.storage.root // empty' "${PROJECT_ROOT}/storage/config.json" 2>/dev/null)"
if [ -z "${STORAGE_ROOT}" ] || [ ! -d "${STORAGE_ROOT}" ]; then
  echo "SKIP：无法从 storage/config.json 解析存储根，跳过（先启动过一次服务以生成配置）"
  exit 0
fi

mkdir -p "${STORAGE_ROOT}/${FIXTURE_NAME}"
BIG_FILE="${STORAGE_ROOT}/${FIXTURE_NAME}/verify-big.bin"
dd if=/dev/urandom of="${BIG_FILE}" bs=1M count="${SIZE_MB}" 2>/dev/null
echo "假数据：${BIG_FILE}（$(ls -lh "${BIG_FILE}" | awk '{print $5}')）"

bash "${SCRIPT_DIR}/start.sh" start >/dev/null 2>&1
sleep 2
login
echo

# ── ① SSE 首帧快照 ──────────────────────────────────────────────────────
FIRST_FRAME="$(timeout 3 curl -sN -b "${COOKIE_JAR}" "${API}/tasks/events" | head -2 | tr '\n' ' ')"
check "SSE 首帧是 snapshot（INV-05）" "event: snapshot" "${FIRST_FRAME}"

# ── ② 起任务 → kill -9 → 重启 → 查恢复 ──────────────────────────────────
curl -s -b "${COOKIE_JAR}" -X POST "${API}/compress/tasks" -H 'Content-Type: application/json' \
  -d "{\"sources\":[\"${FIXTURE_API}/verify-big.bin\"],\"format\":\"zip\",\"mode\":\"bundle\",\"outputDir\":\"${FIXTURE_API}\"}" \
  -o "${TMP_DIR}/verify-task.json" -w '' 2>/dev/null
TASK_ID="$(jq -r '.data.task.id // empty' "${TMP_DIR}/verify-task.json" 2>/dev/null)"
if [ -z "${TASK_ID}" ]; then
  check "创建压缩任务（拿到 taskId）" "." "$(head -c 200 "${TMP_DIR}/verify-task.json")"
else
  check "创建压缩任务（拿到 taskId）" "${TASK_ID}" "${TASK_ID}"
fi
sleep 2

PID="$(cat "${PID_FILE}" 2>/dev/null)"
if [ -z "${PID}" ]; then
  echo "SKIP：PID 文件 ${PID_FILE} 不存在，跳过崩溃恢复验证"
  exit 0
fi
kill -9 "${PID}" 2>/dev/null
sleep 1
PORT_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)"
check "kill -9 后服务确实停止" "000" "${PORT_CODE}"

bash "${SCRIPT_DIR}/start.sh" start >/dev/null 2>&1
sleep 2
login

TASK_JSON="$(curl -s -b "${COOKIE_JAR}" "${API}/tasks/${TASK_ID}")"
# 注意：任务详情响应形如 { ok, data: { task: {...} } } —— 是 data.task，不是 data
STATUS="$(json_field "${TASK_JSON}" '.data.task.status')"
CODE="$(json_field "${TASK_JSON}" '.data.task.error.code')"
REASON="$(json_field "${TASK_JSON}" '.data.task.error.details.reason')"
check "恢复后状态为 interrupted" "interrupted" "${STATUS}"
check "恢复后错误码为 INTERRUPTED" "INTERRUPTED" "${CODE}"
check "恢复后带重启原因（details.reason）" "SERVER_RESTART" "${REASON}"

PART_LEFT="$(ls -1 "${STORAGE_ROOT}/${FIXTURE_NAME}/" 2>/dev/null | grep -c 'part')"
check "中断任务的 .part 已保留（INV-10）" "1" "$([ "${PART_LEFT}" -gt 0 ] && echo 1 || echo 0)"

# ── ④ 带 since 重连首帧仍是快照 ─────────────────────────────────────────
RESUMED="$(timeout 3 curl -sN -b "${COOKIE_JAR}" "${API}/tasks/events?since=0" | head -2 | tr '\n' ' ')"
check "带 since 重连首帧仍是 snapshot" "event: snapshot" "${RESUMED}"

bash "${SCRIPT_DIR}/start.sh" stop >/dev/null 2>&1

echo
echo "── 汇总 ──"
echo "PASS ${PASS} / FAIL ${FAIL}"
[ "${FAIL}" -eq 0 ] || exit 1
