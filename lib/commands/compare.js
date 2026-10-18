// lib/commands/compare.js — 跨股横向对比（紧凑摘要）

const { getFlag, inferMarket, renderTable, PERIODS } = require('./helpers');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { buildSummary } = require('../summary');
const { sparkline } = require('../render/widgets/sparkline');

/**
 * 跨股对比
 * @param {object} ctx
 * @param {string[]} args - [--codes a,b,c | --pool watchlist] [--period day] [--count 250] [--refresh] [--json]
 */
async function cmdCompare(ctx, args) {
  const codesArg = getFlag(args, '--codes', null);
  let items;
  if (codesArg) {
    items = codesArg.split(',').map(s => s.trim()).filter(Boolean).map(code => ({
      code, name: null, market: inferMarket(code) || '',
    }));
  } else {
    items = ctx.cache.watchlistList().map(w => ({ code: w.code, name: w.name || null, market: w.market || inferMarket(w.code) || '' }));
  }
  if (!items.length) {
    throw new Error('用法: ths compare --codes a,b,c（或 --pool watchlist）');
  }

  const period = getFlag(args, '--period', 'day');
  const count = Math.max(30, parseInt(getFlag(args, '--count', 250), 10) || 250);
  const apiPeriod = PERIODS[period] || period;

  const rows = [];
  for (const it of items) {
    const rec = { code: it.code };
    if (!it.market) { rec.error = '无法推断市场码'; rows.push(rec); continue; }
    try {
      const bars = await loadKline(ctx, ctx.cache, {
        code: it.code, market: it.market, period: apiPeriod, count, adjust: getFlag(args, '--adjust', 'forward'),
      }, {
        maxAgeMs: ttlMsForPeriod(ctx.config, period),
        refresh: args.includes('--refresh'),
      });
      const s = buildSummary(it.code, bars, { weights: (ctx.config.score && ctx.config.score.weights) || null });
      rec.name = it.name || (await resolveName(ctx, ctx.cache, it.code)) || it.code;
      rec.summary = s;
      rec.spark = sparkline(bars.slice(-30).map(b => b.close), { width: 12 });
      rec.error = null;
    } catch (e) {
      rec.error = e.message;
    }
    rows.push(rec);
  }

  if (args.includes('--json')) {
    return rows.map(r => r.error
      ? { code: r.code, error: r.error }
      : { code: r.code, name: r.name, ...r.summary });
  }

  const ok = rows.filter(r => !r.error);
  console.log(`跨股对比 ${ok.length} 只（${period} K，${count} 根）:`);
  console.log(renderTable(ok.map(r => {
    const s = r.summary;
    return {
      code: r.code,
      name: r.name,
      close: s.close,
      score: `${s.score} ${s.signal}`,
      ma: s.maAlignment,
      macd: s.macdStatus,
      kdj: s.kdj.k != null ? `${s.kdj.k}/${s.kdj.d}` : '-',
      rsi: s.rsi6,
      adx: s.adx,
      atr: s.atrPct != null ? `${s.atrPct}%` : '-',
      sup: s.support != null ? s.support : '-',
      res: s.resistance != null ? s.resistance : '-',
      spark: r.spark || '-',
      patterns: s.patterns.length ? s.patterns.join('/') : '-',
    };
  }), [
    { header: '代码', key: 'code', priority: 0 },
    { header: '名称', key: 'name', priority: 0 },
    { header: '收盘', key: 'close', align: 'r', priority: 0 },
    { header: '评分', key: 'score', align: 'r', priority: 0 },
    { header: '均线', key: 'ma', priority: 0 },
    { header: 'MACD', key: 'macd', priority: 1 },
    { header: 'KDJ', key: 'kdj', align: 'r', priority: 2 },
    { header: 'RSI6', key: 'rsi', align: 'r', priority: 2 },
    { header: 'ADX', key: 'adx', align: 'r', priority: 1 },
    { header: 'ATR%', key: 'atr', align: 'r', priority: 2 },
    { header: '支撑', key: 'sup', align: 'r', priority: 2 },
    { header: '压力', key: 'res', align: 'r', priority: 2 },
    { header: '30日', key: 'spark', priority: 2 },
    { header: '形态', key: 'patterns', priority: 1 },
  ]));

  const failed = rows.filter(r => r.error);
  if (failed.length) {
    console.log(`\n${failed.length} 只失败:`);
    failed.forEach(r => console.log(`  ${r.code} — ${r.error}`));
  }
  return undefined;
}

module.exports = cmdCompare;
