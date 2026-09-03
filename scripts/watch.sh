#!/usr/bin/env bash
# watch.sh — 盘中盯盘守护（ths watch）生命周期管理（幂等、单实例）
#
# 用法：
#   scripts/watch.sh start [interval]   # 启动盯盘（默认 30s 轮询；重复启动 no-op）
#   scripts/watch.sh stop               # 停止
#   scripts/watch.sh status             # 状态（exit 0 = 在跑）
#   scripts/watch.sh restart [interval]
#
# 说明：
# - status 语义是"盯盘进程在不在"（kill -0 判活），不是"盯盘正不正常"——
#   watch 无 HTTP 探活端点；Bridge/浏览器是否在线由进程内 ⚠ 行反映。
# - 用 nohup + setsid 双重 detach，主 shell 立即返回，不阻塞。
# - 日志 logs/watch.log（追加）；PID 文件 .watch.pid（已在 .gitignore 的 *.pid）。
# - 前台实时表请看 `node cli.js watch`（Ctrl+C 退出）；本脚本是后台常驻（日志 tail 看告警）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.watch.pid"
LOG_FILE="$ROOT/logs/watch.log"
DEFAULT_INTERVAL=30

pid_alive() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid=$(cat "$PID_FILE" 2>/dev/null || true)
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cmd_status() {
  if pid_alive; then
    local pid
    pid=$(cat "$PID_FILE")
    echo "[watch.sh] running — pid=$pid (log=$LOG_FILE)"
    return 0
  fi
  echo "[watch.sh] not running"
  [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"
  return 1
}

cmd_start() {
  local interval="${1:-$DEFAULT_INTERVAL}"
  case "$interval" in
    ''|*[!0-9]*) interval="$DEFAULT_INTERVAL" ;;
  esac
  [[ "$interval" -lt 5 ]] && interval=5

  if pid_alive; then
    echo "[watch.sh] already running (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  mkdir -p "$ROOT/logs"
  setsid nohup node "$ROOT/cli.js" watch --interval "$interval" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "$PID_FILE"

  # 给足启动时间（建参照位可能逐只拉 K 线）；只判进程是否活下来
  sleep 2
  if kill -0 "$pid" 2>/dev/null; then
    echo "[watch.sh] started — pid=$pid, interval=${interval}s, log=$LOG_FILE"
    return 0
  fi
  echo "[watch.sh] process exited prematurely. Last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  return 1
}

cmd_stop() {
  if pid_alive; then
    local pid
    pid=$(cat "$PID_FILE")
    kill "$pid" 2>/dev/null || true
    local i=0
    while (( i < 30 )) && kill -0 "$pid" 2>/dev/null; do
      sleep 0.1
      i=$((i + 1))
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo "[watch.sh] stopped (pid=$pid)"
  else
    echo "[watch.sh] not running (stale PID cleaned)"
  fi
  rm -f "$PID_FILE"
  return 0
}

case "${1:-status}" in
  start) cmd_start "${2:-}" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  restart) cmd_stop; cmd_start "${2:-}" ;;
  *)
    echo "Usage: $0 {start [interval]|stop|status|restart [interval]}" >&2
    exit 1
    ;;
esac
