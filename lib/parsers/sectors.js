// lib/parsers/sectors.js — 板块强弱解析（thshy 行业 / gn 概念）
//
// 数据源:
//   - 行业: q.10jqka.com.cn/thshy/  — m-table 12 列（序号/板块/涨跌幅/总成交量/总成交额/
//     净流入/上涨家数/下跌家数/均价/领涨股/最新价/领涨股涨跌幅），板块代码 881xxx
//   - 概念: q.10jqka.com.cn/gn/     — m-table 5 列（日期/概念名称/驱动事件/龙头股/成分股数量），
//     是"题材事件日历"而非排名；概念详情页代码在 detail/code/ 里
//
// 纯函数：HTML 字符串 → 结构化行数组。

const { stripTags, attr, firstMTable, rowsOf, num } = require('./table');

/** 从单元格 HTML 里抽板块代码：/thshy/detail/code/881172/ 或 /gn/detail/code/309269/ */
function boardCode(cellHtml) {
  const m = String(cellHtml).match(/detail\/code\/(\d+)\//);
  return m ? m[1] : null;
}

/** 从单元格 HTML 里抽领涨股代码：stockpage.10jqka.com.cn/688662/ */
function stockCode(cellHtml) {
  const m = String(cellHtml).match(/stockpage\.10jqka\.com\.cn\/(\d+)\//);
  return m ? m[1] : null;
}

/**
 * 解析行业板块排名（thshy）。
 * @param {string} html
 * @returns {Array<object>}
 */
function parseIndustrySectors(html) {
  const rows = rowsOf(firstMTable(html));
  const out = [];
  for (const cells of rows) {
    if (cells.length < 12) continue;
    const rank = num(cells[0].text);
    if (rank == null) continue; // 表头行/分隔行
    const leadHtml = cells[9].html || '';
    out.push({
      rank,
      code: boardCode(cells[1].html || ''),
      name: stripTags(cells[1].text),
      pct: num(cells[2].text),
      volume: num(cells[3].text), // 总成交量(万手)
      amount: num(cells[4].text), // 总成交额(亿)
      netIn: num(cells[5].text),  // 净流入(亿)
      up: num(cells[6].text),
      down: num(cells[7].text),
      avgPrice: num(cells[8].text),
      leadName: stripTags(cells[9].text),
      leadCode: stockCode(leadHtml),
      leadPrice: num(cells[10].text),
      leadPct: num(cells[11].text),
    });
  }
  return out;
}

/**
 * 解析概念板块热点日历（gn）。
 * @param {string} html
 * @returns {Array<object>}
 */
function parseConceptSectors(html) {
  const rows = rowsOf(firstMTable(html));
  const out = [];
  for (const cells of rows) {
    if (cells.length < 5) continue;
    const date = stripTags(cells[0].text);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; // 表头行
    out.push({
      date,
      code: boardCode(cells[1].html || ''),
      name: stripTags(cells[1].text),
      event: stripTags(cells[2].text),
      leader: stripTags(cells[3].text),
      memberCount: num(cells[4].text),
    });
  }
  return out;
}

/**
 * 解析板块成分股（thshy/gn detail 页，列：序号/代码/名称/…）。
 * @param {string} html
 * @returns {Array<{code: string, name: string}>}
 */
function parseBoardMembers(html) {
  const rows = rowsOf(firstMTable(html));
  const out = [];
  for (const cells of rows) {
    if (cells.length < 3) continue;
    const code = /stockpage\.10jqka\.com\.cn\/(\d+)\//.exec(cells[1].html || '') || [];
    const c = code[1] || stripTags(cells[1].text);
    if (!/^\d{6}$/.test(c)) continue; // 表头/非成分行
    out.push({ code: c, name: stripTags(cells[2].text) });
  }
  return out;
}

module.exports = { parseIndustrySectors, parseConceptSectors, parseBoardMembers };
