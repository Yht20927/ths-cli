// lib/summary.js — 跨股对比 / analyze --compact 共用的紧凑摘要（纯函数）
//
// 只汇总关键信号，避免输出全量序列，便于横向比较多只股票。

const { analyzeBars, adx, atr } = require('./indicators');
const { detectPatterns, recentPatterns } = require('./patterns');
const { detectSR } = require('./support-resistance');
const { scoreBars } = require('./score');
const { classifySignal } = require('./signal');

const r2 = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

/**
 * 构建单只股票的紧凑摘要。
 * @param {string} code
 * @param {Array<{date, open, high, low, close, volume}>} bars
 * @param {object} [opts] { analysis, patterns, score, sr } 已算好则复用
 * @returns {object}
 */
function buildSummary(code, bars, opts = {}) {
  const analysis = opts.analysis || analyzeBars(bars);
  const patterns = opts.patterns || detectPatterns(bars);
  const score = opts.score || scoreBars(bars, { analysis, patterns, weights: opts.weights });
  const sr = opts.sr || detectSR(bars);
  const last = bars.length - 1;
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const adxR = adx(highs, lows, closes, 14);
  const atrV = atr(highs, lows, closes, 14)[last];
  const atrPct = atrV && closes[last] ? (atrV / closes[last]) * 100 : null;
  const recent = recentPatterns(patterns, 3);
  // M1-3: 信号分级（共振升级 / 矛盾降级），signalGrade 是 score.signal 的精化
  const sig = classifySignal(score, {
    maAlignment: analysis.ma.alignment,
    macdStatus: analysis.macd.status,
    adx: adxR.adx[last],
    patterns: recent,
    kdj: { k: analysis.kdj.k, d: analysis.kdj.d },
    rsi6: analysis.rsi.rsi6,
    support: sr.support[0] ? sr.support[0].price : null,
    resistance: sr.resistance[0] ? sr.resistance[0].price : null,
    close: closes[last],
  });

  return {
    code,
    close: r2(analysis.latest.close),
    date: analysis.latest.date,
    score: score.total,
    signal: score.signal,
    signalGrade: sig.grade,
    signalLabel: sig.label,
    conflicts: sig.conflicts,
    factors: score.factors,
    maAlignment: analysis.ma.alignment,
    macdStatus: analysis.macd.status,
    kdj: { k: r2(analysis.kdj.k, 1), d: r2(analysis.kdj.d, 1) },
    rsi6: r2(analysis.rsi.rsi6, 1),
    adx: r2(adxR.adx[last], 1),
    dmi: { pdi: r2(adxR.pdi[last], 1), mdi: r2(adxR.mdi[last], 1) },
    atrPct: r2(atrPct, 2),
    support: sr.support[0] ? r2(sr.support[0].price) : null,
    resistance: sr.resistance[0] ? r2(sr.resistance[0].price) : null,
    patterns: recent.map(p => p.label),
  };
}

module.exports = { buildSummary };
