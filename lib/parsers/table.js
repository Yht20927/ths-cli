// lib/parsers/table.js — GBK HTML 表格通用解析（正则，纯函数，可单测）
//
// 同花顺数据中心/行情中心页面均为服务端渲染的 HTML 表格（GBK），
// 用正则抽取 <table>/<tr>/<td> 比引入 DOM 解析器更稳（无第三方依赖）。

/** 去除标签与 HTML 注释，规整空白 */
function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 取标签内某属性值（不区分大小写） */
function attr(s, name) {
  const m = String(s).match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : null;
}

/** 提取页面中所有 <table>…</table> */
function allTables(html) {
  const out = [];
  const re = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

/**
 * 取第一个 m-table（行情中心/数据中心通用表格 class）。
 * @param {string} html
 * @returns {string} 表格 HTML；找不到则回退第一个 table
 */
function firstMTable(html) {
  const tables = allTables(html);
  return tables.find(t => /m-table/.test(t.slice(0, 300))) || tables[0] || '';
}

/** 从表格 HTML 解析行。每行 = cells: [{ raw, html, text }] */
function rowsOf(tableHtml) {
  const rows = [];
  const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(tableHtml)) !== null) {
    const cells = [];
    const cre = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = cre.exec(m[1])) !== null) {
      const inner = cm[1] != null ? cm[1] : '';
      cells.push({ raw: cm[0], html: inner, text: stripTags(inner) });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * 数值化：'4.07'→4.07 / '-4.56'→-4.56 / '18.14亿'→18.14 / '—'→null
 * @param {string} s
 * @returns {number|null}
 */
function num(s) {
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '—' || t === '-' || t === '--' || t === '暂无') return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

module.exports = { stripTags, attr, allTables, firstMTable, rowsOf, num };
