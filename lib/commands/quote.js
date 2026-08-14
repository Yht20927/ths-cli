// lib/commands/quote.js — 实时行情快照

const { escapeExpression, getFlag, inferMarket, formatQuote, fmtNum, renderKV } = require('./helpers');

/**
 * 实时行情快照
 * @param {object} ctx
 * @param {string[]} args - [code, --market N, --json]
 */
async function cmdQuote(ctx, args) {
  const code = args[0];
  if (!code) throw new Error('用法: ths quote <code> [--market N] [--json]');
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');

  const expr = `window.__ths.quote('${escapeExpression(code)}', '${escapeExpression(market)}')`;
  ctx.audit.startOperation('quote', { code, market });

  const qd = await ctx.loggedCall('quote', { code, market }, expr);
  const row = formatQuote(qd);
  if (!row) {
    ctx.audit.endOperation('error', {}, { code, market });
    throw new Error('未返回行情数据（可能代码/市场码不正确）');
  }
  ctx.audit.endOperation('success', { code: row.code }, { code, market, row });

  if (args.includes('--json')) return row;

  const sign = n => (n > 0 ? '+' : '') + n;
  const line = [
    { label: '最新价', value: row.price },
    { label: '涨跌额', value: row.change != null ? sign(row.change) : '-' },
    { label: '涨跌幅', value: row.pct != null ? sign(row.pct) + '%' : '-' },
  ];
  const line2 = [
    { label: '开盘', value: row.open },
    { label: '最高', value: row.high },
    { label: '最低', value: row.low },
    { label: '昨收', value: row.prevClose },
  ];
  const line3 = [
    { label: '成交量', value: row.volume != null ? fmtNum(row.volume) : '-' },
    { label: '成交额', value: row.amount != null ? fmtNum(row.amount) : '-' },
  ];
  console.log(`${row.code} 实时行情 (market ${row.market})`);
  console.log(renderKV([...line, ...line2, ...line3]));
  return undefined;
}

module.exports = cmdQuote;
