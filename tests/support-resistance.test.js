// tests/support-resistance.test.js — 支撑 / 压力位检测

import { describe, it, expect } from 'vitest';
import { detectSR, findPivots } from '../lib/support-resistance.js';

describe('findPivots', () => {
  it('识别明显的摆动高低点', () => {
    const prices = [110, 112, 108, 106, 104, 100, 103, 107, 111, 115, 120, 125, 130, 127, 124, 121, 118, 120];
    const bars = prices.map(p => ({ date: 'd', open: p, high: p + 1, low: p - 1, close: p }));
    const { highs, lows } = findPivots(bars, 3);
    // 低点枢轴价格取 bar.low = p-1 → 99；高点取 bar.high = p+1 → 131
    expect(lows.some(p => p.price === 99)).toBe(true);
    expect(highs.some(p => p.price === 131)).toBe(true);
  });
});

describe('detectSR', () => {
  const prices = [110, 112, 108, 106, 104, 100, 103, 107, 111, 115, 120, 125, 130, 127, 124, 121, 118, 120];
  const bars = prices.map(p => ({ date: 'd', open: p, high: p + 1, low: p - 1, close: p }));

  it('支撑含 100 附近、压力含 130 附近', () => {
    const sr = detectSR(bars);
    expect(sr.support.some(z => Math.abs(z.price - 100) < 2)).toBe(true);
    expect(sr.resistance.some(z => Math.abs(z.price - 130) < 2)).toBe(true);
  });

  it('zone 带 hits 与 lastDate', () => {
    const sr = detectSR(bars);
    for (const z of [...sr.support, ...sr.resistance]) {
      expect(typeof z.price).toBe('number');
      expect(z.hits).toBeGreaterThanOrEqual(1);
      expect(typeof z.lastDate).toBe('string');
    }
  });

  it('支撑全部低于最新收盘，压力全部高于', () => {
    const sr = detectSR(bars);
    const lastClose = bars[bars.length - 1].close;
    for (const z of sr.support) expect(z.price).toBeLessThan(lastClose);
    for (const z of sr.resistance) expect(z.price).toBeGreaterThan(lastClose);
  });

  it('数据太短 → 空结果', () => {
    const short = bars.slice(0, 5);
    const sr = detectSR(short);
    expect(sr.support).toEqual([]);
    expect(sr.resistance).toEqual([]);
  });
});
