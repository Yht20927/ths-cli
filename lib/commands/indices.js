// lib/commands/indices.js — 大盘指数趋势判定（M2-2）
//
// 数据源：
//   - 日 K/趋势: d.10jqka.com.cn v6/line JSONP（Node 直连，不经油猴/bridge）
//   - 今日实时: d.10jqka.com.cn realhead（与 ths market 同源）
// 用途：查看 上证/深成/创业板 是否站上 MA20、均线排列、支撑压力、近 5 日涨跌，
// 判断"大盘允不允许"（不逆大盘第一关）；科创板指数 1Bxxxx 同样支持。

const { renderKV, fmtNum } = require('./helpers');
const {
  INDEXES, DEFAULT_INDEX_CODES, fetchIndexDailyBars, fetchIndexSnapshot, summarizeIndexTrend,
} = require('../index-kline');

const p2 = v => (v == null ? '-' : String(Math.round(v * 100) / 100));
const sign = n => (n == null || !Number.isFinite(Number(n)) ? '-' : (Number(n) > 0 ? '+' : '') + Math.round(Number(n) * 100) / 100);

/** realhead 字符串字段 → 数值（缺失保持 null） */
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normLive(live) {
  if (!live) return null;
  return {
    price: numOrNull(live.price),
    prevClose: numOrNull(live.prevClose),
    open: numOrNull(live.open),
    high: numOrNull(live.high),
    low: numOrNull(live.low),
    pct: numOrNull(live.pct),
    change: numOrNull(live.change),
    amount: numOrNull(live.amount),
    up: numOrNull(live.upCount),
    down: numOrNull(live.downCount),
    flat: numOrNull(live.flatCount),
    updateTime: live.updateTime || null,
  };
}

async function cmdIndex(ctx, args) {
  // 首个非选项参数才是指数码（--json 可能排在最前）
  const positional = args.find(a => !String(a).startsWith('--'));
  const arg = positional ? String(positional).toUpperCase() : null;
  const json = args.includes('--json');
  let codes;
  if (arg) {
    if (!INDEXES[arg]) throw new Error(`未知指数码 "${arg}"，可用: ${Object.keys(INDEXES).join('/')}（如 1A0001 上证 / 399006 创业板 / 1B0688 科创50）`);
    codes = [arg];
  } else {
    codes = DEFAULT_INDEX_CODES;
  }

  // 日 K 与实时快照并发；任一失败不阻断另一项
  const out = await Promise.all(codes.map(async (c) => {
    const meta = INDEXES[c];
    const [barsRes, liveRes] = await Promise.allSettled([
      fetchIndexDailyBars(c),
      fetchIndexSnapshot(c),
    ]);
    const bars = barsRes.status === 'fulfilled' ? barsRes.value : null;
    const live = liveRes.status === 'fulfilled' ? normLive(liveRes.value) : null;
    const trend = bars ? summarizeIndexTrend(bars) : null;
    const error = !bars
      ? (barsRes.reason && barsRes.reason.message) || '日K拉取失败'
      : (!trend ? '日K不足 20 根，无法判断趋势' : null);
    return {
      code: c,
      name: meta.name,
      bars: bars ? bars.length : 0,
      trend,
      live,
      error,
    };
  }));

  if (json) return out;

  for (const o of out) {
    const t = o.trend;
    const items = [{ label: '指数', value: `${o.name}（${o.code}）` }];

    // 今日实时（交易日盘中才有意义；非交易时段为最近一次快照）
    const l = o.live;
    if (l && l.price != null) {
      const pct = l.pct != null
        ? l.pct
        : (l.prevClose ? (l.price / l.prevClose - 1) * 100 : null);
      const ts = l.updateTime ? `  [${l.updateTime}]` : '';
      items.push({
        label: '今日实时',
        value: `${p2(l.price)}（${sign(pct)}%）  开 ${p2(l.open)} / 高 ${p2(l.high)} / 低 ${p2(l.low)}  成交 ${l.amount != null ? fmtNum(l.amount) : '-'}${ts}`,
      });
    }

    if (!t) {
      console.log('');
      console.log(renderKV(items));
      console.log(`  趋势: ${o.error || '数据不足'}`);
      continue;
    }

    const maTxt = t.aboveMA20 ? '站上 MA20 ✅' : '跌破 MA20 ❌';
    const env = t.aboveMA20 ? '环境允许（指数在均线上方）' : '环境弱——系统性风险，个股信号打折';
    items.push(
      { label: '最新收盘', value: t.date ? `${p2(t.close)}（${t.date}）` : p2(t.close) },
      { label: 'MA20', value: `${maTxt} 距MA20 ${p2(t.maGapPct)}%` },
      { label: '均线', value: `${t.maAlignment}（MA5 ${p2(t.ma5)} / MA10 ${p2(t.ma10)} / MA20 ${p2(t.ma20)} / MA60 ${p2(t.ma60)}）` },
      { label: '支撑', value: p2(t.support) },
      { label: '压力', value: p2(t.resistance) },
      { label: '近5日', value: `${p2(t.ret5Pct)}%` },
      { label: '解读', value: env },
    );
    console.log('');
    console.log(renderKV(items));
  }
  console.log('\n注: 日 K 来自同花顺 v6/line JSONP，今日实时来自 realhead（均为 Node 直连）；趋势统计已剔除盘中占位 K。');
  return undefined;
}

module.exports = cmdIndex;
