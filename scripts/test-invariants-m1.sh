#!/usr/bin/env bash
#
# M1 验收脚本：认证双通道 + 文件浏览 + INV-06 路径白名单十条用例
#
# 用法：
#   bash scripts/start.sh start
#   bash scripts/test-invariants-m1.sh                 # 默认 http://127.0.0.1:<配置端口>
#   ZIPCALM_BASE=http://10.0.0.5:3010 bash scripts/test-invariants-m1.sh
#   ZIPCALM_TEST_PASSWORD=xxx bash scripts/test-invariants-m1.sh
#
# 输出：每条用例一行「用例 | 期望 | 实际 | PASS/FAIL」，最后汇总；有 FAIL 则退出码 1。
#
# 关于编码（踩过的坑，写在最前面）：
# - 非 ASCII 路径必须由**客户端**做百分号编码（浏览器与 axios 会自动做）；
#   直接把 UTF-8 字节塞进请求行，Node 的 HTTP 解析器会先返回 400，根本到不了业务逻辑。
# - 单次编码（%2e%2e / %00 / %5c）要用 curl 原样传 URL（curl 不会二次编码）；
#   用 `--data-urlencode` 会把 `%` 编码成 `%25`，那是"双重编码"场景，两种都要测。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NODE_BIN="$(command -v node || true)"
[ -n "${NODE_BIN}" ] || { printf '找不到 node\n' >&2; exit 1; }

PORT="${ZIPCALM_PORT:-}"
if [ -z "${PORT}" ]; then
  PORT="$("${NODE_BIN}" -e '
    const fs = require("node:fs");
    try { const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j?.server?.port || 3010)); }
    catch { process.stdout.write("3010"); }
  ' "${PROJECT_ROOT}/storage/config.json")"
fi
BASE="${ZIPCALM_BASE:-http://127.0.0.1:${PORT}}"
API="${BASE}/api/v1"
# 测试账号统一来源（见 scripts/helpers/test-credentials.sh：默认值、覆盖方式与审计豁免说明）
source "${SCRIPT_DIR}/helpers/test-credentials.sh"
AUTH_USER="${TEST_USER}"
AUTH_PASSWORD="${TEST_PASSWORD}"

COOKIE_JAR="$(mktemp)"
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
trap 'rm -f "${COOKIE_JAR}"' EXIT

# ===== 断言内核 =====

parse_body() {
  "${NODE_BIN}" -e '
    const fs = require("node:fs");
    const mode = process.argv[2];
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (mode === "code") process.stdout.write(String(j?.error?.code || (j?.ok === true ? "OK" : "NO_ENVELOPE")));
      else process.stdout.write(String(j?.error?.message || ""));
    } catch {
      process.stdout.write(mode === "code" ? "NO_ENVELOPE" : "");
    }
  ' "$1" "$2"
}

record() {
  local name="$1" expectHttp="$2" expectCode="$3" http="$4" code="$5" detail="$6"
  local ok=1
  [ "${http}" = "${expectHttp}" ] || ok=0
  if [ "${expectCode}" != "-" ]; then [ "${code}" = "${expectCode}" ] || ok=0; fi

  if [ "${ok}" = "1" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    printf 'PASS | %-40s | HTTP %-3s %-22s | %s\n' "${name}" "${http}" "${code}" "${detail}"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    printf 'FAIL | %-40s | 期望 HTTP %s/%s，实际 HTTP %s/%s | %s\n' "${name}" "${expectHttp}" "${expectCode}" "${http}" "${code}" "${detail}"
  fi
}

# 任意请求（调用方自己给出完整 URL / 参数）
check_raw() {
  local name="$1" expectHttp="$2" expectCode="$3"; shift 3
  local tmp http code detail
  tmp="$(mktemp)"
  http="$(curl -s -o "${tmp}" -w '%{http_code}' "$@" || echo '000')"
  code="$(parse_body "${tmp}" code)"
  detail="$(parse_body "${tmp}" message)"
  rm -f "${tmp}"
  record "${name}" "${expectHttp}" "${expectCode}" "${http}" "${code}" "${detail}"
}

# 带 path 参数的请求：客户端负责百分号编码（模拟浏览器/axios 行为）
check_path() {
  local name="$1" expectHttp="$2" expectCode="$3" endpoint="$4" pathValue="$5"; shift 5
  local tmp http code detail
  tmp="$(mktemp)"
  http="$(curl -s -o "${tmp}" -w '%{http_code}' -b "${COOKIE_JAR}" -G --data-urlencode "path=${pathValue}" "$@" "${API}${endpoint}" || echo '000')"
  code="$(parse_body "${tmp}" code)"
  detail="$(parse_body "${tmp}" message)"
  rm -f "${tmp}"
  record "${name}" "${expectHttp}" "${expectCode}" "${http}" "${code}" "${detail}"
}

printf 'ZipCalm M1 验收\n目标：%s\n\n' "${API}"

# ===== 1. 认证 =====

printf '── 认证（Session + Bearer 双通道）──\n'

LOGIN_BODY="$(mktemp)"
LOGIN_HTTP="$(curl -s -o "${LOGIN_BODY}" -w '%{http_code}' -c "${COOKIE_JAR}" \
  -X POST "${API}/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${AUTH_USER}\",\"password\":\"${AUTH_PASSWORD}\"}")"
TOKEN="$("${NODE_BIN}" -e '
  const fs = require("node:fs");
  try { const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(j?.data?.token || "")); }
  catch { /* 响应不是合法 JSON：token 留空，由下面的断情报失败 */ }
' "${LOGIN_BODY}")"

if [ "${LOGIN_HTTP}" = "200" ] && [ -n "${TOKEN}" ]; then
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS | %-40s | HTTP 200 + token(%s…)\n' '登录同时返回 Cookie 与 Bearer Token' "${TOKEN:0:8}"
else
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL | 登录失败：HTTP %s\n' "${LOGIN_HTTP}"
  cat "${LOGIN_BODY}"
  rm -f "${LOGIN_BODY}"
  printf '\n提示：确认服务已启动（bash scripts/start.sh status）；密码可用 ZIPCALM_TEST_PASSWORD 覆盖。\n'
  exit 1
fi
rm -f "${LOGIN_BODY}"

check_raw "Cookie（Session）通道 /auth/me" 200 OK -b "${COOKIE_JAR}" "${API}/auth/me"
check_raw "Bearer 通道 /auth/me" 200 OK -H "Authorization: Bearer ${TOKEN}" "${API}/auth/me"
check_raw "未认证访问 /auth/me" 401 AUTH_REQUIRED "${API}/auth/me"
check_raw "伪造 Bearer /auth/me" 401 AUTH_INVALID -H 'Authorization: Bearer not-a-real-token' "${API}/auth/me"
check_raw "错误密码登录" 401 AUTH_INVALID -X POST "${API}/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"${AUTH_USER}\",\"password\":\"definitely-wrong\"}"
check_raw "缺少字段登录" 400 VALIDATION_FAILED -X POST "${API}/auth/login" -H 'Content-Type: application/json' -d '{}'

# ===== 2. 正常浏览 =====

printf '\n── 文件浏览（正常路径）──\n'

check_path "列存储根 /" 200 OK /fs/list /
check_path "进入子目录 /文档" 200 OK /fs/list /文档
check_path "进入二级子目录 /文档/子目录" 200 OK /fs/list /文档/子目录
# 软链夹具在 CIFS/SMB 上可能创建失败（ENOTSUP）—— 缺的是构造样本的能力，不是防护失效
if [ -L "${PROJECT_ROOT}/storage/fs-root/文档-链接" ]; then
  check_path "根内符号链接可进入" 200 OK /fs/list /文档-链接
else
  SKIP_COUNT=$((SKIP_COUNT + 1)); printf "SKIP | %-40s | 文件系统不支持软链，夹具未建成
" "根内符号链接可进入"
fi
check_path "文件详情 /说明.txt" 200 OK /fs/stat /说明.txt
check_path "文件当目录列（NOT_A_DIRECTORY）" 400 NOT_A_DIRECTORY /fs/list /说明.txt
check_path "不存在的路径" 404 PATH_NOT_FOUND /fs/list /没有这个目录
check_path "showHidden=true" 200 OK /fs/list / --data-urlencode 'showHidden=true'
check_path "showHidden=false" 200 OK /fs/list / --data-urlencode 'showHidden=false'

HIDDEN_BODY="$(mktemp)"
curl -s -o "${HIDDEN_BODY}" -b "${COOKIE_JAR}" -G --data-urlencode 'path=/' --data-urlencode 'showHidden=true' "${API}/fs/list"
HIDDEN_OK="$("${NODE_BIN}" -e '
  const fs = require("node:fs");
  try { const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const names = (j?.data?.entries || []).map((e) => e.name); process.stdout.write(names.includes(".隐藏目录") ? "yes" : "no"); } catch { process.stdout.write("no"); }
' "${HIDDEN_BODY}")"
rm -f "${HIDDEN_BODY}"
if [ "${HIDDEN_OK}" = "yes" ]; then
  PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS | %-40s | 返回 .隐藏目录\n' 'showHidden=true 内容断言'
else
  FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL | %-40s | 未返回 .隐藏目录\n' 'showHidden=true 内容断言'
fi

# ===== 3. INV-06 路径白名单十条 =====

printf '\n── INV-06 路径白名单（十条用例，对照 docs/M0/不变量清单.md）──\n'

check_path "① ../ 上级引用" 403 PATH_OUT_OF_ROOT /fs/list ../
check_path "① /../ 读系统文件" 403 PATH_OUT_OF_ROOT /fs/list /../etc/passwd
check_path "② 多级 ../../ 逃逸" 403 PATH_OUT_OF_ROOT /fs/list /a/../../etc/passwd
check_raw  "③ 单次编码 %2e%2e" 403 PATH_OUT_OF_ROOT -b "${COOKIE_JAR}" "${API}/fs/list?path=/%2e%2e/etc"
check_raw  "④ 单次编码 %2e%2e%2f" 403 PATH_OUT_OF_ROOT -b "${COOKIE_JAR}" "${API}/fs/list?path=/a/%2e%2e%2fetc"
check_raw  "⑤ 反斜杠 ..%5c..%5c" 403 PATH_OUT_OF_ROOT -b "${COOKIE_JAR}" "${API}/fs/list?path=/..%5c..%5cwindows"
check_path "⑥ 前缀绕过（兄弟目录）" 403 PATH_OUT_OF_ROOT /fs/list /../fs-root-evil
check_path "⑦ 绝对路径 /etc/passwd" 404 PATH_NOT_FOUND /fs/list /etc/passwd
check_raw  "⑧ null 字节（单次编码 %00）" 400 INVALID_PATH -b "${COOKIE_JAR}" "${API}/fs/list?path=/a%00b"
check_path "⑧ null 字节（双重编码）" 400 INVALID_PATH /fs/list /a%00b
if [ -L "${PROJECT_ROOT}/storage/fs-root/越界-链接" ]; then
  check_path "⑨ 指向根外的符号链接" 403 PATH_OUT_OF_ROOT /fs/list /越界-链接
  check_path "⑨ 穿过越界链接读子路径" 403 PATH_OUT_OF_ROOT /fs/list /越界-链接/server
else
  SKIP_COUNT=$((SKIP_COUNT + 2)); printf "SKIP | %-40s | 文件系统不支持软链，夹具未建成
" "⑨ 越界符号链接（2 项）"
fi
check_path "⑩ root 内正常路径（放行）" 200 OK /fs/list /文档/子目录

# ===== 4. 路径长度上限（配置驱动：limits.maxPathLength / limits.maxPathSegmentLength）=====
# 背景：验收时发现 `/aaaa…(300)` 曾返回 500 INTERNAL_ERROR（底层 ENAMETOOLONG 未翻译成契约码）。
# 修复后：长度类问题一律 400 INVALID_PATH；且上限来自配置，不写死数字。

printf '\n── 路径长度上限（可配置，超长必须 400 而非 500）──\n'

TOO_LONG_SEGMENT="/$(printf 'a%.0s' $(seq 1 300))"   # 单段 300 字节 > 默认上限 255
TOO_LONG_TOTAL="/$(printf 'a%.0s' $(seq 1 5000))"    # 整条 5000 字符 > 默认上限 4096
AT_SEGMENT_LIMIT="/$(printf 'a%.0s' $(seq 1 255))"   # 恰好等于单段上限（不应被长度校验拦下）
CJK_OVER_LIMIT="/$(printf '中%.0s' $(seq 1 90))"     # 90 字 × 3 字节 = 270 字节 > 255（按字节判定）

check_path "超长单段（300 字节）" 400 INVALID_PATH /fs/list "$TOO_LONG_SEGMENT"
check_path "超长整条（5000 字符）" 400 INVALID_PATH /fs/list "$TOO_LONG_TOTAL"
check_path "多字节段超限（90 中文 = 270 字节）" 400 INVALID_PATH /fs/list "$CJK_OVER_LIMIT"
check_path "单段恰好 255（等于上限，放行到磁盘层）" 404 PATH_NOT_FOUND /fs/list "$AT_SEGMENT_LIMIT"
check_path "stat 端点同样受限" 400 INVALID_PATH /fs/stat "$TOO_LONG_SEGMENT"

# 额外安全断言：错误消息里不得出现存储根绝对路径
LEAK_BODY="$(mktemp)"
curl -s -o "${LEAK_BODY}" -b "${COOKIE_JAR}" -G --data-urlencode 'path=/etc/passwd' "${API}/fs/list"
if grep -q 'fs-root' "${LEAK_BODY}"; then
  FAIL_COUNT=$((FAIL_COUNT + 1)); printf 'FAIL | %-40s | 响应体泄漏存储根：%s\n' '错误消息不泄漏绝对路径' "$(cat "${LEAK_BODY}")"
else
  PASS_COUNT=$((PASS_COUNT + 1)); printf 'PASS | %-40s | 响应体不含存储根路径\n' '错误消息不泄漏绝对路径'
fi
rm -f "${LEAK_BODY}"

printf '\n── 汇总 ──\nPASS %s / FAIL %s / SKIP %s\n' "${PASS_COUNT}" "${FAIL_COUNT}" "${SKIP_COUNT}"
[ "${FAIL_COUNT}" -eq 0 ] || exit 1
