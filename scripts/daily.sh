#!/usr/bin/env bash
# daily.sh — 大师日报：开盘前一键跑完七步法前 5 步（大盘→自选池→估值→技术→对比）
#
# 用法:
#   scripts/daily.sh                        # 全量日报（默认自选池）
#   scripts/daily.sh --codes 600519,000001  # 用指定代码池代替自选池
#   scripts/daily.sh --compact              # 只输出紧凑摘要（analyze 用 --compact）
#   scripts/daily.sh --scan-criteria macd-golden,ma-bull   # 自定义扫描条件
#
# 输出顺序（对应 SKILL.md 七步法）:
#   ① 大盘环境: 成交额（日K 5天 + 今日分时）
#   ② 自选池/代码池实时行情（估值初筛: PE/换手/量比/市值）
#   ③ 条件选股扫描（默认: 均线多头 + 评分≥60）
#   ④ 单只技术深挖（默认第一只，--all 逐只 --compact）
#   ⑤ 横向对比定优先级
#
# 依赖: Bridge Server 在线（自动 ensure）；失败步骤给出提示但不中断整份日报。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CODES=""
COMPACT=0
ALL=0
CRITERIA="ma-bull,score-gt"
POOL_ARGS=("--pool" "watchlist")

args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --codes) CODES="${args[$((i+1))]:-}"; i=$((i+1)); POOL_ARGS=("--codes" "$CODES") ;;
    --codes=*) CODES="${args[$i]#--codes=}"; POOL_ARGS=("--codes" "$CODES") ;;
    --compact) COMPACT=1 ;;
    --all) ALL=1 ;;
    --scan-criteria) CRITERIA="${args[$((i+1))]:-}"; i=$((i+1)) ;;
    --scan-criteria=*) CRITERIA="${args[$i]#--scan-criteria=}" ;;
    *) echo "未知参数: ${args[$i]}（可用 --codes / --compact / --all / --scan-criteria）" >&2; exit 2 ;;
  esac
done

USE_COLOR=0
[[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]] && USE_COLOR=1
c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
OK="${c_green}✓${c_reset}"; FAIL="${c_red}✗${c_reset}"; WARN="${c_yellow}⚠${c_reset}"
HDR() { echo ""; echo "${c_bold}━━━ $1 ━━━${c_reset}"; }

# ── 确保 Bridge 在线 ──
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:19422/api/status"; then
  echo "[daily.sh] Bridge Server 未运行，尝试启动..."
  "$SCRIPT_DIR/bridge.sh" start || true
  sleep 1
fi
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:19422/api/status"; then
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

echo "${c_bold}════════ 大师日报 ════════${c_reset}  $(date '+%F %T')"
echo "${c_dim}七步法: ①大盘 → ②自选池估值 → ③扫描 → ④技术 → ⑤对比（详见 SKILL.md）${c_reset}"

# ── ① 大盘环境 ──
HDR "① 大盘情绪（成交额）"
step "大盘成交额(日K, 5天)"  $CLI turnover --period day --count 5
step "今日分时量能"          $CLI turnover --period minute --count 8

# ── ② 自选池实时估值 ──
HDR "② 代码池实时估值（淘汰环节: PE<0 纯题材 / 换手<1% 流动性差）"
step "批量行情"              $CLI quotes "${POOL_ARGS[@]}"

# ── ③ 条件选股 ──
HDR "③ 条件选股（${CRITERIA}）"
step "选股扫描"              $CLI scan "${POOL_ARGS[@]}" --criterion "$CRITERIA" --min-score 50

# ── ④ 单只技术深挖 ──
HDR "④ 技术面深挖（默认第一只; --all 逐只 --compact）"
if [[ $ALL -eq 1 ]]; then
  if [[ -n "$CODES" ]]; then
    IFS=',' read -ra CODEPOOL <<< "$CODES"
    for c in "${CODEPOOL[@]}"; do
      step "分析 $c"          $CLI analyze "$c" --compact
    done
  else
    step "分析自选池(compact 逐只)" $CLI compare "${POOL_ARGS[@]}" --json 2>/dev/null || \
      echo "$WARN 自选池为空或无法分析，先 add 或用 --codes" >&2
  fi
else
  # analyze 只吃单只代码：取 CODES 第一个，否则取自选池第一只
  FIRST=""
  if [[ -n "$CODES" ]]; then
    FIRST="${CODES%%,*}"
  else
    FIRST=$(node -e "const c=require('./data/cache/ths.json');const w=c.watchlist||[];console.log(w.length?w[0].code:'')" 2>/dev/null || true)
  fi
  if [[ -n "$FIRST" ]]; then
    A_ARGS=("$FIRST")
    [[ $COMPACT -eq 1 ]] && A_ARGS+=("--compact")
    step "分析 $FIRST（--all 看全部）" $CLI analyze "${A_ARGS[@]}"
  else
    echo "$WARN 无股票可分析 — 用 --codes a,b 或先 watchlist add" >&2
  fi
fi

# ── ⑤ 横向对比 ──
HDR "⑤ 横向对比定优先级（评分接近时优先 ADX 高 / ATR 低）"
step "跨股对比"              $CLI compare "${POOL_ARGS[@]}"

echo ""
echo "${c_bold}════════ 日报结束 ════════${c_reset}"
echo "${c_dim}纪律提醒: 不追高 / 不抄底 / 止损提前设 / 仓位=目标止损额÷(ATR%×2) / 多重共振才动手${c_reset}"
