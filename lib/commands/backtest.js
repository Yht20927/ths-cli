// lib/commands/backtest.js — 策略回测

const { getFlag, inferMarket, renderKV, PERIODS } = require('./helpers');
const { loadKline, ttlMsForPeriod } = require('../cache');
const { backtest, STRATEGIES } = require('../backtest');

// 各周期的年度化 bar 数（近似）
const PPY = { day: 252, week: 52, month: 12, quarter: 4, '60min': 1008, '120min': 504 };

/**
 * 回测
 * @param {object} ctx
 * @param {string[]} args - <code> [--strategy ma-cross] [--fast N] [--slow N] [--period day] [--count N] [--fee 0.0005] [--json]
 */
async function cmdBacktest(ctx, args) {
  const code = args[0];
  if (!code) throw new Error('用法: ths backtest <code> [--strategy ma-cross|rsi|macd|buy-hold] [--fast N] [--slow N] [--fee 0.0005] [--json]');

  const strategy = getFlag(args, '--strategy', 'ma-cross');
  if (!STRATEGIES[strategy]) {
    throw new Error(`未知策略 "${strategy}"，可选: ${Object.keys(STRATEGIES).join('/')}`);
  }

  const period = getFlag(args, '--period', 'day');
  const params = {};
  if (strategy === 'ma-cross') {
    params.fast = Math.max(2, parseInt(getFlag(args, '--fast', 5), 10) || 5);
    params.slow = Math.max(params.fast + 1, parseInt(getFlag(args, '--slow', 20), 10) || 20);
  } else if (strategy === 'rsi') {
    params.period = Math.max(2, parseInt(getFlag(args, '--period-n', 14), 10) || 14);
    params.oversold = parseInt(getFlag(args, '--oversold', 30), 10) || 30;
    params.overbought = parseInt(getFlag(args, '--overbought', 70), 10) || 70;
  } else if (strategy === 'macd') {
    params.fast = parseInt(getFlag(args, '--fast', 12), 10) || 12;
    params.slow = parseInt(getFlag(args, '--slow', 26), 10) || 26;
    params.signal = parseInt(getFlag(args, '--signal', 9), 10) || 9;
  }

  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');
  const count = Math.max(30, parseInt(getFlag(args, '--count', 500), 10) || 500);
  const fee = getFlag(args, '--fee', null) != null ? parseFloat(getFlag(args, '--fee', '0.0005')) : 0.0005;
  const slippage = getFlag(args, '--slippage', null) != null ? parseFloat(getFlag(args, '--slippage', '0')) : 0;
  const stopLossAtr = getFlag(args, '--stop-loss', null) != null ? parseFloat(getFlag(args, '--stop-loss', '0')) : 0;
  const limitCheck = args.includes('--limit-check');
  const apiPeriod = PERIODS[period] || period;

  const bars = await loadKline(ctx, ctx.cache, {
    code, market, period: apiPeriod, count, adjust: getFlag(args, '--adjust', 'forward'),
  }, {
    maxAgeMs: ttlMsForPeriod(ctx.config, period),
    refresh: args.includes('--refresh'),
  });

  ctx.audit.startOperation('backtest', { code, market, period, strategy, params });
  const res = backtest(bars, strategy, params, { fee, slippage, stopLossAtr, limitCheck, periodsPerYear: PPY[period] || 252 });
  ctx.audit.endOperation('success', { numTrades: res.numTrades, totalReturnPct: res.totalReturnPct }, { code, strategy, res });

  if (args.includes('--json')) return res;

  const meta = STRATEGIES[strategy];
  const sign = n => (n > 0 ? '+' : '') + n;
  const vsBH = res.totalReturnPct - res.buyHoldReturnPct;
  console.log(`════ ${code} 回测（${meta.label}，${period} K，${res.bars} 根）════`);
  console.log(renderKV([
    { label: '策略', value: `${meta.describe(res.params)}` },
    { label: '总收益', value: `${sign(res.totalReturnPct)}%` },
    { label: '年化', value: `${sign(res.annualizedReturnPct)}%` },
    { label: '买入持有', value: `${sign(res.buyHoldReturnPct)}%` },
    { label: '跑赢基准', value: `${sign(Math.round(vsBH * 100) / 100)}% ${vsBH >= 0 ? '✓' : '✗（跑不赢拿着不动就别用）'}` },
    { label: '最大回撤', value: `-${res.maxDrawdownPct}%` },
    { label: '胜率', value: res.winRate != null ? `${res.winRate}%` : '-' },
    { label: '盈亏比', value: res.profitFactor != null ? res.profitFactor : (res.numTrades ? '∞' : '-') },
    { label: '交易次数', value: res.numTrades },
    { label: '平均持仓', value: res.avgHoldBars != null ? `${res.avgHoldBars} 根` : '-' },
    { label: '夏普', value: res.sharpe != null ? res.sharpe : '-' },
    { label: '成本', value: `佣金 ${res.fee * 100}‰/边${res.slippage > 0 ? ` + 滑点 ${(res.slippage * 100)}‰/边` : ''}` },
    { label: 'ATR止损', value: res.stopLossAtr > 0 ? `${res.stopLossAtr}×ATR（触发 ${res.stopLossTriggered} 次）` : '关闭(--stop-loss N 开启)' },
    { label: '一字板约束', value: res.limitCheck ? `开启（跳过 ${res.limitSkipped} 个信号）` : '关闭(--limit-check 开启)' },
  ]));
  console.log('');

  if (res.trades.length) {
    console.log(`最近 ${Math.min(res.trades.length, 10)} 笔交易:`);
    console.log(renderKV(res.trades.slice(-10).reverse().map((t, i, arr) => ({
      label: `#${arr.length - i}`,
      value: `买入 ${t.buyPrice} → 卖出 ${t.sellPrice}  ${sign(t.returnPct.toFixed(2))}%`,
    }))));
  } else {
    console.log('（无完整交易，可能信号太少，试试 --count 加大回看）');
  }
  return undefined;
}

module.exports = cmdBacktest;
