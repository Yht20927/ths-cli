// lib/indicators.js — K 线技术指标纯函数（无副作用，可单测）
//
// 输入均为数组（closes / highs / lows / volumes）。所有返回数组与输入等长，
// 暖机期填充 null。sma/boll/kdj 为 O(n) 增量实现（滑动和 / 单调队列）。
//
// 指标集：
//   基础  sma / ema
//   趋势  macd / adx(dmi) / sar / roc / vwap
//   摆动  kdj / rsi / wr / cci
//   量能  obv / mfi / boll(带宽)
//   汇总  analyzeBars

// ── 基础 ──

/** 简单移动平均（O(n) 滑动和） */
function sma(values, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (i >= n) sum -= values[i - n];
    if (i < n - 1) { out.push(null); continue; }
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

/** 随机指标。返回 { k, d, j }（O(n)，单调队列维护窗口极值） */
function kdj(closes, highs, lows, n = 9) {
  const kArr = [], dArr = [], jArr = [];
  let prevK = 50, prevD = 50;
  // 单调队列存下标，队列内极值随窗口滑动保持
  const maxDq = [], minDq = [];
  let maxHead = 0, minHead = 0;
  for (let i = 0; i < closes.length; i++) {
    const winStart = Math.max(0, i - n + 1);
    while (maxHead < maxDq.length && maxDq[maxHead] < winStart) maxHead++;
    while (minHead < minDq.length && minDq[minHead] < winStart) minHead++;
    while (maxDq.length > maxHead && highs[maxDq[maxDq.length - 1]] <= highs[i]) maxDq.pop();
    maxDq.push(i);
    while (minDq.length > minHead && lows[minDq[minDq.length - 1]] >= lows[i]) minDq.pop();
    minDq.push(i);

    const hh = highs[maxDq[maxHead]];
    const ll = lows[minDq[minHead]];
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

/** 布林带。返回 { mid, up, low }（O(n)，滑动和/平方和） */
function boll(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const up = [], low = [];
  let sumX = 0, sumX2 = 0;
  for (let i = 0; i < closes.length; i++) {
    const x = closes[i];
    sumX += x;
    sumX2 += x * x;
    if (i >= n) {
      const drop = closes[i - n];
      sumX -= drop;
      sumX2 -= drop * drop;
    }
    if (i < n - 1) { up.push(null); low.push(null); continue; }
    const m = sumX / n;
    const variance = Math.max(0, sumX2 / n - m * m); // 数值保护，杜绝负方差
    const sd = Math.sqrt(variance);
    up.push(m + k * sd);
    low.push(m - k * sd);
  }
  return { mid, up, low };
}

// ── 真实波幅 ATR (Wilder) ──

/** 真实波幅：TR = max(H-L, |H-prevC|, |L-prevC|)，前 n 根简单平均，之后 Wilder 平滑 */
function atr(highs, lows, closes, n = 14) {
  const out = new Array(highs.length).fill(null);
  let sum = 0, prev = null;
  for (let i = 0; i < highs.length; i++) {
    const tr = i === 0
      ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    if (i < n - 1) { sum += tr; continue; }
    if (i === n - 1) { prev = (sum + tr) / n; out[i] = prev; continue; }
    prev = (prev * (n - 1) + tr) / n;
    out[i] = prev;
  }
  return out;
}

// ── ADX / DMI (14) ──

/** Wilder 平滑：前 n 个简单平均作种子，之后 (prev*(n-1)+v)/n */
function wilder(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0, prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (i < n - 1) { sum += v; continue; }
    if (i === n - 1) { prev = (sum + v) / n; out[i] = prev; continue; }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

/** 平滑且跳过 null 的 Wilder（ADX 对 DX 二次平滑用） */
function wilderSeeded(values, n) {
  const out = new Array(values.length).fill(null);
  const seed = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    seed.push(v);
    if (seed.length < n) continue;
    if (seed.length === n) { prev = seed.reduce((a, b) => a + b, 0) / n; out[i] = prev; continue; }
    prev = (prev * (n - 1) + v) / n;
    out[i] = prev;
  }
  return out;
}

/** 趋向指标。返回 { pdi, mdi, adx }；pdi>mdi 多头占优，ADX 高=趋势强 */
function adx(highs, lows, closes, n = 14) {
  const len = highs.length;
  const pdi = new Array(len).fill(null);
  const mdi = new Array(len).fill(null);
  const adxArr = new Array(len).fill(null);
  if (len < 2) return { pdi, mdi, adx: adxArr };

  const trA = new Array(len).fill(0);
  const pdmA = new Array(len).fill(0);
  const mdmA = new Array(len).fill(0);
  trA[0] = highs[0] - lows[0];
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    pdmA[i] = up > down && up > 0 ? up : 0;
    mdmA[i] = down > up && down > 0 ? down : 0;
    trA[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }

  const smTR = wilder(trA, n);
  const smP = wilder(pdmA, n);
  const smM = wilder(mdmA, n);

  const dxArr = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (smTR[i] == null || smTR[i] === 0) continue;
    const dp = (100 * smP[i]) / smTR[i];
    const dm = (100 * smM[i]) / smTR[i];
    pdi[i] = dp;
    mdi[i] = dm;
    const s = dp + dm;
    dxArr[i] = s === 0 ? 0 : (100 * Math.abs(dp - dm)) / s;
  }
  const adxArrOut = wilderSeeded(dxArr, n);
  for (let i = 0; i < len; i++) adxArr[i] = adxArrOut[i];
  return { pdi, mdi, adx: adxArr };
}

// ── CCI (20) ──

/** 顺势指标：(TP - SMA(TP,n)) / (0.015 × 平均绝对偏差) */
function cci(highs, lows, closes, n = 20) {
  const len = highs.length;
  const out = new Array(len).fill(null);
  if (len === 0) return out;
  const tp = new Array(len);
  for (let i = 0; i < len; i++) tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
  const tpSma = sma(tp, n);
  for (let i = 0; i < len; i++) {
    if (tpSma[i] == null) continue;
    const m = tpSma[i];
    let md = 0;
    for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m);
    md /= n;
    out[i] = md === 0 ? 0 : (tp[i] - m) / (0.015 * md);
  }
  return out;
}

// ── OBV (能量潮) ──

/** 按收盘涨跌累加成交量。obv[0] = 0 */
function obv(closes, volumes) {
  const out = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + volumes[i];
    else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - volumes[i];
    else out[i] = out[i - 1];
  }
  return out;
}

// ── WR 威廉指标 (14) ──

/** 威廉指标：(HH - C)/(HH - LL) × -100。> -20 超买，< -80 超卖 */
function wr(closes, highs, lows, n = 14) {
  const out = new Array(closes.length).fill(null);
  const maxDq = [], minDq = [];
  let maxHead = 0, minHead = 0;
  for (let i = 0; i < closes.length; i++) {
    const winStart = Math.max(0, i - n + 1);
    while (maxHead < maxDq.length && maxDq[maxHead] < winStart) maxHead++;
    while (minHead < minDq.length && minDq[minHead] < winStart) minHead++;
    while (maxDq.length > maxHead && highs[maxDq[maxDq.length - 1]] <= highs[i]) maxDq.pop();
    maxDq.push(i);
    while (minDq.length > minHead && lows[minDq[minDq.length - 1]] >= lows[i]) minDq.pop();
    minDq.push(i);
    const hh = highs[maxDq[maxHead]];
    const ll = lows[minDq[minHead]];
    out[i] = hh === ll ? -50 : ((hh - closes[i]) / (hh - ll)) * -100;
  }
  return out;
}

// ── SAR 抛物线 (0.02, 0.2) ──

/** 抛物线转向。返回数组，首个值 null；趋势翻转时 SAR 跳到前一段极值 */
function sar(highs, lows, step = 0.02, maxStep = 0.2) {
  const len = highs.length;
  const out = new Array(len).fill(null);
  if (len < 2) return out;
  let trend = 1;          // 1 多头 / -1 空头
  let ep = lows[0];       // 极值点
  let af = step;          // 加速因子
  let prevSar = lows[0];  // 初始 SAR
  for (let i = 1; i < len; i++) {
    let sarVal = prevSar + af * (ep - prevSar);
    if (trend === 1) {
      if (i >= 2) sarVal = Math.min(sarVal, lows[i - 1], lows[i - 2]);
      else sarVal = Math.min(sarVal, lows[i - 1]);
      if (lows[i] < sarVal) {
        trend = -1;
        sarVal = ep;
        ep = highs[i];
        af = step;
      } else {
        if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + step, maxStep); }
      }
    } else {
      if (i >= 2) sarVal = Math.max(sarVal, highs[i - 1], highs[i - 2]);
      else sarVal = Math.max(sarVal, highs[i - 1]);
      if (highs[i] > sarVal) {
        trend = 1;
        sarVal = ep;
        ep = lows[i];
        af = step;
      } else {
        if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + step, maxStep); }
      }
    }
    out[i] = sarVal;
    prevSar = sarVal;
  }
  return out;
}

// ── ROC 变动率 (12) ──

/** (C - C[n-1]) / C[n-1] × 100 */
function roc(closes, n = 12) {
  const out = new Array(closes.length).fill(null);
  for (let i = n; i < closes.length; i++) {
    out[i] = closes[i - n] === 0 ? null : ((closes[i] - closes[i - n]) / closes[i - n]) * 100;
  }
  return out;
}

// ── VWAP ──

/** 累计(TP×V)/累计V；TP=(H+L+C)/3 */
function vwap(highs, lows, closes, volumes) {
  const out = new Array(closes.length).fill(null);
  let cumTPV = 0, cumV = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const v = volumes[i] || 0;
    cumTPV += tp * v;
    cumV += v;
    out[i] = cumV === 0 ? null : cumTPV / cumV;
  }
  return out;
}

// ── MFI 资金流量指标 (14) ──

/** TP×V 的 RSI 式资金流；>80 超买，<20 超卖 */
function mfi(highs, lows, closes, volumes, n = 14) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  if (len === 0) return out;
  const tp = new Array(len);
  const flow = new Array(len);
  for (let i = 0; i < len; i++) {
    tp[i] = (highs[i] + lows[i] + closes[i]) / 3;
    flow[i] = tp[i] * (volumes[i] || 0);
  }
  let posSum = 0, negSum = 0;
  for (let i = 1; i < len; i++) {
    const diff = tp[i] - tp[i - 1];
    if (diff > 0) posSum += flow[i];
    else if (diff < 0) negSum += flow[i];
    if (i > n) {
      const exit = i - n;
      const ediff = tp[exit] - tp[exit - 1];
      if (ediff > 0) posSum -= flow[exit];
      else if (ediff < 0) negSum -= flow[exit];
    }
    if (i >= n) out[i] = negSum === 0 ? 100 : 100 - 100 / (1 + posSum / negSum);
  }
  return out;
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

module.exports = {
  sma, ema, macd, kdj, rsi, boll,
  atr, adx, cci, obv, wr, sar, roc, vwap, mfi,
  analyzeBars,
};
