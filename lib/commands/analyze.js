// lib/commands/analyze.js — K 线技术分析

const { renderKV } = require('./helpers');
const { analyzeBars } = require('../indicators');
const { parseKlineArgs, fetchKlineBars } = require('./kline');

/**
 * K 线技术分析
 * @param {object} ctx
 * @param {string[]} args - [code, --period, --count, --market, --json]
 */
async function cmdAnalyze(ctx, args) {
  const params = parseKlineArgs(args);
  const bars = await fetchKlineBars(ctx, params);
  if (bars.length < 30) {
    throw new Error(`数据太少（${bars.length} 根），建议加大 --count（如 250）`);
  }

  const a = analyzeBars(bars);
  if (args.includes('--json')) return a;

  const { code, period } = params;
  const sign = n => (n > 0 ? '+' : '') + n;
  const r2 = n => (n == null ? '-' : Math.round(n * 100) / 100);

  console.log(`════ ${code} ${period} K线分析（${a.count} 根，${a.firstDate} ~ ${a.lastDate}）════`);
  console.log(`最新收盘: ${r2(a.latest.close)} (${a.latest.date})  区间涨跌: ${sign(r2(a.latest.change))}`);

  console.log('\n区间统计:');
  console.log(renderKV([
    { label: '区间涨跌幅', value: `${sign(a.stats.rangePct)}%` },
    { label: '区间振幅', value: `${a.stats.rangeAmp}%` },
    { label: '区间最高', value: r2(a.stats.high) },
    { label: '区间最低', value: r2(a.stats.low) },
    { label: '量能比', value: `${a.stats.volumeRatio}x（最新/平均）` },
  ]));

  console.log('\n均线 (MA):');
  console.log(renderKV([
    { label: 'MA5', value: a.ma.ma5 },
    { label: 'MA10', value: a.ma.ma10 },
    { label: 'MA20', value: a.ma.ma20 },
    { label: 'MA60', value: a.ma.ma60 },
    { label: '排列', value: a.ma.alignment },
  ]));

  console.log('\nMACD (12,26,9):');
  console.log(renderKV([
    { label: 'DIF', value: a.macd.dif },
    { label: 'DEA', value: a.macd.dea },
    { label: '柱', value: a.macd.hist },
    { label: '状态', value: a.macd.status },
  ]));

  console.log('\nKDJ (9,3,3):');
  console.log(renderKV([
    { label: 'K', value: a.kdj.k },
    { label: 'D', value: a.kdj.d },
    { label: 'J', value: a.kdj.j },
    { label: '状态', value: a.kdj.status },
  ]));

  console.log('\nRSI (6,12,24):');
  console.log(renderKV([
    { label: 'RSI6', value: a.rsi.rsi6 },
    { label: 'RSI12', value: a.rsi.rsi12 },
    { label: 'RSI24', value: a.rsi.rsi24 },
    { label: '状态', value: a.rsi.status },
  ]));

  console.log('\nBOLL (20,2):');
  console.log(renderKV([
    { label: '上轨', value: a.boll.up },
    { label: '中轨', value: a.boll.mid },
    { label: '下轨', value: a.boll.low },
    { label: '带宽', value: `${a.boll.bandwidth}%` },
  ]));
  console.log('');
  return undefined;
}

module.exports = cmdAnalyze;
