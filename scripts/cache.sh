#!/usr/bin/env bash
# cache.sh — 本地缓存管理（data/cache/ths.json: K线 + 自选股 + 名称）
#
# 用法:
#   scripts/cache.sh stats                       # 缓存统计（条数/大小/周期分布）
#   scripts/cache.sh clean [--period day]        # 清理指定周期 K线（默认全清 K线，保留自选股）
#   scripts/cache.sh export --file backup.json   # 导出自选股+名称（迁移/备份）
#   scripts/cache.sh import --file backup.json   # 导入自选股+名称（合并，去重）
#   scripts/cache.sh path                        # 打印缓存文件路径
#
# 退出码: 0 = 成功；1 = 参数错误或文件不存在

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CACHE_FILE="$ROOT/data/cache/ths.json"
JS() { node -e "$1"; }

cmd_stats() {
  [[ -f "$CACHE_FILE" ]] || { echo "缓存文件不存在: $CACHE_FILE"; return 1; }
  JS "
    const c = require('$CACHE_FILE');
    const kl = c.kline || {};
    const keys = Object.keys(kl);
    const periods = {};
    for (const k of keys) {
      const p = (k.split('_')[1] || '?').replace(/[0-9]/g, ''); // day/week/60min → 60min 会被截断, 用宽匹配
      let p2 = k.includes('_60min_') ? '60min' : k.includes('_120min_') ? '120min'
            : k.includes('_day_') ? 'day' : k.includes('_week_') ? 'week'
            : k.includes('_month_') ? 'month' : k.includes('_quarter_') ? 'quarter' : 'other';
      periods[p2] = (periods[p2] || 0) + 1;
    }
    const totalBars = keys.reduce((s, k) => s + ((kl[k].bars||[]).length), 0);
    const sizeMB = (require('fs').statSync('$CACHE_FILE').size / 1048576).toFixed(2);
    console.log('缓存文件 : ' + '$CACHE_FILE');
    console.log('文件大小 : ' + sizeMB + ' MB');
    console.log('K线条目  : ' + keys.length + ' 条（共 ' + totalBars + ' 根）');
    console.log('自选股   : ' + (c.watchlist||[]).length + ' 只');
    console.log('名称缓存 : ' + Object.keys(c.names||{}).length + ' 条');
    console.log('周期分布 :');
    for (const [p, n] of Object.entries(periods).sort((a,b)=>b[1]-a[1])) console.log('  ' + p + ': ' + n);
    const oldest = keys.reduce((m, k) => { const t = kl[k].fetchedAt; return !m || t < m ? t : m; }, null);
    console.log('最早抓取 : ' + (oldest ? oldest.slice(0,16).replace('T',' ') : '-'));
  "
}

cmd_clean() {
  local period="${1:-all}"
  [[ -f "$CACHE_FILE" ]] || { echo "缓存文件不存在: $CACHE_FILE"; return 1; }
  local expr
  if [[ "$period" == "all" ]]; then
    expr="c.kline = {};"
    echo "已清空全部 K线缓存（自选股与名称保留）"
  else
    expr="for (const k of Object.keys(c.kline)) { if (k.includes('_${period}_') || k.startsWith('${period}_')) delete c.kline[k]; }"
    echo "已清理周期 [${period}] 的 K线缓存"
  fi
  JS "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
    $expr
    const tmp = '$CACHE_FILE.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, '$CACHE_FILE');
    console.log('剩余 K线条目: ' + Object.keys(c.kline).length);
  "
}

cmd_export() {
  local out="${1:-}"
  [[ -n "$out" ]] || { echo "用法: scripts/cache.sh export --file backup.json"; return 1; }
  [[ -f "$CACHE_FILE" ]] || { echo "缓存文件不存在: $CACHE_FILE"; return 1; }
  JS "
    const c = require('$CACHE_FILE');
    const fs = require('fs');
    const payload = {
      exportedAt: new Date().toISOString(),
      watchlist: c.watchlist || [],
      names: c.names || {},
    };
    fs.writeFileSync('$out', JSON.stringify(payload, null, 2));
    console.log('✓ 已导出自选股 ' + payload.watchlist.length + ' 只 / 名称 ' + Object.keys(payload.names).length + ' 条 → $out');
  "
}

cmd_import() {
  local src="${1:-}"
  [[ -n "$src" ]] || { echo "用法: scripts/cache.sh import --file backup.json"; return 1; }
  [[ -f "$src" ]] || { echo "导入文件不存在: $src"; return 1; }
  JS "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
    const imp = JSON.parse(fs.readFileSync('$src','utf8'));
    let added = 0, names = 0;
    for (const w of (imp.watchlist||[])) {
      if (w && w.code && !c.watchlist.some(x => x.code === w.code)) { c.watchlist.push(w); added++; }
    }
    for (const [k, v] of Object.entries(imp.names||{})) {
      if (v && !c.names[k]) { c.names[k] = v; names++; }
    }
    const tmp = '$CACHE_FILE.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, '$CACHE_FILE');
    console.log('✓ 已导入自选股 +' + added + ' 只 / 名称 +' + names + ' 条（合并去重）');
  "
}

case "${1:-stats}" in
  stats) cmd_stats ;;
  clean)
    clean_period="all"
    [[ "${2:-}" == "--period" ]] && clean_period="${3:-all}"
    cmd_clean "$clean_period" ;;
  export)
    exp_file=""
    [[ "${2:-}" == "--file" ]] && exp_file="${3:-}"
    cmd_export "$exp_file" ;;
  import)
    imp_file=""
    [[ "${2:-}" == "--file" ]] && imp_file="${3:-}"
    cmd_import "$imp_file" ;;
  path) echo "$CACHE_FILE" ;;
  *)
    echo "用法: $0 {stats|clean [--period day]|export --file f|import --file f|path}" >&2
    exit 1 ;;
esac
