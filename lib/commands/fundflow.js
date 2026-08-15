// lib/commands/fundflow.js — 资金流排行（主力净流入方向）
//
// 数据源: data.10jqka.com.cn/funds/ggzjl/code/{code}/（GBK 页面，返回全市场资金流排行）
// 列: 序号/代码/名称/最新价/涨跌幅/换手率/流入/流出/净额/成交额/大单流入/超大单/...
//
// 依赖油猴脚本 v1.2.0+（window.__ths.fundflow）。

const { renderTable, getFlag, fmtNum } = require('./helpers');

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

  const data = await ctx.loggedCall('fundflow', { top, codesFilter },
    `window.__ths.fundflow('${require('./helpers').escapeExpression(getFlag(args, '--code', '600519'))}')`);
  if (!data || !Array.isArray(data.rows) || !data.rows.length) {
    throw new Error('未返回资金流数据（油猴脚本需 v1.2.0+，请在 Tampermonkey 更新并刷新 10jqka 页面）');
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

  let shown = rows;
  if (codesFilter.length) {
    shown = rows.filter(r => codesFilter.includes(r.code));
    if (!shown.length) {
      throw new Error(`资金流排行前 ${top} 名中未找到 ${codesFilter.join(',')}（可加大 --top）`);
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
