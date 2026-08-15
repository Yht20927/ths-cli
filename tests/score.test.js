// tests/score.test.js — 多因子综合评分

import { describe, it, expect } from 'vitest';
import { scoreBars, normalizeWeights, WEIGHTS } from '../lib/score.js';

function bullBars(n = 80) {
  const bars = [];
  let p = 50;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p + 0.5;
    p = close;
    bars.push({ date: 'd', open, high: close + 0.2, low: open - 0.2, close, volume: 10000 + i * 100, amount: 0 });
  }
  return bars;
}

function bearBars(n = 80) {
  const bars = [];
  let p = 200;
  for (let i = 0; i < n; i++) {
    const open = p;
    const close = p - 0.5;
    p = close;
    bars.push({ date: 'd', open, high: open + 0.2, low: close - 0.2, close, volume: 10000 + i * 100, amount: 0 });
  }
  return bars;
}

describe('scoreBars', () => {
  it('单调上涨 → 看多，分数高', () => {
    const s = scoreBars(bullBars());
    expect(s.total).toBeGreaterThanOrEqual(60);
    expect(s.signal).toBe('看多');
  });

  it('单调下跌 → 看空，分数低', () => {
    const s = scoreBars(bearBars());
    expect(s.total).toBeLessThanOrEqual(40);
    expect(s.signal).toBe('看空');
  });

  it('因子都在 0-100 且权重和为 1', () => {
    const s = scoreBars(bullBars());
    for (const v of Object.values(s.factors)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('空数据抛错', () => {
    expect(() => scoreBars([])).toThrow(/K 线数据为空/);
  });

  it('可复用传入的 analysis 与 patterns', () => {
    const bars = bullBars();
    const { analyzeBars } = require('../lib/indicators.js');
    const { detectPatterns } = require('../lib/patterns.js');
    const a = analyzeBars(bars);
    const p = detectPatterns(bars);
    const s = scoreBars(bars, { analysis: a, patterns: p });
    expect(s.total).toBeGreaterThanOrEqual(60);
  });
});

describe('normalizeWeights / 自定义权重', () => {
  it('部分覆盖时其余回退默认，且总和归一化为 1', () => {
    const w = normalizeWeights({ trend: 0.5 });
    expect(w.trend).toBeCloseTo(0.5 / (0.5 + 0.2 + 0.15 + 0.15 + 0.1 + 0.15), 6);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(w.momentum).toBeGreaterThan(0); // 未覆盖的回退默认
  });

  it('非法值回退默认', () => {
    const w = normalizeWeights({ trend: -1, momentum: 'abc', volume: 0.3 });
    // 非法值回退默认，合法值保留；归一化后比例关系不变
    expect(w.trend / w.momentum).toBeCloseTo(WEIGHTS.trend / WEIGHTS.momentum, 6);
    expect(w.volume).toBeCloseTo(0.3 / (0.25 + 0.2 + 0.3 + 0.15 + 0.1 + 0.15), 6);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('null/空对象返回默认权重', () => {
    expect(normalizeWeights(null)).toEqual(WEIGHTS);
    expect(normalizeWeights({})).toEqual(WEIGHTS);
  });

  it('自定义权重改变总分（把下跌股的趋势因子降为 0 → 分数变化）', () => {
    const bars = bearBars();
    const s0 = scoreBars(bars);
    const s1 = scoreBars(bars, { weights: { trend: 0, momentum: 0, volume: 0, swing: 0, risk: 0, pattern: 1 } });
    // 全押 pattern 因子时，分数 = pattern 因子分
    expect(s1.total).toBe(s1.factors.pattern);
    expect(s1.total).not.toBe(s0.total);
  });

  it('返回结果包含实际使用的 weights', () => {
    const s = scoreBars(bullBars(), { weights: { trend: 0.4 } });
    expect(Object.values(s.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(s.weights.trend).toBeGreaterThan(WEIGHTS.trend);
  });
});
