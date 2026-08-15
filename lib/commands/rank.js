// lib/commands/rank.js — 涨跌幅排行 + 技术形态选股族
//
// 数据源（Node 直连，GBK HTML）: data.10jqka.com.cn
//   - zdfph: 涨跌幅排行（当日/三日/五日涨跌幅、换手、资金净流入）
//   - cxg/cxd/lxsz/lxxd/cxfl/cxsl/xstp/xxtp/ljqs/ljqd: 技术形态选股
//
// 用法: ths rank [--kind zdfph|cxg|...] [--top N] [--json]

const { getFlag, renderTable, fmtNum } = require('./helpers');
const { fetchHtml } = require('../net');
const { parseZdfph, parseTechRank } = require('../parsers');

const KINDS = {
  zdfph: { label: '涨跌幅排行', url: 'https://data.10jqka.com.cn/market/zdfph/', parse: parseZdfph },
  cxg: { label: '创新高', url: 'https://data.10jqka.com.cn/rank/cxg/', parse: parseTechRank },
  cxd: { label: '创新低', url: 'https://data.10jqka.com.cn/rank/cxd/', parse: parseTechRank },
  lxsz: { label: '连续上涨', url: 'https://data.10jqka.com.cn/rank/lxsz/', parse: parseTechRank },
  lxxd: { label: '连续下跌', url: 'https://data.10jqka.com.cn/rank/lxxd/', parse: parseTechRank },
  cxfl: { label: '持续放量', url: 'https://data.10jqka.com.cn/rank/cxfl/', parse: parseTechRank },
  cxsl: { label: '持续缩量', url: 'https://data.10jqka.com.cn/rank/cxsl/', parse: parseTechRank },
  xstp: { label: '向上突破', url: 'https://data.10jqka.com.cn/rank/xstp/', parse: parseTechRank },
  xxtp: { label: '向下突破', url: 'https://data.10jqka.com.cn/rank/xxtp/', parse: parseTechRank },
  ljqs: { label: '量价齐升', url: 'https://data.10jqka.com.cn/rank/ljqs/', parse: parseTechRank },
  ljqd: { label: '量价齐跌', url: 'https://data.10jqka.com.cn/rank/ljqd/', parse: parseTechRank },
};

async function cmdRank(ctx, args) {
  const kind = getFlag(args, '--kind', 'zdfph');
  const meta = KINDS[kind];
  if (!meta) throw new Error(`未知 --kind "${kind}"，可选: ${Object.keys(KINDS).join('|')}`);
  const top = Math.max(1, Math.min(100, parseInt(getFlag(args, '--top', '20'), 10) || 20));

  ctx.audit.startOperation('rank', { kind });
  let html;
  try {
    html = await fetchHtml(meta.url, { timeoutMs: 20000 });
  } catch (e) {
    ctx.audit.endOperation('error', {}, { kind, error: e.message });
    throw e;
  }
  const rows = meta.parse(html);
  ctx.audit.endOperation('success', { rows: rows.length }, { kind, rows });

  if (args.includes('--json')) return rows.slice(0, top);

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
  if (kind === 'zdfph') {
    console.log(`涨跌幅排行 Top ${Math.min(top, rows.length)}（当日/三日/五日）:`);
    console.log(renderTable(rows.slice(0, top).map(r => ({
      rank: r.rank,
      code: r.code,
      name: r.name,
      price: r.price != null ? r.price.toFixed(2) : '-',
      zdf: sign(r.zdf) + '%',
      zdf3: sign(r.zdf3) + '%',
      zdf5: sign(r.zdf5) + '%',
      hsl: r.hsl != null ? r.hsl.toFixed(1) + '%' : '-',
      netIn: r.netIn != null ? fmtNum(r.netIn) : '-',
    })), [
      { header: '#', key: 'rank', align: 'r' },
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '现价', key: 'price', align: 'r' },
      { header: '今日', key: 'zdf', align: 'r' },
      { header: '三日', key: 'zdf3', align: 'r' },
      { header: '五日', key: 'zdf5', align: 'r' },
      { header: '换手', key: 'hsl', align: 'r' },
      { header: '净流入', key: 'netIn', align: 'r' },
    ]));
    console.log('\n提示: 五日强于三日强于今日 = 趋势加速；净流入配合涨幅 = 真突破。可对代码 ths analyze 深挖。');
    return undefined;
  }

  // 技术形态族：列由表头动态决定（各 kind 列不同），值统一格式化
  const shown = rows.slice(0, top);
  const dynKeys = shown.length
    ? Object.keys(shown[0]).filter(k => !['rank', 'code', 'name'].includes(k) && !/^col\d+/.test(k))
    : [];
  console.log(`${meta.label} Top ${shown.length}:`);
  console.log(renderTable(shown.map(r => {
    const cell = { rank: r.rank, code: r.code, name: r.name };
    for (const k of dynKeys) {
      const v = r[k];
      cell[k] = typeof v === 'number' ? String(Math.round(v * 100) / 100) : (v == null || v === '' ? '-' : String(v).slice(0, 14));
    }
    return cell;
  }), [
    { header: '#', key: 'rank', align: 'r' },
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    ...dynKeys.map(k => ({ header: String(k).replace(/（.*?）|\(.*?\)/g, '').slice(0, 10), key: k, align: typeof (shown[0] && shown[0][k]) === 'number' ? 'r' : 'l' })),
  ]));
  console.log('\n提示: 结果可配合 ths analyze <code> 深挖。');
  return undefined;
}

module.exports = cmdRank;
