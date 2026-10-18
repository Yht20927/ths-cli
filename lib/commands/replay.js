// lib/commands/replay.js — 盘中盯盘回放（本地 JSONL）
//
// 用法:
//   ths replay [YYYY-MM-DD] [--date D] [--ticks] [--json] [--dir DIR]
//
// 数据来源: data/realtime/alerts/YYYY-MM-DD.jsonl + ticks/YYYY-MM-DD.jsonl
// 默认显示当日告警时间线；--ticks 追加每只股票的 tick 摘要。

const { getFlag, renderTable } = require('./helpers');
const { WatchJournal, todayBeijing, DEFAULT_DIR } = require('../realtime/watch-journal');
const { fmtTime, fmtPct, fmtPrice } = require('../render/format');
const { sparkline } = require('../render/widgets/sparkline');

const LEVEL_LABEL = { critical: '严重', warn: '警告', info: '提示' };

async function cmdReplay(ctx, args) {
  const date = getFlag(args, '--date', null) || args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || todayBeijing();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期格式应为 YYYY-MM-DD，收到 "${date}"`);
  }
  const dir = getFlag(args, '--dir', null) || process.env.THS_REALTIME_DIR || DEFAULT_DIR;
  const journal = new WatchJournal({ dir, date });
  const alerts = journal.listAlerts();
  const allTicks = journal.listTicks();
  const ticks = args.includes('--ticks') ? allTicks : [];

  const summary = tickSummary(ticks, ctx);
  if (args.includes('--json')) {
    return { date, alerts, tickCount: allTicks.length, ...(args.includes('--ticks') ? { ticks, summary } : {}) };
  }

  console.log(`════ 盯盘回放 ${date} · 告警 ${alerts.length} · tick ${allTicks.length} ════`);
  if (!alerts.length) {
    console.log('  （当日无告警记录）');
  } else {
    console.log('\n── 告警时间线 ─────────────────────────────────────');
    console.log(renderTable(alerts.map(a => ({
      time: fmtTime(a.at || 0),
      code: a.code,
      name: a.name || '',
      kind: a.kind || '',
      level: LEVEL_LABEL[a.level] || a.level || '',
      message: a.message || '',
      acked: a.acked ? '✓' : '',
    })), [
      { header: '时间', key: 'time' },
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '类型', key: 'kind' },
      { header: '级别', key: 'level', tone: v => (v === '严重' ? 'critical' : v === '警告' ? 'warn' : 'info') },
      { header: '消息', key: 'message' },
      { header: '确认', key: 'acked' },
    ]));
  }

  if (args.includes('--ticks')) {
    console.log('\n── tick 摘要 ─────────────────────────────────────');
    if (!summary.length) {
      console.log('  （当日无 tick 记录）');
    } else {
      console.log(renderTable(summary.map(s => ({
        code: s.code,
        name: s.name,
        count: s.count,
        first: s.first,
        last: s.last,
        chg: s.chg == null ? '-' : fmtPct(s.chg, 2),
        spark: s.spark,
      })), [
        { header: '代码', key: 'code' },
        { header: '名称', key: 'name' },
        { header: 'tick', key: 'count', align: 'r' },
        { header: '首价', key: 'first', align: 'r' },
        { header: '末价', key: 'last', align: 'r' },
        { header: '区间', key: 'chg', align: 'r' },
        { header: '走势', key: 'spark' },
      ]));
    }
  }

  console.log('\n提示: --ticks 查看 tick 摘要；--json 输出结构化记录；--dir 指定 data/realtime 目录。');
  return undefined;
}

/** 每只股票：首末价/区间涨跌/tick 数/走势 */
function tickSummary(ticks, ctx) {
  const byCode = new Map();
  for (const t of ticks) {
    for (const [code, q] of Object.entries(t.quotes || {})) {
      if (!Number.isFinite(Number(q.price))) continue;
      if (!byCode.has(code)) byCode.set(code, []);
      byCode.get(code).push(Number(q.price));
    }
  }
  const out = [];
  for (const [code, prices] of byCode) {
    const first = prices[0];
    const last = prices[prices.length - 1];
    const chg = first ? ((last - first) / first) * 100 : null;
    let name = '';
    try { name = (ctx && ctx.cache && ctx.cache.getName(code)) || ''; } catch (e) { /* ignore */ }
    out.push({
      code,
      name,
      count: prices.length,
      first: fmtPrice(first),
      last: fmtPrice(last),
      chg,
      spark: sparkline(prices, { width: 16 }),
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

module.exports = cmdReplay;
