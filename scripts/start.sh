#!/usr/bin/env bash
#
# ZipCalm 启停脚本（项目规范：start | stop | restart | status 四参数）
#
# 设计要点：
# - PID 文件固定在**项目根**：`ZipCalm.pid`（项目全称，不放 /tmp、不放 server/ 子目录）
# - **禁止裸 pkill**：停止只按 PID 文件精确 TERM → 等待 → 必要时 KILL
# - node 路径自探测（环境变量 > PATH > 常见绝对路径），不假设 PATH 里一定有 node
# - 端口从配置读（storage/config.json → config.json → 默认 3010），不写死
# - 日志滚动到 storage/logs/server.log（storage/ 已 gitignore）
#
# 用法：
#   bash scripts/start.sh start      # 后台启动（已在跑则提示，不重复启动）
#   bash scripts/start.sh stop       # 优雅停止（TERM → 最多等 10s → KILL）
#   bash scripts/start.sh restart    # 先 stop 再 start
#   bash scripts/start.sh status     # 输出 PID / 端口 / 健康检查结果
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PID_FILE="${PROJECT_ROOT}/ZipCalm.pid"
BOOT_ENTRY="${PROJECT_ROOT}/server/boot.js"
LOG_DIR="${PROJECT_ROOT}/storage/logs"
LOG_FILE="${LOG_DIR}/server.log"

STOP_WAIT_SECONDS=10
HEALTH_WAIT_TICKS=40   # 40 × 0.5s = 20s
# 等 PID 文件（boot 在 listen 成功后才写，所以它出现=已就绪）。
# 为什么不是 5s：冷启动（尤其刚 build 完、磁盘忙）实测会超过 5s，
# 旧值 5s 会把**正在正常启动**的进程判死并 TERM 掉，表现为"日志停在半路、进程消失"。
PID_WAIT_TICKS="${ZIPCALM_PID_WAIT_TICKS:-75}"      # 75 × 0.2s = 15s
PID_GRACE_TICKS="${ZIPCALM_PID_GRACE_TICKS:-25}"    # 超时后再宽限 25 × 0.2s = 5s
START_LOG="${LOG_DIR}/start.log"

# 失败原因同时写 stderr 与 storage/logs/start.log：
# 调用方常把 start.sh 输出重定向到 /dev/null，只写 stderr 会让"这次为什么失败"不可追溯（实测踩过）。
fail_log() {
  local message="$*"
  printf '%s\n' "${message}" >&2
  mkdir -p "${LOG_DIR}" 2>/dev/null || true
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${message}" >> "${START_LOG}" 2>/dev/null || true
}

# 把服务日志尾部一并写进 start.log（现场证据不能只留在终端）
dump_recent_log() {
  local tail_text
  tail_text="$(tail -n 15 "${LOG_FILE}" 2>/dev/null || true)"
  printf '%s\n' "${tail_text}" >&2
  printf '[%s] --- server.log tail ---\n%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${tail_text}" >> "${START_LOG}" 2>/dev/null || true
}

# ===== node 自探测 =====
resolve_node() {
  if [ -n "${ZIPCALM_NODE:-}" ] && [ -x "${ZIPCALM_NODE}" ]; then
    printf '%s' "${ZIPCALM_NODE}"
    return 0
  fi
  local candidate
  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "${candidate}" ] && [ -x "${candidate}" ]; then
    printf '%s' "${candidate}"
    return 0
  fi
  local fallback
  for fallback in /usr/local/bin/node /usr/bin/node; do
    if [ -x "${fallback}" ]; then
      printf '%s' "${fallback}"
      return 0
    fi
  done
  return 1
}

# ===== 端口解析（配置驱动，不写死）=====
resolve_port() {
  if [ -n "${ZIPCALM_PORT:-}" ]; then
    printf '%s' "${ZIPCALM_PORT}"
    return 0
  fi
  local from_config
  from_config="$(
    cd "${PROJECT_ROOT}" && "${NODE_BIN}" -e '
      const fs = require("node:fs");
      for (const file of ["storage/config.json", "config.json"]) {
        try {
          const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
          if (parsed && parsed.server && parsed.server.port) {
            process.stdout.write(String(parsed.server.port));
            process.exit(0);
          }
        } catch {
          // 配置不可读/不是合法 JSON：不报错，回落到下面的默认端口
        }
      }
      process.stdout.write("3010");
    ' 2>/dev/null || true
  )"
  printf '%s' "${from_config:-3010}"
}

read_pid() {
  if [ -f "${PID_FILE}" ]; then
    tr -d ' \n' < "${PID_FILE}"
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  [ -n "${pid}" ] || return 1
  kill -0 "${pid}" 2>/dev/null
}

# ===== 健康检查（无 jq 依赖，用 node 解析）=====
health_probe() {
  local url="http://127.0.0.1:${PORT}/api/v1/health"
  local body
  body="$("${NODE_BIN}" -e '
    const url = process.argv[1];
    fetch(url, { signal: AbortSignal.timeout(2000) })
      .then((res) => res.json())
      .then((json) => { console.log((json && json.ok) ? "ok" : "not-ok"); })
      .catch(() => { console.log("unreachable"); });
  ' "${url}" 2>/dev/null || echo "unreachable")"
  printf '%s' "${body}"
}

print_status_line() {
  local pid state health
  if is_running; then
    pid="$(read_pid)"
    health="$(health_probe)"
    printf 'ZipCalm: running (pid=%s, port=%s, health=%s)\n' "${pid}" "${PORT}" "${health}"
  else
    health="$(health_probe)"
    if [ "${health}" = "ok" ]; then
      printf 'ZipCalm: 端口 %s 有服务在响应，但 PID 文件（%s）指向的进程已不存在——很可能是另一个实例或陈旧 PID 文件。\n' "${PORT}" "${PID_FILE}"
    elif [ -f "${PID_FILE}" ]; then
      printf 'ZipCalm: stopped (存在陈旧 PID 文件 %s)\n' "${PID_FILE}"
    else
      printf 'ZipCalm: stopped\n'
    fi
  fi
}

do_start() {
  if is_running; then
    printf 'ZipCalm 已在运行（pid=%s），无需重复启动。\n' "$(read_pid)"
    print_status_line
    return 0
  fi

  if [ ! -f "${BOOT_ENTRY}" ]; then
    fail_log "启动失败：找不到入口 ${BOOT_ENTRY}"
    exit 1
  fi

  # 端口预检：PID 文件失效但端口上已有服务在响应 → 说明另有实例/残留进程，
  # 这时必须报错退出，否则新进程会 EADDRINUSE 秒退，而健康检查却因旧实例而"通过"，
  # 造成"启动成功但跑的是旧代码"的假象（本项目真实踩过）。
  if [ "$(health_probe)" = "ok" ]; then
    fail_log "启动失败：端口 ${PORT} 上已有服务在响应，但 PID 文件 ${PID_FILE} 指向的进程不存在。"
    fail_log "请先确认并停止占用该端口的进程（或用 ZIPCALM_PORT 换端口）后再启动。"
    exit 1
  fi

  # 清掉可能存在的陈旧 PID 文件
  [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"

  mkdir -p "${LOG_DIR}"
  printf '\n===== start at %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "${LOG_FILE}"

  # 启动约定：
  # - `&` 只作用在 nohup 这一条命令上（不能写成 `( cd X && nohup ... & )`——
  #   那样 `$!` 拿到的是子 shell 的 PID，stop 会杀错进程，真实 node 变孤儿继续占端口）；
  # - PID 由**进程自己**写（boot.js 读 ZIPCALM_PID_FILE），比 shell 用 $! 猜更可靠。
  pushd "${PROJECT_ROOT}" >/dev/null
  ZIPCALM_PID_FILE="${PID_FILE}" nohup "${NODE_BIN}" "${BOOT_ENTRY}" >> "${LOG_FILE}" 2>&1 &
  LAUNCHED_PID=$!
  popd >/dev/null

  # 等 PID 文件出现：boot.js 监听成功后才写，所以它出现即代表已就绪。
  # 超时不再"立刻杀掉"——慢启动（刚 build 完/磁盘忙）会超过预算，
  # 旧实现直接 TERM 会让一个**正在正常启动**的进程静默消失（实测踩过）。
  local waited=0
  while [ ! -f "${PID_FILE}" ]; do
    sleep 0.2
    waited=$((waited + 1))

    if ! kill -0 "${LAUNCHED_PID}" 2>/dev/null; then
      fail_log "启动失败：进程已退出（很可能是端口占用或配置错误）。最近日志："
      dump_recent_log
      rm -f "${PID_FILE}"
      exit 1
    fi

    if [ "${waited}" -ge "${PID_WAIT_TICKS}" ]; then
      # 超时前再探一次健康：可能刚好就绪（只是 PID 文件还没落盘）
      if [ "$(health_probe)" = "ok" ]; then
        break
      fi
      fail_log "启动较慢：${PID_WAIT_TICKS} 个 tick（约 $((PID_WAIT_TICKS / 5))s）内未见 PID 文件，进程仍在启动中，再宽限 $((PID_GRACE_TICKS / 5))s……"
      local grace=0
      while [ ! -f "${PID_FILE}" ] && [ "${grace}" -lt "${PID_GRACE_TICKS}" ]; do
        sleep 0.2
        grace=$((grace + 1))
      done
      if [ ! -f "${PID_FILE}" ]; then
        if [ "$(health_probe)" = "ok" ]; then
          break
        fi
        fail_log "启动失败：等待 PID 文件超时（已等 $((PID_WAIT_TICKS + PID_GRACE_TICKS)) 个 tick，PID 文件 ${PID_FILE}）。最近日志："
        dump_recent_log
        [ -n "${LAUNCHED_PID}" ] && kill -TERM "${LAUNCHED_PID}" 2>/dev/null || true
        exit 1
      fi
      break
    fi
  done

  # 等健康检查通过再回报（避免"进程在跑但其实是崩的"）
  local tick health
  for tick in $(seq 1 "${HEALTH_WAIT_TICKS}"); do
    sleep 0.5
    if ! is_running; then
      fail_log "启动失败：进程已退出。最近日志："
      dump_recent_log
      rm -f "${PID_FILE}"
      exit 1
    fi
    health="$(health_probe)"
    if [ "${health}" = "ok" ]; then
      printf 'ZipCalm 启动成功（pid=%s, port=%s）\n' "$(read_pid)" "${PORT}"
      printf '日志：%s\n' "${LOG_FILE}"
      print_status_line
      return 0
    fi
  done

  fail_log "启动超时（进程在跑但健康检查未通过）。最近日志："
  dump_recent_log
  exit 1
}

do_stop() {
  if ! is_running; then
    printf 'ZipCalm 未在运行。\n'
    [ -f "${PID_FILE}" ] && rm -f "${PID_FILE}"
    return 0
  fi

  local pid
  pid="$(read_pid)"
  printf '正在停止 ZipCalm（pid=%s）...\n' "${pid}"
  kill -TERM "${pid}" 2>/dev/null || true

  local waited=0
  while kill -0 "${pid}" 2>/dev/null; do
    if [ "${waited}" -ge $((STOP_WAIT_SECONDS * 2)) ]; then
      printf '优雅停止超时，改用 KILL（pid=%s）\n' "${pid}"
      kill -KILL "${pid}" 2>/dev/null || true
      break
    fi
    sleep 0.5
    waited=$((waited + 1))
  done

  rm -f "${PID_FILE}"
  # 停完复核端口：若仍有服务响应，说明还有别的实例，必须说清楚（不要假装停干净了）
  local health
  health="$(health_probe)"
  if [ "${health}" = "ok" ]; then
    printf '警告：PID %s 已停止，但端口 %s 仍有服务在响应（可能存在其他实例）。\n' "${pid}" "${PORT}" >&2
    return 1
  fi
  printf 'ZipCalm 已停止，端口 %s 已释放。\n' "${PORT}"
}

do_status() {
  print_status_line
  if is_running; then
    printf '日志：%s\n' "${LOG_FILE}"
    [ -f "${LOG_FILE}" ] && tail -n 3 "${LOG_FILE}" || true
    return 0
  fi
  return 1
}

# ===== 主流程 =====
ACTION="${1:-status}"

NODE_BIN="$(resolve_node)" || {
  printf '找不到 node（可用环境变量 ZIPCALM_NODE 指定绝对路径）\n' >&2
  exit 1
}
PORT="$(resolve_port)"

case "${ACTION}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  *)
    printf '用法：bash scripts/start.sh {start|stop|restart|status}\n' >&2
    exit 2
    ;;
esac
