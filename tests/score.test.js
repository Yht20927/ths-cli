// tests/score.test.js — 多因子综合评分

import { describe, it, expect } from 'vitest';
import { scoreBars } from '../lib/score.js';

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
