// tests/patterns.test.js — K 线形态识别

import { describe, it, expect } from 'vitest';
import { detectPatterns, recentPatterns } from '../lib/patterns.js';

const names = (arr, i) => (arr[i] || []).map(p => p.name);
const has = (arr, i, name) => names(arr, i).includes(name);

describe('单根形态', () => {
  it('下跌趋势中的锤子线', () => {
    const bars = [];
    for (let i = 0; i < 6; i++) bars.push({ open: 100 - i, close: 99 - i, high: 101 - i, low: 98 - i });
    bars.push({ open: 93, close: 94, high: 94.5, low: 90 }); // 锤子
    const p = detectPatterns(bars);
    const hit = p[bars.length - 1].find(x => x.name === 'hammer');
    expect(hit).toBeTruthy();
    expect(hit.direction).toBe('bull');
  });

  it('上涨趋势中的上吊线', () => {
    const bars = [];
    for (let i = 0; i < 6; i++) bars.push({ open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i });
    bars.push({ open: 106, close: 107, high: 107.5, low: 103 }); // 上吊
    const p = detectPatterns(bars);
    expect(p[bars.length - 1].some(x => x.name === 'hanging-man' && x.direction === 'bear')).toBe(true);
  });

  it('十字星', () => {
    const bars = Array.from({ length: 6 }, (_, i) => ({ open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i }));
    bars.push({ open: 106, close: 106, high: 107, low: 105 });
    const p = detectPatterns(bars);
    expect(has(p, bars.length - 1, 'doji')).toBe(true);
  });

  it('大阳线（实体占比高 + 振幅大）', () => {
    const bars = Array.from({ length: 6 }, (_, i) => ({ open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i }));
    bars.push({ open: 100, close: 112, high: 113, low: 99 }); // 振幅 14 vs 均价 ~4 → 大阳
    const p = detectPatterns(bars);
    expect(has(p, bars.length - 1, 'big-bull')).toBe(true);
  });
});

describe('多根形态', () => {
  it('看涨吞没', () => {
    const bars = [
      { open: 98, close: 99, high: 100, low: 97 },   // 前导（detectPatterns 要求 ≥3 根）
      { open: 100, close: 95, high: 101, low: 94 },  // 前一根大阴
      { open: 94, close: 101, high: 102, low: 93 },  // 阳线吞没阴线实体
    ];
    const p = detectPatterns(bars);
    const hit = p[2].find(x => x.name === 'bull-engulf');
    expect(hit).toBeTruthy();
    expect(hit.direction).toBe('bull');
  });

  it('看跌吞没', () => {
    const bars = [
      { open: 98, close: 99, high: 100, low: 97 },
      { open: 100, close: 105, high: 106, low: 99 },
      { open: 106, close: 99, high: 107, low: 98 },
    ];
    const p = detectPatterns(bars);
    expect(p[2].some(x => x.name === 'bear-engulf' && x.direction === 'bear')).toBe(true);
  });

  it('早晨之星（3 根）', () => {
    const bars = [
      { open: 100, close: 90, high: 101, low: 89 },  // 大阴
      { open: 91.2, close: 91.3, high: 92, low: 90.5 }, // 十字星
      { open: 92, close: 98, high: 99, low: 91 },    // 大阳收复中点
    ];
    const p = detectPatterns(bars);
    expect(p[2].some(x => x.name === 'morning-star' && x.direction === 'bull' && x.strength === 3)).toBe(true);
  });

  it('黄昏之星（3 根）', () => {
    const bars = [
      { open: 90, close: 100, high: 101, low: 89 },
      { open: 99.7, close: 99.8, high: 100.5, low: 99.3 },
      { open: 99, close: 92, high: 100, low: 91 },
    ];
    const p = detectPatterns(bars);
    expect(p[2].some(x => x.name === 'evening-star' && x.direction === 'bear')).toBe(true);
  });

  it('红三兵', () => {
    const bars = [
      { open: 90, close: 95, high: 96, low: 89 },
      { open: 95, close: 99, high: 100, low: 94 },
      { open: 99, close: 104, high: 105, low: 98 },
    ];
    const p = detectPatterns(bars);
    expect(p[2].some(x => x.name === 'three-soldiers' && x.direction === 'bull')).toBe(true);
  });

  it('三只乌鸦', () => {
    const bars = [
      { open: 104, close: 99, high: 105, low: 98 },
      { open: 99, close: 95, high: 100, low: 94 },
      { open: 95, close: 90, high: 96, low: 89 },
    ];
    const p = detectPatterns(bars);
    expect(p[2].some(x => x.name === 'three-crows' && x.direction === 'bear')).toBe(true);
  });
});

describe('recentPatterns', () => {
  it('只返回最近 N 根的非空形态', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i }));
    const p = detectPatterns(bars);
    const recent = recentPatterns(p, 5);
    for (const r of recent) expect(r.barIndex).toBeGreaterThanOrEqual(15);
    expect(Array.isArray(recent)).toBe(true);
  });
});
