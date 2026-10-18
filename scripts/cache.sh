#!/usr/bin/env bash
# cache.sh — 本地缓存管理
#
# 存储拆分后：
#   data/cache/ths.json  K线缓存（大文件，可随时重建）
#   data/state.json      自选股 / 名称 / 持仓台账（小文件，用户数据）
#
# 用法:
#   scripts/cache.sh stats                       # 缓存统计（条数/大小/周期分布）
#   scripts/cache.sh clean [--period day]        # 清理指定周期 K线（默认全清 K线，保留用户状态）
#   scripts/cache.sh export --file backup.json   # 导出自选股+名称（迁移/备份）
#   scripts/cache.sh import --file backup.json   # 导入自选股+名称（合并，去重）
#   scripts/cache.sh path                        # 打印缓存/状态文件路径
#
# 退出码: 0 = 成功；1 = 参数错误或文件不存在

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

CACHE_FILE="$ROOT/data/cache/ths.json"
STATE_FILE="$ROOT/data/state.json"
JS() { node -e "$1"; }

cmd_stats() {
  [[ -f "$CACHE_FILE" ]] || { echo "缓存文件不存在: $CACHE_FILE"; return 1; }
  JS "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
    let st = { watchlist: [], names: {} };
    try { st = JSON.parse(fs.readFileSync('$STATE_FILE','utf8')); }
    catch (e) { st = { watchlist: c.watchlist || [], names: c.names || {} }; }
    const kl = c.kline || {};
    const keys = Object.keys(kl);
    const periods = {};
    for (const k of keys) {
      let p2 = k.includes('_60min_') ? '60min' : k.includes('_120min_') ? '120min'
            : k.includes('_day_') ? 'day' : k.includes('_week_') ? 'week'
            : k.includes('_month_') ? 'month' : k.includes('_quarter_') ? 'quarter' : 'other';
      periods[p2] = (periods[p2] || 0) + 1;
    }
    const totalBars = keys.reduce((s, k) => s + ((kl[k].bars||[]).length), 0);
    const sizeMB = (fs.statSync('$CACHE_FILE').size / 1048576).toFixed(2);
    const stateMB = fs.existsSync('$STATE_FILE') ? (fs.statSync('$STATE_FILE').size / 1024).toFixed(1) + ' KB' : '(迁移前)';
    console.log('K线缓存  : ' + '$CACHE_FILE');
    console.log('文件大小 : ' + sizeMB + ' MB');
    console.log('用户状态 : ' + '$STATE_FILE' + ' · ' + stateMB);
    console.log('K线条目  : ' + keys.length + ' 条（共 ' + totalBars + ' 根）');
    console.log('自选股   : ' + (st.watchlist||[]).length + ' 只');
    console.log('持仓     : ' + (st.positions||[]).length + ' 只');
    console.log('名称缓存 : ' + Object.keys(st.names||{}).length + ' 条');
    console.log('周期分布 :');
    for (const [p, n] of Object.entries(periods).sort((a,b)=>b[1]-a[1])) console.log('  ' + p + ': ' + n);
    const oldest = keys.reduce((m, k) => { const t = kl[k].fetchedAt; return !m || t < m ? t : m; }, null);
    console.log('最早抓取 : ' + (oldest ? oldest.slice(0,16).replace('T',' ') : '-'));
  "
}

cmd_clean() {
  local period="${1:-all}"
  [[ -f "$CACHE_FILE" ]] || { echo "缓存文件不存在: $CACHE_FILE"; return 1; }
  JS "
    const fs = require('fs');
    const { withLock, readJson, atomicWriteJson } = require('./lib/store/atomic');
    withLock('$CACHE_FILE', () => {
      const r = readJson('$CACHE_FILE');
      const c = r.ok ? r.data : { version: 3, kline: {} };
      c.kline = c.kline || {};
      if ('${period}' === 'all') {
        c.kline = {};
      } else {
        for (const k of Object.keys(c.kline)) {
          if (k.includes('_${period}_') || k.startsWith('${period}_')) delete c.kline[k];
        }
      }
      const out = { ...c, version: 3, kline: c.kline };
      // state 已拆分后，主文件不再保留用户数据
      if (fs.existsSync('$STATE_FILE')) {
        delete out.watchlist; delete out.names; delete out.positions;
      }
      atomicWriteJson('$CACHE_FILE', out);
      console.log(('${period}' === 'all' ? '已清空全部 K线缓存' : '已清理周期 [${period}] 的 K线缓存') + '，剩余 ' + Object.keys(c.kline).length + ' 条');
    });
  "
}

cmd_export() {
  local out="${1:-}"
  [[ -n "$out" ]] || { echo "用法: scripts/cache.sh export --file backup.json"; return 1; }
  JS "
    const fs = require('fs');
    let st;
    try { st = JSON.parse(fs.readFileSync('$STATE_FILE','utf8')); }
    catch (e) {
      let c = {};
      try { c = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8')); } catch (e2) { c = {}; }
      st = { watchlist: c.watchlist || [], names: c.names || {} };
    }
    const payload = { exportedAt: new Date().toISOString(), watchlist: st.watchlist || [], names: st.names || {} };
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
    const { StateStore } = require('./lib/state-store');
    const imp = JSON.parse(fs.readFileSync('$src','utf8'));
    const store = new StateStore('$STATE_FILE');
    // 首次导入且 state 不存在：先把旧版缓存里的用户数据迁移过来
    if (!fs.existsSync('$STATE_FILE')) {
      try {
        const c = JSON.parse(fs.readFileSync('$CACHE_FILE','utf8'));
        store.migrateFrom(c);
      } catch (e) { /* ignore */ }
    }
    const r = store.merge({ watchlist: imp.watchlist || [], names: imp.names || {} });
    console.log('✓ 已导入自选股 +' + r.added + ' 只 / 名称 +' + r.names + ' 条（合并去重）');
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
  path)
    echo "cache: $CACHE_FILE"
    echo "state: $STATE_FILE" ;;
  *)
    echo "用法: $0 {stats|clean [--period day]|export --file f|import --file f|path}" >&2
    exit 1 ;;
esac
