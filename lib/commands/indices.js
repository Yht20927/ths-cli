// lib/commands/indices.js — 大盘指数趋势判定（M2-2）
//
// 数据源：d.10jqka.com.cn v6/line JSONP（Node 直连，不经油猴/bridge）。
// 用途：查看 上证/深成/创业板 是否站上 MA20、均线排列、支撑压力、近 5 日涨跌，
// 判断"大盘允不允许"（不逆大盘第一关）。

const { renderKV } = require('./helpers');
const { INDEXES, fetchIndexDailyBars, summarizeIndexTrend } = require('../index-kline');

const p2 = v => (v == null ? '-' : String(Math.round(v * 100) / 100));

async function cmdIndex(ctx, args) {
  const arg = args[0] ? String(args[0]).toUpperCase() : null;
  const json = args.includes('--json');
  let codes;
  if (arg) {
    if (!INDEXES[arg]) throw new Error(`未知指数码 "${arg}"，可用: ${Object.keys(INDEXES).join('/')}（如 1A0001 上证 / 399006 创业板）`);
    codes = [arg];
  } else {
    codes = Object.keys(INDEXES);
  }

  const out = [];
  for (const c of codes) {
    const meta = INDEXES[c];
    try {
      const bars = await fetchIndexDailyBars(c);
      out.push({ code: c, name: meta.name, bars: bars.length, trend: summarizeIndexTrend(bars), error: null });
    } catch (e) {
      out.push({ code: c, name: meta.name, bars: 0, trend: null, error: e.message });
    }
  }

  if (json) return out;

  for (const o of out) {
    if (o.error) {
      console.log(`\n${o.name}（${o.code}）拉取失败: ${o.error}`);
      continue;
    }
    const t = o.trend;
    const maTxt = t.aboveMA20 ? '站上 MA20 ✅' : '跌破 MA20 ❌';
    const env = t.aboveMA20 ? '环境允许（指数在均线上方）' : '环境弱——系统性风险，个股信号打折';
    const items = [
      { label: '指数', value: `${o.name}（${o.code}）` },
      { label: '最新', value: t.date ? `${p2(t.close)}（${t.date}）` : p2(t.close) },
      { label: 'MA20', value: `${maTxt} 距MA20 ${p2(t.maGapPct)}%` },
      { label: '均线', value: `${t.maAlignment}（MA5 ${p2(t.ma5)} / MA10 ${p2(t.ma10)} / MA20 ${p2(t.ma20)} / MA60 ${p2(t.ma60)}）` },
      { label: '支撑', value: p2(t.support) },
      { label: '压力', value: p2(t.resistance) },
      { label: '近5日', value: `${p2(t.ret5Pct)}%` },
      { label: '解读', value: env },
    ];
    console.log('');
    console.log(renderKV(items));
  }
  console.log('\n注: 指数 K 线来自同花顺 v6/line JSONP（Node 直连），与个股 K 线接口不同源。');
  return undefined;
}

module.exports = cmdIndex;
