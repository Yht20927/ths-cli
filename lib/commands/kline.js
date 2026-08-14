// lib/commands/kline.js — 获取 K 线（6 周期）

const {
  escapeExpression,
  getFlag,
  PERIODS,
  inferMarket,
  formatKline,
  fmtNum,
  renderTable,
  toCsv,
} = require('./helpers');

/**
 * 解析 K 线参数并返回 { code, market, period, count, adjust }
 */
function parseKlineArgs(args) {
  const code = args[0];
  if (!code) throw new Error('用法: ths kline <code> [--period day|week|month|quarter|60min|120min] [--count N] [--adjust forward|backward|none] [--market 17|33|48] [--json|--csv]');

  const periodAlias = getFlag(args, '--period', 'day');
  const period = PERIODS[periodAlias];
  if (!period) throw new Error(`未知周期 "${periodAlias}"，可选: ${Object.keys(PERIODS).join('/')}`);

  const count = Math.max(1, parseInt(getFlag(args, '--count', 250), 10) || 250);
  const adjust = getFlag(args, '--adjust', 'forward');
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码（4/8 开头北交所/其他市场，请用 --market 指定，如北交所代码查询同花顺搜索结果的市场码）');

  return { code, market, period, count, adjust };
}

/**
 * 通过 Bridge 拉取并格式化 K 线（analyze 等命令复用）
 * @returns {Promise<Array<{date, open, high, low, close, volume, amount}>>}
 */
async function fetchKlineBars(ctx, params) {
  const { code, market, period, count, adjust } = params;
  const expr = `window.__ths.kline('${escapeExpression(code)}', '${escapeExpression(market)}', '${escapeExpression(period)}', ${-count}, '${escapeExpression(adjust)}')`;
  ctx.audit.startOperation('kline', { code, market, period, count, adjust });
  const qd = await ctx.loggedCall('kline', { code, market, period, count, adjust }, expr);
  if (!qd) throw new Error('未返回行情数据（可能代码/市场码不正确）');
  const rows = (qd.value || []).map(formatKline);
  ctx.audit.endOperation('success', { bars: rows.length }, { code, period, rows });
  return rows;
}

/**
 * 获取 K 线命令
 * @returns {Array<object>|undefined}
 */
async function cmdKline(ctx, args) {
  const params = parseKlineArgs(args);
  const rows = await fetchKlineBars(ctx, params);
  const { code, period, count } = params;

  if (args.includes('--json')) return rows;

  const cols = [
    { header: '日期', key: 'date' },
    { header: '开盘', key: 'open', align: 'r', fmt: fmtNum },
    { header: '最高', key: 'high', align: 'r', fmt: fmtNum },
    { header: '最低', key: 'low', align: 'r', fmt: fmtNum },
    { header: '收盘', key: 'close', align: 'r', fmt: fmtNum },
    { header: '成交量', key: 'volume', align: 'r', fmt: fmtNum },
    { header: '成交额', key: 'amount', align: 'r', fmt: fmtNum },
  ];

  if (args.includes('--csv')) {
    console.log(toCsv(rows, cols));
    return undefined;
  }

  console.log(`K 线 ${code} (${period}) 最近 ${rows.length} 根${rows.length === count ? '' : `（仅 ${rows.length} 根可用）`}`);
  console.log(renderTable(rows, cols));
  return undefined;
}

module.exports = cmdKline;
module.exports.parseKlineArgs = parseKlineArgs;
module.exports.fetchKlineBars = fetchKlineBars;
