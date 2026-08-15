// lib/score.js — 多因子综合评分（纯函数，可单测）
//
// 六因子（各 0-100，按权重合成 0-100）：
//   trend(趋势) 0.25   动量(momentum) 0.20   量能(volume) 0.15
//   swing(摆动) 0.15   risk(波动风险) 0.10    pattern(形态) 0.15
// 信号：≥60 看多 / ≤40 看空 / 其余 观望。

const { analyzeBars, macd, rsi, roc, obv, atr, kdj, wr } = require('./indicators');
const { detectPatterns, recentPatterns } = require('./patterns');

const WEIGHTS = { trend: 0.25, momentum: 0.20, volume: 0.15, swing: 0.15, risk: 0.10, pattern: 0.15 };

/**
 * 归一化用户权重：校验非法值回退默认，总和归一化到 1。
 * @param {object} [userWeights] 如 { trend: 0.3, momentum: 0.3 }（可只覆盖部分）
 * @returns {object} 完整六因子权重（和为 1）
 */
function normalizeWeights(userWeights) {
  if (!userWeights || typeof userWeights !== 'object') return { ...WEIGHTS };
  const w = {};
  for (const k of Object.keys(WEIGHTS)) {
    const v = Number(userWeights[k]);
    w[k] = Number.isFinite(v) && v >= 0 ? v : WEIGHTS[k];
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...WEIGHTS };
  for (const k of Object.keys(w)) w[k] = w[k] / sum;
  return w;
}

const clamp = v => Math.max(0, Math.min(100, v));

/**
 * 对单只股票打分。
 * @param {Array<{date, open, high, low, close, volume, amount}>} bars
 * @param {object} [opts] { analysis, patterns, weights } 已算好则复用；weights 自定义六因子权重（config.score.weights）
 * @returns {object} { total, signal, factors, weights }
 */
function scoreBars(bars, opts = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('K 线数据为空，无法评分');
  }
  const weights = normalizeWeights(opts.weights);
  const n = bars.length;
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);

  const a = opts.analysis || analyzeBars(bars);
  const patterns = opts.patterns || detectPatterns(bars);

  const lastI = n - 1;
  const close = closes[lastI];

  // ── 趋势 factor ──
  let trend = 50;
  const ma5 = a.ma.ma5, ma10 = a.ma.ma10, ma20 = a.ma.ma20, ma60 = a.ma.ma60;
  const hasMa = ma5 != null && ma10 != null && ma20 != null;
  if (hasMa) {
    if (ma5 > ma10 && ma10 > ma20) trend += 12;
    else if (ma5 < ma10 && ma10 < ma20) trend -= 12;
    if (close > ma20) trend += 12; else trend -= 12;
    if (close > ma5) trend += 8; else trend -= 8;
    if (ma20 != null && ma60 != null) {
      if (ma20 > ma60) trend += 10; else trend -= 10;
    }
  }
  trend = clamp(trend);

  // ── 动量 factor ──
  let momentum = 50;
  const hist = a.macd.hist;
  const histSeries = a.macd.series && a.macd.series.hist;
  const prevHist = histSeries ? histSeries[lastI - 1] : null;
  if (hist != null) momentum += hist >= 0 ? 18 : -18;
  if (prevHist != null && hist != null) momentum += hist > prevHist ? 14 : -14;
  if (a.macd.dif != null) momentum += a.macd.dif >= 0 ? 8 : -8;
  const r14 = a.rsi.series && a.rsi.series.rsi6 ? a.rsi.series.rsi6[lastI] : null;
  if (r14 != null) {
    if (r14 >= 50 && r14 <= 70) momentum += 10;
    else if (r14 < 30) momentum -= 12;
    else if (r14 > 70) momentum -= 6;
  }
  const rocV = roc(closes, 12)[lastI];
  if (rocV != null) momentum += rocV >= 0 ? 10 : -10;
  momentum = clamp(momentum);

  // ── 量能 factor ──
  let volume = 50;
  const volRatio = a.stats.volumeRatio;
  const lastChg = lastI > 0 ? closes[lastI] - closes[lastI - 1] : 0;
  if (volRatio != null) {
    if (volRatio > 1.2) volume += lastChg > 0 ? 25 : -25;
    else if (volRatio < 0.7) volume += lastChg > 0 ? -8 : 8;
  }
  const obvS = obv(closes, volumes);
  const obvUp = lastI >= 5 && obvS[lastI] >= obvS[lastI - 5];
  volume += obvUp ? 15 : -15;
  volume = clamp(volume);

  // ── 摆动 factor（超卖反弹 / 超买回调）──
  let swing = 50;
  const k = a.kdj.k, kd = a.kdj.d;
  if (k != null) {
    if (k < 20 && kd != null && k > kd) swing += 28;      // 低位金叉
    else if (k < 20) swing += 18;
    else if (k > 80 && kd != null && k < kd) swing -= 28; // 高位死叉
    else if (k > 80) swing -= 18;
  }
  if (r14 != null) {
    if (r14 < 20) swing += 12;
    else if (r14 > 80) swing -= 12;
  }
  const wrV = wr(closes, highs, lows, 14)[lastI];
  if (wrV != null) {
    if (wrV < -80) swing += 10;
    else if (wrV > -20) swing -= 10;
  }
  swing = clamp(swing);

  // ── 波动风险 factor（低波利于持有，高波给负分）──
  let risk = 60;
  const atrSeries = atr(highs, lows, closes, 14);
  const atrV = atrSeries[lastI];
  if (atrV != null && close !== 0) {
    const atrPct = (atrV / close) * 100;
    if (atrPct > 6) risk -= 25;
    else if (atrPct > 3.5) risk -= 10;
    else if (atrPct < 1.5) risk += 10;
  }
  const bandwidth = a.boll.bandwidth;
  if (bandwidth != null) {
    if (bandwidth < 3) risk += 8;       // 布林收口 → 低波动
    else if (bandwidth > 15) risk -= 10;
  }
  risk = clamp(risk);

  // ── 形态 factor ──
  let pattern = 50;
  const recent = recentPatterns(patterns, 5);
  for (const p of recent) {
    const w = p.strength === 3 ? 10 : p.strength === 2 ? 7 : 4;
    pattern += p.direction === 'bull' ? w : -w;
  }
  pattern = clamp(pattern);

  const factors = { trend, momentum, volume, swing, risk, pattern };
  const total = Math.round(
    factors.trend * weights.trend +
    factors.momentum * weights.momentum +
    factors.volume * weights.volume +
    factors.swing * weights.swing +
    factors.risk * weights.risk +
    factors.pattern * weights.pattern
  );
  const signal = total >= 60 ? '看多' : total <= 40 ? '看空' : '观望';

  return { total, signal, factors, weights };
}

module.exports = { scoreBars, normalizeWeights, WEIGHTS };
