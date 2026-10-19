// lib/commands/watch.js — 盘中实时追踪：轮询自选池行情，对照固化止损/支撑压力/涨跌停/阈值告警
//
// 定位：把 M1-1 保命环（破止损纪律）从"收盘后 daily run 亮灯"提前到"盘中破位瞬间"。
// 不生成新买卖信号、不自动执行——只对固化过的日线级阈值做边沿触发提醒。
// 状态/告警/tick 默认落盘到 data/realtime（JSONL），用于跨重启恢复与 ths replay；
// --no-journal 可关闭。
//
// 用法:
//   ths watch [--pool watchlist|--codes a,b] [--interval N(30s)] [--once]
//             [--chase 7] [--drop -5] [--vol 3] [--cooldown 300] [--until HH:MM]
//             [--quiet] [--json] [--tui] [--no-journal]
//   --once    单次体检即退出（可脚本化）；--json 与 --once 组合输出结构化结果。
//   --tui     交互式面板（需要 TTY；与 --json/--once 互斥）。
//
// 设计：
// - tick 直接用 ctx.bridgeCall 拉 quotes（不走 loggedCall），避免全天数百次轮询刷爆 audit.json。
// - 每 tick 独立 try/catch：瞬时 bridge/网络错误绝不冒泡到 cli.js:169 被当成致命错 exit(1)。
// - SIGINT 用 Node 默认（循环期无原子写在途，默认信号即干净退出）。

const { getFlag, inferMarket, isBoardIndex, formatQuotes, renderTable } = require('./helpers');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { detectSR } = require('../support-resistance');
const { buildSummary } = require('../summary');
const { toBeijingClock, marketPhase, shouldPoll } = require('../trading-hours');
const { evaluateTick, filterCooldown, DEFAULT_RULES } = require('../watch-engine');
const { getRenderOptions } = require('../render/output');
const { createState, onTick, onError, onClock, handleKey } = require('../tui/state');
const { renderScreen } = require('../tui/render');
const { Screen } = require('../tui/screen');
const { WatchJournal } = require('../realtime/watch-journal');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowStr = () => new Date().toTimeString().slice(0, 8);
const r2 = n => (n == null ? '-' : String(Math.round(Number(n) * 100) / 100));
const r1 = n => (n == null ? '-' : String(Math.round(Number(n) * 10) / 10));

const flagInt = (args, flag, dflt) => {
  const v = getFlag(args, flag, null);
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};
const flagNum = (args, flag, dflt) => {
  const v = getFlag(args, flag, null);
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

// 北京某日期给定钟面分钟 → 毫秒（用于 09:15/13:00/--until 等待目标）
function beijingAt(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60) - 8 * 3600 * 1000;
}

// --until HH:MM → 今日/明日该时刻的毫秒（已过则顺延明日）
function untilTargetMs(hhmm) {
  const [hh, mm] = hhmm.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const target = hh * 60 + mm;
  const now = Date.now();
  const cl = toBeijingClock(now);
  let ms = beijingAt(cl.dateStr, target);
  if (ms <= now) ms = beijingAt(cl.dateStr, target) + 24 * 3600 * 1000;
  return ms;
}

// 距下一个时段边界的等待时长（pre→09:15, lunch→13:00）
function nextBoundaryMs(now, phase) {
  const cl = toBeijingClock(now);
  const t = phase === 'pre' ? beijingAt(cl.dateStr, 9 * 60 + 15) : beijingAt(cl.dateStr, 13 * 60);
  const d = t - now;
  return d > 0 ? d : 60 * 1000;
}

// ── 池与参照位 ────────────────────────────────────────────────

async function resolvePool(ctx, args) {
  const codesArg = getFlag(args, '--codes', null);
  let items;
  if (codesArg) {
    items = codesArg.split(',').map(s => s.trim()).filter(Boolean).map(code => {
      const w = ctx.cache.watchlistList().find(x => x.code === String(code));
      return {
        code: String(code),
        name: (w && w.name) || ctx.cache.getName(code) || '',
        market: String((w && w.market) || inferMarket(code) || ''),
      };
    });
  } else {
    items = ctx.cache.watchlistList().map(w => ({
      code: String(w.code),
      name: (w && w.name) || ctx.cache.getName(w.code) || '',
      market: String((w && w.market) || inferMarket(w.code) || ''),
    }));
  }
  if (!items.length) throw new Error('池为空：请先 ths watchlist add，或用 --codes a,b 指定');
  for (const it of items) {
    if (!it.name) it.name = (await resolveName(ctx, ctx.cache, it.code)) || it.code;
  }
  return items;
}

// 会话启动算一次参照位：支持/压力用剔除在途末根的日 K（前复权，与实时价同尺度）；止损用固化持仓值。
async function buildLevels(ctx, items) {
  const levels = {};
  for (const it of items) {
    const pos = ctx.cache.positionGet(it.code);
    const lvl = {
      code: it.code,
      name: it.name,
      market: it.market,
      isBoard: isBoardIndex(it.code),
      support: null,
      resistance: null,
      stop: pos && pos.stopPrice != null ? Number(pos.stopPrice) : null,
      warn: pos && pos.stopPrice != null ? '固化止损' : '',
    };
    if (!lvl.isBoard) {
      let bars = null;
      try {
        bars = await loadKline(ctx, ctx.cache, {
          code: it.code, market: it.market || '17', period: 'day_1', count: 120, adjust: 'forward',
        }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day'), excludeForming: true });
      } catch (e) { bars = null; }
      if (bars && bars.length >= 7) {
        const sr = detectSR(bars);
        lvl.support = sr.support.length ? Number(sr.support[0].price) : null;
        lvl.resistance = sr.resistance.length ? Number(sr.resistance[0].price) : null;
        // TUI 详情页复用：保留日K与摘要（仅内存，不落盘）
        lvl.bars = bars;
        try { lvl.summary = buildSummary(it.code, bars, { sr }); } catch (e) { lvl.summary = null; }
      }
    }
    levels[it.code] = lvl;
  }
  return levels;
}

async function fetchQuotes(ctx, items) {
  const payload = items.map(it => ({ code: it.code, market: it.market || inferMarket(it.code) || '0' }));
  const resp = await ctx.bridgeCall(`window.__ths.quotes(${JSON.stringify(payload)})`);
  return formatQuotes(resp);
}

function toQMap(items, quotes) {
  const m = {};
  for (const it of items) m[it.code] = null;
  for (const q of quotes) m[String(q.code)] = q;
  return m;
}

// ── 展示 ───────────────────────────────────────────────────────

const COLS = [
  { header: '代码', key: 'code' },
  { header: '名称', key: 'name' },
  { header: '现价', key: 'price' },
  { header: '涨跌%', key: 'pct' },
  { header: '距支撑', key: 'distSup' },
  { header: '距压力', key: 'distRes' },
  { header: '止损', key: 'stopTxt' },
  { header: '量比', key: 'vr' },
  { header: '状态', key: 'status' },
];

function statusOf(sCode, price) {
  if (sCode && sCode.board) return '板块风向';
  if (sCode && sCode.frozen) return '停牌/无成交';
  const c = (sCode && sCode.cond) || {};
  if (c.stop) return '🔴破止损';
  if (c.support) return '🔴破支撑';
  if (c.resistance) return '🟠触压力';
  if (c.chase) return '🟠追高';
  if (c.drop) return '🟠急跌';
  if (c.limitDown) return '🟡封跌停';
  if (c.limitUp) return '🟡封涨停';
  if (c.vol) return '🟡放量';
  return '';
}

function buildRows(items, qMap, levels, state) {
  return items.map(it => {
    const q = qMap[it.code];
    const lvl = levels[it.code] || {};
    const sCode = (state || {})[it.code];
    const price = q && q.price != null ? Number(q.price) : null;
    const pct = q && q.pct != null ? Number(q.pct) : null;
    const vr = q && q.volumeRatio != null ? Number(q.volumeRatio) : null;
    const dist = (ref) => {
      if (ref == null || price == null) return '-';
      const p = ((price - ref) / ref) * 100;
      return (p > 0 ? '+' : '') + p.toFixed(1) + '%';
    };
    const c = (sCode && sCode.cond) || {};
    return {
      code: it.code,
      name: it.name || it.code,
      price: price == null ? '-' : r2(price),
      pct: pct == null ? '-' : `${pct > 0 ? '+' : ''}${r1(pct)}%`,
      distSup: dist(lvl.support),
      distRes: dist(lvl.resistance),
      stopTxt: lvl.stop == null ? '-' : r2(lvl.stop) + (c.stop ? ' ▼' : ''),
      vr: vr == null ? '-' : r2(vr),
      status: q == null ? '⏳ 无行情' : statusOf(sCode, price),
    };
  });
}

function printTick(payload, rules, interval, quiet = false) {
  // --quiet：后台常驻时只落告警（例行 tick 不刷日志）
  if (!quiet) {
    const tickTxt = payload.tick ? ` · tick #${payload.tick}` : '';
    console.log(`\n[${nowStr()}] ${payload.label} · 盯 ${payload.quotes.length} 只${tickTxt} · 轮询 ${interval}s · 阈值 追高≥${rules.chasePct}% 急跌≤${rules.dropPct}% 量比≥${rules.volRatio}`);
    console.log(renderTable(payload.quotes, COLS));
  }
  for (const a of payload.alerts) {
    console.log(`${a.icon || '⚠'} ${a.name} ${a.code}：${a.message}  [${nowStr()}]`);
  }
  if (!payload.alerts.length && !quiet) console.log('  （本 tick 无触发）');
}

// ── TUI 模式 ───────────────────────────────────────────────────

/**
 * 盘中交互式盯盘（alt screen + 行级 diff + 热键）。
 * 复用 line 模式的取数/告警引擎，只替换渲染与输入。
 */
async function runTui(ctx, items, levels, rules, interval, untilMs, journal = null, saved = null, restoredAlerts = [], cooldownMs = 5 * 60 * 1000) {
  const ro = getRenderOptions();
  const screen = new Screen(process.stdout);
  let state = {
    ...createState({
      items,
      levels,
      rules,
      alerts: restoredAlerts,
      priceHistory: (saved && saved.priceHistory) || {},
    }),
    interval,
    tickNo: (saved && saved.tickNo) || 0,
  };
  state.prevState = (saved && saved.prevState) || {};
  let running = true;
  let pending = false;
  let timer = null;
  let clockTimer = null;
  let resolveDone;
  const done = new Promise(r => { resolveDone = r; });

  const draw = (full = false) => {
    if (!running) return;
    screen.render(renderScreen(state, {
      width: screen.width,
      height: screen.height,
      color: ro.color,
      theme: ro.theme,
    }), { full });
  };

  const cleanupInput = () => {
    if (process.stdin.off) {
      process.stdin.off('keypress', onKey);
    }
    process.stdout.off('resize', onResize);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false); } catch (e) { /* ignore */ }
    }
    process.stdin.pause();
  };

  const stop = (msg) => {
    if (!running) return;
    running = false;
    if (timer) clearTimeout(timer);
    if (clockTimer) clearInterval(clockTimer);
    cleanupInput();
    screen.exit();
    if (msg) console.log(msg);
    resolveDone();
  };

  const schedule = () => {
    if (!running) return;
    const fails = state.consecFails || 0;
    const delay = fails
      ? Math.min(interval * (2 ** Math.min(fails, 4)), 300)
      : interval;
    timer = setTimeout(tick, delay * 1000);
  };

  const tick = async () => {
    if (!running) return;
    if (untilMs && Date.now() >= untilMs) { stop('[watch] 已达 --until，退出盯盘。'); return; }
    if (state.paused) { schedule(); return; }
    if (pending) return;

    const now = Date.now();
    const clock = marketPhase(now);
    state = {
      ...state,
      phase: clock.phase,
      inSession: clock.inSession,
      label: clock.label,
      now,
    };
    if (clock.phase === 'weekend') { stop('[watch] 周末休市——今日盯盘结束，退出。'); return; }
    if (clock.phase === 'post') { stop('[watch] 已收盘（15:00）——今日盯盘结束，退出。'); return; }
    if (!shouldPoll(clock.phase)) { draw(); schedule(); return; }

    pending = true;
    try {
      const quotes = await fetchQuotes(ctx, items);
      if (!quotes.length) throw new Error('未返回行情数据（Bridge/页面可能异常）');
      const qMap = toQMap(items, quotes);
      if (items.every(it => !qMap[it.code] || qMap[it.code].price == null)) {
        throw new Error('全部标的无有效行情（Bridge/页面可能异常）');
      }

      const evaluated = evaluateTick({
        quotes, levels, rules,
        prevState: state.prevState || {},
        phase: clock.phase,
      });
      const statusByCode = {};
      for (const code of Object.keys(levels)) {
        if (levels[code].isBoard) { statusByCode[code] = 'info'; continue; }
        const q = qMap[code];
        if (!q || q.price == null) { statusByCode[code] = ''; continue; }
        const cond = (evaluated.state[code] && evaluated.state[code].cond) || {};
        statusByCode[code] =
          (cond.stop || cond.support) ? 'critical'
            : (cond.resistance || cond.chase || cond.drop) ? 'warn'
              : (cond.vol || cond.limitUp || cond.limitDown) ? 'info' : '';
      }

      // 同一 (code, kind) 冷却，避免阈值附近震荡刷屏
      let alerts = filterCooldown(evaluated.alerts, state.alerts, now, cooldownMs);
      // 首次运行（当日无恢复状态）时，对已经处于破位的标的补一条“启动告警”，
      // 避免重启/晚启动时漏掉“已经跌破止损”。
      if (!saved || !saved.prevState) {
        const startup = [];
        for (const code of Object.keys(levels)) {
          if (levels[code].isBoard) continue;
          const cond = (evaluated.state[code] && evaluated.state[code].cond) || {};
          if (!cond.stop && !cond.support) continue;
          const price = qMap[code] && qMap[code].price;
          startup.push({
            code,
            name: levels[code].name || code,
            kind: cond.stop ? 'stop' : 'support',
            level: 'critical',
            icon: '🔴',
            message: `启动时已处于${cond.stop ? '破止损' : '破支撑'}状态（现价 ${price}）`,
            startup: true,
          });
        }
        alerts = startup.concat(alerts);
      }

      let enriched = alerts;
      if (journal) {
        try { enriched = journal.appendAlerts(alerts, now); } catch (e) { /* 不阻塞盯盘 */ }
        try { journal.appendTick({ ts: now, phase: clock.phase, quotes: qMap }); } catch (e) { /* ignore */ }
      }

      state = onTick(state, {
        ts: now,
        phase: clock.phase,
        inSession: clock.inSession,
        label: clock.label,
        quotes: qMap,
        statusByCode,
        alerts: enriched,
      });
      state.prevState = evaluated.state;
      if (journal) {
        try {
          journal.saveState({
            prevState: evaluated.state,
            priceHistory: state.priceHistory,
            tickNo: state.tickNo,
            phase: clock.phase,
            lastTickAt: now,
          });
        } catch (e) { /* ignore */ }
      }
      draw();
      schedule();
    } catch (e) {
      state = onError(state, e);
      draw();
      schedule();
    } finally {
      pending = false;
    }
  };

  // ── 输入 ──
  const readline = require('readline');
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.resume();

  const onKey = (str, key) => {
    if (!running) return;
    const ackedBefore = new Set(state.alerts.filter(a => a.acked).map(a => a.id));
    const res = handleKey(state, str, key);
    state = res.state;
    if (journal) {
      for (const a of state.alerts) {
        if (a.acked && !ackedBefore.has(a.id)) {
          try { journal.appendAck(a.id); } catch (e) { /* ignore */ }
        }
      }
    }
    if (res.quit) { stop('[watch] 盯盘结束。'); return; }
    if (res.refresh) {
      if (timer) clearTimeout(timer);
      tick();
      return;
    }
    draw();
  };
  const onResize = () => {
    screen.resize(process.stdout.columns, process.stdout.rows);
    draw(true);
  };
  const onSignal = () => stop('[watch] 收到退出信号。');

  process.stdin.on('keypress', onKey);
  process.stdout.on('resize', onResize);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  screen.enter();
  draw(true);
  clockTimer = setInterval(() => {
    if (!running) return;
    state = onClock(state);
    draw();
  }, 1000);
  tick();
  await done;
  return undefined;
}

// ── 命令入口 ───────────────────────────────────────────────────

async function cmdWatch(ctx, args) {
  const once = args.includes('--once');
  const json = args.includes('--json');
  const quiet = args.includes('--quiet');
  const tui = args.includes('--tui');
  const interval = Math.max(5, flagInt(args, '--interval', 30) || 30); // 秒
  const rules = {
    chasePct: flagNum(args, '--chase', DEFAULT_RULES.chasePct),
    dropPct: flagNum(args, '--drop', DEFAULT_RULES.dropPct),
    volRatio: flagNum(args, '--vol', DEFAULT_RULES.volRatio),
  };
  const untilMs = getFlag(args, '--until', null) ? untilTargetMs(getFlag(args, '--until', null)) : null;
  const cooldownMs = Math.max(0, flagInt(args, '--cooldown', 300)) * 1000;

  if (tui) {
    if (once) throw new Error('--tui 与 --once 不能同时使用');
    if (json) throw new Error('--tui 与 --json 不能同时使用');
    if (!process.stdout.isTTY) throw new Error('--tui 需要交互式终端（TTY）');
  }

  const items = await resolvePool(ctx, args);
  const levels = await buildLevels(ctx, items);

  // 盘中状态/告警 journal（--once 不写；--no-journal 可关闭）
  const journal = (!once && !args.includes('--no-journal')) ? new WatchJournal() : null;
  const saved = journal ? journal.loadState() : null;
  const restoredAlerts = journal ? journal.listAlerts().slice(-200).reverse() : [];

  if (tui) return runTui(ctx, items, levels, rules, interval, untilMs, journal, saved, restoredAlerts, cooldownMs);

  if (once) {
    const clock = marketPhase(Date.now());
    const quotes = await fetchQuotes(ctx, items);
    const qMap = toQMap(items, quotes);
    const { alerts, state } = evaluateTick({ quotes, levels, rules, prevState: {}, phase: clock.phase });
    const payload = {
      ts: new Date().toISOString(),
      phase: clock.phase,
      inSession: clock.inSession,
      label: clock.label,
      quotes: buildRows(items, qMap, levels, state),
      alerts,
    };
    if (json) return payload;
    printTick(payload, rules, interval, quiet);
    return undefined;
  }

  // ── 前台循环 ──
  let prevState = (saved && saved.prevState) || {};
  let tickNo = (saved && saved.tickNo) || 0;
  let consecFails = 0;
  let lastPrintedPhase = null;
  let startupDone = !!(saved && saved.prevState);
  let alertHistory = restoredAlerts.slice();

  for (;;) {
    const now = Date.now();
    if (untilMs && now >= untilMs) { console.log('[watch] 已达 --until，退出盯盘。'); break; }
    const clock = marketPhase(now);
    const phase = clock.phase;

    if (phase === 'weekend') { console.log('[watch] 周末休市——今日盯盘结束，退出。'); break; }
    if (phase === 'post') { console.log('[watch] 已收盘（15:00）——今日盯盘结束，退出。'); break; }

    if (shouldPoll(phase)) {
      try {
        const quotes = await fetchQuotes(ctx, items);
        consecFails = 0;
        const qMap = toQMap(items, quotes);
        const { alerts, state } = evaluateTick({ quotes, levels, rules, prevState, phase });
        prevState = state;
        tickNo += 1;
        let enriched = filterCooldown(alerts, alertHistory, now, cooldownMs);
        if (!startupDone) {
          startupDone = true;
          const startup = [];
          for (const code of Object.keys(levels)) {
            if (levels[code].isBoard) continue;
            const cond = (state[code] && state[code].cond) || {};
            if (!cond.stop && !cond.support) continue;
            startup.push({
              code,
              name: levels[code].name || code,
              kind: cond.stop ? 'stop' : 'support',
              level: 'critical',
              icon: '🔴',
              message: `启动时已处于${cond.stop ? '破止损' : '破支撑'}状态（现价 ${qMap[code] && qMap[code].price}）`,
              startup: true,
            });
          }
          if (startup.length) enriched = startup.concat(enriched);
        }
        if (journal) {
          try { enriched = journal.appendAlerts(enriched, now); } catch (e) { /* ignore */ }
          try { journal.appendTick({ ts: now, phase, quotes: qMap }); } catch (e) { /* ignore */ }
          try {
            journal.saveState({ prevState: state, tickNo, phase, lastTickAt: now });
          } catch (e) { /* ignore */ }
        }
        alertHistory = enriched.concat(alertHistory).slice(0, 200);
        const payload = {
          tick: tickNo, ts: new Date().toISOString(), phase, inSession: clock.inSession, label: clock.label,
          quotes: buildRows(items, qMap, levels, state), alerts: enriched,
        };
        printTick(payload, rules, interval, quiet);
        if (enriched.length && !quiet && process.stdout.isTTY) process.stdout.write('\x07');
      } catch (e) {
        consecFails += 1;
        const hint = consecFails >= 3 ? '（连续失败——检查 Bridge 服务与浏览器油猴是否在线）' : '';
        console.log(`  ⚠ [${nowStr()}] tick 失败：${e.message}${hint}`);
        if (consecFails >= 6) { console.log('  ⚠ 连续失败过多，退出盯盘。'); break; }
      }
      await sleep(interval * 1000);
    } else {
      // pre / lunch：等待开市/复市
      if (phase !== lastPrintedPhase) {
        console.log(`[watch] ${clock.label}——等待开市…（可 Ctrl+C 退出）`);
        lastPrintedPhase = phase;
      }
      await sleep(Math.min(nextBoundaryMs(now, phase), interval * 1000 * 2));
    }
  }
  return undefined;
}

module.exports = cmdWatch;
