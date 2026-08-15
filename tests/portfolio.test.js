// tests/portfolio.test.js — 持仓台账逻辑（applyTrade / summarize / summary）
import { describe, it, expect } from 'vitest';
import { applyTrade, summarizePosition, portfolioSummary } from '../lib/portfolio';

describe('applyTrade 建仓/加仓/减仓', () => {
  it('首笔买入建立持仓', () => {
    const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 1300, date: '2026-01-01' });
    expect(p.qty).toBe(100);
    expect(p.avgCost).toBe(1300);
    expect(p.realizedPnl).toBe(0);
    expect(p.trades.length).toBe(1);
  });

  it('加仓按摊薄成本', () => {
    const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 1000 });
    const p2 = applyTrade(p, { action: 'buy', qty: 100, price: 1100 });
    expect(p2.qty).toBe(200);
    expect(p2.avgCost).toBe(1050);
    expect(p2.trades.length).toBe(2);
  });

  it('卖出计算已实现盈亏', () => {
    const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 1000 });
    const p2 = applyTrade(p, { action: 'sell', qty: 40, price: 1200, fee: 5 });
    expect(p2.qty).toBe(60);
    expect(p2.realizedPnl).toBeCloseTo((1200 - 1000) * 40 - 5, 5);
  });

  it('部分卖出不改变摊薄成本', () => {
    const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 1000 });
    const p2 = applyTrade(p, { action: 'sell', qty: 50, price: 900 });
    expect(p2.qty).toBe(50);
    expect(p2.avgCost).toBe(1000);
  });

  it('清仓后 qty=0 保留流水与已实现', () => {
    const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 10 });
    const p2 = applyTrade(p, { action: 'sell', qty: 100, price: 12 });
    expect(p2.qty).toBe(0);
    expect(p2.realizedPnl).toBe(200);
    expect(p2.trades.length).toBe(2);
  });

  it('校验非法输入', () => {
    expect(() => applyTrade(null, { action: 'buy', qty: 0, price: 10 })).toThrow(/数量/);
    expect(() => applyTrade(null, { action: 'buy', qty: 100, price: 0 })).toThrow(/价格/);
    expect(() => applyTrade(null, { action: 'hold', qty: 1, price: 1 })).toThrow(/未知操作/);
    expect(() => applyTrade(null, { action: 'sell', qty: 1, price: 1 })).toThrow(/未持有/);
    const p = applyTrade(null, { code: 'x', action: 'buy', qty: 10, price: 10 });
    expect(() => applyTrade(p, { action: 'sell', qty: 999, price: 10 })).toThrow(/超过持仓/);
  });
});

describe('summarizePosition / portfolioSummary', () => {
  const p = applyTrade(null, { code: '600519', action: 'buy', qty: 100, price: 1000 });
  it('给定现价计算浮动盈亏', () => {
    const s = summarizePosition(p, { price: 1100, pct: 5 });
    expect(s.marketValue).toBe(110000);
    expect(s.floatPnl).toBe(10000);
    expect(s.floatPct).toBeCloseTo(10, 5);
    expect(s.pct).toBe(5);
  });
  it('无行情时用成本价（浮盈 0）', () => {
    const s = summarizePosition(p);
    expect(s.floatPnl).toBe(0);
    expect(s.price).toBe(1000);
  });
  it('组合汇总', () => {
    const a = summarizePosition(applyTrade(null, { code: 'a', action: 'buy', qty: 10, price: 100 }), { price: 110 });
    const b = summarizePosition(applyTrade(null, { code: 'b', action: 'buy', qty: 10, price: 100 }), { price: 90 });
    const t = portfolioSummary([a, b]);
    expect(t.marketValue).toBe(2000);
    expect(t.cost).toBe(2000);
    expect(t.floatPnl).toBe(0);
    expect(t.floatPct).toBe(0);
  });
});
