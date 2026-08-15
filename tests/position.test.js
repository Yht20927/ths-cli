// tests/position.test.js — 仓位计算引擎（calcPosition）
import { describe, it, expect } from 'vitest';
import { calcPosition } from '../lib/position';

// 构造确定性 K 线：40 根，收盘 10→14 稳步上行，高低点围绕收盘 ±0.3
function makeBars(n = 40, start = 10) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * 0.1;
    bars.push({
      date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.05,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 10000 + i * 100,
      amount: close * (10000 + i * 100),
    });
  }
  return bars;
}

// 带摆动底部的数据：前 70 根在 9.85~10.15 窄幅震荡（摆动低点 ≈9.7），后 10 根突破到 ≈11
// 场景 = "平台震荡后放量突破"：最近支撑 9.7 距现价 11 超过 2×ATR，支撑应优先于 ATR 止损
function makeSwingBars() {
  const bars = [];
  for (let i = 0; i < 70; i++) {
    const close = 10 + Math.sin(i / 3) * 0.1;
    bars.push({
      date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.05,
      high: close + 0.15,
      low: close - 0.15,
      close,
      volume: 10000 + i * 100,
      amount: close * (10000 + i * 100),
    });
  }
  for (let i = 0; i < 10; i++) {
    const close = 10.2 + i * 0.08;
    bars.push({
      date: `2025-02-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.05,
      high: close + 0.15,
      low: close - 0.15,
      close,
      volume: 20000 + i * 100,
      amount: close * (20000 + i * 100),
    });
  }
  return bars;
}

describe('calcPosition 仓位计算', () => {
  it('按 ATR×2 止损距离反推仓位：risk / 止损距离%', () => {
    const bars = makeBars();
    const r = calcPosition(bars, { risk: 10000 });
    // 止损距离 = 2 × ATR%，仓位 = 10000 / (止损距离%)
    expect(r.feasible).toBe(true);
    expect(r.stopSource).toBe('ATR');
    expect(r.stopPrice).toBeLessThan(r.price);
    expect(r.stopDistPct).toBeCloseTo(r.atrPct * 2, 5);
    expect(r.riskPerShare).toBeCloseTo(r.price - r.stopPrice, 5);
    // 仓位金额按手取整后 ≤ 目标仓位，且整百股
    expect(r.shares % 100).toBe(0);
    expect(r.positionValue).toBeLessThanOrEqual(10000 / (r.stopDistPct / 100));
    // 止损后实际亏损 ≈ 目标止损额
    const actualLoss = r.shares * r.riskPerShare;
    expect(actualLoss).toBeLessThanOrEqual(10000);
  });

  it('手动止损价优先于 ATR', () => {
    const bars = makeBars();
    const r = calcPosition(bars, { risk: 10000, stop: 11 });
    expect(r.stopSource).toBe('手动');
    expect(r.stopPrice).toBe(11);
  });

  it('支撑位比 ATR 止损更远时采用支撑位（平台突破场景）', () => {
    const bars = makeSwingBars();
    const r = calcPosition(bars, { risk: 10000, atrMult: 2 });
    expect(r.stopSource).toBe('支撑位');
    expect(r.stopPrice).toBeLessThan(r.price);
    expect(r.stopPrice).toBeGreaterThan(8); // 支撑在平台底部 ≈9.7 附近
  });

  it('支撑位贴着现价时取 ATR 止损（避免扫损，SKILL 陷阱 6）', () => {
    // 平滑上行：摆动低点几乎贴着现价，ATR 止损更远 → 应取 ATR
    const bars = makeBars(80, 10); // 收盘 10→18，摆动低点贴现值
    const r = calcPosition(bars, { risk: 10000, atrMult: 2 });
    expect(r.stopSource).toBe('ATR');
    expect(r.stopPrice).toBeCloseTo(r.price - r.atrValue * 2, 5);
  });

  it('--capital 输出占总资金比例', () => {
    const bars = makeBars();
    const r = calcPosition(bars, { risk: 10000, capital: 100000 });
    expect(r.capitalPct).not.toBeNull();
    expect(r.capitalPct).toBeCloseTo((r.positionValue / 100000) * 100, 5);
  });

  it('止损价高于现价 → 不可行并警告', () => {
    const bars = makeBars();
    const r = calcPosition(bars, { risk: 10000, stop: 999 });
    expect(r.feasible).toBe(false);
    expect(r.warning).toContain('无风险空间');
  });

  it('risk 缺失或非法抛错', () => {
    const bars = makeBars();
    expect(() => calcPosition(bars, {})).toThrow(/--risk/);
    expect(() => calcPosition(bars, { risk: -5 })).toThrow(/--risk/);
  });

  it('空数据抛错', () => {
    expect(() => calcPosition([], { risk: 10000 })).toThrow(/为空/);
  });
});
