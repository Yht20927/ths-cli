// lib/commands/fundamental.js — F10 财务概况（质地判断）
//
// 数据源（Node 直连，GBK HTML）: basic.10jqka.com.cn/{code}/finance.html
// 解析"财务分析"courier 清单: 毛利率/净利率/ROE/营收净利增速/资产负债率/净利现金含量 等
//   + 报告期 + 财务状况诊断结论
//
// 用法: ths fundamental <code> [--json]

const { getFlag, renderTable, inferMarket } = require('./helpers');
const { fetchHtml } = require('../net');
const { parseFundamental } = require('../parsers');

/** 清理指标名前缀：本期/中报 → 简洁名 */
function cleanName(name) {
  return String(name).replace(/^(本期|中报|年报|一季报|中报扣非后|本期扣非后)/, '').trim() || name;
}

async function cmdFundamental(ctx, args) {
  const code = (args[0] || '').trim();
  if (!code) throw new Error('用法: ths fundamental <code> [--json]');
  // 板块/指数无 F10，提示即可
  const market = inferMarket(code);
  if (market == null) throw new Error(`无法推断市场码（${code}），F10 仅支持 A 股个股`);

  const url = `https://basic.10jqka.com.cn/${code}/finance.html`;
  ctx.audit.startOperation('fundamental', { code });
  let html;
  try {
    html = await fetchHtml(url, { timeoutMs: 20000 });
  } catch (e) {
    ctx.audit.endOperation('error', {}, { code, error: e.message });
    throw e;
  }
  const r = parseFundamental(html);
  ctx.audit.endOperation('success', { items: r.items.length }, { code, ...r });

  if (args.includes('--json')) return { code, ...r };

  console.log(`${code} 财务概况（F10）${r.reportPeriod ? ' — 报告期: ' + r.reportPeriod : ''}`);
  if (r.verdict) console.log(`财务状况: ${r.verdict}`);
  if (r.diagnosis) console.log(`诊断: ${r.diagnosis}`);

  if (!r.items.length) {
    console.log('\n（未解析到财务指标——页面结构可能变更，或该股无 F10 数据）');
    return undefined;
  }
  console.log('\n核心指标（本期 / 去年同期 / 点评）:');
  console.log(renderTable(r.items.map(it => ({
    name: cleanName(it.name),
    value: it.value,
    prev: it.prev,
    comment: it.comment,
  })), [
    { header: '指标', key: 'name' },
    { header: '本期', key: 'value', align: 'r' },
    { header: '去年同期', key: 'prev', align: 'r' },
    { header: '点评', key: 'comment' },
  ]));
  return undefined;
}

module.exports = cmdFundamental;
