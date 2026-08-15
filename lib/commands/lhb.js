// lib/commands/lhb.js — 龙虎榜（营业部席位 / 机构游资）
//
// 数据源（Node 直连，GBK HTML）: data.10jqka.com.cn/market/longhu/
// 每只上榜股票含: 名称/上榜原因/成交额/合计买入/合计卖出/净额 + 买卖前5营业部
//
// 用法: ths lhb [--top N] [--json]

const { getFlag, renderTable } = require('./helpers');
const { fetchHtml } = require('../net');
const { parseLhb } = require('../parsers');

const URL = 'https://data.10jqka.com.cn/market/longhu/';

async function cmdLhb(ctx, args) {
  const top = Math.max(1, Math.min(100, parseInt(getFlag(args, '--top', '15'), 10) || 15));

  ctx.audit.startOperation('lhb', {});
  let html;
  try {
    html = await fetchHtml(URL, { timeoutMs: 25000 });
  } catch (e) {
    ctx.audit.endOperation('error', {}, { error: e.message });
    throw e;
  }
  let rows = parseLhb(html);
  // 过滤无净额的数据（部分上榜条目无营业部席位），按净额降序
  rows = rows.filter(r => r.net != null && r.name && r.name !== r.code);
  rows.sort((a, b) => (b.net || 0) - (a.net || 0));
  ctx.audit.endOperation('success', { rows: rows.length }, { rows });

  if (args.includes('--json')) return rows.slice(0, top);

  console.log(`龙虎榜 Top ${Math.min(top, rows.length)}（净额，万元）:`);
  console.log(renderTable(rows.slice(0, top).map(r => ({
    code: r.code,
    name: r.name,
    reason: r.reason ? r.reason.slice(0, 22) : '-',
    net: r.net != null ? r.net.toFixed(0) : '-',
    buy: r.buyTotal != null ? r.buyTotal.toFixed(0) : '-',
    sell: r.sellTotal != null ? r.sellTotal.toFixed(0) : '-',
    buyTop: r.buyDealers[0] ? r.buyDealers[0].name.slice(0, 16) : '-',
    sellTop: r.sellDealers[0] ? r.sellDealers[0].name.slice(0, 16) : '-',
  })), [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '上榜原因', key: 'reason' },
    { header: '净额', key: 'net', align: 'r' },
    { header: '买额', key: 'buy', align: 'r' },
    { header: '卖额', key: 'sell', align: 'r' },
    { header: '买入Top1营业部', key: 'buyTop' },
    { header: '卖出Top1营业部', key: 'sellTop' },
  ]));
  console.log('\n大师解读: 净额为正 + 营业部里有"机构专用"或知名游资席位 = 资金合力；--json 看完整 5 个席位明细。');
  return undefined;
}

module.exports = cmdLhb;
