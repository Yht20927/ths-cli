// lib/commands/analyze.js — K 线技术分析（增强版）
//
// 基础：区间统计 + MA/MACD/KDJ/RSI/BOLL
// 增强：ATR / ADX(DMI) / CCI / WR / MFI / OBV / SAR / ROC / VWAP、
//       支撑压力位、K线形态、多因子综合评分。
// 数据走本地缓存（--refresh 强制刷新）。

const { renderKV } = require('./helpers');
const {
  analyzeBars, atr, adx, cci, obv, wr, sar, roc, vwap, mfi,
} = require('../indicators');
const { detectPatterns, recentPatterns } = require('../patterns');
const { detectSR } = require('../support-resistance');
const { scoreBars } = require('../score');
const { loadKline, ttlMsForPeriod } = require('../cache');
const { parseKlineArgs } = require('./kline');

/**
 * K 线技术分析
 * @param {object} ctx
 * @param {string[]} args - [code, --period, --count, --market, --json, --refresh]
 */
async function cmdAnalyze(ctx, args) {
  const params = parseKlineArgs(args);
  const bars = await loadKline(ctx, ctx.cache, params, {
    maxAgeMs: ttlMsForPeriod(ctx.config, params.period),
    refresh: args.includes('--refresh'),
  });
  if (bars.length < 30) {
    throw new Error(`数据太少（${bars.length} 根），建议加大 --count（如 250）`);
  }

  // ── 全量计算 ──
  const a = analyzeBars(bars);
  const patterns = detectPatterns(bars);
  const score = scoreBars(bars, { analysis: a, patterns });
  const sr = detectSR(bars);
  const recent = recentPatterns(patterns, 5);

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const vols = bars.map(b => b.volume);
  const last = bars.length - 1;
  const round = (v, d = 2) => (v == null || !isFinite(v) ? null : Number(v.toFixed(d)));

  const atrS = atr(highs, lows, closes, 14);
  const adxR = adx(highs, lows, closes, 14);
  const cciS = cci(highs, lows, closes, 20);
  const wrS = wr(closes, highs, lows, 14);
  const obvS = obv(closes, vols);
  const sarS = sar(highs, lows);
  const rocS = roc(closes, 12);
  const vwapS = vwap(highs, lows, closes, vols);
  const mfiS = mfi(highs, lows, closes, vols, 14);

  const atrV = atrS[last];
  const atrPct = atrV && closes[last] ? (atrV / closes[last]) * 100 : null;
  const obvUp = obvS[last] >= obvS[Math.max(0, last - 5)];
  const sarV = sarS[last];
  const sarTrend = sarV != null ? (closes[last] >= sarV ? '看多（价在 SAR 上方）' : '看空（价在 SAR 下方）') : '-';
  const adxTrend = adxR.pdi[last] != null && adxR.mdi[last] != null
    ? (adxR.pdi[last] > adxR.mdi[last] ? '多头' : '空头') : '-';

  const enriched = {
    ...a,
    atr: { value: round(atrV), pct: round(atrPct), series: atrS },
    adx: { pdi: round(adxR.pdi[last]), mdi: round(adxR.mdi[last]), adx: round(adxR.adx[last]), trend: adxTrend, series: adxR },
    cci: { value: round(cciS[last]), series: cciS },
    wr: { value: round(wrS[last]), series: wrS },
    obv: { trend: obvUp ? '上升' : '下降', series: obvS },
    sar: { value: round(sarV), trend: sarTrend, series: sarS },
    roc: { value: round(rocS[last]), series: rocS },
    vwap: { value: round(vwapS[last]), series: vwapS },
    mfi: { value: round(mfiS[last]), series: mfiS },
    patterns: { recent, count: patterns.reduce((s, x) => s + x.length, 0) },
    supportResistance: sr,
    score,
  };

  if (args.includes('--json')) return enriched;

  const { code, period } = params;
  const sign = n => (n > 0 ? '+' : '') + n;
  const r2 = n => (n == null ? '-' : Math.round(n * 100) / 100);
  const f = score.factors;

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

  console.log('\n趋势强度 (ATR/ADX):');
  console.log(renderKV([
    { label: 'ATR14', value: `${r2(enriched.atr.value)}（${enriched.atr.pct}%）` },
    { label: 'ADX', value: enriched.adx.adx },
    { label: '+DI / -DI', value: `${enriched.adx.pdi} / ${enriched.adx.mdi}` },
    { label: 'DMI 方向', value: enriched.adx.trend },
    { label: 'SAR', value: `${r2(enriched.sar.value)} ${enriched.sar.trend}` },
  ]));

  console.log('\n量价 (OBV/CCI/WR/MFI):');
  console.log(renderKV([
    { label: 'OBV 趋势', value: enriched.obv.trend },
    { label: 'CCI20', value: enriched.cci.value },
    { label: 'WR14', value: enriched.wr.value },
    { label: 'MFI14', value: enriched.mfi.value },
    { label: 'ROC12', value: `${sign(enriched.roc.value)}%` },
  ]));

  console.log('\n支撑 / 压力:');
  const srLines = [];
  sr.support.slice(0, 2).forEach((z, i) => srLines.push({ label: `支撑${i + 1}`, value: `${r2(z.price)}（${z.hits} 次）` }));
  sr.resistance.slice(0, 2).forEach((z, i) => srLines.push({ label: `压力${i + 1}`, value: `${r2(z.price)}（${z.hits} 次）` }));
  if (!srLines.length) srLines.push({ label: '支撑/压力', value: '未检测到（数据太短）' });
  console.log(renderKV(srLines));

  console.log('\n最近形态:');
  if (recent.length) {
    console.log(renderKV(recent.map(p => ({
      label: p.label,
      value: (p.direction === 'bull' ? '▲ 看多' : '▼ 看空') + ` 强度 ${p.strength}`,
    }))));
  } else {
    console.log('  无显著形态');
  }

  console.log('\n综合评分:');
  console.log(renderKV([
    { label: '评分', value: `${score.total}/100（${score.signal}）` },
    { label: '趋势/动量', value: `${f.trend} / ${f.momentum}` },
    { label: '量能/摆动', value: `${f.volume} / ${f.swing}` },
    { label: '波动/形态', value: `${f.risk} / ${f.pattern}` },
  ]));
  console.log('');
  return undefined;
}

module.exports = cmdAnalyze;
