// lib/commands/report.js — 静态研究报告（Markdown / HTML / JSON）
//
// 用法:
//   ths report daily [--date YYYY-MM-DD] [--since N(90)] [--min-n N(5)]
//                    [--format md|html|json] [--out FILE]
//   ths report review [--since N(90)] [--min-n N(5)]
//                     [--format md|html|json] [--out FILE]
//
// 数据全部来自本地快照/台账，不联网。--out 由 cli.js 统一捕获 stdout。

const path = require('path');
const { getFlag, inferMarket, isBoardIndex } = require('./helpers');
const { parseKlineArgs } = require('./kline');
const { DailyStore } = require('../daily-store');
const { computeStats, BUCKETS } = require('../daily-review');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { backtest, STRATEGIES } = require('../backtest');
const { computeRisk } = require('../portfolio-risk');
const { summarizePosition, portfolioSummary } = require('../portfolio');
const { toBeijingClock } = require('../trading-hours');
const { getOutputOptions } = require('../render/output');
const { fmtPrice, fmtPct, fmtMoney, fmtDateTime } = require('../render/format');
const { renderHtml } = require('../report/html');
const { renderMarkdown } = require('../report/markdown');

const BUCKET_LABEL = {
  signal: '信号', scoreBand: '评分', ma: '均线', marketMood: '市场',
  boardMood: '板块', fundDir: '资金', lhbJoin: '龙虎榜',
  macdDir: 'MACD', kdjRegime: 'KDJ', rsiRegime: 'RSI6', adxRegime: 'ADX',
  atrRegime: 'ATR%', patternDir: '形态', resonance: '共振',
  signalGrade: '信号分级', boardLeader: '龙头', dirResonance: '方向共振',
};

function today() { return toBeijingClock().dateStr; }
function daysAgo(n) { return toBeijingClock(Date.now() - n * 86400000).dateStr; }

async function cmdReport(ctx, args) {
  const sub = (args[0] || 'help').toLowerCase();
  switch (sub) {
    case 'daily': return reportDaily(ctx, args.slice(1));
    case 'review': return reportReview(ctx, args.slice(1));
    case 'backtest': return reportBacktest(ctx, args.slice(1));
    case 'risk': return reportRisk(ctx, args.slice(1));
    case 'portfolio': return reportPortfolio(ctx, args.slice(1));
    case 'help':
    case '-h':
    case '--help':
      console.log(`ths report 用法:
  report daily [--date YYYY-MM-DD] [--since N(90)] [--min-n N(5)] [--format md|html|json] [--out FILE]
  report review [--since N(90)] [--min-n N(5)] [--format md|html|json] [--out FILE]
  report backtest <code> --strategy ma-cross|rsi|macd|score|resonance|buy-hold
         [--period day] [--count 500] [--fee X] [--slippage X] [--stop-loss N] [--limit-check]
  report risk [--codes a,b | --pool watchlist] [--count 120] [--weights A=0.5,B=0.3]
  report portfolio [--offline] [--format md|html|json] [--out FILE]

  示例:
    ths report daily --format html --out reports/daily.html
    ths report review --since 90 --format md --out reports/review.md
    ths report backtest 600519 --strategy score --format html --out reports/bt.html
    ths report risk --pool watchlist --format html --out reports/risk.html
    ths report portfolio --format html --out reports/portfolio.html
    ths report daily --format json | jq .`);
      return undefined;
    default:
      throw new Error(`未知子命令 "${sub}"，可用: daily/review/help`);
  }
}

// ── daily ───────────────────────────────────────────────────

async function reportDaily(ctx, args) {
  const store = makeStore(args);
  const dates = store.listDates();
  const date = getFlag(args, '--date', null) || dates[dates.length - 1];
  if (!date) throw new Error('没有每日快照。先运行 `ths daily run`。');
  const snap = store.loadSnapshotFile(date);
  if (!snap) throw new Error(`快照不存在或损坏: ${date}`);

  const sinceDays = parseInt(getFlag(args, '--since', '90'), 10) || 90;
  const minN = parseInt(getFlag(args, '--min-n', '5'), 10) || 5;
  const stats = computeStats(store.loadSnapshots({ since: daysAgo(sinceDays) }), { minN });

  const stocks = Object.values(snap.stocks || {});
  const positions = safePositions(ctx);
  const holdingRows = buildHoldingRows(positions, snap);
  const broken = holdingRows.filter(h => h.stopBroken).length;

  const warnings = [];
  if (!snap.marketEnv || !snap.marketEnv.indices) warnings.push('快照缺少指数趋势（旧快照或取数失败）');
  if (!snap.direction || !Object.keys(snap.direction).length) warnings.push('快照缺少方向环境（旧快照或取数失败）');
  if (stats.pending.n3 > 0) warnings.push(`${stats.pending.n3} 条 3 日窗口尚未闭合`);

  const report = {
    schemaVersion: 1,
    kind: 'daily',
    title: `每日监控报告 · ${date}`,
    subtitle: `自选池 ${stocks.length} 只 · 近 ${sinceDays} 日复盘 · n≥${minN}`,
    generatedAt: fmtDateTime(Date.now()),
    quality: { label: '本地快照报告', tone: warnings.length ? 'warn' : '', warnings },
    sections: [
      { type: 'tiles', title: '市场与环境', items: marketTiles(snap, broken) },
      { type: 'kv', title: '方向环境', items: directionItems(snap.direction) },
      {
        type: 'table',
        title: '自选池快照',
        columns: [
          { header: '代码', key: 'code' },
          { header: '名称', key: 'name' },
          { header: '收盘', key: 'close', align: 'r' },
          { header: '评分', key: 'score', align: 'r', tone: scoreTone },
          { header: '信号', key: 'signal' },
          { header: '均线', key: 'ma' },
          { header: 'MACD', key: 'macd' },
          { header: 'KDJ', key: 'kdj', align: 'r' },
          { header: 'RSI6', key: 'rsi6', align: 'r' },
          { header: 'ADX', key: 'adx', align: 'r' },
          { header: 'ATR%', key: 'atr', align: 'r' },
          { header: '支撑', key: 'support', align: 'r' },
          { header: '压力', key: 'resistance', align: 'r' },
          { header: '方向', key: 'dir' },
        ],
        rows: stocks.map(stockRow),
        note: '评分为多因子综合分；信号为原始三分类；方向标签：龙=板块领涨、资=资金前排、榜=龙虎榜。',
      },
      ...(holdingRows.length ? [{
        type: 'table',
        title: '持仓联动',
        columns: [
          { header: '代码', key: 'code' },
          { header: '名称', key: 'name' },
          { header: '数量', key: 'qty', align: 'r' },
          { header: '成本', key: 'avgCost', align: 'r' },
          { header: '现价', key: 'price', align: 'r' },
          { header: '浮盈亏', key: 'floatPct', align: 'r', tone: (v) => (String(v).startsWith('+') ? 'up' : String(v).startsWith('-') ? 'down' : '') },
          { header: '固化止损', key: 'stop', align: 'r' },
          { header: '状态', key: 'status', tone: v => (String(v).includes('破位') ? 'critical' : '') },
        ],
        rows: holdingRows,
      }] : []),
      { type: 'chart', title: '特征命中率（3日）', chart: 'bars', items: bucketBars(stats, minN) },
      { type: 'text', title: '报告口径', text: reportNotes(stats, sinceDays) },
    ],
  };

  return outputReport(report, ctx);
}

function marketTiles(snap, broken) {
  const env = snap.marketEnv || {};
  const idx = env.indices || {};
  const sh = idx['1A0001'];
  const cyb = idx['399006'];
  const mood = env.mood || '-';
  return [
    { label: '涨 / 跌', value: `${env.totalUp ?? '-'} / ${env.totalDown ?? '-'}`, delta: mood, tone: moodTone(mood) },
    { label: '两市成交', value: env.totalAmount != null ? fmtMoney(env.totalAmount) : '-', tone: 'flat' },
    {
      label: '上证指数',
      value: sh ? `${fmtPrice(sh.close)} ${sh.aboveMA20 ? '站上MA20' : '跌破MA20'}` : '-',
      delta: sh && sh.maGapPct != null ? fmtPct(sh.maGapPct, 2) : '',
      tone: sh ? (sh.aboveMA20 ? 'up' : 'down') : 'flat',
    },
    {
      label: '创业板指',
      value: cyb ? `${fmtPrice(cyb.close)} ${cyb.aboveMA20 ? '站上MA20' : '跌破MA20'}` : '-',
      delta: cyb && cyb.maGapPct != null ? fmtPct(cyb.maGapPct, 2) : '',
      tone: cyb ? (cyb.aboveMA20 ? 'up' : 'down') : 'flat',
    },
    { label: '持仓破位', value: String(broken), tone: broken ? 'critical' : 'flat' },
    { label: '快照股票', value: String(Object.keys(snap.stocks || {}).length), tone: 'flat' },
  ];
}

function directionItems(dir) {
  const out = [];
  const b = dir.boardMood;
  const f = dir.fundDir;
  const l = dir.lhbJoin;
  if (b) out.push({ label: '板块', value: `${b.label || '-'} · ${b.topSector || '-'}${b.topPct != null ? ' ' + fmtPct(b.topPct, 2) : ''}` });
  if (f) out.push({ label: '资金', value: `${f.label || '-'} · 前排正占比 ${f.positiveRatio != null ? Math.round(f.positiveRatio * 100) + '%' : '-'}` });
  if (l) out.push({ label: '龙虎榜', value: `${l.label || '-'} · ${l.count || 0} 只` });
  return out.length ? out : [{ label: '方向环境', value: '（无数据）' }];
}

function stockRow(s) {
  return {
    code: s.code,
    name: s.name || s.code,
    close: fmtPrice(s.close),
    score: s.score == null ? '-' : `${s.score} ${s.signalLabel || s.signal || ''}`.trim(),
    signal: s.signalLabel || s.signal || '-',
    ma: s.maAlignment || '-',
    macd: s.macdStatus || '-',
    kdj: s.kdj && s.kdj.k != null ? `${s.kdj.k}/${s.kdj.d}` : '-',
    rsi6: s.rsi6 == null ? '-' : String(s.rsi6),
    adx: s.adx == null ? '-' : String(s.adx),
    atr: s.atrPct == null ? '-' : `${s.atrPct}%`,
    support: s.support == null ? '-' : fmtPrice(s.support),
    resistance: s.resistance == null ? '-' : fmtPrice(s.resistance),
    dir: dirTag(s.dir),
  };
}

function dirTag(d) {
  if (!d) return '-';
  const tags = [];
  if (d.boardLeader) tags.push('龙');
  if (d.fundTop) tags.push('资');
  if (d.lhb != null) tags.push('榜');
  return tags.length ? tags.join(' ') : '-';
}

function safePositions(ctx) {
  try { return ctx.cache.positionsList(); } catch (e) { return []; }
}

function buildHoldingRows(positions, snap) {
  return positions.map(pos => {
    const s = snap.stocks && snap.stocks[pos.code];
    const price = s && s.close != null ? Number(s.close) : null;
    const avg = Number(pos.avgCost);
    const floatPct = price != null && avg > 0 ? ((price - avg) / avg) * 100 : null;
    const stop = pos.stopPrice != null ? Number(pos.stopPrice) : null;
    const broken = stop != null && price != null && price <= stop;
    return {
      code: pos.code,
      name: (s && s.name) || pos.name || pos.code,
      qty: pos.qty,
      avgCost: fmtPrice(avg),
      price: price == null ? '-' : fmtPrice(price),
      floatPct: floatPct == null ? '-' : fmtPct(floatPct, 2),
      stop: stop == null ? '-' : fmtPrice(stop),
      status: broken ? '破位' : stop == null ? '未设止损' : '正常',
      stopBroken: broken,
    };
  });
}

function bucketBars(stats, minN) {
  const keys = ['signal', 'scoreBand', 'ma', 'marketMood', 'boardMood', 'fundDir', 'lhbJoin', 'macdDir', 'resonance'];
  const items = [];
  for (const key of keys) {
    const bucket = stats.buckets[key];
    if (!bucket) continue;
    for (const [value, agg] of Object.entries(bucket)) {
      if (agg.hitRate3 == null || agg.n3 < minN) continue;
      items.push({
        label: `${BUCKET_LABEL[key] || key}: ${value}`,
        value: Math.round(agg.hitRate3 * 1000) / 10,
        max: 100,
        note: `${Math.round(agg.hitRate3 * 100)}% (n=${agg.nDir3})`,
        tone: agg.hitRate3 >= 0.55 ? 'up' : agg.hitRate3 < 0.4 ? 'down' : 'flat',
      });
    }
  }
  return items.slice(0, 14);
}

function reportNotes(stats, sinceDays) {
  return [
    `统计窗口：近 ${sinceDays} 天；命中判定：看多且 3 日后上涨 / 看空且 3 日后下跌。`,
    `全方向 3 日命中率 ${stats.overall.hitRate3 != null ? Math.round(stats.overall.hitRate3 * 100) + '%' : '样本不足'}（方向样本 ${stats.overall.nDir3}），5 日 ${stats.overall.hitRate5 != null ? Math.round(stats.overall.hitRate5 * 100) + '%' : '-'}（方向样本 ${stats.overall.nDir5}）。`,
    `窗口未闭合：3日 ${stats.pending.n3} 条 / 5日 ${stats.pending.n5} 条。`,
    '注意：命中率未做基准调整/交易成本/重叠窗口修正，应结合样本量与市场环境解读。',
  ].join('\n');
}

// ── review ──────────────────────────────────────────────────

async function reportReview(ctx, args) {
  const sinceDays = parseInt(getFlag(args, '--since', '90'), 10) || 90;
  const minN = parseInt(getFlag(args, '--min-n', '5'), 10) || 5;
  const store = makeStore(args);
  const snaps = store.loadSnapshots({ since: daysAgo(sinceDays) });
  if (!snaps.length) throw new Error('没有快照记录。先运行 `ths daily run`。');
  const stats = computeStats(snaps, { minN });

  const bucketRows = [];
  for (const meta of BUCKETS) {
    const bucket = stats.buckets[meta.key];
    if (!bucket) continue;
    for (const [value, agg] of Object.entries(bucket)) {
      if (meta.tier === 2 && agg.n3 < minN) continue;
      bucketRows.push({
        feature: `${BUCKET_LABEL[meta.key] || meta.key}: ${value}`,
        n3: agg.n3,
        dir3: agg.nDir3,
        hit3: hitText(agg, 3),
        n5: agg.n5,
        dir5: agg.nDir5,
        hit5: hitText(agg, 5),
      });
    }
  }

  const report = {
    schemaVersion: 1,
    kind: 'review',
    title: `复盘命中率报告 · 近 ${sinceDays} 天`,
    subtitle: `快照 ${snaps.length} 条 · n≥${minN}`,
    generatedAt: fmtDateTime(Date.now()),
    quality: {
      label: '本地快照统计',
      tone: stats.overall.hitRate3 == null ? 'warn' : '',
      warnings: stats.overall.hitRate3 == null ? ['方向样本不足，命中率暂不可用'] : [],
    },
    sections: [
      {
        type: 'tiles',
        title: '总体',
        items: [
          { label: '3日命中', value: rateText(stats.overall.hitRate3), delta: `方向样本 ${stats.overall.nDir3}`, tone: rateTone(stats.overall.hitRate3) },
          { label: '5日命中', value: rateText(stats.overall.hitRate5), delta: `方向样本 ${stats.overall.nDir5}`, tone: rateTone(stats.overall.hitRate5) },
          { label: '总样本', value: String(stats.overall.n3), delta: `5日 ${stats.overall.n5}`, tone: 'flat' },
          { label: '待判定', value: `${stats.pending.n3} / ${stats.pending.n5}`, delta: '3日 / 5日', tone: 'flat' },
        ],
      },
      {
        type: 'table',
        title: '特征桶命中率',
        columns: [
          { header: '特征', key: 'feature' },
          { header: 'n3', key: 'n3', align: 'r' },
          { header: '方向3', key: 'dir3', align: 'r' },
          { header: '3日命中', key: 'hit3', align: 'r', tone: v => (String(v).startsWith('样本') ? '' : parseFloat(v) >= 55 ? 'up' : parseFloat(v) < 40 ? 'down' : '') },
          { header: 'n5', key: 'n5', align: 'r' },
          { header: '方向5', key: 'dir5', align: 'r' },
          { header: '5日命中', key: 'hit5', align: 'r' },
        ],
        rows: bucketRows,
        note: 'n3=总样本（含观望）；方向样本才是命中率分母。',
      },
      { type: 'chart', title: '3日命中率分布', chart: 'bars', items: bucketBars(stats, minN) },
    ],
  };

  return outputReport(report, ctx);
}

function hitText(agg, win) {
  const n = win === 3 ? agg.n3 : agg.n5;
  const dir = win === 3 ? agg.nDir3 : agg.nDir5;
  const rate = win === 3 ? agg.hitRate3 : agg.hitRate5;
  if (!n) return '-';
  if (rate == null) return `样本不足(${dir})`;
  return `${Math.round(rate * 100)}% (${dir}/${n})`;
}

function rateText(rate) {
  return rate == null ? '样本不足' : `${Math.round(rate * 100)}%`;
}

function rateTone(rate) {
  if (rate == null) return 'flat';
  return rate >= 0.55 ? 'up' : rate < 0.4 ? 'down' : 'flat';
}

function scoreTone(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return '';
  return n >= 60 ? 'up' : n <= 40 ? 'down' : '';
}

function moodTone(mood) {
  if (!mood) return 'flat';
  if (String(mood).includes('普涨') || String(mood).includes('涨多')) return 'up';
  if (String(mood).includes('普跌') || String(mood).includes('跌多')) return 'down';
  return 'flat';
}

// ── backtest ────────────────────────────────────────────────

const PPY = { day: 252, week: 52, month: 12, quarter: 4, '60min': 1008, '120min': 504 };

async function reportBacktest(ctx, args) {
  const code = args[0];
  if (!code) throw new Error('用法: ths report backtest <code> --strategy ma-cross|rsi|macd|score|resonance|buy-hold');
  const cliPeriod = getFlag(args, '--period', 'day');
  const params = parseKlineArgs(args);
  const strategy = getFlag(args, '--strategy', 'ma-cross');
  if (!STRATEGIES[strategy]) throw new Error(`未知策略 "${strategy}"，可选: ${Object.keys(STRATEGIES).join('/')}`);

  const strategyParams = parseStrategyParams(strategy, args);
  const fee = getFlag(args, '--fee', null) != null ? parseFloat(getFlag(args, '--fee', '0.0005')) : 0.0005;
  const slippage = getFlag(args, '--slippage', null) != null ? parseFloat(getFlag(args, '--slippage', '0')) : 0;
  const stopLossAtr = getFlag(args, '--stop-loss', null) != null ? parseFloat(getFlag(args, '--stop-loss', '0')) : 0;
  const limitCheck = args.includes('--limit-check');

  const bars = await loadKline(ctx, ctx.cache, params, {
    maxAgeMs: ttlMsForPeriod(ctx.config, cliPeriod),
    refresh: args.includes('--refresh'),
    excludeForming: true,
  });
  if (bars.length < 30) throw new Error(`数据太少（${bars.length} 根），建议加大 --count`);

  const res = backtest(bars, strategy, strategyParams, {
    fee, slippage, stopLossAtr, limitCheck,
    periodsPerYear: PPY[cliPeriod] || 252,
  });
  const cachedName = ctx.cache && typeof ctx.cache.getName === 'function' ? ctx.cache.getName(code) : null;
  const name = cachedName || (await resolveName(ctx, ctx.cache, code)) || code;
  const dates = bars.map(b => b.date);
  const dd = drawdownSeries(res.equity);
  const vsBH = res.totalReturnPct - res.buyHoldReturnPct;
  const trades = res.trades.slice(-30).reverse().map(t => ({
    buyDate: dates[t.buyIdx] || '-',
    sellDate: dates[t.sellIdx] || '-',
    buyPrice: fmtPrice(t.buyPrice),
    sellPrice: fmtPrice(t.sellPrice),
    ret: fmtPct(t.returnPct, 2),
    reason: t.reason === 'stop' ? 'ATR止损' : '信号',
  }));

  const warnings = [];
  if (res.numTrades < 3) warnings.push(`交易样本仅 ${res.numTrades} 笔，统计意义有限`);
  if (limitCheck === false) warnings.push('未开启一字板约束（--limit-check）');

  const report = {
    schemaVersion: 1,
    kind: 'backtest',
    title: `回测报告 · ${code} ${name}`,
    subtitle: `${STRATEGIES[strategy].label} · ${cliPeriod} K · ${res.bars} 根`,
    generatedAt: fmtDateTime(Date.now()),
    quality: { label: `${dates[0] || '?'} ~ ${dates[dates.length - 1] || '?'}`, tone: warnings.length ? 'warn' : '', warnings },
    sections: [
      {
        type: 'tiles',
        title: '核心指标',
        items: [
          { label: '总收益', value: fmtPct(res.totalReturnPct, 2), tone: res.totalReturnPct >= 0 ? 'up' : 'down' },
          { label: '年化', value: fmtPct(res.annualizedReturnPct, 2), tone: res.annualizedReturnPct >= 0 ? 'up' : 'down' },
          { label: '最大回撤', value: fmtPct(-Math.abs(res.maxDrawdownPct), 2), tone: 'down' },
          { label: '胜率', value: res.winRate != null ? `${res.winRate}%` : '-', delta: `${res.numTrades} 笔`, tone: 'flat' },
          { label: '盈亏比', value: res.profitFactor != null ? String(res.profitFactor) : (res.numTrades ? '∞' : '-'), tone: 'flat' },
          { label: '夏普', value: res.sharpe != null ? String(res.sharpe) : '-', tone: 'flat' },
          { label: '跑赢基准', value: fmtPct(vsBH, 2), tone: vsBH >= 0 ? 'up' : 'down' },
          { label: '买入持有', value: fmtPct(res.buyHoldReturnPct, 2), tone: res.buyHoldReturnPct >= 0 ? 'up' : 'down' },
        ],
      },
      {
        type: 'chart',
        title: '权益曲线',
        chart: 'line',
        values: res.equity,
        color: 'var(--up)',
        fill: true,
        yLabels: false,
        xLabels: dates,
        fmt: v => Number(v).toFixed(2),
      },
      {
        type: 'chart',
        title: '回撤 (%)',
        chart: 'line',
        values: dd,
        color: 'var(--down)',
        yMax: 0,
        xLabels: dates,
        fmt: v => Number(v).toFixed(1),
      },
      {
        type: 'table',
        title: '最近交易（最多 30 笔）',
        columns: [
          { header: '买入日期', key: 'buyDate' },
          { header: '卖出日期', key: 'sellDate' },
          { header: '买入价', key: 'buyPrice', align: 'r' },
          { header: '卖出价', key: 'sellPrice', align: 'r' },
          { header: '收益', key: 'ret', align: 'r', tone: v => (String(v).startsWith('+') ? 'up' : String(v).startsWith('-') ? 'down' : '') },
          { header: '原因', key: 'reason' },
        ],
        rows: trades,
        note: trades.length ? '' : '（无完整交易，可能信号太少）',
      },
      {
        type: 'text',
        title: '参数与成本',
        text: [
          `策略：${STRATEGIES[strategy].describe(res.params)}`,
          `成本：佣金 ${(fee * 100).toFixed(3)}%/边${slippage ? `，滑点 ${(slippage * 100).toFixed(3)}%/边` : ''}`,
          `约束：ATR止损 ${stopLossAtr > 0 ? stopLossAtr + '×ATR' : '关闭'}；一字板约束 ${limitCheck ? '开启' : '关闭'}`,
          '回测为历史统计，不含未来函数，但不代表实盘收益。',
        ].join('\n'),
      },
    ],
  };
  return outputReport(report, ctx);
}

function parseStrategyParams(strategy, args) {
  const p = {};
  if (strategy === 'ma-cross') {
    p.fast = Math.max(2, parseInt(getFlag(args, '--fast', '5'), 10) || 5);
    p.slow = Math.max(p.fast + 1, parseInt(getFlag(args, '--slow', '20'), 10) || 20);
  } else if (strategy === 'rsi') {
    p.period = Math.max(2, parseInt(getFlag(args, '--period-n', '14'), 10) || 14);
    p.oversold = parseInt(getFlag(args, '--oversold', '30'), 10) || 30;
    p.overbought = parseInt(getFlag(args, '--overbought', '70'), 10) || 70;
  } else if (strategy === 'macd') {
    p.fast = parseInt(getFlag(args, '--fast', '12'), 10) || 12;
    p.slow = parseInt(getFlag(args, '--slow', '26'), 10) || 26;
    p.signal = parseInt(getFlag(args, '--signal', '9'), 10) || 9;
  } else if (strategy === 'score') {
    p.buy = clamp(parseInt(getFlag(args, '--score-buy', '60'), 10) || 60, 0, 100);
    p.sell = clamp(parseInt(getFlag(args, '--score-sell', '40'), 10) || 40, 0, 100);
  } else if (strategy === 'resonance') {
    p.scoreBuy = clamp(parseInt(getFlag(args, '--score-min', '60'), 10) || 60, 0, 100);
    p.adxMin = Math.max(0, parseInt(getFlag(args, '--adx', '25'), 10) || 25);
  }
  return p;
}

function drawdownSeries(equity) {
  let peak = equity && equity.length ? equity[0] : 0;
  return (equity || []).map(v => {
    if (v > peak) peak = v;
    return peak > 0 ? ((v / peak) - 1) * 100 : 0;
  });
}

// ── risk ────────────────────────────────────────────────────

async function reportRisk(ctx, args) {
  const codesArg = getFlag(args, '--codes', null);
  let items;
  if (codesArg) {
    items = codesArg.split(',').map(s => s.trim()).filter(Boolean).map(code => ({
      code, name: null, market: inferMarket(code) || '',
    }));
  } else {
    items = ctx.cache.watchlistList().map(w => ({
      code: w.code, name: w.name || null, market: w.market || inferMarket(w.code) || '',
    }));
  }
  if (!items.length) throw new Error('池为空：请先 ths watchlist add，或用 --codes a,b 指定');

  const count = Math.min(500, Math.max(30, parseInt(getFlag(args, '--count', '120'), 10) || 120));
  const weights = parseWeights(getFlag(args, '--weights', null));
  const refresh = args.includes('--refresh');
  const stocks = [];
  const skipped = [];
  for (const it of items) {
    if (isBoardIndex(it.code)) { skipped.push(`${it.code}(板块指数)`); continue; }
    const market = it.market || inferMarket(it.code) || '17';
    try {
      const bars = await loadKline(ctx, ctx.cache, {
        code: it.code, market, period: 'day_1', count, adjust: 'forward',
      }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day'), excludeForming: true, refresh });
      if (bars && bars.length >= 45) {
        const cachedName = ctx.cache && typeof ctx.cache.getName === 'function' ? ctx.cache.getName(it.code) : null;
        const name = it.name || cachedName || (await resolveName(ctx, ctx.cache, it.code)) || it.code;
        stocks.push({ code: it.code, name, bars });
      } else {
        skipped.push(`${it.code}(日K不足)`);
      }
    } catch (e) {
      skipped.push(`${it.code}(${e.message})`);
    }
  }
  if (!stocks.length) throw new Error('无足够日K数据（≥45 根）。先跑 analyze/kline 拉数据，或 --codes 指定已缓存代码');

  const res = computeRisk({ stocks, weights, n: count });
  const mode = weights ? '自定义权重' : '等权纸面组合';
  const codes = res.codes;
  const m = res.metrics;
  const flags = [];
  for (const c of m.overweight) flags.push(`${c} ${res.perCode[c].name} 权重 ${(res.perCode[c].weight * 100).toFixed(1)}% 超 ${Math.round(m.maxWeight * 100)}% 铁律`);
  for (const hp of res.highCorrPairs) flags.push(`${hp.a} ${res.perCode[hp.a].name} × ${hp.b} ${res.perCode[hp.b].name} ρ=${Number(hp.r).toFixed(3)} —— 同向风险重复`);

  const report = {
    schemaVersion: 1,
    kind: 'risk',
    title: `组合风险报告 · ${codes.length} 标的`,
    subtitle: `${mode} · 窗口 ${res.window.startDate} ~ ${res.window.endDate}（${res.window.n} 个共同交易日）`,
    generatedAt: fmtDateTime(Date.now()),
    quality: { label: mode, tone: flags.length ? 'warn' : '', warnings: skipped.length ? [`跳过: ${skipped.join(', ')}`] : [] },
    sections: [
      {
        type: 'tiles',
        title: '组合指标',
        items: [
          { label: '平均两两相关', value: m.avgCorr != null ? Number(m.avgCorr).toFixed(3) : '-', tone: m.avgCorr >= 0.5 ? 'warn' : 'flat' },
          { label: '有效独立标的', value: m.effectiveBets != null ? `${Number(m.effectiveBets).toFixed(2)} / ${codes.length}` : '-', tone: 'flat' },
          { label: '组合年化波动', value: `${Number(m.portVolAnnPct).toFixed(2)}%`, tone: 'warn' },
          { label: '集中度 HHI', value: Number(m.herfindahl).toFixed(3), tone: m.herfindahl > 0.3 ? 'warn' : 'flat' },
          { label: '超 20% 标的', value: String(m.overweight.length), tone: m.overweight.length ? 'warn' : 'flat' },
        ],
      },
      {
        type: 'chart',
        title: '相关系数矩阵',
        chart: 'heatmap',
        labels: codes,
        matrix: codes.map(a => codes.map(b => res.corr[a][b])),
      },
      {
        type: 'table',
        title: '单票画像',
        columns: [
          { header: '代码', key: 'code' },
          { header: '名称', key: 'name' },
          { header: '权重', key: 'weight', align: 'r' },
          { header: `${res.window.n}日涨跌`, key: 'ret', align: 'r', tone: v => (String(v).startsWith('+') ? 'up' : String(v).startsWith('-') ? 'down' : '') },
          { header: '年化波动', key: 'vol', align: 'r' },
          { header: 'ATR%', key: 'atr', align: 'r' },
          { header: '对池均相关', key: 'corr', align: 'r' },
        ],
        rows: codes.map(c => {
          const p = res.perCode[c];
          return {
            code: c,
            name: p.name,
            weight: `${(p.weight * 100).toFixed(1)}%`,
            ret: fmtPct(p.retPct, 2),
            vol: p.volAnnPct == null ? '-' : `${Number(p.volAnnPct).toFixed(2)}%`,
            atr: p.atrPct == null ? '-' : `${Number(p.atrPct).toFixed(2)}%`,
            corr: p.avgCorrToOthers == null ? '-' : Number(p.avgCorrToOthers).toFixed(3),
          };
        }),
      },
      {
        type: 'text',
        title: '风险提示',
        text: flags.length ? flags.join('\n') : '无超 20% 单票、无 ≥0.7 高相关对',
      },
    ],
  };
  return outputReport(report, ctx);
}

// ── portfolio ───────────────────────────────────────────────

async function reportPortfolio(ctx, args) {
  const positions = ctx.cache && typeof ctx.cache.positionsList === 'function'
    ? ctx.cache.positionsList()
    : [];
  if (!positions.length) throw new Error('持仓台账为空。先 `ths portfolio add <code> --qty N --price X`。');
  const offline = args.includes('--offline');
  const warnings = [];
  const rows = [];
  const summaries = [];

  for (const pos of positions) {
    let price = null;
    let source = '成本价';
    const key = `${pos.code}_day_forward`;
    const entry = ctx.cache && typeof ctx.cache.getKline === 'function' ? ctx.cache.getKline(key) : null;
    if (entry && Array.isArray(entry.bars) && entry.bars.length) {
      const last = entry.bars[entry.bars.length - 1];
      if (last && last.close != null) { price = Number(last.close); source = '缓存日K'; }
    }
    if (price == null && !offline) {
      try {
        const market = inferMarket(pos.code) || '17';
        const bars = await loadKline(ctx, ctx.cache, {
          code: pos.code, market, period: 'day_1', count: 10, adjust: 'forward',
        }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day'), excludeForming: true });
        const last = bars && bars[bars.length - 1];
        if (last && last.close != null) { price = Number(last.close); source = '实时日K'; }
      } catch (e) {
        warnings.push(`${pos.code} 取价失败: ${e.message}`);
      }
    }
    if (price == null) warnings.push(`${pos.code} 无可用行情，按成本价展示`);

    const cachedName = ctx.cache && typeof ctx.cache.getName === 'function' ? ctx.cache.getName(pos.code) : null;
    const s = summarizePosition(pos, { price, name: pos.name || cachedName || pos.code });
    const stop = pos.stopPrice != null ? Number(pos.stopPrice) : null;
    const broken = stop != null && price != null && price <= stop;
    summaries.push(s);
    rows.push({
      code: pos.code,
      name: s.name || pos.code,
      qty: pos.qty,
      avgCost: fmtPrice(s.avgCost),
      price: fmtPrice(s.price),
      floatPnl: fmtMoney(s.floatPnl),
      floatPct: fmtPct(s.floatPct, 2),
      realized: fmtMoney(s.realizedPnl),
      stop: stop == null ? '-' : fmtPrice(stop),
      status: broken ? '破位' : stop == null ? '未设止损' : '正常',
      source,
      stopBroken: broken,
    });
  }

  const total = portfolioSummary(summaries);
  const broken = rows.filter(r => r.stopBroken).length;
  const missingStop = rows.filter(r => r.stop === '-').length;

  const report = {
    schemaVersion: 1,
    kind: 'portfolio',
    title: `持仓报告 · ${rows.length} 只`,
    subtitle: '持仓台账 + 本地/实时日K',
    generatedAt: fmtDateTime(Date.now()),
    quality: {
      label: '持仓快照',
      tone: broken || missingStop ? 'warn' : '',
      warnings,
    },
    sections: [
      {
        type: 'tiles',
        title: '组合概览',
        items: [
          { label: '总市值', value: fmtMoney(total.marketValue), tone: 'flat' },
          { label: '总成本', value: fmtMoney(total.cost), tone: 'flat' },
          { label: '浮动盈亏', value: fmtMoney(total.floatPnl), delta: fmtPct(total.floatPct, 2), tone: total.floatPnl >= 0 ? 'up' : 'down' },
          { label: '已实现盈亏', value: fmtMoney(total.realizedPnl), tone: total.realizedPnl >= 0 ? 'up' : 'down' },
          { label: '破位标的', value: String(broken), tone: broken ? 'critical' : 'flat' },
          { label: '未设止损', value: String(missingStop), tone: missingStop ? 'warn' : 'flat' },
        ],
      },
      {
        type: 'table',
        title: '持仓明细',
        columns: [
          { header: '代码', key: 'code' },
          { header: '名称', key: 'name' },
          { header: '数量', key: 'qty', align: 'r' },
          { header: '成本', key: 'avgCost', align: 'r' },
          { header: '现价', key: 'price', align: 'r' },
          { header: '浮动盈亏', key: 'floatPnl', align: 'r', tone: v => (String(v).startsWith('-') ? 'down' : 'up') },
          { header: '浮动%', key: 'floatPct', align: 'r', tone: v => (String(v).startsWith('-') ? 'down' : 'up') },
          { header: '已实现', key: 'realized', align: 'r' },
          { header: '固化止损', key: 'stop', align: 'r' },
          { header: '状态', key: 'status', tone: v => (v === '破位' ? 'critical' : v === '未设止损' ? 'warn' : '') },
          { header: '价格来源', key: 'source' },
        ],
        rows,
      },
      {
        type: 'text',
        title: '口径',
        text: [
          '现价优先取本地日K缓存，其次取实时日K（--offline 可禁止联网）。',
          '浮动盈亏按成本价计算；已实现盈亏来自持仓台账买卖流水。',
          '止损为建仓/手动固化的 stopPrice，不会被每日行情悄悄下移。',
        ].join('\n'),
      },
    ],
  };
  return outputReport(report, ctx);
}

function parseWeights(str) {
  if (!str) return null;
  const out = {};
  for (const part of str.split(',')) {
    const [code, w] = part.split('=').map(s => s.trim());
    const n = Number(w);
    if (code && Number.isFinite(n)) out[code] = n;
  }
  return Object.keys(out).length ? out : null;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ── 输出 ────────────────────────────────────────────────────

/** --dir 指定 data/daily 目录（测试/多数据集） */
function makeStore(args) {
  const dir = getFlag(args, '--dir', null);
  if (!dir) return new DailyStore();
  return new DailyStore({
    snapDir: path.join(dir, 'snapshots'),
    lessonsFile: path.join(dir, 'lessons.json'),
  });
}

function outputReport(report, ctx) {
  const fromCtx = ctx && ctx.output && ctx.output.format;
  const opts = getOutputOptions();
  const requested = fromCtx || opts.format;
  const format = ['html', 'md', 'json'].includes(requested) ? requested : 'md';
  if (format === 'json') return report;
  const text = format === 'html' ? renderHtml(report) : renderMarkdown(report);
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
  return undefined;
}

module.exports = cmdReport;
