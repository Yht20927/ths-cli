// lib/commands/quotes.js — 批量实时行情（含换手率/量比/PE/市值/涨跌停）
//
// 依赖升级后的油猴脚本 window.__ths.quotes(items)；
// 若旧脚本无 quotes，自动回退为逐只 window.__ths.quote（无扩展字段）。

const { getFlag, inferMarket, formatQuotes, fmtNum, renderTable } = require('./helpers');
const { resolvePoolItems } = require('../scanner');
const { resolveName } = require('../cache');
const { escapeExpression } = require('./helpers');

/**
 * 批量行情
 * @param {object} ctx
 * @param {string[]} args - [--pool watchlist|--codes a,b | --code X] [--json]
 */
async function cmdQuotes(ctx, args) {
  const codes = getFlag(args, '--codes', null) || getFlag(args, '--code', null);
  const items = resolvePoolItems(ctx.cache, { codes, pool: getFlag(args, '--pool', 'watchlist') });
  if (!items.length) {
    throw new Error(
      codes ? '--codes 为空，示例: --codes 600519,000001'
        : '自选股为空。先 `ths watchlist add <code>` 或用 `--codes 600519,000001`'
    );
  }

  const needMarket = items.map(it => ({ ...it, market: it.market || inferMarket(it.code) || '' }))
    .filter(it => it.market);
  if (!needMarket.length) throw new Error('无法推断市场码，请用 --market 或 --codes 指定');

  ctx.audit.startOperation('quotes', { count: needMarket.length });

  let rows;
  try {
    // 升级后的油猴：一次请求多只（按 market 分组）
    const expr = `window.__ths.quotes(${JSON.stringify(needMarket.map(i => ({ code: i.code, market: i.market })))})`;
    const raw = await ctx.loggedCall('quotes', { count: needMarket.length }, expr);
    rows = formatQuotes(raw);
  } catch (e) {
    // 旧油猴无 quotes：逐只回退
    const quoted = [];
    for (const it of needMarket) {
      const q = await ctx.loggedCall('quote', { code: it.code, market: it.market },
        `window.__ths.quote('${escapeExpression(it.code)}', '${escapeExpression(it.market)}')`);
      const f = require('./helpers').formatQuote(q);
      if (f) quoted.push(f);
    }
    rows = quoted;
  }
  if (!rows.length) throw new Error('未返回行情数据（可能代码/市场码不正确）');

  // 名称：watchlist 自带 / 解析
  const nameOf = async (code) => {
    const w = ctx.cache.watchlistList().find(x => x.code === code);
    if (w && w.name) return w.name;
    return resolveName(ctx, ctx.cache, code);
  };
  const withNames = [];
  for (const r of rows) {
    withNames.push({ ...r, name: (await nameOf(r.code)) || r.code });
  }

  ctx.audit.endOperation('success', { rows: withNames.length }, { rows: withNames });

  if (args.includes('--json')) {
    return withNames.map(r => ({
      code: r.code, name: r.name, market: r.market, price: r.price, open: r.open,
      high: r.high, low: r.low, prevClose: r.prevClose, volume: r.volume, amount: r.amount,
      pct: r.pct, change: r.change, turnoverRate: r.turnoverRate, volumeRatio: r.volumeRatio,
      pe: r.pe, pb: r.pb, totalMv: r.totalMv, floatMv: r.floatMv, limitUp: r.limitUp, limitDown: r.limitDown,
    }));
  }

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
  console.log(`批量行情 ${withNames.length} 只:`);
  console.log(renderTable(withNames.map(r => ({
    code: r.code,
    name: r.name,
    price: r.price != null ? r.price.toFixed(2) : '-',
    pct: r.pct != null ? sign(r.pct) + '%' : '-',
    turnoverRate: r.turnoverRate != null ? r.turnoverRate + '%' : '-',
    volumeRatio: r.volumeRatio != null ? r.volumeRatio : '-',
    pe: r.pe != null ? r.pe : '-',
    pb: r.pb != null ? r.pb : '-',
    totalMv: r.totalMv != null ? fmtNum(r.totalMv) : '-',
    limit: r.limitUp != null ? `${r.limitUp}/${r.limitDown}` : '-',
  })), [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '现价', key: 'price', align: 'r' },
    { header: '涨跌幅', key: 'pct', align: 'r' },
    { header: '换手', key: 'turnoverRate', align: 'r' },
    { header: '量比', key: 'volumeRatio', align: 'r' },
    { header: 'PE', key: 'pe', align: 'r' },
    { header: 'PB', key: 'pb', align: 'r' },
    { header: '总市值', key: 'totalMv', align: 'r' },
    { header: '涨停/跌停', key: 'limit' },
  ]));
  return undefined;
}

module.exports = cmdQuotes;
