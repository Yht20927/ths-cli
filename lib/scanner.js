// lib/scanner.js — 选股引擎
//
// 对代码池中的每只股票：缓存感知拉 K 线 → 计算分析/形态/评分/额外序列 →
// 逐个判定条件（纯函数）。单只失败不中断，节流保护 WAF。
//
// 条件一览：
//   ma-bull 均线多头排列 | ma-cross-up MA5上穿MA20 | macd-golden MACD金叉
//   macd-bull MACD多头 | rsi-oversold 超卖 | rsi-overbought 超买
//   kdj-golden KDJ金叉 | volume-break 放量突破 | atr-range 波动区间
//   pattern 看多形态 | score-gt 评分≥N

const { analyzeBars, sma, kdj, atr } = require('./indicators');
const { detectPatterns, recentPatterns } = require('./patterns');
const { scoreBars } = require('./score');
const { loadKline } = require('./cache');
const { inferMarket } = require('./commands/helpers');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 最近 lookback 根内 A 上穿 B */
function crossedUpIn(a, b, lookback) {
  const last = a.length - 1;
  for (let i = Math.max(1, last - lookback + 1); i <= last; i++) {
    if (a[i - 1] == null || b[i - 1] == null || a[i] == null || b[i] == null) continue;
    if (a[i] > b[i] && a[i - 1] <= b[i - 1]) return true;
  }
  return false;
}

/** 最近 lookback 根内序列上穿 0 */
function crossedAboveZero(series, lookback) {
  const last = series.length - 1;
  for (let i = Math.max(1, last - lookback + 1); i <= last; i++) {
    if (series[i - 1] == null || series[i] == null) continue;
    if (series[i - 1] <= 0 && series[i] > 0) return true;
  }
  return false;
}

/** 每只股票预计算的额外序列（避免各条件重复算） */
function buildSeries(bars) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const last = bars.length - 1;
  const atrV = atr(highs, lows, closes, 14)[last];
  const kd = kdj(closes, highs, lows);
  return {
    closes, highs, lows,
    last,
    lastClose: closes[last],
    sma5: sma(closes, 5),
    sma20: sma(closes, 20),
    kdjK: kd.k,
    kdjD: kd.d,
    atrPct: atrV != null && closes[last] ? (atrV / closes[last]) * 100 : null,
  };
}

/** 条件注册表。check(r, opts) 返回 boolean 或 { matched, detail } */
const CRITERIA = {
  'ma-bull': {
    label: '均线多头排列',
    check(r) { return r.analysis.ma.alignment === '多头排列'; },
  },
  'ma-cross-up': {
    label: 'MA5上穿MA20',
    check(r, o) { return crossedUpIn(r.series.sma5, r.series.sma20, o.lookback || 5); },
  },
  'macd-golden': {
    label: 'MACD金叉',
    check(r, o) {
      const hist = r.analysis.macd.series.hist;
      return crossedAboveZero(hist, o.lookback || 5);
    },
  },
  'macd-bull': {
    label: 'MACD多头',
    check(r) { return r.analysis.macd.dif != null && r.analysis.macd.dif > 0 && r.analysis.macd.hist > 0; },
  },
  'rsi-oversold': {
    label: 'RSI超卖',
    check(r, o) { return r.analysis.rsi.rsi6 != null && r.analysis.rsi.rsi6 < (o.oversold != null ? o.oversold : 30); },
  },
  'rsi-overbought': {
    label: 'RSI超买',
    check(r, o) { return r.analysis.rsi.rsi6 != null && r.analysis.rsi.rsi6 > (o.overbought != null ? o.overbought : 70); },
  },
  'kdj-golden': {
    label: 'KDJ金叉',
    check(r, o) { return crossedUpIn(r.series.kdjK, r.series.kdjD, o.lookback || 5); },
  },
  'volume-break': {
    label: '放量突破',
    check(r, o) {
      const n = o.breakN || 20;
      const vRatio = o.volumeRatio != null ? o.volumeRatio : 1.5;
      if (r.bars.length < n + 1) return false;
      const prior = r.bars.slice(-(n + 1), -1);
      const hi = Math.max(...prior.map(b => b.high));
      const volRatio = r.analysis.stats.volumeRatio;
      if (r.series.lastClose <= hi || volRatio == null || volRatio < vRatio) return false;
      return { matched: true, detail: `量比${volRatio.toFixed(2)}` };
    },
  },
  'atr-range': {
    label: '波动区间',
    check(r, o) {
      const lo = o.atrMin != null ? o.atrMin : 1;
      const hi = o.atrMax != null ? o.atrMax : 6;
      if (r.series.atrPct == null) return false;
      const v = r.series.atrPct;
      if (v < lo || v > hi) return false;
      return { matched: true, detail: `ATR${v.toFixed(2)}%` };
    },
  },
  'pattern': {
    label: '看多形态',
    check(r, o) {
      const recent = recentPatterns(r.patterns, o.patternLookback || 5);
      const bull = recent.find(p => p.direction === 'bull');
      if (!bull) return false;
      return { matched: true, detail: bull.label };
    },
  },
  'score-gt': {
    label: '评分≥N',
    check(r, o) { return r.score.total >= (o.scoreThreshold != null ? o.scoreThreshold : 60); },
  },
};

function normalizeRes(res) {
  if (res && typeof res === 'object') return { matched: !!res.matched, detail: res.detail };
  return { matched: !!res, detail: undefined };
}

/**
 * 解析代码池。
 * @param {KlineCache} cache
 * @param {object} opts { codes: '600519,000001' | null, pool: 'watchlist'|null }
 * @returns {Array<{code, name, market}>}
 */
function resolvePoolItems(cache, opts = {}) {
  if (opts.codes) {
    return opts.codes.split(',').map(s => s.trim()).filter(Boolean).map(code => ({
      code, name: code, market: inferMarket(code) || '',
    }));
  }
  const list = cache.watchlistList();
  if (!list.length) return [];
  return list.map(w => ({ code: w.code, name: w.name || w.code, market: w.market || inferMarket(w.code) || '' }));
}

/**
 * 执行扫描。
 * @param {object} ctx - CLI 上下文
 * @param {KlineCache} cache
 * @param {Array<{code, name, market}>} items
 * @param {Array<string>} criterionNames
 * @param {object} opts { period, count, adjust, delayMs, refresh, maxAgeMs, minScore, ...条件参数 }
 * @returns {Promise<Array<object>>} 每只股票一条
 */
async function runScan(ctx, cache, items, criterionNames, opts = {}) {
  const criteria = criterionNames.map(name => {
    const c = CRITERIA[name];
    if (!c) throw new Error(`未知选股条件 "${name}"，可选: ${Object.keys(CRITERIA).join('/')}`);
    return { name, ...c };
  });

  const results = [];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const rec = { code: item.code, name: item.name || item.code };
    try {
      const params = {
        code: item.code,
        market: item.market || inferMarket(item.code) || '',
        period: opts.period || 'day',
        count: opts.count || 250,
        adjust: opts.adjust || 'forward',
      };
      if (!params.market) throw new Error('无法推断市场码，请先用 search 查询或 --codes 指定');
      const bars = await loadKline(ctx, cache, params, {
        maxAgeMs: opts.maxAgeMs,
        refresh: opts.refresh,
      });

      const analysis = analyzeBars(bars);
      const patterns = detectPatterns(bars);
      const score = scoreBars(bars, { analysis, patterns, weights: opts.weights });
      const series = buildSeries(bars);

      const matched = [];
      for (const c of criteria) {
        const res = normalizeRes(c.check({ ...rec, bars, analysis, patterns, score, series }, opts));
        if (res.matched) matched.push({ name: c.name, label: c.label, detail: res.detail });
      }

      let passed = matched.length > 0;
      if (passed && opts.minScore != null && score.total < opts.minScore) passed = false;

      Object.assign(rec, { analysis, patterns, score, matched, passed, skipped: false });
    } catch (e) {
      Object.assign(rec, { passed: false, skipped: true, error: e.message });
    }
    results.push(rec);

    if (opts.delayMs && idx < items.length - 1) await sleep(opts.delayMs);
  }
  return results;
}

module.exports = { CRITERIA, runScan, resolvePoolItems };
