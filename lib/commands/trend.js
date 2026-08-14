// lib/commands/trend.js — 分时数据

const { escapeExpression, getFlag, inferMarket, formatTrend, fmtNum, renderTable, toCsv } = require('./helpers');

/**
 * 分时
 * @param {object} ctx
 * @param {string[]} args - [code, --count N, --market N, --json|--csv]
 */
async function cmdTrend(ctx, args) {
  const code = args[0];
  if (!code) throw new Error('用法: ths trend <code> [--count N] [--market N] [--json|--csv]');
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');
  const count = Math.max(0, parseInt(getFlag(args, '--count', 0), 10) || 0);

  const expr = `window.__ths.trend('${escapeExpression(code)}', '${escapeExpression(market)}', ${count})`;
  ctx.audit.startOperation('trend', { code, market, count });

  const qd = await ctx.loggedCall('trend', { code, market, count }, expr);
  const rows = formatTrend(qd);
  ctx.audit.endOperation('success', { points: rows.length }, { code, market, rows });
  if (!rows.length) throw new Error('未返回分时数据');

  if (args.includes('--json')) return rows;

  const cols = [
    { header: '时间', key: 'time' },
    { header: '价格', key: 'price', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
    { header: '成交量', key: 'volume', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
    { header: '成交额', key: 'amount', align: 'r', fmt: v => (v == null ? '-' : fmtNum(v)) },
  ];

  if (args.includes('--csv')) {
    console.log(toCsv(rows, cols));
    return undefined;
  }

  console.log(`分时 ${code} 共 ${rows.length} 个点`);
  console.log(renderTable(rows, cols));
  return undefined;
}

module.exports = cmdTrend;
