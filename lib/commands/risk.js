// lib/commands/risk.js — 组合/风控层量化：相关性 / 集中度 / 组合波动 / 波动预算
//
// 用法:
//   ths risk [--pool watchlist|--codes a,b] [--count N(120)] [--weights A=0.5,B=0.3] [--json]
//
// 数据：日 K（默认走 loadKline 缓存感知、剔除盘中在途 bar，与 analyze 同 TTL）。
// 持仓为空 → 等权"纸面组合"；给了 --weights 用给定权重。风险提示是画像，不是下单建议。

const { getFlag, inferMarket, renderTable, renderKV } = require('./helpers');
const { loadKline, ttlMsForPeriod } = require('../cache');
const { computeRisk } = require('../portfolio-risk');

const pct2 = v => (v == null ? '-' : `${v > 0 ? '+' : ''}${(Math.round(v * 100) / 100)}%`);
const pct1 = v => (v == null ? '-' : `${v > 0 ? '+' : ''}${(Math.round(v * 10) / 10)}%`);
const fmtW = v => (v == null ? '-' : `${Math.round(v * 1000) / 10}%`);
const p2 = v => (v == null ? '-' : String(Math.round(v * 100) / 100));
const p3 = v => (v == null ? '-' : String(Math.round(v * 1000) / 1000));

function resolveCodes(ctx, args) {
  const codesArg = getFlag(args, '--codes', null);
  if (codesArg) {
    return codesArg.split(',').map(s => s.trim()).filter(Boolean).map(c => {
      const w = ctx.cache.watchlistList().find(x => x.code === String(c));
      return { code: String(c), name: (w && w.name) || ctx.cache.getName(c) || c };
    });
  }
  const list = ctx.cache.watchlistList();
  if (!list.length) throw new Error('池为空：请先 ths watchlist add，或用 --codes a,b 指定');
  return list.map(w => ({ code: String(w.code), name: w.name || ctx.cache.getName(w.code) || w.code }));
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

async function cmdRisk(ctx, args) {
  const json = args.includes('--json');
  const count = Math.min(500, Math.max(30, parseInt(getFlag(args, '--count', '120'), 10) || 120));
  const weights = parseWeights(getFlag(args, '--weights', null));
  const refresh = args.includes('--refresh');

  const items = resolveCodes(ctx, args);
  const stocks = [];
  const skipped = [];
  for (const it of items) {
    if (/^88\d{4}$/.test(it.code)) continue; // 板块指数不可当组合标的（方向观察，非持仓）
    let bars = null;
    try {
      bars = await loadKline(ctx, ctx.cache, {
        code: it.code, market: inferMarket(it.code) || '17', period: 'day_1', count, adjust: 'forward',
      }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day'), excludeForming: true, refresh });
    } catch (e) { bars = null; }
    if (bars && bars.length >= 45) stocks.push({ code: it.code, name: it.name, bars });
    else skipped.push(it.code);
  }
  if (!stocks.length) throw new Error('无足够日K数据（≥45 根）。先跑 ths analyze/kline 拉数据，或 --codes 指定缓存过的代码');

  const res = computeRisk({ stocks, weights, n: count });
  const mode = weights ? '自定义权重' : '等权纸面组合';

  if (json) {
    return { pool: items.map(i => i.code), weightsMode: mode, skipped, ...res };
  }

  const codes = res.codes;
  console.log(`════ 组合风险 · ${codes.length} 标的 · ${mode} · 窗口 ${res.window.startDate} ~ ${res.window.endDate}（${res.window.n} 个共同交易日）════`);
  if (skipped.length) console.log(`  ⚠ 跳过（日K不足/无缓存）: ${skipped.join(', ')}`);

  // 相关矩阵
  console.log('\n相关系数矩阵（N=收益共同日 | [x.xx]=高相关≥0.7 | 名称对照见下表）');
  const legend = codes.map(c => `${c}=${res.perCode[c].name}`).join(' ');
  console.log(`  ${legend}`);
  const mCols = [{ header: '代码', key: 'code' }].concat(codes.map(c => ({ header: c, key: c })));
  const mRows = codes.map(a => {
    const row = { code: a };
    for (const b of codes) {
      const r = res.corr[a][b];
      row[b] = a === b ? '1.00' : (r == null ? ' — ' : (r >= 0.7 ? `[${p3(r)}]` : p3(r)));
    }
    return row;
  });
  console.log(renderTable(mRows, mCols));

  // 单票画像
  console.log('\n单票画像');
  const pCols = [
    { header: '代码', key: 'code' }, { header: '名称', key: 'name' },
    { header: '权重', key: 'w', align: 'r' },
    { header: `${res.window.n}日涨跌`, key: 'ret', align: 'r' },
    { header: '年化波动', key: 'vol', align: 'r' },
    { header: 'ATR%', key: 'atr', align: 'r' },
    { header: '对池均相关', key: 'corr', align: 'r' },
  ];
  const pRows = codes.map(c => {
    const p = res.perCode[c];
    return {
      code: c, name: p.name,
      w: fmtW(p.weight), ret: pct1(p.retPct),
      vol: p.volAnnPct == null ? '-' : `${p2(p.volAnnPct)}%`,
      atr: p.atrPct == null ? '-' : `${p2(p.atrPct)}%`, corr: p3(p.avgCorrToOthers),
    };
  });
  console.log(renderTable(pRows, pCols));

  // 指标
  const m = res.metrics;
  const kv = [
    { label: '平均两两相关', value: p3(m.avgCorr) },
    { label: '有效独立标的', value: m.effectiveBets != null ? `${p2(m.effectiveBets)} / ${codes.length}` : '-' },
    { label: '组合年化波动', value: `${p2(m.portVolAnnPct)}%` },
    { label: '组合日波动', value: `${p2(m.portVolDailyPct)}%` },
    { label: '集中度 HHI', value: p3(m.herfindahl) },
    { label: '权重来源', value: mode },
  ];
  console.log('\n组合指标');
  console.log(renderKV(kv));

  // flags
  const flags = [];
  for (const p of m.overweight) flags.push(`🔴 ${p} ${res.perCode[p].name} 权重 ${fmtW(res.perCode[p].weight)} 超 ${Math.round(m.maxWeight * 100)}% 仓位铁律`);
  for (const hp of res.highCorrPairs) flags.push(`🟠 ${hp.a} ${res.perCode[hp.a].name} × ${hp.b} ${res.perCode[hp.b].name} ρ=${p3(hp.r)} —— 同向风险重复，最好只留一只`);
  console.log('\n风险提示');
  if (!flags.length) console.log('  ✓ 无超 20% 单票、无 ≥0.7 高相关对');
  else flags.forEach(f => console.log(`  ${f}`));

  if (weights) console.log('\n注：纸面/自定义权重仅供参考；实盘请以持仓市值为准（weight×现价）。');
  return undefined;
}

module.exports = cmdRisk;
