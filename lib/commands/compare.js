// lib/commands/compare.js — 跨股横向对比（紧凑摘要）

const { getFlag, inferMarket, renderTable, PERIODS } = require('./helpers');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { buildSummary } = require('../summary');

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
      const s = buildSummary(it.code, bars);
      rec.name = it.name || (await resolveName(ctx, ctx.cache, it.code)) || it.code;
      rec.summary = s;
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
      patterns: s.patterns.length ? s.patterns.join('/') : '-',
    };
  }), [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '收盘', key: 'close', align: 'r' },
    { header: '评分', key: 'score', align: 'r' },
    { header: '均线', key: 'ma' },
    { header: 'MACD', key: 'macd' },
    { header: 'KDJ', key: 'kdj', align: 'r' },
    { header: 'RSI6', key: 'rsi', align: 'r' },
    { header: 'ADX', key: 'adx', align: 'r' },
    { header: 'ATR%', key: 'atr', align: 'r' },
    { header: '支撑', key: 'sup', align: 'r' },
    { header: '压力', key: 'res', align: 'r' },
    { header: '形态', key: 'patterns' },
  ]));

  const failed = rows.filter(r => r.error);
  if (failed.length) {
    console.log(`\n${failed.length} 只失败:`);
    failed.forEach(r => console.log(`  ${r.code} — ${r.error}`));
  }
  return undefined;
}

module.exports = cmdCompare;
