// lib/parsers/fundamental.js — F10 财务摘要解析（basic.10jqka.com.cn/{code}/finance.html）
//
// 页面含"财务分析"courier 清单，每条形如：
//   <li>…毛利率89.76%,去年同期为91.97%,主营获利能力保持稳定</li>
//   <li><a …>行业排名 <span>1/20</span></a>2.本期净利率52.22%,去年同期为54.89%,…</li>
// 另有 报告期 与 财务状况诊断结论（upcolor h3 + 诊断 p）。
//
// 纯函数：HTML 字符串 → { reportPeriod, verdict, items: [{name, value, prev, comment}] }

const { stripTags } = require('./table');

/**
 * 解析财务分析 courier 清单项。
 * 模式：指标名 + 数值%,去年同期为数值%,评价
 * @returns {Array<{name, value, prev, comment}>}
 */
function parseCourierItems(html) {
  const items = [];
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripTags(m[1]);
    const mm = text.match(/(.+?)([-+]?\d+(?:\.\d+)?)%,去年同期为([-+]?\d+(?:\.\d+)?)%,(.+)/);
    if (!mm) continue;
    let name = mm[1]
      .replace(/行业排名\s*[\d.]+\/\d+/g, '') // 去掉 "行业排名 1/20"
      .replace(/^\s*\d+[\.、]/, '')            // 去掉前导序号 "1."（可能带空格）
      .trim();
    if (!name) name = stripTags(mm[1]).trim();
    items.push({
      name,
      value: parseFloat(mm[2]),
      prev: parseFloat(mm[3]),
      comment: mm[4].trim(),
    });
  }
  return items;
}

/**
 * 解析 F10 财务页。
 * @param {string} html
 * @returns {{ reportPeriod: string|null, verdict: string|null, diagnosis: string|null, items: Array<object> }}
 */
function parseFundamental(html) {
  const periodM = /报告期：([^<]{2,12})/.exec(html);
  const verdictM = /<h3[^>]*class="[^"]*upcolor[^"]*"[^>]*>([^<]+)<\/h3>/.exec(html);
  const diagM = /<div class="courier_box">\s*<div class="courier_left">\s*<h3[^>]*>[\s\S]*?<\/h3>\s*<p>([\s\S]*?)<\/p>/.exec(html);
  const items = parseCourierItems(html);
  return {
    reportPeriod: periodM ? stripTags(periodM[1]) : null,
    verdict: verdictM ? stripTags(verdictM[1]) : null,
    diagnosis: diagM ? stripTags(diagM[1]).replace(/\[查看具体诊断\]/g, '').trim() : null,
    items,
  };
}

module.exports = { parseFundamental, parseCourierItems };
