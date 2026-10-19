// lib/commands/chart.js — 终端 K 线图
//
// 用法:
//   ths chart <code> [--period day|week|month|quarter|60min|120min]
//              [--count N(120)] [--market N] [--width N] [--json] [--refresh]
//
// 文本模式输出：价格 K 线 + MA5/MA20 + 成交量 + 日期轴。
// --json 返回原始 bars（供脚本/报告使用）。

const { getFlag, inferMarket, PERIODS, leadingPositional } = require('./helpers');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { getRenderOptions } = require('../render/output');
const { candlestickChart } = require('../render/widgets/candles');
const { fmtPrice, fmtPct } = require('../render/format');

async function cmdChart(ctx, args) {
  const code = leadingPositional(args);
  if (!code) throw new Error('用法: ths chart <code> [--period day] [--count 120] [--market N] [--json]');

  const periodKey = getFlag(args, '--period', 'day');
  const period = PERIODS[periodKey];
  if (!period) throw new Error(`未知周期 "${periodKey}"，可选: ${Object.keys(PERIODS).join('/')}`);
  const count = Math.max(10, parseInt(getFlag(args, '--count', '120'), 10) || 120);
  const market = getFlag(args, '--market', null) || inferMarket(code);
  if (!market) throw new Error('无法推断市场码，请用 --market 指定');
  const adjust = getFlag(args, '--adjust', 'forward');

  const bars = await loadKline(ctx, ctx.cache, {
    code, market, period, count, adjust,
  }, {
    maxAgeMs: ttlMsForPeriod(ctx.config, periodKey),
    refresh: args.includes('--refresh'),
    excludeForming: true,
  });
  if (!bars || !bars.length) throw new Error(`未获取到 ${code} 的 K 线数据`);

  const name = (await resolveName(ctx, ctx.cache, code)) || code;
  if (args.includes('--json')) {
    return { code, name, period: periodKey, market, adjust, count: bars.length, bars };
  }

  const ro = getRenderOptions();
  const width = ro.width || 80;
  const last = bars[bars.length - 1];
  const prev = bars.length > 1 ? bars[bars.length - 2] : null;
  const pct = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;

  const header = `${code} ${name} · ${periodKey} · 前复权 · ${bars.length} 根`;
  const line = `${header}    收盘 ${fmtPrice(last.close)}  ${pct == null ? '' : fmtPct(pct)}`;
  const chart = candlestickChart(bars, {
    width,
    height: 14,
    volumeHeight: 3,
    color: ro.color,
    theme: ro.theme,
    ascii: ro.unicode !== 'full',
    showMA: true,
  });
  console.log(line);
  console.log(chart);
  return undefined;
}

module.exports = cmdChart;
