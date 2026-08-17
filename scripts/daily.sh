#!/usr/bin/env bash
# daily.sh — 每日监控 + 复盘 + 经验积累（学习回路）
#
# 一键跑 `ths daily run`（①大盘 ②自选池估值 ③逐股分析存快照 ④回填历史outcome ⑤池建议）
# + `ths daily review`（复盘命中率统计，纯本地）。结果落盘 data/daily/，长期积累可复用。
#
# 用法:
#   scripts/daily.sh                          # 默认自选池，监控+复盘
#   scripts/daily.sh --codes 600519,000001    # 用指定代码池
#   scripts/daily.sh --refresh                # 强制刷新 K 线缓存（否则走 TTL 缓存）
#   scripts/daily.sh --since 90               # 复盘统计窗口（天，默认 30）
#   scripts/daily.sh --scan                   # 显式加跑一遍条件选股（默认不做，省接口）
#   scripts/daily.sh --candidates a,b,c       # 让候选参与"加入"池建议评估
#
# 依赖: Bridge Server 在线（自动 ensure）；失败步骤给出提示但不中断整份日报。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CODES=""
REFRESH=0
SINCE=30
SCAN=0
CANDIDATES=""
MIN_N=""
POOL_ARGS=()
RUN_FLAGS=()

args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --codes) CODES="${args[$((i+1))]:-}"; i=$((i+1)); POOL_ARGS=("--codes" "$CODES") ;;
    --codes=*) CODES="${args[$i]#--codes=}"; POOL_ARGS=("--codes" "$CODES") ;;
    --refresh) REFRESH=1 ;;
    --since) SINCE="${args[$((i+1))]:-}"; i=$((i+1)) ;;
    --since=*) SINCE="${args[$i]#--since=}" ;;
    --scan) SCAN=1 ;;
    --candidates) CANDIDATES="${args[$((i+1))]:-}"; i=$((i+1)) ;;
    --candidates=*) CANDIDATES="${args[$i]#--candidates=}" ;;
    --min-n) MIN_N="${args[$((i+1))]:-}"; i=$((i+1)) ;;
    --min-n=*) MIN_N="${args[$i]#--min-n=}" ;;
    *) echo "未知参数: ${args[$i]}（可用 --codes / --refresh / --since N / --scan / --candidates / --min-n）" >&2; exit 2 ;;
  esac
done

[[ $REFRESH -eq 1 ]] && RUN_FLAGS+=("--refresh")
[[ -n "$MIN_N" ]] && RUN_FLAGS+=("--min-n" "$MIN_N")
[[ -n "$CANDIDATES" ]] && RUN_FLAGS+=("--candidates" "$CANDIDATES")

USE_COLOR=0
[[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]] && USE_COLOR=1
c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
OK="${c_green}✓${c_reset}"; FAIL="${c_red}✗${c_reset}"; WARN="${c_yellow}⚠${c_reset}"
HDR() { echo ""; echo "${c_bold}━━━ $1 ━━━${c_reset}"; }

# ── 确保 Bridge 在线 ──
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:19429/api/status"; then
  echo "[daily.sh] Bridge Server 未运行，尝试启动..."
  "$SCRIPT_DIR/bridge.sh" start || true
  sleep 1
fi
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:19429/api/status"; then
  echo "$FAIL Bridge Server 仍不可用 — 先: ./scripts/bridge.sh start（浏览器需打开 10jqka 页面）" >&2
  exit 1
fi

CLI="node cli.js"
step() { # step <名称> <命令...>  失败不中断，打 ⚠ 继续
  local name="$1"; shift
  echo "${c_dim}── $name ──${c_reset}"
  if ! "$@" 2>&1; then
    echo "$WARN 步骤失败（不影响日报其他部分）" >&2
  fi
}

echo "${c_bold}════════ 每日监控 + 复盘 ════════${c_reset}  $(date '+%F %T')"
echo "${c_dim}学习回路: 盯盘→存快照→3/5日回填命中→经验积累→池建议（详见 SKILL.md / README 每日学习回路）${c_reset}"

# ── 主流程：监控 + 快照 + 复盘 + 建议 ──
HDR "① 每日监控（大盘 → 自选池估值 → 逐股分析快照 → 回填 → 池建议）"
step "每日监控+快照+建议"  $CLI daily run "${POOL_ARGS[@]}" "${RUN_FLAGS[@]}"

# ── 复盘统计（纯本地）──
HDR "② 复盘命中率统计（近 ${SINCE} 天）"
step "复盘统计"  $CLI daily review --since "$SINCE" ${MIN_N:+--min-n "$MIN_N"}

# ── 经验与待确认建议 ──
HDR "③ 经验教训 + 待确认池建议"
step "经验与建议"  $CLI daily lessons

# ── 条件选股（可选，默认关闭以省接口）──
if [[ $SCAN -eq 1 ]]; then
  HDR "④ 条件选股（--scan 显式开启）"
  step "选股扫描"  $CLI scan "${POOL_ARGS[@]}" --criterion ma-bull,score-gt --min-score 50
fi

echo ""
echo "${c_bold}════════ 日报结束 ════════${c_reset}"
echo "${c_dim}纪律提醒: 不追高 / 不抄底 / 止损提前设 / 多重共振才动手 / 池建议用 ths daily apply <Sid> --yes 手动确认${c_reset}"
