// lib/commands/sectors.js — 板块强弱排名（行业 / 概念热点）
//
// 数据源（Node 直连，GBK HTML）:
//   - 行业: q.10jqka.com.cn/thshy/   板块代码 881xxx，可 ths analyze <code> 深挖
//   - 概念: q.10jqka.com.cn/gn/      题材事件日历（日期/概念/驱动事件/龙头/成分数）
//
// 用法: ths sectors [--type industry|concept] [--top N] [--sort pct|netIn|amount] [--json]

const { getFlag, renderTable, fmtNum } = require('./helpers');
const { fetchHtml } = require('../net');
const { parseIndustrySectors, parseConceptSectors } = require('../parsers');

const URLS = {
  industry: 'https://q.10jqka.com.cn/thshy/',
  concept: 'https://q.10jqka.com.cn/gn/',
};
const INDUSTRY_SORTS = ['pct', 'netIn', 'amount', 'up'];

async function cmdSectors(ctx, args) {
  const type = getFlag(args, '--type', 'industry');
  if (!URLS[type]) throw new Error(`未知 --type "${type}"，可选: ${Object.keys(URLS).join('|')}`);
  const top = Math.max(1, Math.min(100, parseInt(getFlag(args, '--top', '20'), 10) || 20));

  ctx.audit.startOperation('sectors', { type });
  let html;
  try {
    html = await fetchHtml(URLS[type], { timeoutMs: 20000 });
  } catch (e) {
    ctx.audit.endOperation('error', {}, { type, error: e.message });
    throw e;
  }
  let rows = type === 'industry' ? parseIndustrySectors(html) : parseConceptSectors(html);
  ctx.audit.endOperation('success', { rows: rows.length }, { type, rows });

  if (type === 'industry') {
    const sort = INDUSTRY_SORTS.includes(getFlag(args, '--sort', 'pct')) ? getFlag(args, '--sort', 'pct') : 'pct';
    rows = rows.filter(r => r[sort] != null).sort((a, b) => b[sort] - a[sort]);
  }
  rows = rows.slice(0, top);

  if (args.includes('--json')) return rows;

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
  if (type === 'industry') {
    console.log(`行业板块强弱 Top ${rows.length}（可对板块代码 ths analyze 深挖）:`);
    console.log(renderTable(rows.map(r => ({
      rank: r.rank,
      code: r.code || '-',
      name: r.name,
      pct: sign(r.pct) + '%',
      amount: r.amount != null ? fmtNum(r.amount) + '亿' : '-',
      netIn: r.netIn != null ? sign(r.netIn) + '亿' : '-',
      upDown: r.up != null ? `${r.up}/${r.down}` : '-',
      lead: `${r.leadName || '-'}${r.leadPct != null ? ' ' + sign(r.leadPct) + '%' : ''}`,
    })), [
      { header: '#', key: 'rank', align: 'r' },
      { header: '代码', key: 'code' },
      { header: '板块', key: 'name' },
      { header: '涨跌幅', key: 'pct', align: 'r' },
      { header: '总成交额', key: 'amount', align: 'r' },
      { header: '净流入', key: 'netIn', align: 'r' },
      { header: '涨/跌家数', key: 'upDown', align: 'r' },
      { header: '领涨股', key: 'lead' },
    ]));
    console.log('\n提示: 净流入为正 = 主力进攻方向；涨跌家数悬殊 = 板块分化。板块代码（881xxx）可直接 ths analyze 深挖。');
  } else {
    console.log(`概念热点（题材事件日历）Top ${rows.length}:`);
    console.log(renderTable(rows.map(r => ({
      date: r.date,
      name: r.name,
      event: r.event ? r.event.slice(0, 40) : '-',
      leader: r.leader || '-',
      count: r.memberCount ?? '-',
    })), [
      { header: '日期', key: 'date' },
      { header: '概念', key: 'name' },
      { header: '驱动事件', key: 'event' },
      { header: '龙头股', key: 'leader' },
      { header: '成分数', key: 'count', align: 'r' },
    ]));
  }
  return undefined;
}

module.exports = cmdSectors;
