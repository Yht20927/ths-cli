// tests/portfolio-risk.test.js — 组合风险画像（纯函数，确定性数据）

import { describe, it, expect } from 'vitest';
import { computeRisk, corr } from '../lib/portfolio-risk.js';

// 从收益序列生成 closes，再包成 bars（high/low 取 close±0.5，与 ATR 测试无关）
function barsFromReturns(base, rs, k = 1) {
  const bars = [];
  let c = base;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < rs.length; i++) {
    const dt = new Date(start + i * 86400000).toISOString().slice(0, 10);
    bars.push({ date: dt, open: c, high: c + 0.5, low: c - 0.5, close: c });
    c = c * (1 + rs[i]);
  }
  // 乘 k：完全保持收益序列（等比缩放 → 日收益不变），用于构造"同涨跌"标的
  if (k !== 1) for (const b of bars) { b.close *= k; b.open *= k; b.high *= k; b.low *= k; }
  return bars;
}

const RS = Array.from({ length: 60 }, (_, i) => [0.012, -0.005, 0.003, 0.008, -0.011, 0.002][i % 6]);
const stock = (code, name, bars) => ({ code, name, bars });

describe('corr / 收益对齐', () => {
  it('等比缩放的两只 = 完全同收益，相关 = 1', () => {
    const A = barsFromReturns(100, RS);
    const B = barsFromReturns(100, RS, 2);
    const ra = A.map(b => b.close);
    const rb = B.map(b => b.close);
    const r = corr(ra.map((v, i) => i === 0 ? 0 : (A[i].close - A[i - 1].close) / A[i - 1].close), rb.map((v, i) => i === 0 ? 0 : (B[i].close - B[i - 1].close) / B[i - 1].close));
    expect(r).toBeCloseTo(1, 6);
  });
});

describe('computeRisk 组合画像', () => {
  it('两只完全相关 → 平均相关≈1、有效独立标的≈1、等权 HHI=0.5、高相关对被报', () => {
    const A = barsFromReturns(100, RS);
    const B = barsFromReturns(100, RS, 2); // 同收益
    const r = computeRisk({ stocks: [stock('A', '甲', A), stock('B', '乙', B)], n: 40 });
    expect(r.metrics.avgCorr).toBeGreaterThan(0.999);
    expect(r.metrics.effectiveBets).toBeLessThan(1.05);
    expect(r.metrics.herfindahl).toBeCloseTo(0.5, 3);
    expect(r.weights.A).toBeCloseTo(0.5, 3);
    expect(r.weights.B).toBeCloseTo(0.5, 3);
    expect(r.highCorrPairs.some(p => (p.a === 'A' && p.b === 'B') || (p.a === 'B' && p.b === 'A'))).toBe(true);
    // 等权 2 票 = 各 50% > 20% 铁律 → 应被 flag（纸面组合也提示）
    expect(r.metrics.overweight.sort()).toEqual(['A', 'B']);
  });

  it('指定权重 + maxWeight：超限单票被 flag', () => {
    const A = barsFromReturns(100, RS);
    const B = barsFromReturns(100, RS, 2);
    const C = barsFromReturns(100, RS, 3);
    const r = computeRisk({
      stocks: [stock('A', '甲', A), stock('B', '乙', B), stock('C', '丙', C)],
      weights: { A: 0.5, B: 0.3, C: 0.2 }, n: 40, maxWeight: 0.35,
    });
    expect(r.weights.A).toBeCloseTo(0.5, 3);
    expect(r.metrics.overweight).toEqual(['A']);
    expect(r.metrics.herfindahl).toBeCloseTo(0.25 + 0.09 + 0.04, 3);
  });

  it('权重未给时等权归一', () => {
    const A = barsFromReturns(100, RS);
    const B = barsFromReturns(100, RS, 2);
    const r = computeRisk({ stocks: [stock('A', '甲', A), stock('B', '乙', B)], weights: {}, n: 40 });
    expect(r.weights.A).toBeCloseTo(0.5, 3);
  });

  it('ATR%：恒定 2 元波幅(high-low=2) → ≈2/收盘', () => {
    const bars = [];
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 60; i++) {
      const dt = new Date(start + i * 86400000).toISOString().slice(0, 10);
      bars.push({ date: dt, open: 100, high: 101, low: 99, close: 100 });
    }
    const r = computeRisk({ stocks: [stock('S', '平线', bars)], n: 40 });
    expect(r.perCode.S.atrPct).toBeCloseTo(2, 1);
    expect(r.metrics.overweight).toEqual(['S']); // 单标的权重 1 > 20% 铁律
  });

  it('共同交易日对齐：B 只覆盖 A 后 30 天（模拟上市晚/停牌）仍只算交集且相关=1', () => {
    const A = barsFromReturns(100, RS);
    const B = A.map(b => ({ ...b, close: b.close * 2, open: b.open * 2, high: b.high * 2, low: b.low * 2 })).slice(30);
    const r = computeRisk({ stocks: [stock('A', '甲', A), stock('B', '乙', B)], n: 60 });
    expect(r.window.dates.length).toBeLessThanOrEqual(B.length); // 只取 B 有行情的日子
    expect(r.metrics.avgCorr).toBeGreaterThan(0.99);
  });
});
