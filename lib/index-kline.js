// lib/index-kline.js — 大盘指数日 K（纯函数解析 + Node 直连拉取）
//
// 背景（实测）：指数 K 线**不能**走 quota single_kline / multi_last_snapshot
// （numeric market 17/33/48 对 1A0001/399001/399006 一律返回空；000001 深=平安银行是撞个股坑）。
// 唯一可靠数据源是同花顺经典 JSONP 日 K：`d.10jqka.com.cn/v6/line/hs_<码>/01/last.js`，
// Node 直连即可（无需油猴/bridge），返回最近 140 根升序日 bar。
//
// 复用：bars 形状 {date,open,high,low,close,volume,amount} 与个股缓存一致，
// 可直接喂 sma/detectSR/… 做指数 MA20 / 支撑压力 / 趋势判定。

const { fetchHtml } = require('./net');
const { sma } = require('./indicators');
const { detectSR } = require('./support-resistance');

// 大盘指数映射（key 用同花顺 hs_ 体系代码）
const INDEXES = {
  '1A0001': { key: 'sh', name: '上证指数' },
  '399001': { key: 'sz', name: '深证成指' },
  '399006': { key: 'cyb', name: '创业板指' },
};

const idxUrl = code => `https://d.10jqka.com.cn/v6/line/hs_${code}/01/last.js`;

/** YYYYMMDD → YYYY-MM-DD */
function fmtDate(yyyymmdd) {
  const s = String(yyyymmdd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/**
 * 解析指数日 K JSONP 文本 → bars（升序）。
 * 结构: quotebridge_v6_line_hs_1A0001_01_last({ ... , data:"YYYYMMDD,o,h,l,c,v,amt,...;..." , ... })
 * @param {string} text
 * @returns {Array<{date,open,high,low,close,volume,amount}>}
 */
function parseIndexDailyText(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  const obj = JSON.parse(m[0]);
  const raw = obj && obj.data;
  if (typeof raw !== 'string') return [];
  const bars = [];
  for (const row of raw.split(';')) {
    if (!row) continue;
    const f = row.split(',');
    if (f.length < 6) continue;
    const o = Number(f[1]), h = Number(f[2]), l = Number(f[3]), c = Number(f[4]);
    if (![o, h, l, c].every(Number.isFinite) || c === 0) continue;
    bars.push({
      date: fmtDate(f[0]),
      open: o, high: h, low: l, close: c,
      volume: Number(f[5]) || 0,
      amount: f[6] != null ? Number(f[6]) || 0 : 0,
    });
  }
  return bars;
}

/**
 * Node 直连拉取某指数最近日 K。
 * @param {string} code INDEXES 的 key（'1A0001'）
 * @returns {Promise<Array<{date,open,high,low,close,volume,amount}>>}
 */
async function fetchIndexDailyBars(code) {
  const text = await fetchHtml(idxUrl(code), { timeoutMs: 12000 });
  const bars = parseIndexDailyText(text);
  if (!bars.length) throw new Error(`拉取指数 ${code} 日 K 失败（空返回）`);
  return bars;
}

/** 拉取全部大盘指数日 K → { code: bars } */
async function fetchAllIndexBars() {
  const out = {};
  for (const code of Object.keys(INDEXES)) {
    try { out[code] = await fetchIndexDailyBars(code); } catch (e) { out[code] = null; }
  }
  return out;
}

/**
 * 指数趋势摘要（纯函数，复用个股 sma/detectSR）。
 * @param {Array<{date,open,high,low,close,volume,amount}>} bars 升序
 * @returns {object|null} { date, close, ma5,ma10,ma20,ma60, maAlignment, aboveMA20,
 *   maGapPct, support, resistance, ret5Pct }（不足暖机返回 null）
 */
function summarizeIndexTrend(bars) {
  if (!Array.isArray(bars) || bars.length < 20) return null;
  const closes = bars.map(b => b.close);
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
  const last = bars.length - 1;
  const close = closes[last];
  const g = arr => (arr[last] != null ? Number(arr[last].toFixed(2)) : null);
  const a5 = g(ma5), a10 = g(ma10), a20 = g(ma20), a60 = g(ma60);
  let maAlignment = '交叉/缠绕';
  if (a5 != null && a10 != null && a20 != null && a60 != null) {
    if (a5 > a10 && a10 > a20 && a20 > a60) maAlignment = '多头排列';
    else if (a5 < a10 && a10 < a20 && a20 < a60) maAlignment = '空头排列';
  }
  const aboveMA20 = a20 != null && close >= a20;
  const sr = detectSR(bars);
  return {
    date: bars[last].date,
    close: Number(close.toFixed(2)),
    ma5: a5, ma10: a10, ma20: a20, ma60: a60,
    maAlignment,
    aboveMA20,
    maGapPct: a20 ? Number(((close - a20) / a20 * 100).toFixed(2)) : null, // 距 MA20（%）
    support: sr.support.length ? Number(sr.support[0].price.toFixed(2)) : null,
    resistance: sr.resistance.length ? Number(sr.resistance[0].price.toFixed(2)) : null,
    ret5Pct: bars.length > 5 ? Number(((close / closes[last - 5] - 1) * 100).toFixed(2)) : null,
  };
}

module.exports = {
  INDEXES, idxUrl, parseIndexDailyText, fetchIndexDailyBars, fetchAllIndexBars, fmtDate, summarizeIndexTrend,
};
