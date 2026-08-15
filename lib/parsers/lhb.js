// lib/parsers/lhb.js — 龙虎榜解析（data.10jqka.com.cn/market/longhu/）
//
// 页面结构：多个 <div class="stockcont" stockcode="..."> 块，每块含
//   <p>名称(代码)明细：上榜原因</p>
//   成交额/合计买入/合计卖出/净额（万元）
//   买入金额最大的前5名营业部 表 + 卖出金额最大的前5名营业部 表（bg-blue 表头）
//
// 纯函数：HTML 字符串 → 结构化数组。

const { stripTags, rowsOf, num } = require('./table');

/** 解析单个营业部表格 → { dir: 'buy'|'sell', dealers: [{name, buy, sell, net}] } */
function parseDealerTable(tableHtml) {
  const theadM = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(tableHtml);
  const dir = theadM && /买入/.test(theadM[1]) ? 'buy' : 'sell';
  const dealers = [];
  for (const cells of rowsOf(tableHtml)) {
    if (cells.length < 4) continue;
    const raw = cells[0].raw || '';
    // 营业部全名在 <a title="…">；跳过表头行
    const titleM = /title="([^"]*)"/.exec(raw);
    const name = titleM ? titleM[1] : stripTags(cells[0].text);
    if (!name || /前5名营业部/.test(name)) continue;
    dealers.push({
      name,
      buy: num(cells[1].text),
      sell: num(cells[2].text),
      net: num(cells[3].text),
    });
  }
  return { dir, dealers };
}

/** 解析单个 stockcont 块 */
function parseBlock(code, block) {
  // 名称(代码)明细：上榜原因
  const pM = /<p>([\s\S]*?)<\/p>/.exec(block);
  const pText = pM ? stripTags(pM[1]) : '';
  const reasonM = /明细：([\s\S]*)$/.exec(pText);
  const nameM = /^([^（(]+)[（(]\d+[)）]/.exec(pText) || [];
  const name = stripTags(nameM[1] || code);
  const reason = reasonM ? reasonM[1].trim() : '';

  // 成交额/合计买入/合计卖出/净额（万元）
  const grab = (label) => {
    const re = new RegExp(label + '：<span[^>]*>([-\\d.]+)<\\/span>\\s*万|' + label + '：([-\\d.]+)\\s*万');
    const m = re.exec(block);
    const v = m ? (m[1] != null ? m[1] : m[2]) : null;
    return v != null ? parseFloat(v) : null;
  };

  // 营业部表
  const buyDealers = [];
  const sellDealers = [];
  const tableRe = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(block)) !== null) {
    const { dir, dealers } = parseDealerTable(tm[0]);
    if (dir === 'buy') buyDealers.push(...dealers);
    else sellDealers.push(...dealers);
  }

  return {
    code,
    name,
    reason,
    amount: grab('成交额'),
    buyTotal: grab('合计买入'),
    sellTotal: grab('合计卖出'),
    net: grab('净额'),
    buyDealers: buyDealers.slice(0, 5),
    sellDealers: sellDealers.slice(0, 5),
  };
}

/**
 * 解析龙虎榜页面。
 * @param {string} html
 * @returns {Array<object>}
 */
function parseLhb(html) {
  const out = [];
  const re = /<div class="stockcont" stockcode="(\d+)"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push({ code: m[1], idx: m.index });
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i].idx, i + 1 < starts.length ? starts[i + 1].idx : html.length);
    out.push(parseBlock(starts[i].code, block));
  }
  return out;
}

module.exports = { parseLhb, parseDealerTable };
