// lib/support-resistance.js — 支撑 / 压力位检测（纯函数，可单测）
//
// 方法：摆动高低点（分型枢轴，左右各 k 根极值）→ 按价格容差聚类成 zone
// → 命中次数 = 有效性权重 → 以最新收盘为界分支撑（下方）/ 压力（上方）。

const { atr } = require('./indicators');

/** 分型枢轴：返回 { highs: [{price, idx, date}], lows: [...] } */
function findPivots(bars, k = 3) {
  const highs = [], lows = [];
  const n = bars.length;
  for (let i = k; i < n - k; i++) {
    const bar = bars[i];
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ price: bar.high, idx: i, date: bar.date });
    if (isLow) lows.push({ price: bar.low, idx: i, date: bar.date });
  }
  return { highs, lows };
}

/** 聚类：按容差把相近价格的枢轴并成 zone（加权均价、命中数、最近测试） */
function cluster(pivots, tol) {
  const zones = [];
  for (const p of pivots) {
    let placed = false;
    for (const z of zones) {
      if (Math.abs(z.price - p.price) <= tol) {
        z.hits += 1;
        z.price = (z.price * (z.hits - 1) + p.price) / z.hits;
        if (p.idx > z.lastIdx) { z.lastIdx = p.idx; z.lastDate = p.date; }
        placed = true;
        break;
      }
    }
    if (!placed) {
      zones.push({ price: p.price, hits: 1, lastIdx: p.idx, lastDate: p.date });
    }
  }
  return zones;
}

/**
 * 检测支撑 / 压力位。
 * @param {Array<{date, high, low, close}>} bars 按时间升序
 * @param {object} [opts] { k: 分型半宽(3), tolPct: 容差%(0.4), topN: 每向保留数(3) }
 * @returns {object} { support: [{price, hits, lastDate}], resistance: [...] } 距离最新价最近的排最前
 */
function detectSR(bars, opts = {}) {
  const k = opts.k || 3;
  const tolPct = opts.tolPct != null ? opts.tolPct : 0.004;
  const topN = opts.topN || 3;
  const n = bars.length;
  if (n < k * 2 + 1) return { support: [], resistance: [] };

  const { highs, lows } = findPivots(bars, k);

  // 容差自适应：价格 * tolPct 与 0.5×ATR 取大，避免高波动股把近邻全吞掉
  const atrSeries = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14);
  const atrVals = atrSeries.filter(v => v != null && isFinite(v));
  const avgATR = atrVals.length ? atrVals.reduce((a, b) => a + b, 0) / atrVals.length : 0;

  const tolAt = p => Math.max(p * tolPct, avgATR * 0.5);

  const supZones = cluster(lows, tolAt(lows.length ? lows[0].price : 0)).map(z => ({
    price: z.price, hits: z.hits, lastDate: z.lastDate, lastIdx: z.lastIdx,
  }));
  const resZones = cluster(highs, tolAt(highs.length ? highs[0].price : 0)).map(z => ({
    price: z.price, hits: z.hits, lastDate: z.lastDate, lastIdx: z.lastIdx,
  }));

  const lastClose = bars[n - 1].close;

  const support = supZones
    .filter(z => z.price < lastClose)
    .sort((a, b) => b.price - a.price)   // 距最新价近的在前（价格高）
    .slice(0, topN);
  const resistance = resZones
    .filter(z => z.price > lastClose)
    .sort((a, b) => a.price - b.price)   // 距最新价近的在前（价格低）
    .slice(0, topN);

  return { support, resistance };
}

module.exports = { detectSR, findPivots };
