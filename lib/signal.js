// lib/signal.js — 信号矛盾检测 + 共振分级（纯函数，可单测）
//
// 六因子打分会把冲突吞进一个数字：如"看多但 MACD 空头 + 看跌吞没 + 波动偏高"，
// 加权后照样 63 分看多，冲突被抹平。本模块在 score.signal 之上做一层精化：
//   - 共振升级：看多 + 趋势/量能/形态共振 → 强看多；看空对称 → 强看空
//   - 矛盾降级：看多但有空头矛盾 → 看多(存疑)，并列出矛盾项
// 让"不追高、多重共振才动手"的纪律在信号层直接亮灯，而不是靠人盯因子表。
//
// 注意：保留 score.signal（看多/观望/看空）不变——命中率统计（computeOutcomes）依赖它，
// signalGrade 是附加精化字段，不破坏现有统计。

/** 归一化形态数组（容忍 {label, direction} 或 {name, label, direction}） */
function bearPatterns(patterns) {
  return Array.isArray(patterns) ? patterns.filter(p => p && p.direction === 'bear') : [];
}
function bullPatterns(patterns) {
  return Array.isArray(patterns) ? patterns.filter(p => p && p.direction === 'bull') : [];
}

/**
 * 信号分级。
 * @param {object} score - scoreBars 输出 { total, signal, factors }
 * @param {object} [ctx]
 *   { maAlignment, macdStatus, adx, patterns, kdj:{k,d}, rsi6, support, resistance, close }
 *   patterns 建议传 recentPatterns(patterns, 3)（近期形态，含 direction）
 * @returns {object} { grade, label, conflicts }
 *   grade: strong-bull | bull | bull-doubt | watch | bear | bear-doubt | strong-bear
 *   label: 强看多 | 看多 | 看多(存疑) | 观望 | 看空 | 看空(存疑) | 强看空
 */
function classifySignal(score, ctx = {}) {
  const base = score && score.signal;
  const factors = (score && score.factors) || ctx.factors || {};
  const bearish = bearPatterns(ctx.patterns).length > 0;
  const bullish = bullPatterns(ctx.patterns).length > 0;
  const macdBear = ctx.macdStatus === '空头' || ctx.macdStatus === '死叉';
  const macdBull = ctx.macdStatus === '多头' || ctx.macdStatus === '金叉';
  const trendStrong = ctx.adx != null && ctx.adx >= 25;
  const bullAlign = ctx.maAlignment === '多头排列';
  const bearAlign = ctx.maAlignment === '空头排列';
  const k = ctx.kdj && ctx.kdj.k;
  const rsi6 = ctx.rsi6;
  const overbought = (k != null && k >= 80) || (rsi6 != null && rsi6 > 75);
  const oversold = (k != null && k <= 20) || (rsi6 != null && rsi6 < 30);
  const nearRes = ctx.resistance != null && ctx.close != null && ctx.resistance > ctx.close
    && (ctx.resistance - ctx.close) / ctx.close < 0.03;
  const nearSup = ctx.support != null && ctx.close != null && ctx.support < ctx.close
    && (ctx.close - ctx.support) / ctx.close < 0.03;
  const riskLow = factors.risk != null && factors.risk < 40;

  if (base === '看多') {
    const conflicts = [];
    if (bearish) conflicts.push('含看跌形态');
    if (macdBear) conflicts.push('MACD空头');
    if (overbought && nearRes) conflicts.push('超买且近压力位（追高风险）');
    else if (overbought) conflicts.push('严重超买');
    if (riskLow) conflicts.push('波动风险偏高');
    if (conflicts.length) return { grade: 'bull-doubt', label: '看多(存疑)', conflicts };
    // 无矛盾：均线多头 + MACD非空 + ADX趋势强 + 无看跌形态 → 共振升级
    if (bullAlign && !macdBear && trendStrong && !bearish) {
      return { grade: 'strong-bull', label: '强看多', conflicts: [] };
    }
    return { grade: 'bull', label: '看多', conflicts: [] };
  }

  if (base === '看空') {
    const conflicts = [];
    if (bullish) conflicts.push('含看涨形态');
    if (macdBull) conflicts.push('MACD多头');
    if (oversold && nearSup) conflicts.push('超卖且贴支撑位（反弹风险）');
    else if (oversold) conflicts.push('严重超卖');
    if (factors.risk != null && factors.risk >= 60) conflicts.push('低波动（难深跌）');
    if (conflicts.length) return { grade: 'bear-doubt', label: '看空(存疑)', conflicts };
    if (bearAlign && macdBear && trendStrong && !bullish) {
      return { grade: 'strong-bear', label: '强看空', conflicts: [] };
    }
    return { grade: 'bear', label: '看空', conflicts: [] };
  }

  return { grade: 'watch', label: '观望', conflicts: [] };
}

module.exports = { classifySignal };
