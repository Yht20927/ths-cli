// lib/backtest.js — 简单 bar 级回测引擎（纯函数，可单测）
//
// 策略根据已算好的指标序列在 bar i 产生信号：1 买入 / -1 卖出 / 0 观望。
// 信号只用 ≤ i 的数据（无未来函数）。全仓进出，支持单边佣金。
//
// 指标：总收益 / 年化 / 最大回撤 / 胜率 / 盈亏比 / 交易次数 / 平均持仓 /
//       夏普（日收益 ×√252，年度化）。

const { sma, rsi, macd, atr } = require('./indicators');
const { scoresByBar, resonanceSeries } = require('./factor-series');

const STRATEGIES = {
  'ma-cross': {
    label: '均线交叉',
    defaultParams: { fast: 5, slow: 20 },
    describe: p => `MA${p.fast} 上穿 MA${p.slow} 买入，下穿卖出`,
  },
  rsi: {
    label: 'RSI 超买超卖',
    defaultParams: { period: 14, oversold: 30, overbought: 70 },
    describe: p => `RSI${p.period} 上穿 ${p.oversold} 买入，下穿 ${p.overbought} 卖出`,
  },
  macd: {
    label: 'MACD 金叉死叉',
    defaultParams: { fast: 12, slow: 26, signal: 9 },
    describe: () => 'DIF 上穿 DEA 买入，下穿卖出',
  },
  score: {
    label: '综合评分（实战打分）',
    defaultParams: { buy: 60, sell: 40 },
    describe: p => `评分上穿 ${p.buy} 买入、跌破 ${p.sell} 卖出（同 analyze 打分口径）`,
  },
  resonance: {
    label: '共振（评分+多头+MACD+ADX）',
    defaultParams: { scoreBuy: 60, adxMin: 25 },
    describe: p => `共振触发买卖：评分≥${p.scoreBuy}+MA多头+MACD非空头+ADX≥${p.adxMin}`,
  },
  'buy-hold': {
    label: '买入持有（基准）',
    defaultParams: {},
    describe: () => '首根买入持有到底',
  },
};

/** 生成信号序列（1 买 / -1 卖 / 0 观望），与 bars 等长 */
function makeSignals(bars, strategy, params = {}) {
  const n = bars.length;
  const closes = bars.map(b => b.close);
  const signals = new Array(n).fill(0);

  switch (strategy) {
    case 'ma-cross': {
      const { fast = 5, slow = 20 } = params;
      if (fast >= slow) throw new Error(`fast(${fast}) 必须小于 slow(${slow})`);
      const f = sma(closes, fast);
      const s = sma(closes, slow);
      for (let i = 1; i < n; i++) {
        if (f[i] == null || s[i] == null || f[i - 1] == null || s[i - 1] == null) continue;
        if (f[i] > s[i] && f[i - 1] <= s[i - 1]) signals[i] = 1;
        else if (f[i] < s[i] && f[i - 1] >= s[i - 1]) signals[i] = -1;
      }
      break;
    }
    case 'rsi': {
      const { period = 14, oversold = 30, overbought = 70 } = params;
      const r = rsi(closes, period);
      for (let i = 1; i < n; i++) {
        if (r[i] == null || r[i - 1] == null) continue;
        if (r[i - 1] <= oversold && r[i] > oversold) signals[i] = 1;
        else if (r[i - 1] >= overbought && r[i] < overbought) signals[i] = -1;
      }
      break;
    }
    case 'macd': {
      const { fast = 12, slow = 26, signal = 9 } = params;
      const m = macd(closes, fast, slow, signal);
      for (let i = 1; i < n; i++) {
        const d0 = m.dif[i - 1], e0 = m.dea[i - 1], d1 = m.dif[i], e1 = m.dea[i];
        if (d0 == null || e0 == null || d1 == null || e1 == null) continue;
        if (d1 > e1 && d0 <= e0) signals[i] = 1;
        else if (d1 < e1 && d0 >= e0) signals[i] = -1;
      }
      break;
    }
    case 'score': {
      const { buy = 60, sell = 40 } = params;
      if (buy <= sell) throw new Error(`评分策略需 buy(${buy}) > sell(${sell})，否则无法离场`);
      const sc = scoresByBar(bars);
      for (let i = 1; i < n; i++) {
        const a = sc[i - 1], b = sc[i];
        if (a == null || b == null) continue;
        if (a < buy && b >= buy) signals[i] = 1;      // 转看多 → 买
        else if (a > sell && b <= sell) signals[i] = -1; // 破看空 → 卖
      }
      break;
    }
    case 'resonance': {
      const res = resonanceSeries(bars, { scoreBuy: params.scoreBuy != null ? params.scoreBuy : 60, adxMin: params.adxMin != null ? params.adxMin : 25 });
      for (let i = 1; i < n; i++) {
        if (res[i - 1] !== false && res[i - 1] !== true) continue;
        if (!res[i - 1] && res[i]) signals[i] = 1;
        else if (res[i - 1] && !res[i]) signals[i] = -1;
      }
      break;
    }
    case 'buy-hold': {
      if (n > 0) signals[0] = 1;
      break;
    }
    default:
      throw new Error(`未知策略 "${strategy}"，可选: ${Object.keys(STRATEGIES).join('/')}`);
  }
  return signals;
}

/** 四舍五入到 d 位（null 保留） */
function r2(v, d = 2) {
  return v == null || !isFinite(v) ? null : Number(v.toFixed(d));
}

/**
 * 回测。
 * @param {Array<{open, high, low, close}>} bars 按时间升序
 * @param {string} strategy STRATEGIES 的 key
 * @param {object} [params] 策略参数（缺省取 STRATEGIES 默认）
 * @param {object} [opts]
 *   - fee:            单边佣金率(0.0005)
 *   - slippage:       单边滑点率(默认 0，如 0.001 = 千一)
 *   - stopLossAtr:    ATR 止损倍数（0 = 关闭；2 = 入场价 - 2×ATR 止损）
 *   - limitCheck:     一字板约束（true 时 high≈low 的 bar 视为无法成交，信号跳过）
 *   - periodsPerYear: 年化 bar 数（日 252 / 周 52 / 月 12）
 * @returns {object} 指标
 */
function backtest(bars, strategy, params = {}, opts = {}) {
  if (!Array.isArray(bars) || bars.length < 2) {
    throw new Error('回测需要至少 2 根 K 线');
  }
  const n = bars.length;
  const closes = bars.map(b => b.close);
  const fee = opts.fee != null ? opts.fee : 0.0005;
  const slippage = opts.slippage != null ? opts.slippage : 0;
  const stopLossAtr = opts.stopLossAtr != null ? opts.stopLossAtr : 0;
  const limitCheck = !!opts.limitCheck;

  // 一字板（无振幅）近似判定：high ≈ low
  const isLimitBar = i => {
    const b = bars[i];
    return b.high != null && b.low != null && (b.high - b.low) <= Math.abs(b.close || 0) * 1e-6;
  };

  // ATR 序列（止损用）
  const atrSeries = stopLossAtr > 0
    ? atr(bars.map(b => b.high), bars.map(b => b.low), closes, 14)
    : [];

  const signals = makeSignals(bars, strategy, { ...STRATEGIES[strategy].defaultParams, ...params });

  let cash = 1, shares = 0;      // 起始资金 1
  let position = 0;              // 0 空仓 / 1 持仓
  let entryPrice = null, entryIdx = null, entryAtr = null;
  const trades = [];
  const equity = new Array(n);
  let stopLossTriggered = 0;
  let limitSkipped = 0;

  const closeTrade = (sellIdx, sellPrice, reason = 'signal') => {
    const buyCost = entryPrice * (1 + slippage) * (1 + fee);
    const sellNet = sellPrice * (1 - slippage) * (1 - fee);
    trades.push({
      buyIdx: entryIdx, sellIdx,
      buyPrice: entryPrice, sellPrice,
      reason,
      returnPct: ((sellNet - buyCost) / buyCost) * 100,
    });
    entryPrice = null; entryIdx = null; entryAtr = null;
  };

  for (let i = 0; i < n; i++) {
    const price = closes[i];
    const sig = signals[i];

    // 持仓中：先检查 ATR 止损（跳空低开以开盘价成交）
    if (position === 1 && stopLossAtr > 0 && entryAtr != null) {
      const stop = entryPrice - stopLossAtr * entryAtr;
      if (bars[i].low != null && bars[i].low <= stop) {
        const sellPrice = Math.min(bars[i].open != null ? bars[i].open : stop, stop);
        cash = shares * sellPrice * (1 - slippage) * (1 - fee);
        shares = 0; position = 0;
        closeTrade(i, sellPrice, 'stop');
        stopLossTriggered++;
        equity[i] = cash;
        continue; // 已平仓，跳过当日信号
      }
    }

    if (sig === 1 && position === 0) {
      if (limitCheck && isLimitBar(i)) { limitSkipped++; equity[i] = cash; continue; }
      shares = (cash * (1 - fee)) / (price * (1 + slippage));
      cash = 0; position = 1; entryPrice = price; entryIdx = i;
      entryAtr = atrSeries[i] != null ? atrSeries[i] : atrSeries.find(v => v != null) || null;
    } else if (sig === -1 && position === 1) {
      if (limitCheck && isLimitBar(i)) { limitSkipped++; equity[i] = shares * price; continue; }
      cash = shares * price * (1 - slippage) * (1 - fee);
      shares = 0; position = 0;
      closeTrade(i, price);
    }
    equity[i] = position === 1 ? shares * price : cash;
  }

  // 末尾强平
  if (position === 1) {
    const lastPrice = closes[n - 1];
    cash = shares * lastPrice * (1 - slippage) * (1 - fee);
    shares = 0; position = 0;
    closeTrade(n - 1, lastPrice);
    equity[n - 1] = cash;
  }

  const finalEquity = equity[n - 1];
  const totalReturnPct = ((finalEquity - 1) / 1) * 100;

  // 年化（按 bar 数，日/周/月 K 分别近似 252/52/12 年化？统一按日频 √252，其余按 bar 频标注）
  const periodsPerYear = opts.periodsPerYear || 252;
  const annualizedReturnPct = totalReturnPct > -100
    ? ((Math.pow(finalEquity, periodsPerYear / Math.max(1, n)) - 1) * 100)
    : -100;

  // 最大回撤
  let peak = equity[0], maxDrawdownPct = 0;
  for (let i = 1; i < n; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = peak > 0 ? ((peak - equity[i]) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // 交易统计
  const wins = trades.filter(t => t.returnPct > 0);
  const losses = trades.filter(t => t.returnPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.returnPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
  const winRate = trades.length ? (wins.length / trades.length) * 100 : null;
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : null) : grossProfit / grossLoss;
  const avgHoldBars = trades.length ? trades.reduce((s, t) => s + (t.sellIdx - t.buyIdx), 0) / trades.length : null;
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : null;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : null;

  // 夏普：日收益序列
  const rets = [];
  for (let i = 1; i < n; i++) {
    if (equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }
  let sharpe = null;
  if (rets.length > 1) {
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
    const sd = Math.sqrt(variance);
    sharpe = sd === 0 ? null : (mean / sd) * Math.sqrt(periodsPerYear);
  }

  // 买入持有基准（同样计入滑点与佣金，公平对比）
  const buyCost = closes[0] * (1 + slippage) * (1 + fee);
  const sellNet = closes[n - 1] * (1 - slippage) * (1 - fee);
  const buyHoldReturnPct = ((sellNet - buyCost) / buyCost) * 100;

  return {
    strategy,
    params: { ...STRATEGIES[strategy].defaultParams, ...params },
    bars: n,
    fee,
    slippage,
    stopLossAtr,
    limitCheck,
    stopLossTriggered,
    limitSkipped,
    finalEquity: r2(finalEquity),
    totalReturnPct: r2(totalReturnPct),
    annualizedReturnPct: r2(annualizedReturnPct),
    maxDrawdownPct: r2(maxDrawdownPct),
    winRate: r2(winRate),
    profitFactor: profitFactor === Infinity ? null : r2(profitFactor),
    numTrades: trades.length,
    avgHoldBars: r2(avgHoldBars, 1),
    avgWinPct: r2(avgWinPct),
    avgLossPct: r2(avgLossPct),
    sharpe: r2(sharpe, 2),
    buyHoldReturnPct: r2(buyHoldReturnPct),
    trades,
  };
}

module.exports = { backtest, makeSignals, STRATEGIES };
