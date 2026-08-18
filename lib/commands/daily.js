// lib/commands/daily.js — 每日监控 + 复盘 + 经验积累循环
//
// 子命令:
//   daily run [--codes a,b] [--period day] [--count 250] [--refresh] [--min-n N] [--since N]
//             [--candidates a,b,c] [--json]
//       ①大盘环境 ②自选池估值 ③逐股分析存快照 ④回填已到3/5日窗口的旧快照 outcome
//       ⑤报告（每只快照 + 历史命中率标注 + 池建议）
//   daily review [--since N] [--code X] [--min-n N] [--json]    复盘统计（纯本地）
//   daily lessons [--json]                                      查看经验教训
//   daily lesson-add <text> [--category X] [--code X] [--date D] 手动记一条经验
//   daily snapshot [--date D] [--code X] [--json]               查看历史快照
//   daily apply <Sid> [--yes]                                   执行池建议（手动确认）
//
// 数据持久化: data/daily/snapshots/YYYY-MM-DD.json + data/daily/lessons.json
// 快照 date = 该次取数 K 线最后一根的交易日期；窗口按快照序列定位（无交易日历）。

const { getFlag, renderTable, fmtNum, inferMarket, isBoardIndex, PERIODS, formatQuotes } = require('./helpers');
const { moodLabel } = require('./market');
const { fetchHtml } = require('../net');
const { parseIndustrySectors, parseLhb } = require('../parsers');
const { parseCnMoney } = require('./fundflow');
const { DailyStore } = require('../daily-store');
const { computeStats, computeOutcomes, generateSuggestions, groupByCode } = require('../daily-review');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { analyzeBars } = require('../indicators');
const { detectPatterns, recentPatterns } = require('../patterns');
const { detectSR } = require('../support-resistance');
const { scoreBars } = require('../score');
const { buildSummary } = require('../summary');
const { resolvePoolItems } = require('../scanner');
const { summarizePosition } = require('../portfolio');

const DAY_MS = 24 * 60 * 60 * 1000;
const pad2 = n => String(n).padStart(2, '0');
/** 本地日期 YYYY-MM-DD（用本地时区而非 UTC，避免凌晨差一天） */
function localDate(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const TODAY = localDate;
const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
const r1 = v => (v == null || !isFinite(v) ? null : Number(v.toFixed(1)));
const r2 = v => (v == null || !isFinite(v) ? null : Number(v.toFixed(2)));

/** 按 -N 天算统计窗口起始日期（本地时区；快照按交易日期过滤，近似可用） */
function daysAgo(n) {
  return localDate(Date.now() - n * DAY_MS);
}

/** 解析 --codes 为池条目（市场码自动推断） */
function parseCodesArg(codes) {
  return codes.split(',').map(s => s.trim()).filter(Boolean).map(code => ({
    code, name: code, market: inferMarket(code) || '',
  }));
}

// ═══════════════════════════════════════════════════════════
// 大盘环境
// ═══════════════════════════════════════════════════════════

async function fetchMarketEnv(ctx) {
  const data = await ctx.loggedCall('market', {}, 'window.__ths.market()');
  if (!Array.isArray(data) || !data.length) return {};
  const sh = data.find(d => d.code === '1A0001');
  const sz = data.find(d => d.code === '399001');
  const totalUp = sh && sz && sh.upCount != null && sz.upCount != null ? Number(sh.upCount) + Number(sz.upCount) : null;
  const totalDown = sh && sz && sh.downCount != null && sz.downCount != null ? Number(sh.downCount) + Number(sz.downCount) : null;
  const totalAmount = data.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  return {
    totalUp, totalDown,
    totalAmount,
    mood: moodLabel(totalUp, totalDown),
  };
}

// ═══════════════════════════════════════════════════════════
// 方向环境（M2-1: 板块/资金/龙虎榜 → 每日回路）
// ═══════════════════════════════════════════════════════════

/**
 * 抓取方向环境（板块情绪 / 主力资金 / 龙虎榜合力）。
 * 三个数据源各自 try/catch：单个失败不影响其它，返回 warns 由调用方并入报告警告。
 * @returns {Promise<{ env: {boardMood, fundDir, lhbJoin}, warns: string[] }>}
 */
async function fetchDirectionEnv(ctx) {
  const env = {};
  const warns = [];

  // ① 板块情绪：行业板块涨幅 Top + 净流入 Top（Node 直连 GBK 页）
  try {
    const html = await fetchHtml('https://q.10jqka.com.cn/thshy/', { timeoutMs: 20000 });
    const rows = parseIndustrySectors(html).filter(r => r.pct != null && r.name);
    const byPct = rows.slice().sort((a, b) => b.pct - a.pct);
    const byNet = rows.filter(r => r.netIn != null).sort((a, b) => b.netIn - a.netIn);
    const top = byPct.slice(0, 5);
    const strongest = top[0] || null;
    env.boardMood = {
      label: strongest ? (strongest.pct >= 2 ? '强' : strongest.pct >= 0.5 ? '中' : '弱') : null,
      topPct: strongest ? strongest.pct : null,
      topSector: strongest ? strongest.name : null,
      topCode: strongest ? strongest.code : null,
      topLead: strongest ? { code: strongest.leadCode, name: strongest.leadName, pct: strongest.leadPct } : null,
      topNet: byNet.slice(0, 3).map(r => ({ code: r.code, name: r.name, netIn: r.netIn })),
      leaders: top.map(r => ({ code: r.leadCode, name: r.leadName, sector: r.name, pct: r.pct })).filter(l => l.code),
    };
  } catch (e) {
    warns.push(`板块情绪获取失败: ${e.message}`);
  }

  // ② 主力资金方向（走油猴 bridge 批量资金流）
  try {
    const data = await ctx.loggedCall('fundflow', {}, `window.__ths.fundflow('600519')`);
    if (data && Array.isArray(data.rows) && data.rows.length) {
      const parsed = data.rows.map(r => ({
        code: String(r.code || '').trim(),
        name: String(r.name || '').trim(),
        net: parseCnMoney(r.net),
      })).filter(r => r.code && r.name && r.net != null);
      const positive = parsed.filter(r => r.net > 0);
      const ratio = parsed.length ? positive.length / parsed.length : null;
      env.fundDir = {
        label: ratio == null ? null : (ratio >= 0.6 ? '进攻' : ratio >= 0.4 ? '分歧' : '流出'),
        count: parsed.length,
        positiveCount: positive.length,
        positiveRatio: ratio,
        sumNet: parsed.reduce((s, r) => s + r.net, 0),
        topCodes: parsed.slice(0, 5).map(r => ({ code: r.code, name: r.name, net: r.net })),
      };
    }
  } catch (e) {
    warns.push(`资金流获取失败: ${e.message}`);
  }

  // ③ 龙虎榜合力（Node 直连 GBK 页）
  try {
    const html = await fetchHtml('https://data.10jqka.com.cn/market/longhu/', { timeoutMs: 25000 });
    const rows = parseLhb(html)
      .filter(r => r.net != null && r.name && r.name !== r.code)
      .sort((a, b) => (b.net || 0) - (a.net || 0));
    const instCount = rows.filter(r => (r.buyDealers || []).some(d => /机构/.test(d.name))).length;
    const netSum = rows.reduce((s, r) => s + (r.net || 0), 0);
    env.lhbJoin = {
      label: rows.length >= 10 ? (netSum > 0 ? '强' : '中性') : '弱',
      count: rows.length,
      netSum,
      instCount,
      topCodes: rows.slice(0, 5).map(r => ({ code: r.code, name: r.name, net: r.net })),
    };
  } catch (e) {
    warns.push(`龙虎榜获取失败: ${e.message}`);
  }

  return { env, warns };
}

/**
 * 个股方向标签：是否领涨板块龙头 / 资金净流入前排 / 龙虎榜上榜（M2-1）。
 * @returns {object|null} { boardLeader, fundTop, lhb, dirCount } | null（方向数据为空时）
 */
function stockDirTag(dirEnv, code) {
  const c = String(code);
  const board = dirEnv && dirEnv.boardMood;
  const fund = dirEnv && dirEnv.fundDir;
  const lhb = dirEnv && dirEnv.lhbJoin;
  if (!board && !fund && !lhb) return null;
  const leader = (board && board.leaders || []).find(l => l.code === c);
  const fundTop = !!(fund && fund.topCodes && fund.topCodes.some(t => t.code === c));
  const lhbHit = (lhb && lhb.topCodes || []).find(t => t.code === c);
  const dir = {
    boardLeader: leader ? leader.sector : null,
    fundTop,
    lhb: lhbHit ? lhbHit.net : null,
  };
  dir.dirCount = (dir.boardLeader ? 1 : 0) + (dir.fundTop ? 1 : 0) + (dir.lhb != null ? 1 : 0);
  return dir;
}

// ═══════════════════════════════════════════════════════════
// 回填 outcome（按日期文件合并写入）
// ═══════════════════════════════════════════════════════════

function backfillOutcomes(store) {
  const all = store.loadSnapshots();
  if (!all.length) return 0;
  // 已有 outcome 索引（避免对每个 (date,code) 重复读盘）
  const prevOutcome = new Map(all.map(s => [`${s.date}:${s.code}`, s.outcome]));
  const byCode = new Map();
  for (const s of all) {
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s);
  }
  const batch = {};
  let filled = 0;
  for (const [code, codeSnaps] of byCode) {
    for (const row of computeOutcomes(codeSnaps)) {
      if (!row.outcome) continue;
      const prev = prevOutcome.get(`${row.date}:${code}`);
      if (JSON.stringify(prev) !== JSON.stringify(row.outcome)) {
        batch[row.date] = batch[row.date] || {};
        batch[row.date][code] = row.outcome;
        filled++;
      }
    }
  }
  if (filled) store.backfillOutcomes(batch);
  return filled;
}

// ═══════════════════════════════════════════════════════════
// run
// ═══════════════════════════════════════════════════════════

async function dailyRun(ctx, args) {
  const store = new DailyStore();
  const codes = getFlag(args, '--codes', null);
  const pool = getFlag(args, '--pool', 'watchlist');
  const cliPeriod = getFlag(args, '--period', 'day');
  const apiPeriod = PERIODS[cliPeriod] || cliPeriod;
  const count = Math.max(60, parseInt(getFlag(args, '--count', '250'), 10) || 250);
  const refresh = args.includes('--refresh');
  const sinceDays = parseInt(getFlag(args, '--since', '90'), 10) || 90;
  const minN = parseInt(getFlag(args, '--min-n', '5'), 10) || 5;
  const candidatesArg = getFlag(args, '--candidates', null);
  const delayMs = Math.max(0, parseInt(getFlag(args, '--delay', '0'), 10) || 0);

  const items = codes ? parseCodesArg(codes) : resolvePoolItems(ctx.cache, { pool });
  if (!items.length) {
    throw new Error('无股票可监控。先 `ths watchlist add <code>` 或用 `--codes a,b`');
  }

  ctx.audit.startOperation('daily-run', { codes: items.map(i => i.code), period: cliPeriod });
  const warns = [];

  // ① 大盘环境
  let marketEnv = {};
  try {
    marketEnv = await fetchMarketEnv(ctx);
  } catch (e) {
    warns.push(`大盘环境获取失败: ${e.message}`);
  }

  // ①b 方向环境（M2-1: 板块/资金/龙虎榜 → 每日回路）
  let dirEnv = {};
  {
    const res = await fetchDirectionEnv(ctx);
    dirEnv = res.env;
    warns.push(...res.warns);
  }

  // ② 批量估值
  const valuations = {};
  try {
    const qItems = items.filter(it => it.market).map(it => ({ code: it.code, market: it.market }));
    if (qItems.length) {
      const raw = await ctx.loggedCall('daily-quotes', { count: qItems.length },
        `window.__ths.quotes(${JSON.stringify(qItems)})`);
      for (const q of formatQuotes(raw)) valuations[q.code] = q;
    }
  } catch (e) {
    warns.push(`批量行情获取失败: ${e.message}`);
  }

  // ③ 逐股分析 + 快照
  const weights = (ctx.config.score && ctx.config.score.weights) || null;
  const snapshots = [];
  let runDate = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const market = it.market || inferMarket(it.code) || '';
    if (!market) { warns.push(`${it.code} 无法推断市场码，跳过`); continue; }
    try {
      const bars = await loadKline(ctx, ctx.cache,
        { code: it.code, market, period: apiPeriod, count, adjust: 'forward' },
        { maxAgeMs: ttlMsForPeriod(ctx.config, cliPeriod), refresh });
      if (bars.length < 30) throw new Error(`数据太少(${bars.length} 根)`);
      const last = bars[bars.length - 1];
      const a = analyzeBars(bars);
      const patterns = detectPatterns(bars);
      const score = scoreBars(bars, { analysis: a, patterns, weights });
      const sr = detectSR(bars);
      const summary = buildSummary(it.code, bars, { analysis: a, patterns, score, sr });
      const recent = recentPatterns(patterns, 3);
      const v = valuations[it.code];
      const snap = {
        code: it.code,
        name: it.name && it.name !== it.code ? it.name : null,
        isBoard: isBoardIndex(it.code),
        date: summary.date,
        close: summary.close,
        score: summary.score,
        signal: summary.signal,
        signalGrade: summary.signalGrade,
        signalLabel: summary.signalLabel,
        conflicts: summary.conflicts,
        factors: summary.factors,
        maAlignment: summary.maAlignment,
        macdStatus: summary.macdStatus,
        kdj: summary.kdj,
        rsi6: summary.rsi6,
        adx: summary.adx,
        dmi: summary.dmi,
        atrPct: summary.atrPct,
        support: summary.support,
        resistance: summary.resistance,
        patterns: recent.map(p => ({ label: p.label, direction: p.direction })),
        dayLow: last.low,
        dayHigh: last.high,
        pct: v && v.pct != null ? v.pct : null, // 当日涨跌幅%（W2 不追高判定用）
        pe: v && v.pe != null ? v.pe : null,
        turnoverRate: v && v.turnoverRate != null ? v.turnoverRate : null,
        volumeRatio: v && v.volumeRatio != null ? v.volumeRatio : null,
      };
      if (!snap.name) {
        const nm = await resolveName(ctx, ctx.cache, it.code);
        snap.name = nm || it.code;
      }
      // M2-1: 个股方向标签（板块龙头/资金前排/龙虎榜）
      const dir = stockDirTag(dirEnv, it.code);
      if (dir) snap.dir = dir;
      if (snap.date) {
        store.upsertSnapshot(snap.date, snap);
        if (!runDate || snap.date > runDate) runDate = snap.date;
      }
      snapshots.push(snap);
      ctx.audit.logApiCall('daily-snapshot', { code: it.code }, 0, 'success', { date: snap.date });
    } catch (e) {
      warns.push(`${it.code} 分析失败: ${e.message}`);
    }
    if (delayMs && i < items.length - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  if (!runDate) {
    ctx.audit.endOperation('error', { warns }, {});
    throw new Error('所有股票分析失败，无快照生成');
  }
  if (marketEnv && Object.keys(marketEnv).length) store.setMarketEnv(runDate, marketEnv);
  if (dirEnv && Object.keys(dirEnv).length) store.setDirection(runDate, dirEnv);

  // ④ 回填历史 outcome
  const filled = backfillOutcomes(store);

  // ⑤ 统计 + 建议
  const sinceDate = daysAgo(sinceDays);
  const statSnaps = store.loadSnapshots({ since: sinceDate });
  const stats = computeStats(statSnaps, { minN });

  // 候选分析：buildSummary 特征 → 与历史命中率高分组合比对（只给"有数据支撑"的强弱）
  let candidates = [];
  if (candidatesArg) {
    const candItems = parseCodesArg(candidatesArg);
    for (const cand of candItems) {
      const market = cand.market || inferMarket(cand.code) || '';
      try {
        if (!market) throw new Error('无法推断市场码');
        const bars = await loadKline(ctx, ctx.cache,
          { code: cand.code, market, period: apiPeriod, count, adjust: 'forward' },
          { maxAgeMs: ttlMsForPeriod(ctx.config, cliPeriod), refresh });
        if (bars.length < 30) throw new Error('数据太少');
        const name = (await resolveName(ctx, ctx.cache, cand.code)) || cand.code;
        const summary = buildSummary(cand.code, bars);
        candidates.push({
          code: cand.code, name,
          score: summary.score, signal: summary.signal,
          maAlignment: summary.maAlignment, macdStatus: summary.macdStatus,
          adx: summary.adx, resistance: summary.resistance, close: summary.close,
        });
      } catch (e) {
        candidates.push({ code: cand.code, name: cand.name || cand.code }); // 分析失败给弱建议兜底
        warns.push(`候选 ${cand.code} 分析失败: ${e.message}`);
      }
    }
  }

  const suggestions = generateSuggestions({ snaps: statSnaps, candidates }, { minN });
  // 持久化建议（同 code 同 type 的 open 去重由 store 处理），供 `daily apply` 读取
  for (const s of suggestions) store.addSuggestion(s);
  // 自清洁：条件型建议（remove/reduce）不再成立时自动 dismissed，避免过时建议残留
  const fresh = new Set(suggestions.map(s => `${s.code}:${s.type}`));
  for (const open of store.listSuggestions({ status: 'open' })) {
    if (open.type !== 'add' && !fresh.has(`${open.code}:${open.type}`)) {
      store.markSuggestion(open.id, 'dismissed');
    }
  }
  const openSugs = store.listSuggestions({ status: 'open' });

  // 持仓联动：监控信号 vs 实际持仓（止损纪律 + 浮盈亏对照）
  // M1-1: 破位判定用建仓固化的 stopPrice（不是当日支撑）；跌破 → 红字告警 + 写回连续违规天数
  const holdings = [];
  const reminders = [];
  const todayStr = TODAY();
  for (const pos of ctx.cache.positionsList()) {
    const snap = snapshots.find(s => s.code === pos.code);
    const v = valuations[pos.code];
    // 现价优先取今日快照收盘（K线准确）；quotes 的"现价"字段可能返回昨收
    const mkt = {
      price: (snap && snap.close) || (v && v.price) || null,
      pct: (v && v.pct != null) ? v.pct : (snap ? snap.pct : null),
      name: (snap && snap.name) || pos.name || pos.code,
    };
    const s = summarizePosition(pos, mkt);
    const stopPrice = pos.stopPrice != null ? Number(pos.stopPrice) : null;
    const stopBroken = stopPrice != null && mkt.price != null && mkt.price <= stopPrice;
    // 回到止损上方（且非同日重复）→ 判定为"刚跨回"，用于提示违规解除
    const justRecovered = !stopBroken && pos.violationStreak && pos.lastViolationDate !== todayStr;

    // 违规计数写回：跌破固化止损 +1 天（同日重跑幂等）；回到止损上方则重置
    if (stopPrice != null && mkt.price != null) {
      const next = { ...pos };
      let changed = false;
      if (stopBroken) {
        if (pos.lastViolationDate !== todayStr) {
          next.violationStreak = (pos.violationStreak || 0) + 1;
          next.lastViolationDate = todayStr;
          if (!pos.violationStart) next.violationStart = todayStr;
          changed = true;
        }
      } else if (justRecovered) {
        next.violationStreak = 0;
        next.violationStart = null;
        next.lastViolationDate = todayStr;
        changed = true;
      }
      if (changed) ctx.cache.positionsUpsert(next);
    }

    holdings.push({
      code: s.code, name: s.name || s.code, qty: s.qty, avgCost: s.avgCost,
      price: s.price, floatPct: s.floatPct, signal: snap ? snap.signal : null,
      support: snap ? snap.support : null, close: snap ? snap.close : null,
      stopPrice, stopBroken,
      violationStreak: stopBroken ? (pos.violationStreak || 0) + 1 : 0,
    });
    if (stopBroken) {
      reminders.push(`🔴 ${pos.code} ${snap ? snap.name || pos.code : pos.code}: 跌破固化止损 ${stopPrice}（现价 ${mkt.price}）——破位必走，连续违规 ${(pos.violationStreak || 0) + 1} 天`);
    } else if (justRecovered) {
      reminders.push(`✓ ${pos.code} ${snap ? snap.name || pos.code : pos.code}: 回到固化止损 ${stopPrice} 上方，违规解除（${pos.violationStart || '?'} 起）`);
    } else if (snap && snap.signal === '看空') {
      reminders.push(`${pos.code} ${snap.name || pos.code}: 信号转空，检查止损（现价 ${snap.close}）`);
    } else if (snap && snap.support != null && snap.close != null && snap.close <= snap.support) {
      reminders.push(`${pos.code} ${snap.name || pos.code}: 收盘跌破支撑 ${snap.support}，注意止损纪律`);
    }
  }

  ctx.audit.endOperation('success', {
    runDate, stocks: snapshots.length, filled, warnings: warns.length,
  }, { snapshots, stats, suggestions: openSugs });

  if (args.includes('--json')) {
    return { date: runDate, marketEnv, direction: dirEnv, stocks: snapshots, stats, suggestions: openSugs, filled, warnings: warns, holdings, reminders };
  }

  const changes = signalChanges(store);
  renderRunReport({ runDate, marketEnv, direction: dirEnv, snapshots, stats, suggestions: openSugs, filled, warns, minN, changes, reminders, holdings, sinceDays });
  return undefined;
}

function renderRunReport(r) {
  const { runDate, marketEnv, direction, snapshots, stats, suggestions, filled, warns, minN, changes, reminders, holdings, sinceDays } = r;
  console.log(`════ 每日监控 + 复盘 ${runDate} ════`);
  if (marketEnv && marketEnv.mood) {
    const up = marketEnv.totalUp, down = marketEnv.totalDown;
    console.log(`市场环境: 涨 ${up ?? '-'} / 跌 ${down ?? '-'}（${marketEnv.mood}）  两市成交 ${fmtNum(marketEnv.totalAmount || 0)}`);
  } else {
    console.log('市场环境: 获取失败');
  }
  // M2-1: 方向环境（板块/资金/龙虎榜）
  if (direction && (direction.boardMood || direction.fundDir || direction.lhbJoin)) {
    console.log(renderDirectionLine(direction));
  }

  console.log('\n── 今日快照（盯盘）──────────────────────────────');
  if (!snapshots.length) {
    console.log('（今日无快照）');
  } else {
    const rows = snapshots.map(s => {
      const sig = stats.perCode[s.code] && stats.perCode[s.code].bySignal[s.signal];
      return {
        code: s.code,
        name: s.name || s.code,
        close: s.close,
        score: s.isBoard ? '⚠指数' : `${s.score}/${s.signalLabel || s.signal}`,
        ma: s.maAlignment,
        macd: s.macdStatus,
        kdj: s.kdj && s.kdj.k != null ? s.kdj.k : '-',
        rsi6: s.rsi6 != null ? r1(s.rsi6) : '-',
        dir: fmtDirTag(s),
        hit3: fmtHit(sig, 3),
        hit5: fmtHit(sig, 5),
      };
    });
    console.log(renderTable(rows, [
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '收盘', key: 'close', align: 'r' },
      { header: '评分/信号', key: 'score', align: 'r' },
      { header: '均线', key: 'ma' },
      { header: 'MACD', key: 'macd' },
      { header: 'KDJ', key: 'kdj', align: 'r' },
      { header: 'RSI6', key: 'rsi6', align: 'r' },
      { header: '方向', key: 'dir' },
      { header: '本股3日命中', key: 'hit3', align: 'r' },
      { header: '本股5日命中', key: 'hit5', align: 'r' },
    ]));
    console.log('（命中列 = 该股历史该信号命中率，如 62%(13) 为命中率62%、样本13；方向列 = 龙[板块领涨] 资[资金前排] 榜[龙虎榜]）');
  }

  // 持仓联动
  if (holdings && holdings.length) {
    console.log('\n── 持仓联动（信号 vs 实际持仓）──────────────────');
    console.log(renderTable(holdings.map(h => ({
      code: h.code,
      name: h.name,
      qty: h.qty,
      avgCost: r2(h.avgCost),
      price: r2(h.price),
      floatPct: sign(r1(h.floatPct)) + '%',
      signal: h.signal || '-',
      stop: h.stopPrice != null ? r2(h.stopPrice) : '-',
      riskStatus: h.stopBroken ? `🔴破位·${h.violationStreak}天` : (h.stopPrice != null ? '正常' : '未设'),
    })), [
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '数量', key: 'qty', align: 'r' },
      { header: '成本', key: 'avgCost', align: 'r' },
      { header: '现价', key: 'price', align: 'r' },
      { header: '浮盈亏', key: 'floatPct', align: 'r' },
      { header: '今日信号', key: 'signal' },
      { header: '固化止损', key: 'stop', align: 'r' },
      { header: '止损状态', key: 'riskStatus' },
    ]));
  }
  if (reminders && reminders.length) {
    console.log('\n── 持仓提醒（止损纪律）──────────────────────────');
    for (const rm of reminders) console.log(`  ⚠ ${rm}`);
  }

  // 信号变化（与最近一次快照日相比）
  if (changes.length) {
    console.log('\n── 信号变化（vs 上一快照日）─────────────────────');
    for (const c of changes) console.log(`  ${c.code} ${c.name}: ${c.from || '—'} → ${c.to}`);
  }

  console.log(`\n── 特征命中率速览（近${sinceDays}日，n≥${minN} 才显示命中率）───────`);
  printBucketTable(stats, minN);

  if (suggestions.length) {
    console.log('\n── 池建议（需手动确认执行: ths daily apply <Sid> --yes）──');
    for (const s of suggestions) {
      const tag = s.type === 'remove' ? '剔除' : s.type === 'reduce' ? '减仓观望' : '加入';
      const sid = s.id ? ` [${s.id}]` : '';
      console.log(`  ${sid} [${tag}] ${s.code} ${s.name || ''} — ${s.reason}`);
    }
  } else {
    console.log('\n── 池建议 ────────────────────────────────────────');
    console.log('  （无建议。可 `ths daily run --candidates a,b,c` 让候选参与加入评估）');
  }

  if (filled) console.log(`\n✓ 回填 ${filled} 条历史 outcome（3/5 日窗口已闭合）`);
  if (warns.length) {
    console.log(`\n⚠ ${warns.length} 个警告:`);
    for (const w of warns) console.log(`  ⚠ ${w}`);
  }
  console.log('\n手动复盘: ths daily lesson-add "看错/看对原因…" --code <code>');
  console.log('复盘统计: ths daily review   |   执行建议: ths daily apply <Sid>');
}

/** 方向环境单行摘要（M2-1） */
function renderDirectionLine(direction) {
  const parts = [];
  const b = direction.boardMood;
  if (b && b.topSector) {
    const lead = b.topLead && b.topLead.name && b.topLead.name !== b.topSector
      ? `（领涨 ${b.topLead.name}${b.topLead.pct != null ? ' ' + sign(b.topLead.pct) + '%' : ''}）` : '';
    parts.push(`板块: ${b.label || '-'} ${b.topSector}${b.topPct != null ? ' ' + sign(r1(b.topPct)) + '%' : ''}${lead}`);
  }
  const f = direction.fundDir;
  if (f && f.label) {
    const top0 = f.topCodes && f.topCodes[0];
    parts.push(`资金: ${f.label} 前排正占比 ${f.positiveRatio != null ? Math.round(f.positiveRatio * 100) + '%' : '-'}${top0 ? '（Top ' + top0.name + ' ' + fmtNum(top0.net) + '）' : ''}`);
  }
  const l = direction.lhbJoin;
  if (l && l.label) {
    parts.push(`龙虎榜: ${l.label} ${l.count || '-'} 只${l.netSum != null ? ' 净额 ' + (l.netSum > 0 ? '+' : '') + fmtNum(l.netSum) : ''}${l.instCount ? `（${l.instCount} 只含机构席）` : ''}`);
  }
  return `方向环境: ${parts.join('  |  ')}`;
}

/** 个股方向标记（龙=板块领涨龙头 / 资=资金净流入前排 / 榜=龙虎榜） */
function fmtDirTag(s) {
  const d = s.dir;
  if (!d) return '-';
  const tags = [];
  if (d.boardLeader) tags.push('龙');
  if (d.fundTop) tags.push('资');
  if (d.lhb != null) tags.push('榜');
  return tags.length ? tags.join(' ') : '-';
}

/** 找出"昨日信号 → 今日信号"变化的股票（取最近的两次快照） */
function signalChanges(store) {
  if (!store) return [];
  const out = [];
  const dates = store.listDates();
  if (dates.length < 2) return [];
  const today = dates[dates.length - 1];
  const prev = dates[dates.length - 2];
  const tFile = store.loadSnapshotFile(today);
  const pFile = store.loadSnapshotFile(prev);
  if (!tFile || !pFile) return out;
  for (const code of Object.keys(tFile.stocks)) {
    const t = tFile.stocks[code];
    const p = pFile.stocks[code];
    if (t && p && t.signal !== p.signal) {
      out.push({ code, name: t.name || code, from: p.signal, to: t.signal });
    }
  }
  return out;
}

function fmtHit(agg, win) {
  if (!agg) return '-';
  const f = win === 3 ? '3' : '5';
  const n = agg[`n${f}`], rate = agg[`hitRate${f}`];
  if (n == null || n < 1) return '-';
  if (rate == null) return `样本不足(${n})`;
  return `${Math.round(rate * 100)}%(${n})`;
}

function printBucketTable(stats, minN) {
  const tier1 = ['signal', 'scoreBand', 'ma', 'marketMood'];
  const tier2 = ['macdDir', 'kdjRegime', 'rsiRegime', 'adxRegime', 'atrRegime', 'patternDir', 'resonance'];
  const label = { signal: '信号', scoreBand: '评分', ma: '均线', marketMood: '市场', boardMood: '板块', fundDir: '资金', lhbJoin: '龙虎榜', macdDir: 'MACD', kdjRegime: 'KDJ', rsiRegime: 'RSI6', adxRegime: 'ADX', atrRegime: 'ATR%', patternDir: '形态', resonance: '共振', signalGrade: '信号分级', boardLeader: '龙头', dirResonance: '方向共振' };
  const rows = [];
  for (const key of [...tier1, ...tier2]) {
    const b = stats.buckets[key];
    if (!b) continue;
    for (const value of Object.keys(b).sort()) {
      const agg = b[value];
      const n3 = agg.n3 || 0;
      if (tier2.includes(key) && n3 < minN) continue; // Tier 2 样本不足不显示
      rows.push({
        bucket: `${label[key]}: ${value}`,
        n3,
        hit3: fmtHit(agg, 3),
        n5: agg.n5 || 0,
        hit5: fmtHit(agg, 5),
      });
    }
  }
  if (!rows.length) {
    console.log('  （样本不足，暂无命中率统计）');
    return;
  }
  console.log(renderTable(rows, [
    { header: '特征', key: 'bucket' },
    { header: 'n3', key: 'n3', align: 'r' },
    { header: '3日命中', key: 'hit3', align: 'r' },
    { header: 'n5', key: 'n5', align: 'r' },
    { header: '5日命中', key: 'hit5', align: 'r' },
  ]));
  const o = stats.overall;
  if (o.nDir3 >= minN) {
    console.log(`全方向 3日命中 ${Math.round(o.hitRate3 * 100)}%(${o.nDir3})  5日 ${o.hitRate5 != null ? Math.round(o.hitRate5 * 100) + '%(' + o.nDir5 + ')' : '-'}  |  窗口未闭合待判定 3日${stats.pending.n3}/5日${stats.pending.n5}`);
  }
}

// ═══════════════════════════════════════════════════════════
// review / lessons / lesson-add / snapshot / apply
// ═══════════════════════════════════════════════════════════

async function dailyReview(ctx, args) {
  const store = new DailyStore();
  const sinceDays = parseInt(getFlag(args, '--since', '90'), 10) || 90;
  const code = getFlag(args, '--code', null);
  const minN = parseInt(getFlag(args, '--min-n', '5'), 10) || 5;
  const verbose = args.includes('--verbose');
  const snaps = store.loadSnapshots({ since: daysAgo(sinceDays), code });
  const stats = computeStats(snaps, { minN });

  if (args.includes('--json')) return { since: daysAgo(sinceDays), stats };

  console.log(`══ 复盘统计（近 ${sinceDays} 天${code ? `，${code}` : ''}${verbose ? '，含逐条时间线' : ''}）══`);
  if (!snaps.length) {
    console.log('  无快照记录。先 `ths daily run` 建立每日快照。');
    return undefined;
  }
  printBucketTable(stats, minN);

  console.log('\n── 分股票 ──────────────────────────────────────────');
  const rows = Object.keys(stats.perCode).sort().map(c => {
    const pc = stats.perCode[c];
    return {
      code: c,
      name: (pc.last && pc.last.name) || c,
      n3: pc.stat3.n3,
      hit3: fmtHit(pc.stat3, 3),
      n5: pc.stat5.n5,
      hit5: fmtHit(pc.stat5, 5),
    };
  });
  console.log(renderTable(rows, [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: 'n3', key: 'n3', align: 'r' },
    { header: '3日命中', key: 'hit3', align: 'r' },
    { header: 'n5', key: 'n5', align: 'r' },
    { header: '5日命中', key: 'hit5', align: 'r' },
  ]));

  // --verbose：逐条预测 → 结果 时间线（积累经验的核心视图）
  if (verbose) {
    const byCode = groupByCode(snaps);
    for (const [c, codeSnaps] of [...byCode.entries()].sort()) {
      const seq = computeOutcomes(codeSnaps);
      console.log(`\n── ${c} ${(seq[seq.length - 1] && seq[seq.length - 1].name) || ''} 预测时间线 ──────`);
      const vrows = seq.map(s => {
        const o = s.outcome;
        const hit3 = o && o[3] ? (o[3].hit === true ? '✓' : o[3].hit === false ? '✗' : '—') : '…';
        const hit5 = o && o[5] ? (o[5].hit === true ? '✓' : o[5].hit === false ? '✗' : '—') : '…';
        return {
          date: s.date,
          close: s.close,
          signal: s.signal,
          ret3: o && o[3] && o[3].ret != null ? sign(r2(o[3].ret * 100)) + '%' : '…',
          hit3,
          sr3: o && o[3] ? (o[3].supportHeld === false ? '破支撑' : o[3].hitResistance ? '触压力' : o[3].supportHeld ? '守' : '') : '',
          ret5: o && o[5] && o[5].ret != null ? sign(r2(o[5].ret * 100)) + '%' : '…',
          hit5,
        };
      });
      console.log(renderTable(vrows, [
        { header: '日期', key: 'date' },
        { header: '收盘', key: 'close', align: 'r' },
        { header: '信号', key: 'signal' },
        { header: '3日', key: 'ret3', align: 'r' },
        { header: '✓/✗', key: 'hit3', align: 'r' },
        { header: '支撑/压力', key: 'sr3' },
        { header: '5日', key: 'ret5', align: 'r' },
        { header: '✓/✗', key: 'hit5', align: 'r' },
      ]));
    }
  }
  return undefined;
}

async function dailyLessons(ctx, args) {
  const store = new DailyStore();
  const category = getFlag(args, '--category', null);
  const code = getFlag(args, '--code', null);
  const sinceDays = parseInt(getFlag(args, '--since', '0'), 10) || 0;
  const lessons = store.listLessons({ category, code, since: sinceDays ? daysAgo(sinceDays) : null });
  const sugs = store.listSuggestions();

  if (args.includes('--json')) return { lessons, suggestions: sugs };

  console.log('══ 经验教训 ══');
  if (!lessons.length) console.log('  （暂无。`ths daily lesson-add "…" --code X` 记录复盘）');
  for (const l of lessons) {
    console.log(`  [${l.category}] ${l.date} ${l.code || ''} — ${l.text}`);
  }
  console.log('\n══ 池建议 ══');
  const open = sugs.filter(s => s.status === 'open');
  if (!open.length) console.log('  （暂无待确认建议）');
  for (const s of open) {
    const tag = s.type === 'remove' ? '剔除' : s.type === 'reduce' ? '减仓观望' : '加入';
    console.log(`  [${s.id} ${tag}] ${s.code} ${s.name || ''} — ${s.reason}（${s.strength}）  执行: ths daily apply ${s.id}`);
  }
  return undefined;
}

async function dailyLessonAdd(ctx, args) {
  const store = new DailyStore();
  // text = 第一个非 --flag 参数（args 已被 cmdDaily 切掉子命令；带空格用引号包裹则为一个参数）
  const text = args.filter(a => !a.startsWith('--'))[0];
  if (!text) throw new Error('用法: ths daily lesson-add "复盘文字" [--category 分类] [--code X] [--date YYYY-MM-DD]');
  const lesson = store.addLesson({
    text,
    category: getFlag(args, '--category', '复盘'),
    code: getFlag(args, '--code', null),
    date: getFlag(args, '--date', null),
  });
  console.log(`✓ 已记录经验 [${lesson.id}] ${lesson.category}: ${lesson.text}`);
  return undefined;
}

async function dailyLessonRemove(ctx, args) {
  const store = new DailyStore();
  const id = args[0];
  if (!id) throw new Error('用法: ths daily lesson-remove <id>（ths daily lessons 查看 id）');
  const ok = store.removeLesson(id);
  if (!ok) throw new Error(`经验不存在: ${id}`);
  console.log(`✓ 已删除经验 ${id}`);
  return undefined;
}

async function dailySnapshot(ctx, args) {
  const store = new DailyStore();
  const date = getFlag(args, '--date', null) || store.listDates().slice(-1)[0];
  const code = getFlag(args, '--code', null);
  if (!date) throw new Error('暂无快照，先 `ths daily run`');
  const file = store.loadSnapshotFile(date);
  if (!file) throw new Error(`快照不存在: ${date}`);
  const rows = code
    ? (file.stocks[code] ? [{ ...file.stocks[code], marketEnv: file.marketEnv }] : [])
    : Object.keys(file.stocks).map(k => ({ ...file.stocks[k], marketEnv: file.marketEnv }));
  if (!rows.length) throw new Error(`${date} 无 ${code || '任何'} 快照`);
  if (args.includes('--json')) return { date, marketEnv: file.marketEnv, direction: file.direction, stocks: rows };
  console.log(`══ 快照 ${date} ══  ${file.marketEnv.mood ? `市场: ${file.marketEnv.mood}` : ''}`);
  if (file.direction && (file.direction.boardMood || file.direction.fundDir || file.direction.lhbJoin)) {
    console.log(renderDirectionLine(file.direction));
  }
  for (const s of rows) {
    const o = s.outcome;
    const outStr = o
      ? `  outcome: ${[3, 5].map(n => o[n] ? `${n}日${o[n].ret != null ? sign(r2(o[n].ret * 100)) + '%' : '-'} ${o[n].hit === true ? '✓' : o[n].hit === false ? '✗' : ''}${o[n].supportHeld === false ? ' 破支撑' : ''}${o[n].hitResistance ? ' 触压力' : ''}` : '').filter(Boolean).join(' | ')}`
      : '';
    const dirTag = s.dir ? `  方向[${fmtDirTag(s)}]` : '';
    const sigLabel = s.signalLabel || s.signal;
    console.log(`  ${s.code} ${s.name || ''} 收盘 ${s.close}  评分 ${s.score}/${sigLabel}  均线 ${s.maAlignment}  MACD ${s.macdStatus}  KDJ ${s.kdj ? s.kdj.k + '/' + s.kdj.d : '-'}  RSI6 ${s.rsi6}  支撑 ${s.support} 压力 ${s.resistance}${dirTag}${outStr}`);
    if (s.note) console.log(`    笔记: ${s.note}`);
  }
  return undefined;
}

async function dailyApply(ctx, args) {
  const store = new DailyStore();
  const id = args[0];
  if (!id) throw new Error('用法: ths daily apply <Sid> [--yes]');
  const sugs = store.listSuggestions();
  const sug = sugs.find(s => s.id === id);
  if (!sug) throw new Error(`建议不存在: ${id}（ths daily lessons 查看）`);
  if (sug.status !== 'open') throw new Error(`建议 ${id} 已处理（${sug.status}）`);

  const held = ctx.cache.positionGet(sug.code);
  if (held) {
    console.log(`⚠ ${sug.code} 有持仓（${held.qty} 股 @ ${held.avgCost}）。${sug.type === 'remove' ? '剔除监控不影响持仓，但请先想清楚仓位怎么处理' : '减仓/止损前先看实际仓位与支撑位'}。`);
  }

  if (!args.includes('--yes')) {
    const tag = sug.type === 'remove' ? '剔除' : sug.type === 'reduce' ? '减仓观望' : '加入';
    console.log(`将执行: ${tag} ${sug.code} ${sug.name || ''} — ${sug.reason}`);
    console.log('确认请加 --yes: ths daily apply ' + id + ' --yes');
    return undefined;
  }

  if (sug.type === 'remove') {
    const ok = ctx.cache.watchlistRemove(sug.code);
    if (!ok) console.log(`⚠ ${sug.code} 不在自选池（可能已移除）`);
    else console.log(`✓ 已从监控池移除: ${sug.code} ${sug.name || ''}`);
    // 给该股未闭合快照打 removedAt（统计时排除）
    const snaps = store.loadSnapshots({ code: sug.code });
    for (const s of snaps) {
      if (!s.outcome && !s.removedAt) store.setRemovedAt(s.date, sug.code, TODAY());
    }
  } else if (sug.type === 'add') {
    const market = inferMarket(sug.code) || '';
    let name = sug.name;
    if (!name || name === sug.code) {
      name = (await resolveName(ctx, ctx.cache, sug.code)) || sug.code;
    }
    const ok = ctx.cache.watchlistAdd({ code: sug.code, name, market });
    if (!ok) console.log(`⚠ ${sug.code} 已在自选池`);
    else console.log(`✓ 已加入监控池: ${sug.code} ${name}`);
  } else { // reduce
    console.log(`✓ 已记录减仓观望建议（${sug.code} ${sug.name || ''}）— 请按纪律执行：不追高/逢高减仓`);
  }
  store.markSuggestion(id, 'applied');
  return undefined;
}

// ═══════════════════════════════════════════════════════════
// 分发
// ═══════════════════════════════════════════════════════════

async function cmdDaily(ctx, args) {
  const sub = (args[0] || 'run').toLowerCase();
  switch (sub) {
    case 'run': return dailyRun(ctx, args.slice(1));
    case 'review': return dailyReview(ctx, args.slice(1));
    case 'lessons': return dailyLessons(ctx, args.slice(1));
    case 'lesson-add': return dailyLessonAdd(ctx, args.slice(1));
    case 'lesson-remove': return dailyLessonRemove(ctx, args.slice(1));
    case 'snapshot': return dailySnapshot(ctx, args.slice(1));
    case 'apply': return dailyApply(ctx, args.slice(1));
    case 'help':
    case '-h':
    case '--help':
      console.log(`ths daily 用法:
  daily run [--codes a,b] [--refresh] [--min-n N] [--since N] [--candidates a,b,c] [--json]  每日监控+快照+复盘+建议
  daily review [--since N] [--code X] [--min-n N] [--json]     复盘命中率统计（纯本地）
  daily lessons [--json]                                       经验教训 + 待确认池建议
  daily lesson-add "复盘文字" [--category X] [--code X]         手动记一条经验
  daily lesson-remove <id>                                    删除一条经验
  daily snapshot [--date YYYY-MM-DD] [--code X] [--json]       查看历史快照
  daily apply <Sid> [--yes]                                    执行池建议（剔除/加入/减仓）`);
      return undefined;
    default:
      throw new Error(`未知子命令 "${sub}"，可用: run/review/lessons/lesson-add/lesson-remove/snapshot/apply`);
  }
}

module.exports = cmdDaily;
