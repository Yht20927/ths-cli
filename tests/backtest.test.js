// tests/backtest.test.js — 回测引擎

import { describe, it, expect } from 'vitest';
import { backtest, makeSignals, STRATEGIES } from '../lib/backtest.js';

const bars = closes => closes.map(c => ({ open: c, high: c, low: c, close: c }));

// 先横盘后上涨：确保均线交叉能触发买入
function flatThenRise() {
  const closes = [];
  for (let i = 0; i < 8; i++) closes.push(100);
  for (let i = 1; i <= 20; i++) closes.push(100 + i * 2.5);
  return bars(closes);
}

function sineWave() {
  const closes = [];
  let p = 100;
  // 大幅锯齿：确保 RSI 能冲过 70 / 跌破 30
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 15; i++) { p += 4; closes.push(p); }
    for (let i = 0; i < 15; i++) { p -= 4; closes.push(p); }
  }
  return bars(closes);
}

describe('STRATEGIES 注册', () => {
  it('包含 4 个策略', () => {
    expect(Object.keys(STRATEGIES)).toEqual(['ma-cross', 'rsi', 'macd', 'buy-hold']);
  });
});

describe('buy-hold', () => {
  it('上涨行情收益为正，恰好 1 笔交易', () => {
    const r = backtest(flatThenRise(), 'buy-hold', {}, { fee: 0.0005 });
    expect(r.numTrades).toBe(1);
    expect(r.totalReturnPct).toBeGreaterThan(40);
    expect(r.buyHoldReturnPct).toBeGreaterThan(40);
    expect(r.finalEquity).toBeGreaterThan(1);
  });
});

describe('ma-cross', () => {
  it('横盘转上涨 → 触发买入，收益为正', () => {
    const r = backtest(flatThenRise(), 'ma-cross', { fast: 2, slow: 5 }, { fee: 0.0005 });
    expect(r.numTrades).toBeGreaterThanOrEqual(1);
    expect(r.totalReturnPct).toBeGreaterThan(0);
  });

  it('fast >= slow 报错', () => {
    expect(() => backtest(sineWave(), 'ma-cross', { fast: 10, slow: 5 })).toThrow(/fast.*slow/);
  });
});

describe('rsi', () => {
  it('震荡序列产生交易', () => {
    const r = backtest(sineWave(), 'rsi', { period: 14 }, { fee: 0.0005 });
    expect(r.numTrades).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(r.finalEquity)).toBe(true);
  });
});

describe('指标完整性', () => {
  it('返回全部指标且数值合法', () => {
    const r = backtest(sineWave(), 'macd', {}, { fee: 0.0005 });
    for (const k of ['totalReturnPct', 'annualizedReturnPct', 'maxDrawdownPct', 'winRate', 'profitFactor', 'numTrades', 'avgHoldBars', 'sharpe', 'buyHoldReturnPct']) {
      expect(k in r).toBe(true);
    }
    expect(r.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    if (r.winRate != null) { expect(r.winRate).toBeGreaterThanOrEqual(0); expect(r.winRate).toBeLessThanOrEqual(100); }
    if (r.sharpe != null) expect(Number.isFinite(r.sharpe)).toBe(true);
  });

  it('手续费降低收益', () => {
    const s = flatThenRise();
    const r0 = backtest(s, 'buy-hold', {}, { fee: 0 });
    const r3 = backtest(s, 'buy-hold', {}, { fee: 0.003 });
    expect(r3.totalReturnPct).toBeLessThan(r0.totalReturnPct);
  });
});

describe('makeSignals', () => {
  it('信号长度与 bars 一致', () => {
    const s = makeSignals(sineWave(), 'rsi', { period: 14 });
    expect(s).toHaveLength(sineWave().length);
  });
});
