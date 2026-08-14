// lib/indicators.js — K 线技术指标纯函数（无副作用，可单测）
//
// 输入均为收盘价数组 closes（可带 high/low/volume 用于特定指标）。
// 所有返回的数组与输入等长，暖机期填充 null。

// ── 基础 ──

/** 简单移动平均 */
function sma(values, n) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += values[j];
    out.push(sum / n);
  }
  return out;
}

/** 指数移动平均（跳过 null，首个有效值作种子） */
function ema(values, n) {
  const out = [];
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out.push(prev); continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// ── MACD (12,26,9) ──

/** 返回 { dif, dea, hist }；hist = (DIF-DEA)*2 */
function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const dea = ema(dif, signal).map((v, i) => (dif[i] == null ? null : v));
  const hist = dif.map((v, i) => (v != null && dea[i] != null ? (v - dea[i]) * 2 : null));
  return { dif, dea, hist };
}

// ── KDJ (9,3,3) ──

/** 随机指标。返回 { k, d, j } */
function kdj(closes, highs, lows, n = 9) {
  const kArr = [], dArr = [], jArr = [];
  let prevK = 50, prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - n + 1);
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    const k = (2 / 3) * prevK + (1 / 3) * rsv;
    const d = (2 / 3) * prevD + (1 / 3) * k;
    kArr.push(k);
    dArr.push(d);
    jArr.push(3 * k - 2 * d);
    prevK = k;
    prevD = d;
  }
  return { k: kArr, d: dArr, j: jArr };
}

// ── RSI (Wilder 平滑) ──

/** 相对强弱。返回数组，首元素 null。 */
function rsi(closes, n) {
  const out = [null];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = Math.max(chg, 0);
    const loss = Math.max(-chg, 0);
    if (i < n) {
      avgGain += gain;
      avgLoss += loss;
      out.push(null);
      continue;
    }
    if (i === n) {
      avgGain /= n;
      avgLoss /= n;
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
    }
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

// ── BOLL (20,2) ──

/** 布林带。返回 { mid, up, low } */
function boll(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const up = [], low = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) { up.push(null); low.push(null); continue; }
    let sum = 0;
    for (let j = i - n + 1; j <= i; j++) sum += closes[j];
    const m = sum / n;
    let variance = 0;
    for (let j = i - n + 1; j <= i; j++) variance += (closes[j] - m) ** 2;
    const sd = Math.sqrt(variance / n);
    up.push(m + k * sd);
    low.push(m - k * sd);
  }
  return { mid, up, low };
}

// ── 综合分析 ──

/**
 * 对 K 线 bars 计算全套指标。
 * @param {Array<{date, open, high, low, close, volume, amount}>} bars 按时间升序
 * @param {object} [opts]
 * @returns {object} { count, firstDate, lastDate, latest, stats, ma, macd, kdj, rsi, boll }
 */
function analyzeBars(bars, opts = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('K 线数据为空，无法分析');
  }
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const n = bars.length;
  const first = bars[0], last = bars[n - 1];

  const latest = { date: last.date, close: last.close, change: last.close - first.close };
  const rangePct = first.close !== 0 ? ((last.close - first.close) / first.close) * 100 : null;
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const rangeAmp = first.close !== 0 ? ((rangeHigh - rangeLow) / first.close) * 100 : null;
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / n;

  const lastI = n - 1;
  const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

  const MA = [5, 10, 20, 60].reduce((acc, p) => {
    const s = sma(closes, p);
    acc[`ma${p}`] = { value: round(s[lastI]), series: s };
    return acc;
  }, {});

  const m = macd(closes);
  const dif = m.dif[lastI], dea = m.dea[lastI], hist = m.hist[lastI];
  const prevHist = m.hist[lastI - 1];
  const macdStatus =
    prevHist != null && dif != null && prevHist <= 0 && hist > 0 ? '金叉'
    : prevHist != null && prevHist >= 0 && hist < 0 ? '死叉'
    : dif != null && dif >= 0 ? '多头' : dif != null ? '空头' : '-';

  const kd = kdj(closes, highs, lows);
  const k = kd.k[lastI], d = kd.d[lastI], j = kd.j[lastI];
  const kdjStatus = k >= 80 ? '超买' : k <= 20 ? '超卖' : '中性';

  const RSI = [6, 12, 24].reduce((acc, p) => {
    const r = rsi(closes, p);
    acc[`rsi${p}`] = { value: round(r[lastI]), series: r };
    return acc;
  }, {});
  const rsiStatus =
    RSI.rsi6.value != null && RSI.rsi6.value > 80 ? '超买' :
    RSI.rsi6.value != null && RSI.rsi6.value < 20 ? '超卖' : '中性';

  const b = boll(closes);
  const bollMid = b.mid[lastI], bollUp = b.up[lastI], bollLow = b.low[lastI];
  const bollBandwidth = bollMid ? ((bollUp - bollLow) / bollMid) * 100 : null;

  // 均线多空排列
  const maArr = [5, 10, 20, 60].map(p => MA[`ma${p}`].value).filter(v => v != null);
  const bullAlign = maArr.length >= 4 && maArr[0] > maArr[1] && maArr[1] > maArr[2] && maArr[2] > maArr[3];
  const bearAlign = maArr.length >= 4 && maArr[0] < maArr[1] && maArr[1] < maArr[2] && maArr[2] < maArr[3];

  return {
    count: n,
    firstDate: first.date,
    lastDate: last.date,
    latest: { date: last.date, close: last.close, change: last.close - first.close },
    stats: {
      rangePct: round(rangePct),
      rangeAmp: round(rangeAmp),
      high: rangeHigh,
      low: rangeLow,
      avgVolume,
      lastVolume: last.volume,
      volumeRatio: avgVolume ? round(last.volume / avgVolume, 2) : null,
    },
    ma: {
      ...Object.fromEntries(Object.entries(MA).map(([k, v]) => [k, v.value])),
      alignment: bullAlign ? '多头排列' : bearAlign ? '空头排列' : '交叉/缠绕',
      series: Object.fromEntries(Object.entries(MA).map(([k, v]) => [k, v.series])),
    },
    macd: { dif: round(dif), dea: round(dea), hist: round(hist), status: macdStatus, series: { dif: m.dif, dea: m.dea, hist: m.hist } },
    kdj: { k: round(k), d: round(d), j: round(j), status: kdjStatus, series: kd },
    rsi: {
      rsi6: RSI.rsi6.value, rsi12: RSI.rsi12.value, rsi24: RSI.rsi24.value,
      status: rsiStatus,
      series: { rsi6: RSI.rsi6.series, rsi12: RSI.rsi12.series, rsi24: RSI.rsi24.series },
    },
    boll: { up: round(bollUp), mid: round(bollMid), low: round(bollLow), bandwidth: round(bollBandwidth), series: b },
  };
}

module.exports = { sma, ema, macd, kdj, rsi, boll, analyzeBars };
