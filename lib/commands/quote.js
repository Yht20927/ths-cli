// lib/commands/quote.js — 实时行情快照（含换手/量比/PE/市值/涨跌停）

const { escapeExpression, getFlag, inferMarket, formatQuote, fmtNum, renderKV } = require('./helpers');
const { resolveName, codeExists } = require('../cache');

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
    const exists = await codeExists(ctx, code);
    if (exists === false) throw new Error(`代码 ${code} 不存在或已退市（可用 search 确认代码）`);
    if (exists === true) throw new Error(`代码 ${code} 可能停牌/暂无行情数据`);
    throw new Error(`未返回行情数据（代码 ${code} 不正确/停牌/已退市）`);
  }
  const name = (await resolveName(ctx, ctx.cache, code)) || null;
  ctx.audit.endOperation('success', { code: row.code, name }, { code, market, row });

  const out = { name, ...row };
  if (args.includes('--json')) return out;

  const sign = n => (n > 0 ? '+' : '') + n;
  const line = [
    { label: '名称', value: name || '-' },
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
    { label: '成交量', value: row.volume != null ? fmtNum(row.volume) + '股' : '-' },
    { label: '成交额', value: row.amount != null ? fmtNum(row.amount) : '-' },
    { label: '换手率', value: row.turnoverRate != null ? row.turnoverRate + '%' : '-' },
    { label: '量比', value: row.volumeRatio != null ? row.volumeRatio : '-' },
  ];
  const line4 = [
    { label: '市盈率', value: row.pe != null ? row.pe : '-' },
    { label: '市净率', value: row.pb != null ? row.pb : '-' },
    { label: '总市值', value: row.totalMv != null ? fmtNum(row.totalMv) : '-' },
    { label: '涨停/跌停', value: row.limitUp != null && row.limitDown != null ? `${row.limitUp} / ${row.limitDown}` : '-' },
  ];
  console.log(`${row.code}${name ? ' ' + name : ''} 实时行情 (market ${row.market})`);
  console.log(renderKV([...line, ...line2, ...line3, ...line4]));
  return undefined;
}

module.exports = cmdQuote;
