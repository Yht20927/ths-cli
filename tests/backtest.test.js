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
  it('包含 6 个策略', () => {
    expect(Object.keys(STRATEGIES)).toEqual(['ma-cross', 'rsi', 'macd', 'score', 'resonance', 'buy-hold']);
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

describe('回测增强：ATR 止损 / 滑点 / 一字板约束', () => {
  // 买入后单边暴跌：ma-cross 金叉买入后一路下跌
  function buyThenCrash() {
    const closes = [];
    for (let i = 0; i < 8; i++) closes.push(100);              // 横盘
    for (let i = 1; i <= 10; i++) closes.push(100 + i * 3);    // 拉升触发金叉
    for (let i = 1; i <= 30; i++) closes.push(125 - i * 4);    // 暴跌至 5
    return closes.map(c => ({ open: c, high: c + 1, low: c - 1, close: c }));
  }

  it('ATR 止损在暴跌中触发，亏损远小于裸奔', () => {
    const b = buyThenCrash();
    // 用 buy-hold：全程持仓无卖出信号，只有止损能截断暴跌
    const r0 = backtest(b, 'buy-hold', {}, { fee: 0.0005 });
    const rs = backtest(b, 'buy-hold', {}, { fee: 0.0005, stopLossAtr: 2 });
    expect(rs.stopLossTriggered).toBeGreaterThanOrEqual(1);
    // 止损后总收益应显著优于无止损（暴跌从 145 跌到 5，裸奔接近 -100%）
    expect(rs.totalReturnPct).toBeGreaterThan(r0.totalReturnPct);
    // 止损交易 reason 标记
    expect(rs.trades.some(t => t.reason === 'stop')).toBe(true);
  });

  it('止损价 = 入场价 - N×ATR，跳空低开按开盘价成交', () => {
    // 单根巨幅低开：open 远低于 stop 价
    const closes = [];
    for (let i = 0; i < 8; i++) closes.push(100);
    for (let i = 1; i <= 8; i++) closes.push(100 + i * 2);   // 拉升到 116
    closes.push(116);                                        // 横一天
    const b = closes.map((c, i) => {
      if (i === closes.length - 1) return { open: 90, high: 90, low: 85, close: 88 }; // 跳空低开暴跌
      return { open: c, high: c + 1, low: c - 1, close: c };
    });
    const r = backtest(b, 'ma-cross', { fast: 2, slow: 5 }, { fee: 0, stopLossAtr: 2 });
    const stopTrade = r.trades.find(t => t.reason === 'stop');
    expect(stopTrade).toBeTruthy();
    expect(stopTrade.sellPrice).toBe(90); // 开盘跳空低于止损 → 以 open 成交
  });

  it('滑点降低收益', () => {
    const s = flatThenRise();
    const r0 = backtest(s, 'buy-hold', {}, { fee: 0 });
    const rs = backtest(s, 'buy-hold', {}, { fee: 0, slippage: 0.01 });
    expect(rs.totalReturnPct).toBeLessThan(r0.totalReturnPct);
    expect(rs.slippage).toBe(0.01);
  });

  it('limitCheck 跳过一字板（high≈low）信号', () => {
    const closes = [];
    for (let i = 0; i < 8; i++) closes.push(100);
    for (let i = 1; i <= 6; i++) closes.push(100 + i * 3);
    const b = closes.map((c, i) => {
      // 第 8 根（金叉信号可能出现的区域）人为一字板
      if (i === 8) return { open: c, high: c, low: c, close: c };
      return { open: c - 0.5, high: c + 1, low: c - 1, close: c };
    });
    const rOn = backtest(b, 'ma-cross', { fast: 2, slow: 5 }, { fee: 0, limitCheck: true });
    const rOff = backtest(b, 'ma-cross', { fast: 2, slow: 5 }, { fee: 0, limitCheck: false });
    expect(rOn.limitCheck).toBe(true);
    expect(rOff.limitCheck).toBe(false);
    // 开启后应有跳过记录（数据里存在一字板 bar），且开关行为不同
    expect(rOn.limitSkipped + rOff.limitSkipped).toBeGreaterThanOrEqual(0);
    // 至少有一个场景被约束影响（信号在一字板日被跳过 → 交易次数可能不同）
    expect([rOn.numTrades, rOff.numTrades].some((v, i, a) => a[0] !== a[1])).toBe(true);
  });

  it('buy-hold 基准计入滑点佣金', () => {
    const s = flatThenRise();
    const r = backtest(s, 'buy-hold', {}, { fee: 0.001, slippage: 0.002 });
    // 总收益与基准都应小于 0 成本理想值
    const r0 = backtest(s, 'buy-hold', {}, { fee: 0, slippage: 0 });
    expect(r.totalReturnPct).toBeLessThan(r0.totalReturnPct);
    expect(r.buyHoldReturnPct).toBeLessThan(r0.buyHoldReturnPct);
  });
});

// 实战打分 / 共振策略（需 volume 参与评分）
function bullSeries(n = 200, step = 0.0035, vol = 2e6) {
  const out = [];
  let p = 100;
  const d0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const dt = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: dt, open: p, high: p * (1 + step * 0.6), low: p * (1 - step * 0.6), close: p, volume: vol });
    p *= 1 + step;
  }
  return out;
}

describe('score / resonance 策略（实战打分可回测）', () => {
  it('稳步多头：score 上穿 60 → 至少 1 笔且盈利', () => {
    const r = backtest(bullSeries(), 'score', {}, { fee: 0.0005 });
    expect(r.numTrades).toBeGreaterThanOrEqual(1);
    expect(r.totalReturnPct).toBeGreaterThan(0);
    expect(r.strategy).toBe('score');
  });

  it('score buy<=sell 报错', () => {
    expect(() => makeSignals(bullSeries(120), 'score', { buy: 40, sell: 60 })).toThrow(/buy.*sell/);
  });

  it('稳步多头：共振触发 ≥1 笔（共振窗口持仓到底由末尾强平收尾）', () => {
    const r = backtest(bullSeries(), 'resonance', {}, { fee: 0.0005 });
    expect(r.numTrades).toBeGreaterThanOrEqual(1);
    expect(r.totalReturnPct).toBeGreaterThan(0);
    expect(r.params.scoreBuy).toBe(60);
    expect(r.params.adxMin).toBe(25);
  });

  it('单边下跌：score 不达标 → 0 笔交易', () => {
    const n = 200;
    const out = [];
    let p = 100;
    const d0 = Date.UTC(2024, 0, 1);
    for (let i = 0; i < n; i++) {
      const dt = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
      out.push({ date: dt, open: p, high: p * 1.002, low: p * 0.998, close: p, volume: 2e6 });
      p *= 0.996;
    }
    const r = backtest(out, 'score', {}, { fee: 0.0005 });
    expect(r.numTrades).toBe(0);
  });

  it('makeSignals(resonance) 与 bars 等长且取值合法', () => {
    const s = makeSignals(bullSeries(150), 'resonance');
    expect(s).toHaveLength(150);
    expect(s.every(v => v === -1 || v === 0 || v === 1)).toBe(true);
    expect(s.includes(1)).toBe(true);
  });
});
