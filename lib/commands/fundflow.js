// lib/commands/fundflow.js — 资金流排行（主力净流入方向）
//
// 数据源: data.10jqka.com.cn/funds/ggzjl/code/{code}/（GBK 页面，返回全市场资金流排行）
// 列: 序号/代码/名称/最新价/涨跌幅/换手率/流入/流出/净额/成交额/大单流入/超大单/...
//
// Node 直连 data.10jqka.com.cn 页面（优先）；失败时回退油猴 v1.2.0+ 的 window.__ths.fundflow。

const { renderTable, getFlag, fmtNum, escapeExpression } = require('./helpers');
const { fetchHtml } = require('../net');
const { parseFundflow } = require('../parsers');

/** Node 直连资金流页面（GBK HTML；失败重试一次） */
async function fetchFundflowDirect(code) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fetchHtml(`https://data.10jqka.com.cn/funds/ggzjl/code/${code}/`, { timeoutMs: 20000 });
      const parsed = parseFundflow(html);
      if (parsed.rows.length) return parsed;
      lastErr = new Error('资金流页面未解析出行数据');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 优先 Node 直连；失败时回退油猴（浏览器上下文） */
async function loadFundflow(ctx, code) {
  if (ctx.fundflowData) return ctx.fundflowData;
  try {
    return await fetchFundflowDirect(code);
  } catch (directErr) {
    try {
      return await ctx.loggedCall('fundflow', { code },
        `window.__ths.fundflow('${escapeExpression(code)}')`);
    } catch (bridgeErr) {
      throw new Error(`资金流数据获取失败：Node 直连 ${directErr.message}；油猴 ${bridgeErr.message}`);
    }
  }
}

/** 解析中文金额 '3.75亿'→3.75e8 / '4216.13万'→4.21613e7 / '0.00'→0；解析失败返回 null */
function parseCnMoney(s) {
  if (s == null) return null;
  // 容忍 HTML 注释残留（data.10jqka.com.cn 表格行尾的 -->）
  const t = String(s).trim().replace(/-->/g, '').trim();
  if (!t || t === '--' || t === '-') return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)(亿|万)?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (m[2] === '亿') return num * 1e8;
  if (m[2] === '万') return num * 1e4;
  return num;
}

/**
 * 资金流排行
 * @param {object} ctx
 * @param {string[]} args - [--top N] [--codes a,b] [--json]
 */
async function cmdFundflow(ctx, args) {
  const top = Math.max(1, Math.min(50, parseInt(getFlag(args, '--top', '10'), 10) || 10));
  const codesFilter = (getFlag(args, '--codes', null) || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const quoteCode = getFlag(args, '--code', '600519');
  const data = await loadFundflow(ctx, quoteCode);
  if (!data || !Array.isArray(data.rows) || !data.rows.length) {
    throw new Error('未返回资金流数据（Node 直连与油猴均无有效响应，请检查网络或升级油猴脚本）');
  }

  const rows = data.rows.map((r, i) => ({
    rank: r.rank || String(i + 1),
    code: String(r.code || '').trim(),
    name: String(r.name || '').trim(),
    price: r.price != null ? parseFloat(r.price) : null,
    pct: r.pct != null ? parseFloat(String(r.pct).replace('%', '')) : null,
    turnoverRate: r.turnoverRate != null ? parseFloat(String(r.turnoverRate).replace('%', '')) : null,
    net: parseCnMoney(r.net),
    inflow: parseCnMoney(r.inflow),
    outflow: parseCnMoney(r.outflow),
    amount: parseCnMoney(r.amount),
    bigIn: parseCnMoney(r.bigIn),
  })).filter(r => r.code && r.name);

  // 页面默认按涨幅排序；命令语义是“主力净流入排行”，统一按净额降序
  rows.sort((a, b) => {
    if (a.net == null && b.net == null) return 0;
    if (a.net == null) return 1;
    if (b.net == null) return -1;
    return b.net - a.net;
  });

  let shown = rows;
  if (codesFilter.length) {
    shown = rows.filter(r => codesFilter.includes(r.code));
    if (!shown.length) {
      throw new Error(`资金流排行中未找到 ${codesFilter.join(',')}（该页只含当日强势股资金榜，非全市场）`);
    }
  } else {
    shown = rows.slice(0, top);
  }

  if (args.includes('--json')) {
    return { headers: data.headers, rows: shown };
  }

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + Math.round(n * 100) / 100);
  console.log(`资金流排行（主力净流入 ${codesFilter.length ? `筛选 ${codesFilter.join(',')}` : `Top ${top}`}）:`);
  console.log(renderTable(shown.map(r => ({
    code: r.code,
    name: r.name,
    price: r.price != null ? r.price.toFixed(2) : '-',
    pct: sign(r.pct) + '%',
    turnoverRate: r.turnoverRate != null ? r.turnoverRate + '%' : '-',
    net: r.net != null ? fmtNum(r.net) : '-',
    inflow: r.inflow != null ? fmtNum(r.inflow) : '-',
    bigIn: r.bigIn != null ? fmtNum(r.bigIn) : '-',
  })), [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '现价', key: 'price', align: 'r' },
    { header: '涨跌', key: 'pct', align: 'r' },
    { header: '换手', key: 'turnoverRate', align: 'r' },
    { header: '主力净流入', key: 'net', align: 'r' },
    { header: '流入', key: 'inflow', align: 'r' },
    { header: '大单流入', key: 'bigIn', align: 'r' },
  ]));

  const pos = shown.filter(r => r.net != null && r.net > 0).length;
  console.log(`\n大师解读: 前 ${shown.length} 名中 ${pos} 只主力净流入为正 — ${pos > shown.length / 2 ? '资金进攻方向明确' : '资金分歧/流出，谨慎追高'}`);
  return undefined;
}

module.exports = cmdFundflow;
module.exports.parseCnMoney = parseCnMoney;
module.exports.fetchFundflowDirect = fetchFundflowDirect;
module.exports.loadFundflow = loadFundflow;
