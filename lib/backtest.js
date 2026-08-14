// lib/backtest.js — 简单 bar 级回测引擎（纯函数，可单测）
//
// 策略根据已算好的指标序列在 bar i 产生信号：1 买入 / -1 卖出 / 0 观望。
// 信号只用 ≤ i 的数据（无未来函数）。全仓进出，支持单边佣金。
//
// 指标：总收益 / 年化 / 最大回撤 / 胜率 / 盈亏比 / 交易次数 / 平均持仓 /
//       夏普（日收益 ×√252，年度化）。

const { sma, rsi, macd } = require('./indicators');

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
 * @param {object} [opts] { fee: 单边佣金率(0.0005) }
 * @returns {object} 指标
 */
function backtest(bars, strategy, params = {}, opts = {}) {
  if (!Array.isArray(bars) || bars.length < 2) {
    throw new Error('回测需要至少 2 根 K 线');
  }
  const n = bars.length;
  const closes = bars.map(b => b.close);
  const fee = opts.fee != null ? opts.fee : 0.0005;

  const signals = makeSignals(bars, strategy, { ...STRATEGIES[strategy].defaultParams, ...params });

  let cash = 1, shares = 0;      // 起始资金 1
  let position = 0;              // 0 空仓 / 1 持仓
  let entryPrice = null, entryIdx = null;
  const trades = [];
  const equity = new Array(n);

  const closeTrade = (sellIdx, sellPrice) => {
    const buyCost = entryPrice * (1 + fee);
    const sellNet = sellPrice * (1 - fee);
    trades.push({
      buyIdx: entryIdx, sellIdx,
      buyPrice: entryPrice, sellPrice,
      returnPct: ((sellNet - buyCost) / buyCost) * 100,
    });
    entryPrice = null; entryIdx = null;
  };

  for (let i = 0; i < n; i++) {
    const price = closes[i];
    const sig = signals[i];

    if (sig === 1 && position === 0) {
      shares = (cash * (1 - fee)) / price;
      cash = 0; position = 1; entryPrice = price; entryIdx = i;
    } else if (sig === -1 && position === 1) {
      cash = shares * price * (1 - fee);
      shares = 0; position = 0;
      closeTrade(i, price);
    }
    equity[i] = position === 1 ? shares * price : cash;
  }

  // 末尾强平
  if (position === 1) {
    const lastPrice = closes[n - 1];
    cash = shares * lastPrice * (1 - fee);
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

  // 买入持有基准
  const buyHoldReturnPct = ((closes[n - 1] * (1 - fee) - closes[0] * (1 + fee)) / (closes[0] * (1 + fee))) * 100;

  return {
    strategy,
    params: { ...STRATEGIES[strategy].defaultParams, ...params },
    bars: n,
    fee,
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
