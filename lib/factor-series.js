// lib/factor-series.js — 逐 bar 综合因子/共振序列（纯函数，可单测）
//
// 现状：scoreBars / analyzeBars 只给"末根"打分与合成状态；本模块把核心组合
// 还原成整段因果序列，供回测"实战打分/共振"策略使用（无前视：每根只用 ≤i 数据）。
//
// - scoresByBar: 每根 i 对 bars[0..i] 跑一次 scoreBars —— O(n²) 但 n≤500 可接受
//   （scoreBars 内部会重建 analyzeBars+detectPatterns，逐根累积成本高，属取舍）。
// - resonanceSeries: 照抄学习回路"共振"定义（lib/daily-review.js resonanceOf）：
//   评分≥scoreBuy(60) && MA 多头排列(5>10>20>60) && MACD 非空头 && ADX≥adxMin(25)。
//   不含支撑压力/KDJ/RSI/形态（与命中率桶口径一致，可跨回测↔复盘对照）。

const { sma, macd, adx } = require('./indicators');
const { scoreBars } = require('./score');

/** 每根 bar 的综合评分（null = 不足暖机/算不出） */
function scoresByBar(bars, weights) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let total = null;
    try {
      const s = scoreBars(bars.slice(0, i + 1), weights ? { weights } : {});
      if (s && typeof s.total === 'number' && Number.isFinite(s.total)) total = s.total;
    } catch (e) { total = null; }
    out[i] = total;
  }
  return out;
}

/** MA 多头排列(5>10>20>60)逐根布尔 */
function maBullSeries(bars) {
  const closes = bars.map(b => b.close);
  const a5 = sma(closes, 5), a10 = sma(closes, 10), a20 = sma(closes, 20), a60 = sma(closes, 60);
  const n = bars.length;
  const out = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (a5[i] == null || a10[i] == null || a20[i] == null || a60[i] == null) continue;
    out[i] = a5[i] > a10[i] && a10[i] > a20[i] && a20[i] > a60[i];
  }
  return out;
}

/**
 * MACD "非空头"(≠'空头'，含金叉/死叉/多头，与 daily-review 口径一致)逐根布尔。
 * status 还原自 analyzeBars 的判定公式。
 */
function macdNotBearSeries(bars) {
  const closes = bars.map(b => b.close);
  const m = macd(closes, 12, 26, 9);
  const { dif, dea, hist } = m;
  const n = bars.length;
  const out = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    const h = hist[i], d = dif[i], prevH = i > 0 ? hist[i - 1] : null;
    if (h == null || d == null) continue;
    let status;
    if (prevH != null && prevH <= 0 && h > 0) status = '金叉';
    else if (prevH != null && prevH >= 0 && h < 0) status = '死叉';
    else status = d >= 0 ? '多头' : '空头';
    out[i] = status !== '空头';
  }
  return out;
}

/** ADX≥min 逐根布尔 */
function adxStrongSeries(bars, min = 25) {
  const n = bars.length;
  const out = new Array(n).fill(false);
  const adxArr = adx(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14).adx;
  for (let i = 0; i < n; i++) {
    if (adxArr[i] != null && adxArr[i] >= min) out[i] = true;
  }
  return out;
}

/**
 * 共振逐根布尔序列。
 * @param {Array<{date,open,high,low,close,volume}>} bars
 * @param {object} [params] { scoreBuy=60, adxMin=25 }
 * @returns {Array<boolean>}
 */
function resonanceSeries(bars, params = {}) {
  const { scoreBuy = 60, adxMin = 25 } = params;
  const scores = scoresByBar(bars);
  const bull = maBullSeries(bars);
  const macdOk = macdNotBearSeries(bars);
  const strong = adxStrongSeries(bars, adxMin);
  const n = bars.length;
  const out = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    out[i] = !!(scores[i] != null && scores[i] >= scoreBuy && bull[i] && macdOk[i] && strong[i]);
  }
  return out;
}

module.exports = { scoresByBar, resonanceSeries, maBullSeries, macdNotBearSeries, adxStrongSeries };
