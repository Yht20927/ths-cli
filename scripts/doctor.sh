#!/usr/bin/env bash
# doctor.sh — 一键环境排障（健康检查 + 修复指引）
#
# 用法:
#   scripts/doctor.sh          # 全量检查（默认）
#   scripts/doctor.sh -q       # 静默模式: 只输出结论行，适合脚本里判断
#   scripts/doctor.sh -v       # verbose: 输出每项检查的细节
#   scripts/doctor.sh --fix    # 可自动修复项（如 config.json 缺失）直接修复
#
# 退出码: 0 = 全部通过；1 = 有问题（-q 模式同样适用）
#
# 检查项:
#   [1] node 版本 ≥ 18 / curl 可用
#   [2] config.json 存在且合法、bridge.port 已配置
#   [3] 依赖已安装（node_modules/ws）
#   [4] Bridge Server 在线（/api/status）+ PID 文件一致
#   [5] 油猴脚本存在、版本 ≥ 1.1.0、token 与 config.json 一致
#   [6] 数据目录可写（data/cache）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

QUIET=0
VERBOSE=0
FIX=0
for a in "$@"; do
  case "$a" in
    -q|--quiet) QUIET=1 ;;
    -v|--verbose) VERBOSE=1 ;;
    --fix) FIX=1 ;;
    *) echo "未知参数: $a（可用 -q / -v / --fix）" >&2; exit 2 ;;
  esac
done

CONFIG_FILE="$ROOT/config.json"
USERSCRIPT="$ROOT/scripts/tonghuashun.user.js"
CACHE_DIR="$ROOT/data/cache"
LOG_FILE="$ROOT/logs/bridge-server.log"
PID_FILE="$ROOT/.bridge.pid"

# ── 输出工具 ──
USE_COLOR=0
if [[ -t 1 ]] && [[ "${NO_COLOR:-}" == "" ]]; then USE_COLOR=1; fi
c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'

ok()   { [[ $QUIET -eq 0 ]] && echo "  ${c_green}✓${c_reset} $1"; }
warn() { [[ $QUIET -eq 0 ]] && echo "  ${c_yellow}⚠${c_reset} $1"; }
fail() { [[ $QUIET -eq 0 ]] && echo "  ${c_red}✗${c_reset} $1"; }
detail() { [[ $QUIET -eq 0 ]] && [[ $VERBOSE -eq 1 ]] && echo "      ${c_dim}$1${c_reset}"; }
hdr()  { [[ $QUIET -eq 0 ]] && echo "" && echo "${c_bold}$1${c_reset}"; }

# node 小工具: 传 JS 表达式，从 config.json 取值（避免 grep 解析 JSON）
cfg() {
  node -e "const c=require('$CONFIG_FILE');const v=c$1;console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)" 2>/dev/null
}

PASS=0; FAIL_COUNT=0; WARN_COUNT=0
pass() { PASS=$((PASS+1)); }
failc() { FAIL_COUNT=$((FAIL_COUNT+1)); }
warnc() { WARN_COUNT=$((WARN_COUNT+1)); }

[[ $QUIET -eq 0 ]] && echo "${c_bold}ths-cli 环境体检${c_reset}（$(date '+%F %T')）"

# ═══════════════════════════════════════════════════
hdr "1. 运行环境"
# ═══════════════════════════════════════════════════
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/^v//')
  MAJOR=${NODE_VER%%.*}
  if (( MAJOR >= 18 )); then
    ok "node ${NODE_VER}（≥ 18）"; detail "which: $(command -v node)"; pass
  else
    fail "node ${NODE_VER} 过低，需要 ≥ 18"; failc
  fi
else
  fail "未找到 node — 请先安装 Node.js ≥ 18（https://nodejs.org）"; failc
fi
if command -v curl >/dev/null 2>&1; then
  ok "curl 可用"; pass
else
  fail "未找到 curl — 安装: apt install curl / brew install curl"; failc
fi

# ═══════════════════════════════════════════════════
hdr "2. 配置文件 config.json"
# ═══════════════════════════════════════════════════
if [[ ! -f "$CONFIG_FILE" ]]; then
  fail "config.json 不存在"
  if [[ $FIX -eq 1 ]] && [[ -f "$ROOT/config.example.json" ]]; then
    cp "$ROOT/config.example.json" "$CONFIG_FILE"
    ok "已从 config.example.json 复制生成 config.json"
    pass
  else
    echo "     ${c_dim}修复: cp config.example.json config.json（或运行 doctor.sh --fix）${c_reset}"
    failc
  fi
else
  if node -e "JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'))" >/dev/null 2>&1; then
    ok "config.json 是合法 JSON"; pass
  else
    fail "config.json 不是合法 JSON — 检查是否有手误（逗号/引号）"; failc
  fi
  PORT=$(cfg '.bridge?.port' 2>/dev/null || true)
  if [[ -n "$PORT" ]] && [[ "$PORT" != "0" ]]; then
    ok "bridge.port = ${PORT}"; pass
  else
    fail "config.json 缺 bridge.port"; failc
  fi
fi

# ═══════════════════════════════════════════════════
hdr "3. 依赖安装"
# ═══════════════════════════════════════════════════
if [[ -d "$ROOT/node_modules/ws" ]]; then
  ok "node_modules 已安装（ws）"; pass
else
  fail "依赖未安装 — 运行: npm install"; failc
fi

# ═══════════════════════════════════════════════════
hdr "4. Bridge Server"
# ═══════════════════════════════════════════════════
HOST=$(cfg '.bridge?.host' 2>/dev/null || true); HOST=${HOST:-127.0.0.1}
PORT=$(cfg '.bridge?.port' 2>/dev/null || true)
if [[ -n "$PORT" ]] && [[ "$PORT" != "0" ]]; then
  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://${HOST}:${PORT}/api/status" 2>/dev/null || true)
  if [[ "$CODE" == "200" ]]; then
    ok "Server 在线 http://${HOST}:${PORT}"; detail "GET /api/status → 200"; pass
  else
    fail "Server 未响应 /api/status（curl=${CODE:-no-response}）"
    if [[ -f "$PID_FILE" ]]; then
      PID=$(cat "$PID_FILE" 2>/dev/null || true)
      if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
        echo "     ${c_dim}进程 $PID 存活但端口无响应 — 尝试 scripts/bridge.sh restart${c_reset}"
      else
        echo "     ${c_dim}PID 文件残留（进程已死）— 运行 scripts/bridge.sh stop 清理后 start${c_reset}"
      fi
    else
      echo "     ${c_dim}修复: ./scripts/bridge.sh start（需浏览器已装油猴脚本并打开 10jqka 页面）${c_reset}"
    fi
    if [[ -f "$LOG_FILE" ]]; then
      detail "日志尾部: $(tail -n 3 "$LOG_FILE" 2>/dev/null | tr '\n' ' ')"
    fi
    failc
  fi
else
  warn "跳过（第 2 步已发现配置问题）"; warnc
fi

# ═══════════════════════════════════════════════════
hdr "5. 油猴脚本"
# ═══════════════════════════════════════════════════
if [[ ! -f "$USERSCRIPT" ]]; then
  fail "scripts/tonghuashun.user.js 不存在"; failc
else
  ok "油猴脚本存在"; pass

  # 版本检查: quotes/quote 扩展字段依赖 v1.1.0+
  VER=$(grep -m1 '@version' "$USERSCRIPT" | sed 's/.*@version[[:space:]]*//' | tr -d ' \r')
  if [[ -n "$VER" ]]; then
    ok "脚本版本 ${VER}"; pass
    if [[ "$VER" < "1.1.0" ]]; then
      warn "版本 < 1.1.0 — quotes 批量行情 / 换手率 / PE / 市值等字段不可用，请在 Tampermonkey 更新脚本"; warnc
    fi
  else
    warn "未读到 @version"; warnc
  fi

  # token 一致性（不打印明文）
  CFG_TOKEN=$(cfg '.bridge?.token' 2>/dev/null || true)
  US_TOKEN=$(grep -oE "token: *'[^']*'" "$USERSCRIPT" | head -1 | sed "s/.*'\([^']*\)'/\1/")
  if [[ -n "$CFG_TOKEN" ]] && [[ -n "$US_TOKEN" ]]; then
    if [[ "$CFG_TOKEN" == "$US_TOKEN" ]]; then
      ok "token 一致（config.json ↔ 油猴脚本）"; pass
    else
      fail "token 不一致 — config.json 与 scripts/tonghuashun.user.js 的 CONFIG.token 必须相同"
      echo "     ${c_dim}修复: 改 config.json 的 bridge.token 为油猴脚本里的值（或反向），两边保持一致${c_reset}"
      failc
    fi
  else
    warn "无法比对 token（config 或油猴脚本未配置 token）"; warnc
  fi
fi

# ═══════════════════════════════════════════════════
hdr "6. 数据目录"
# ═══════════════════════════════════════════════════
if mkdir -p "$CACHE_DIR" 2>/dev/null && touch "$CACHE_DIR/.write-test" 2>/dev/null; then
  rm -f "$CACHE_DIR/.write-test"
  ok "data/cache 可写"; pass
else
  fail "data/cache 不可写 — 检查目录权限: chmod -R u+w data"; failc
fi

# ═══════════════════════════════════════════════════
hdr "检查结果"
# ═══════════════════════════════════════════════════
if [[ $QUIET -eq 0 ]]; then
  echo "  ${c_green}通过 ${PASS}${c_reset} / ${c_red}失败 ${FAIL_COUNT}${c_reset} / ${c_yellow}警告 ${WARN_COUNT}${c_reset}"
fi
if [[ $FAIL_COUNT -gt 0 ]]; then
  [[ $QUIET -eq 0 ]] && echo "  ${c_red}存在 ${FAIL_COUNT} 个问题，按上面 ✗ 行的修复指引处理；处理后可再跑一次本脚本确认。${c_reset}"
  exit 1
fi
[[ $QUIET -eq 0 ]] && [[ $WARN_COUNT -eq 0 ]] && echo "  ${c_green}全部就绪 ✓ 开跑: node cli.js search 茅台${c_reset}"
exit 0
