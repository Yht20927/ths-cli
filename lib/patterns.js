// lib/patterns.js — K 线形态识别（纯函数，可单测）
//
// detectPatterns(bars) → 与 bars 等长的数组，每项为该根 K 线命中的形态列表：
//   [{ name, label, direction: 'bull'|'bear', strength: 1-3 }]
//
// 单根形态：十字星 / 锤子线 / 倒锤子 / 上吊线 / 射击之星 / 大阳 / 大阴
// 多根形态：看涨/看跌吞没、孕线、早晨/黄昏之星、红三兵、三只乌鸦、
//          乌云盖顶、曙光初现

/** 实体大小 */
function bodyOf(b) { return Math.abs(b.close - b.open); }
/** 振幅 */
function rangeOf(b) { return b.high - b.low; }
function isBull(b) { return b.close >= b.open; }
function isBear(b) { return b.close < b.open; }
/** 上影 */
function upperWick(b) { return b.high - Math.max(b.open, b.close); }
/** 下影 */
function lowerWick(b) { return Math.min(b.open, b.close) - b.low; }

/** 最近 lookback 根的平均振幅（含 i） */
function avgRange(bars, i, lookback = 10) {
  let s = 0, c = 0;
  for (let j = Math.max(0, i - lookback + 1); j <= i; j++) { s += rangeOf(bars[j]); c++; }
  return c ? s / c : 0;
}

/** 最近 lookback 根的趋势：1 上行 / -1 下行 / 0 震荡（不含当前 K） */
function trendAt(bars, i, lookback = 4) {
  if (i < lookback) return 0;
  let up = 0, down = 0;
  for (let j = i - lookback; j < i; j++) {
    const a = bars[j].close, b = bars[j + 1].close;
    if (b > a) up++; else if (b < a) down++;
  }
  if (up === down) return 0;
  return up > down ? 1 : -1;
}

/** 造一条形态记录 */
function P(name, label, direction, strength) {
  return { name, label, direction, strength };
}

/**
 * 识别全部 K 线形态。
 * @param {Array<{open, high, low, close}>} bars 按时间升序
 * @param {object} [opts] { lookback, minRangePct } 调参预留
 * @returns {Array<Array<object>>}
 */
function detectPatterns(bars, opts = {}) {
  const n = bars.length;
  const out = Array.from({ length: n }, () => []);
  if (n < 3) return out;

  const minRangePct = opts.minRangePct != null ? opts.minRangePct : 0.15; // 振幅 < 均价 15% 视为微幅（十字星判定用）

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const range = rangeOf(bar);
    if (range === 0) continue;
    const body = bodyOf(bar);
    const upper = upperWick(bar);
    const lower = lowerWick(bar);
    const bodyPct = body / range;
    const avg = avgRange(bars, i, opts.lookback || 10);
    const bigBar = avg > 0 && range >= avg * 1.8;
    const trend = trendAt(bars, i, opts.lookbackTrend || 4);
    const hits = out[i];

    // ── 十字星：实体 ≤ 振幅 10%（或 ≤ 均价 15%），振幅非微幅 ──
    if (bodyPct <= 0.1 && range >= avg * minRangePct) {
      hits.push(P('doji', '十字星', trend >= 0 ? 'bull' : 'bear', 1));
    }

    // ── 锤子线 / 上吊线：实体小且贴顶，下影 ≥ 2×实体，上影很短 ──
    //    下跌中出现 = 锤子线(看涨)；上涨中出现 = 上吊线(看跌)
    if (bodyPct <= 0.35 && lower >= body * 2 && upper <= body * 0.5) {
      if (trend === -1) hits.push(P('hammer', '锤子线', 'bull', lower >= body * 3 ? 3 : 2));
      else if (trend === 1) hits.push(P('hanging-man', '上吊线', 'bear', lower >= body * 3 ? 3 : 2));
      else hits.push(P('hammer', '锤子线', 'bull', 1));
    }

    // ── 倒锤子 / 射击之星：实体小且贴底，上影 ≥ 2×实体，下影很短 ──
    if (bodyPct <= 0.35 && upper >= body * 2 && lower <= body * 0.5) {
      if (trend === -1) hits.push(P('inverted-hammer', '倒锤子', 'bull', upper >= body * 3 ? 3 : 2));
      else if (trend === 1) hits.push(P('shooting-star', '射击之星', 'bear', upper >= body * 3 ? 3 : 2));
      else hits.push(P('inverted-hammer', '倒锤子', 'bull', 1));
    }

    // ── 大阳 / 大阴：实体 ≥ 60% 振幅 且 振幅 ≥ 1.8×均价 ──
    if (bigBar && bodyPct >= 0.6) {
      if (isBull(bar)) hits.push(P('big-bull', '大阳线', 'bull', 2));
      else hits.push(P('big-bear', '大阴线', 'bear', 2));
    }

    if (i >= 1) {
      const prev = bars[i - 1];
      const prevRange = rangeOf(prev);
      if (prevRange > 0) {
        const prevBody = bodyOf(prev);
        // ── 吞没：当前实体完全包住前一根实体（带前趋方向）──
        if (isBull(bar) && isBear(prev) && bar.open <= prev.close && bar.close >= prev.open && body > prevBody) {
          hits.push(P('bull-engulf', '看涨吞没', 'bull', body >= prevBody * 1.5 ? 3 : 2));
        } else if (isBear(bar) && isBull(prev) && bar.open >= prev.close && bar.close <= prev.open && body > prevBody) {
          hits.push(P('bear-engulf', '看跌吞没', 'bear', body >= prevBody * 1.5 ? 3 : 2));
        }

        // ── 孕线：当前实体被前一根实体完全包住（且前一根实体不小）──
        const prevBodyPct = prevBody / prevRange;
        if (prevBodyPct >= 0.5) {
          if (isBear(bar) && isBull(prev) && bar.open <= prev.close && bar.close >= prev.open) {
            hits.push(P('bear-harami', '看跌孕线', 'bear', 2));
          } else if (isBull(bar) && isBear(prev) && bar.open >= prev.close && bar.close <= prev.open) {
            hits.push(P('bull-harami', '看涨孕线', 'bull', 2));
          }
        }
      }

      // ── 乌云盖顶 / 曙光初现：当前开在前一根极值之外，收过实体中点 ──
      if (isBear(bar) && isBull(prev) && bar.open > prev.high && bar.close < (prev.open + prev.close) / 2) {
        hits.push(P('dark-cloud', '乌云盖顶', 'bear', 2));
      } else if (isBull(bar) && isBear(prev) && bar.open < prev.low && bar.close > (prev.open + prev.close) / 2) {
        hits.push(P('piercing', '曙光初现', 'bull', 2));
      }
    }

    // ── 早晨之星 / 黄昏之星（3 根）──
    if (i >= 2) {
      const b2 = bars[i - 2];
      const b1 = bars[i - 1];
      const b2range = rangeOf(b2);
      const b1range = rangeOf(b1);
      if (b2range > 0 && b1range > 0) {
        const b2BodyPct = bodyOf(b2) / b2range;
        const b1BodyPct = bodyOf(b1) / b1range;
        // 早晨之星：大阴 → 小实体(星) → 大阳收复 b2 实体中点上方
        if (isBear(b2) && b2BodyPct >= 0.5 && b1BodyPct <= 0.2
            && isBull(bar) && bar.close > (b2.open + b2.close) / 2) {
          hits.push(P('morning-star', '早晨之星', 'bull', 3));
        }
        // 黄昏之星：大阳 → 小实体(星) → 大阴跌破 b2 实体中点下方
        if (isBull(b2) && b2BodyPct >= 0.5 && b1BodyPct <= 0.2
            && isBear(bar) && bar.close < (b2.open + b2.close) / 2) {
          hits.push(P('evening-star', '黄昏之星', 'bear', 3));
        }
      }

      // ── 红三兵 / 三只乌鸦（连续 3 根同向，收盘步步新高/新低）──
      if (i >= 2) {
        const a = bars[i - 2], b = bars[i - 1], c = bar;
        if (isBull(a) && isBull(b) && isBull(c)
            && a.close < b.close && b.close < c.close
            && b.open >= a.open && c.open >= b.open) {
          hits.push(P('three-soldiers', '红三兵', 'bull', 2));
        }
        if (isBear(a) && isBear(b) && isBear(c)
            && a.close > b.close && b.close > c.close
            && b.open <= a.open && c.open <= b.open) {
          hits.push(P('three-crows', '三只乌鸦', 'bear', 2));
        }
      }
    }
  }
  return out;
}

/**
 * 最近 N 根的非空形态（拍平，按 bar 时间顺序），供 analyze/scan 展示。
 * @param {Array<Array<object>>} patterns detectPatterns 的输出
 * @param {number} [n=5] 最近多少根
 * @returns {Array<{barIndex, ...pattern}>}
 */
function recentPatterns(patterns, n = 5) {
  const out = [];
  const start = Math.max(0, patterns.length - n);
  for (let i = start; i < patterns.length; i++) {
    for (const p of patterns[i]) out.push({ barIndex: i, ...p });
  }
  return out;
}

module.exports = { detectPatterns, recentPatterns };
