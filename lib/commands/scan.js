// lib/commands/scan.js — 选股扫描

const { getFlag, renderTable, renderKV, PERIODS, formatSearchRow, escapeExpression, inferMarket, formatQuotes } = require('./helpers');
const { CRITERIA, runScan, resolvePoolItems } = require('../scanner');
const { ttlMsForPeriod, resolveName } = require('../cache');
const { moodLabel } = require('./market');

/** realhead 大盘 → { up, down, mood }（沪+深涨跌家数合计，与 market/daily 同口径） */
function marketEnvOf(raw) {
  const sh = (raw || []).find(r => r.code === '1A0001');
  const sz = (raw || []).find(r => r.code === '399001');
  if (!sh || !sz || sh.upCount == null || sz.upCount == null) return null;
  const up = Number(sh.upCount) + Number(sz.upCount);
  const down = Number(sh.downCount) + Number(sz.downCount);
  return { up, down, mood: moodLabel(up, down) };
}

/**
 * 选股扫描
 * @param {object} ctx
 * @param {string[]} args - [--criterion a,b --pool watchlist|--codes .. --min-score N --delay MS --refresh --json]
 */
async function cmdScan(ctx, args) {
  const criterionArg = getFlag(args, '--criterion', null);
  const criterionNames = criterionArg
    ? criterionArg.split(',').map(s => s.trim()).filter(Boolean)
    : ['macd-golden'];
  for (const name of criterionNames) {
    if (!CRITERIA[name]) {
      throw new Error(`未知选股条件 "${name}"，可选: ${Object.keys(CRITERIA).join('/')}`);
    }
  }

  const codes = getFlag(args, '--codes', null);
  const pool = getFlag(args, '--pool', 'watchlist');
  const universe = getFlag(args, '--universe', null);
  let items;
  if (universe) {
    // 用 search 联想建池（如 --universe 证券 / 银行），过滤 A 股
    const data = await ctx.loggedCall('search', { keyword: universe },
      `window.__ths.searchStock('${escapeExpression(universe)}')`);
    const head = data && data.head;
    const rows = ((data && data.body) || []).map(r => formatSearchRow(r, head));
    items = rows
      .filter(r => /^[603]/.test(r.code) && /A/.test(r.market || ''))
      .map(r => ({ code: r.code, name: r.name || r.code, market: inferMarket(r.code) || '' }));
    if (!items.length) throw new Error(`未搜到 "${universe}" 相关 A 股`);
  } else {
    items = resolvePoolItems(ctx.cache, { codes, pool });
  }
  if (!items.length) {
    throw new Error(
      codes
        ? '--codes 为空，示例: --codes 600519,000001'
        : '自选股为空。先 `ths watchlist add <code>` 或用 `--codes 600519,000001`（--universe 关键词亦可）'
    );
  }

  // CLI 周期名（缓存 TTL）与 API 周期名（fetch）分离
  const cliPeriod = getFlag(args, '--period', 'day');
  const apiPeriod = PERIODS[cliPeriod] || cliPeriod;
  const opts = {
    period: apiPeriod,
    count: Math.max(30, parseInt(getFlag(args, '--count', 250), 10) || 250),
    adjust: getFlag(args, '--adjust', 'forward'),
    delayMs: Math.max(0, parseInt(getFlag(args, '--delay', 0), 10) || 0),
    refresh: args.includes('--refresh'),
    minScore: getFlag(args, '--min-score', null) != null ? parseInt(getFlag(args, '--min-score', '0'), 10) : null,
    lookback: Math.max(1, parseInt(getFlag(args, '--lookback', 5), 10) || 5),
    oversold: getFlag(args, '--oversold', null) != null ? parseInt(getFlag(args, '--oversold', '0'), 10) : null,
    overbought: getFlag(args, '--overbought', null) != null ? parseInt(getFlag(args, '--overbought', '0'), 10) : null,
    breakN: Math.max(5, parseInt(getFlag(args, '--break-n', 20), 10) || 20),
    volumeRatio: getFlag(args, '--vol-ratio', null) != null ? parseFloat(getFlag(args, '--vol-ratio', '1.5')) : null,
    atrMin: getFlag(args, '--atr-min', null) != null ? parseFloat(getFlag(args, '--atr-min', '1')) : null,
    atrMax: getFlag(args, '--atr-max', null) != null ? parseFloat(getFlag(args, '--atr-max', '6')) : null,
    scoreThreshold: getFlag(args, '--score', null) != null ? parseInt(getFlag(args, '--score', '60'), 10) : null,
    maxAgeMs: ttlMsForPeriod(ctx.config, cliPeriod),
    weights: (ctx.config.score && ctx.config.score.weights) || null,
  };

  // 方向门控: --only-hot 只在"大盘不普跌"时允许做多类命中（不逆大盘落到选股）
  const onlyHot = args.includes('--only-hot');
  let marketEnv = null;
  if (onlyHot) {
    try {
      marketEnv = marketEnvOf(await ctx.loggedCall('market', {}, 'window.__ths.market()'));
    } catch (e) { marketEnv = null; }
    opts.marketCold = !!(marketEnv && marketEnv.mood.includes('普跌'));
    if (!marketEnv) console.log('  ⚠ 取大盘情绪失败（油猴需 v1.2.0+），--only-hot 本次按无门控运行');
  }

  ctx.audit.startOperation('scan', { criterionNames, pool, codes, opts });
  const results = await runScan(ctx, ctx.cache, items, criterionNames, opts);
  ctx.audit.endOperation('success', {
    total: results.length,
    passed: results.filter(r => r.passed).length,
    skipped: results.filter(r => r.skipped).length,
  }, { criterionNames, results });

  const passed = results.filter(r => r.passed);
  const skipped = results.filter(r => r.skipped);

  // --codes / --universe 场景解析股票名（缓存复用，只对命中的解析）
  for (const r of passed) {
    if (!r.name || r.name === r.code) {
      const nm = await resolveName(ctx, ctx.cache, r.code);
      if (nm) r.name = nm;
    }
  }

  // 批量实时估值增强（一次批量接口调用；油猴旧版或失败时静默跳过，不影响扫描）
  let valuations = {};
  try {
    if (passed.length) {
      const items = passed
        .map(r => ({ code: r.code, market: r.market || inferMarket(r.code) || '' }))
        .filter(it => it.market);
      if (items.length) {
        const raw = await ctx.loggedCall('scan-valuations', { count: items.length },
          `window.__ths.quotes(${JSON.stringify(items)})`);
        for (const q of formatQuotes(raw)) valuations[q.code] = q;
      }
    }
  } catch (e) { /* 估值增强失败不影响扫描结果 */ }

  if (args.includes('--json')) {
    return passed.map(r => {
      const v = valuations[r.code];
      return {
        code: r.code,
        name: r.name,
        close: r.analysis ? r.analysis.latest.close : null,
        score: r.score ? r.score.total : null,
        signal: r.score ? r.score.signal : null,
        criteria: r.matched.map(m => m.label + (m.detail ? `(${m.detail})` : '')),
        error: r.error || null,
        valuation: v ? {
          price: v.price, pct: v.pct, turnoverRate: v.turnoverRate,
          volumeRatio: v.volumeRatio, pe: v.pe, pb: v.pb, totalMv: v.totalMv,
        } : null,
      };
    });
  }

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
  if (onlyHot && marketEnv) {
    console.log(`环境门控(--only-hot): 涨 ${marketEnv.up} / 跌 ${marketEnv.down}（${marketEnv.mood}）${opts.marketCold ? '→ 做多条件已抑制' : '→ 可做多'}`);
  }
  console.log(`扫描 ${items.length} 只（${criterionNames.map(c => CRITERIA[c].label).join(' + ')}），命中 ${passed.length} 只${skipped.length ? `，跳过 ${skipped.length} 只` : ''}`);
  if (!passed.length) {
    console.log('（无命中。可放宽条件：减少 --criterion、降低 --min-score、加大 --count）');
    return undefined;
  }

  console.log(renderTable(passed.map(r => {
    const v = valuations[r.code];
    return {
      code: r.code,
      name: r.name,
      close: r.analysis ? r.analysis.latest.close : '-',
      score: r.score ? r.score.total : '-',
      signal: r.score ? r.score.signal : '-',
      pct: v && v.pct != null ? sign(v.pct) + '%' : '-',
      turnoverRate: v && v.turnoverRate != null ? v.turnoverRate + '%' : '-',
      volumeRatio: v && v.volumeRatio != null ? v.volumeRatio : '-',
      pe: v && v.pe != null ? v.pe : '-',
      criteria: r.matched.map(m => m.label + (m.detail ? `(${m.detail})` : '')).join(' | '),
    };
  }), [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '收盘', key: 'close', align: 'r' },
    { header: '评分', key: 'score', align: 'r' },
    { header: '信号', key: 'signal' },
    { header: '涨跌', key: 'pct', align: 'r' },
    { header: '换手', key: 'turnoverRate', align: 'r' },
    { header: '量比', key: 'volumeRatio', align: 'r' },
    { header: 'PE', key: 'pe', align: 'r' },
    { header: '命中条件', key: 'criteria' },
  ]));

  if (skipped.length) {
    console.log(`\n以下 ${skipped.length} 只跳过（数据获取失败）:`);
    console.log(renderKV(skipped.map(r => ({ label: r.code, value: r.name + ' — ' + (r.error || '未知') }))));
  }
  return undefined;
}

module.exports = cmdScan;
