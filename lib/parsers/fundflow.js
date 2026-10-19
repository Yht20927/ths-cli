// lib/parsers/fundflow.js — 资金流排行页解析（纯函数）
//
// 数据源: data.10jqka.com.cn/funds/ggzjl/code/{code}/（GBK HTML）
// 表头: 序号/股票代码/股票简称/最新价/涨跌幅/换手率/流入资金/流出资金/净额/成交额/大单流入

const { stripTags, firstMTable, rowsOf } = require('./table');

/**
 * 解析资金流排行 HTML。
 * @param {string} html
 * @returns {{headers: string[], rows: Array<object>}}
 */
function parseFundflow(html) {
  const table = firstMTable(html);
  if (!table) return { headers: [], rows: [] };

  const headers = (table.match(/<th[^>]*>[\s\S]*?<\/th>/gi) || [])
    .map(s => stripTags(s))
    .filter(Boolean);

  const rows = [];
  for (const cells of rowsOf(table)) {
    if (!cells || cells.length < 4) continue;
    const rank = stripTags(cells[0].text);
    if (!/^\d+$/.test(rank)) continue; // 表头行 / “暂无数据”行
    rows.push({
      rank,
      code: stripTags(cells[1].text),
      name: stripTags(cells[2].text),
      price: stripTags(cells[3].text),
      pct: cells[4] ? stripTags(cells[4].text) : '',
      turnoverRate: cells[5] ? stripTags(cells[5].text) : '',
      inflow: cells[6] ? stripTags(cells[6].text) : '',
      outflow: cells[7] ? stripTags(cells[7].text) : '',
      net: cells[8] ? stripTags(cells[8].text) : '',
      amount: cells[9] ? stripTags(cells[9].text) : '',
      bigIn: cells[10] ? stripTags(cells[10].text) : '',
    });
  }
  return { headers, rows };
}

module.exports = { parseFundflow };
