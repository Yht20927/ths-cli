#!/usr/bin/env bash
# demo.sh — 全链路冒烟测试（验证 CLI ↔ Bridge ↔ 油猴 ↔ 同花顺接口整条链路）
#
# 用法:
#   scripts/demo.sh            # 全链路（搜索→行情→K线→分析→批量→对比→回测→大盘）
#   scripts/demo.sh --quick    # 快速版（search + quote + kline + analyze --compact）
#   scripts/demo.sh --codes 600519,000001   # 自定义演示股票池
#
# 依赖: Bridge Server 运行中 + 浏览器已装油猴脚本并打开 10jqka 页面。
# 任何一步失败即退出非 0 并提示，适合升级后回归 / CI。
#
# 退出码: 0 = 全链路通过；1 = 有步骤失败

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

QUICK=0
CODES="600519,000001"
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  case "${args[$i]}" in
    --quick) QUICK=1 ;;
    --codes) CODES="${args[$((i+1))]:-}"; i=$((i+1)) ;;
    --codes=*) CODES="${args[$i]#--codes=}" ;;
    *) echo "未知参数: ${args[$i]}（可用 --quick / --codes a,b）" >&2; exit 2 ;;
  esac
done

USE_COLOR=0
[[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]] && USE_COLOR=1
c_green=$'\033[32m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
OK="${c_green}✓${c_reset}"; FAIL="${c_red}✗${c_reset}"

# ── 前置: Bridge 必须在线 ──
echo "${c_bold}ths-cli 冒烟测试${c_reset} $(date '+%F %T')"
if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:19429/api/status"; then
  echo "$FAIL Bridge Server 未运行 — 先执行: ./scripts/bridge.sh start（并确认浏览器油猴已连接）" >&2
  exit 1
fi
echo "$OK Bridge Server 在线"

CLI="node cli.js"
STEP=0; TOTAL=0
run() { # run <名称> <命令...>
  local name="$1"; shift
  TOTAL=$((TOTAL+1))
  local out
  if out=$("$@" 2>&1); then
    STEP=$((STEP+1))
    echo "$OK $name"
    [[ -n "$out" ]] && echo "${c_dim}    $(echo "$out" | head -3 | tr '\n' '; ')${c_reset}"
  else
    echo "$FAIL $name" >&2
    echo "$out" >&2
    echo "  冒烟测试终止于第 $TOTAL 步（$name）" >&2
    exit 1
  fi
}

# ── 全链路步骤 ──
run "搜索联想 茅台"          $CLI search 茅台
run "实时行情 600519"        $CLI quote 600519
run "日K 600519 (20根)"      $CLI kline 600519 --period day --count 20
run "周K 000001 (JSON)"      $CLI kline 000001 --period week --count 52 --json
run "分时 600519"            $CLI trend 600519 --count 10
run "大盘成交额(日)"          $CLI turnover --period day --count 3

if [[ $QUICK -eq 0 ]]; then
  run "技术分析 600519 --compact" $CLI analyze 600519 --compact
  run "批量行情"                $CLI quotes --codes "$CODES"
  run "跨股对比"                $CLI compare --codes "$CODES"
  run "选股扫描(自选池, 评分≥40)" $CLI scan --pool watchlist --criterion score-gt --score 40
  run "策略回测 600519 ma-cross" $CLI backtest 600519 --strategy ma-cross --count 250
fi

echo ""
echo "$STEP/$TOTAL 步通过 — ${c_green}冒烟测试完成 ✓${c_reset}"
exit 0
