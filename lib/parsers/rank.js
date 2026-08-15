// lib/parsers/rank.js — 排行解析（zdfph 涨跌幅排行 + 技术形态选股族）
//
// 数据源: data.10jqka.com.cn
//   - market/zdfph/  涨跌幅排行：序号/代码/简称/最新价/涨跌幅(当日·三日·五日)/
//                    累计换手率(当日·三日·五日)/资金净流入(当日·三日·五日)
//   - rank/{cxg,cxd,lxsz,lxxd,cxfl,cxsl,xstp,xxtp,ljqs,ljqd}/  技术形态选股族
//
// 注意: 各技术形态页的列布局不同（如 ljqs 是"量价齐升天数/阶段涨幅/累计换手/所属行业"，
//       lxsz 是"收盘/最高/最低/连涨天数/连续涨跌幅/累计换手/所属行业"），
//       因此技术形态族按"表头动态映射"解析，而不是硬编码列。
//
// 纯函数：HTML 字符串 → 结构化行数组。

const { stripTags, firstMTable, rowsOf, num } = require('./table');

/** 中文金额 '18.14亿'→1.814e9 / '4216.13万'→4.21613e7 / '123'→123；解析失败 null */
function money(s) {
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '—' || t === '-') return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)(亿|万)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] === '亿') return n * 1e8;
  if (m[2] === '万') return n * 1e4;
  return n;
}

/** 表头行标签（清理空白；label 可含 "（%）" 等） */
function headerLabels(tableHtml) {
  const theadM = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(tableHtml);
  const labels = [];
  if (!theadM) return labels;
  const firstTr = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(theadM[1]);
  if (!firstTr) return labels;
  const re = /<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi;
  let m;
  while ((m = re.exec(firstTr[1])) !== null) {
    labels.push(stripTags(m[0]).replace(/\s+/g, ' ').replace(/ （/g, '（').trim());
  }
  return labels;
}

/** 涨跌幅排行（zdfph，13 列，表头 colspan 固定结构） */
function parseZdfph(html) {
  const rows = rowsOf(firstMTable(html));
  const out = [];
  for (const cells of rows) {
    if (cells.length < 13) continue;
    const rank = num(cells[0].text);
    if (rank == null) continue;
    const codeM = /stockpage\.10jqka\.com\.cn\/(\d+)\//.exec(cells[1].html || '');
    out.push({
      rank,
      code: codeM ? codeM[1] : stripTags(cells[1].text),
      name: stripTags(cells[2].text),
      price: num(cells[3].text),
      zdf: num(cells[4].text), zdf3: num(cells[5].text), zdf5: num(cells[6].text),
      hsl: num(cells[7].text), hsl3: num(cells[8].text), hsl5: num(cells[9].text),
      netIn: money(cells[10].text), netIn3: money(cells[11].text), netIn5: money(cells[12].text),
    });
  }
  return out;
}

/**
 * 技术形态选股族（动态按表头映射，兼容各 kind 不同列）。
 * @param {string} html
 * @returns {Array<object>} { rank, code, name, ...动态列（表头 label → 值，数值/字符串） }
 */
function parseTechRank(html) {
  const table = firstMTable(html);
  const labels = headerLabels(table);
  const rows = rowsOf(table);
  const out = [];
  for (const cells of rows) {
    if (cells.length < 4) continue;
    const rank = num(cells[0].text);
    if (rank == null) continue;
    const codeM = /stockpage\.10jqka\.com\.cn\/(\d+)\//.exec(cells[1].html || '');
    const row = {
      rank,
      code: codeM ? codeM[1] : stripTags(cells[1].text),
      name: stripTags(cells[2].text),
    };
    for (let i = 3; i < cells.length; i++) {
      const label = labels[i] || `col${i}`;
      const text = stripTags(cells[i].text);
      // 日期形如 2026-08-13 保持字符串（num 会把年份截成 2026）
      row[label] = /^\d{4}-\d{2}-\d{2}/.test(text) ? text : (num(text) != null ? num(text) : text);
    }
    out.push(row);
  }
  return out;
}

/** 按 kind 分发 */
function parseRank(html, kind = 'zdfph') {
  return kind === 'zdfph' ? parseZdfph(html) : parseTechRank(html);
}

module.exports = { parseRank, parseZdfph, parseTechRank, money };
