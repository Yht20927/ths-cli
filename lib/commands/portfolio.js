// lib/commands/portfolio.js — 持仓台账（记录买卖 → 盈亏/止损/盈亏比）
//
// 用法:
//   ths portfolio add <code> --qty N --price X [--name X] [--stop X] [--date X] [--fee X] [--note X]
//   ths portfolio sell <code> --qty N --price X [--date X] [--fee X]
//   ths portfolio list [--capital N] [--risk] [--json]
//   ths portfolio risk <code> [--stop <价> --save] [--json]  # 固化止损/目标/盈亏比
//   ths portfolio history [code] [--json]
//   ths portfolio remove <code> | clear
//
// 数据: 持仓存 data/cache/ths.json（positions），与自选股/K线缓存同文件。
// M1-1: 建仓时固化 stopPrice（calcStopTarget），之后 daily/portfolio 用固化值查破位，
//       不再每天重算导致"止损位漂移"。

const { getFlag, renderTable, renderKV, fmtNum, inferMarket, isBoardIndex } = require('./helpers');
const { applyTrade, summarizePosition, portfolioSummary } = require('../portfolio');
const { resolveName, loadKline, ttlMsForPeriod } = require('../cache');
const { calcStopTarget } = require('../position');
const { parseKlineArgs } = require('./kline');

const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + n);
const r2 = v => (v == null ? '-' : Number(v.toFixed(2)));

/** 批量取现价: [{code} → {price, pct, name}]（走油猴批量行情，失败静默） */
async function fetchPrices(ctx, codes) {
  const items = codes
    .map(code => ({ code, market: inferMarket(code) || '' }))
    .filter(it => it.market);
  if (!items.length) return {};
  try {
    const raw = await ctx.loggedCall('portfolio-quotes', { count: items.length },
      `window.__ths.quotes(${JSON.stringify(items)})`);
    const { formatQuotes } = require('./helpers');
    const map = {};
    for (const q of formatQuotes(raw)) {
      map[q.code] = { price: q.price, pct: q.pct, name: q.name };
    }
    return map;
  } catch (e) {
    return {};
  }
}

async function cmdPortfolio(ctx, args) {
  const cache = ctx.cache;
  const action = (args[0] || '').toLowerCase();

  // ── 建仓 / 加仓（M1-1 建仓即固化止损）──
  if (action === 'add') {
    const code = (args[1] || '').trim();
    if (!code || !/^\d{6}$/.test(code)) throw new Error('用法: ths portfolio add <code> --qty N --price X [--name X]');
    if (isBoardIndex(code)) throw new Error(`⚠ ${code} 是同花顺板块指数，不可直接买入——板块指数仅供观察强弱，请换真实个股代码。`);
    const qty = parseInt(getFlag(args, '--qty', '0'), 10);
    const price = parseFloat(getFlag(args, '--price', '0'));
    if (!(qty > 0) || !(price > 0)) throw new Error('--qty 与 --price 必须为正数');
    const name = getFlag(args, '--name', null) || cache.positionGet(code)?.name
      || (await resolveName(ctx, cache, code));
    const prev = cache.positionGet(code);
    // 止损固化：新开仓或显式 --stop 时计算并固化；加仓未指定 --stop → 保留原止损（applyTrade 处理）
    const stopArg = getFlag(args, '--stop', null);
    let stopPrice = null, stopSource = null, stopWarn = null;
    if (stopArg != null) {
      stopPrice = parseFloat(stopArg);
      if (!(stopPrice > 0)) throw new Error('--stop 必须为正数（止损价）');
      stopSource = '手动';
    } else if (!prev) {
      try {
        const bars = await loadKline(ctx, cache,
          { code, market: inferMarket(code) || '', period: 'day', count: 120, adjust: 'forward' },
          { maxAgeMs: ttlMsForPeriod(ctx.config, 'day') });
        if (bars && bars.length >= 30) {
          const st = calcStopTarget(bars, { price });
          stopPrice = st.stopPrice;
          stopSource = st.stopSource;
        } else {
          stopWarn = 'K线数据不足，未能固化止损';
        }
      } catch (e) {
        stopWarn = `未能固化止损（K线获取失败: ${e.message}）`;
      }
    }
    const pos = applyTrade(prev, {
      code, name, action: 'buy', qty, price,
      fee: getFlag(args, '--fee', null) != null ? parseFloat(getFlag(args, '--fee')) : 0,
      date: getFlag(args, '--date', null), note: getFlag(args, '--note', null),
      stopPrice, stopSource,
    });
    cache.positionsUpsert(pos);
    const stopStr = pos.stopPrice != null
      ? `，止损 ${r2(pos.stopPrice)}（${pos.stopSource}）`
      : stopWarn ? `，⚠ ${stopWarn}`
      : prev ? '' // 加仓保留原止损，stopPrice 非空时已走上面分支；此处仅当原持仓无止损
      : '，⚠ 未设止损（建议 ths portfolio risk 补设 --stop）';
    console.log(`✓ 买入 ${code}${name ? ' ' + name : ''} ${qty} 股 @ ${price}，持仓 ${pos.qty} 股，均价 ${r2(pos.avgCost)}${stopStr}`);
    return undefined;
  }

  // ── 减仓 / 清仓 ──
  if (action === 'sell') {
    const code = (args[1] || '').trim();
    if (!code) throw new Error('用法: ths portfolio sell <code> --qty N --price X');
    const pos = cache.positionGet(code);
    if (!pos) throw new Error(`未持有 ${code}，先 ths portfolio add`);
    const qty = parseInt(getFlag(args, '--qty', '0'), 10);
    const price = parseFloat(getFlag(args, '--price', '0'));
    if (!(qty > 0) || !(price > 0)) throw new Error('--qty 与 --price 必须为正数');
    const next = applyTrade(pos, {
      code, action: 'sell', qty, price,
      fee: getFlag(args, '--fee', null) != null ? parseFloat(getFlag(args, '--fee')) : 0,
      date: getFlag(args, '--date', null), note: getFlag(args, '--note', null),
    });
    const realized = next.realizedPnl - pos.realizedPnl;
    if (next.qty === 0) cache.positionsRemove(code);
    else cache.positionsUpsert(next);
    console.log(`✓ 卖出 ${code} ${qty} 股 @ ${price}，本笔实现盈亏 ${sign(realized.toFixed(0))} 元${next.qty === 0 ? '（已清仓）' : '，剩余 ' + next.qty + ' 股'}`);
    return undefined;
  }

  // ── 持仓总览 ──
  if (action === 'list' || action === 'ls') {
    const positions = cache.positionsList().filter(p => p.qty > 0);
    if (!positions.length) {
      console.log('暂无持仓。`ths portfolio add <code> --qty N --price X` 建仓。');
      return undefined;
    }
    const prices = await fetchPrices(ctx, positions.map(p => p.code));
    const capital = getFlag(args, '--capital', null) != null ? parseFloat(getFlag(args, '--capital')) : null;
    const wantRisk = args.includes('--risk');

    const summaries = [];
    for (const p of positions) {
      const mkt = prices[p.code];
      const s = summarizePosition(p, mkt);
      // 止损 = 建仓时固化的 stopPrice（不重算，防"跌破旧止损后工具悄悄重算更低支撑当新止损"）
      s.stop = p.stopPrice != null ? Number(p.stopPrice) : null;
      s.stopSource = p.stopSource || null;
      s.stopBroken = (mkt && mkt.price != null && s.stop != null) ? mkt.price <= s.stop : false;
      s.violationStreak = p.violationStreak || 0;
      // 盈亏比：仍现算，但风险空间用固化止损（--risk 时），目标/盈亏比观察用
      if (wantRisk && mkt && mkt.price != null && s.stop != null) {
        try {
          const bars = await loadKline(ctx, cache, { code: p.code, market: inferMarket(p.code) || '', period: 'day_1', count: 250, adjust: 'forward' }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day') });
          const st = calcStopTarget(bars, { price: mkt.price, stop: s.stop });
          s.rr = st.riskReward;
        } catch (e) { /* K线失败不阻塞 */ }
      }
      summaries.push(s);
    }
    const total = portfolioSummary(summaries);

    if (args.includes('--json')) {
      return { positions: summaries, total };
    }

    console.log(`持仓 ${summaries.length} 只:`);
    console.log(renderTable(summaries.map(s => ({
      code: s.code,
      name: s.name || '-',
      qty: s.qty,
      avgCost: r2(s.avgCost),
      price: r2(s.price),
      pct: s.pct != null ? sign(Number(s.pct.toFixed(2))) + '%' : '-',
      float: sign(s.floatPnl.toFixed(0)) + '（' + sign(s.floatPct.toFixed(1)) + '%）',
      realized: sign(s.realizedPnl.toFixed(0)),
      stop: s.stop != null ? r2(s.stop) + (s.stopBroken ? ' ⚠' : '') : '-',
      rr: s.rr != null ? s.rr.toFixed(1) : '-',
      riskAlert: s.stopBroken ? `破位·${s.violationStreak}天` : (s.stop == null ? '未设止损' : '-'),
      pctOf: capital ? ((s.marketValue / capital) * 100).toFixed(1) + '%' : '-',
    })), [
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '持仓', key: 'qty', align: 'r' },
      { header: '成本', key: 'avgCost', align: 'r' },
      { header: '现价', key: 'price', align: 'r' },
      { header: '今日', key: 'pct', align: 'r' },
      { header: '浮动盈亏', key: 'float', align: 'r' },
      { header: '已实现', key: 'realized', align: 'r' },
      { header: '止损', key: 'stop', align: 'r' },
      { header: '盈亏比', key: 'rr', align: 'r' },
      { header: '止损状态', key: 'riskAlert' },
      { header: '占资金', key: 'pctOf', align: 'r' },
    ]));

    const noStop = summaries.filter(s => s.stop == null).length;
    console.log(`\n总市值 ${fmtNum(total.marketValue)} | 总成本 ${fmtNum(total.cost)} | 浮动 ${sign(total.floatPnl.toFixed(0))}（${sign(total.floatPct.toFixed(1))}%）| 已实现 ${sign(total.realizedPnl.toFixed(0))} 元`);
    if (summaries.some(s => s.stopBroken)) {
      console.log(`\n🔴 ${summaries.filter(s => s.stopBroken).length} 只破位固化止损——先走人再研究，不要等反弹。`);
    }
    console.log(wantRisk
      ? `\n大师提醒: 止损跌破即走（先走人再研究）；盈亏比 < 2 可减仓；浮盈后止损上移到成本线（ths portfolio risk <code> --stop <价> --save）。${noStop ? `\n⚠ ${noStop} 只未设止损，建议 ths portfolio risk <code> --stop <价> --save 固化。` : ''}`
      : `\n提示: 加 --risk 显示盈亏比；止损 = 建仓时固化值，破位会打 ⚠。${noStop ? `\n⚠ ${noStop} 只未设止损（旧台账），建议 ths portfolio risk <code> --stop <价> --save 固化。` : ''}`);
    return undefined;
  }

  // ── 单只止损/目标/盈亏比（M1-1 优先显示固化止损）──
  if (action === 'risk') {
    const code = (args[1] || '').trim();
    if (!code) throw new Error('用法: ths portfolio risk <code> [--stop <价> --save] [--json]');
    const pos = cache.positionGet(code);
    if (!pos) throw new Error(`未持有 ${code}，先 ths portfolio add`);
    const params = parseKlineArgs([code, ...args.slice(2)]);
    const bars = await loadKline(ctx, cache, params, { maxAgeMs: ttlMsForPeriod(ctx.config, params.period) });
    const mkt = (await fetchPrices(ctx, [code]))[code] || {};
    const price = mkt.price != null ? mkt.price : bars[bars.length - 1].close;
    const stopArg = getFlag(args, '--stop', null);
    const st = calcStopTarget(bars, { price, stop: stopArg, target: getFlag(args, '--target', null) });
    const name = pos.name || (await resolveName(ctx, cache, code));

    // --stop --save：固化/上移止损（浮盈止损上移到成本线等纪律落地）
    if (stopArg != null && args.includes('--save')) {
      const stopPrice = parseFloat(stopArg);
      if (!(stopPrice > 0)) throw new Error('--stop 必须为正数（止损价）');
      cache.positionsUpsert({ ...pos, stopPrice, stopSource: '手动', stopSetAt: new Date().toISOString() });
      console.log(`✓ 已固化止损为 ${r2(stopPrice)}（手动）${name ? name : code}`);
      return undefined;
    }

    const solid = pos.stopPrice != null ? Number(pos.stopPrice) : null;
    const solidDist = (solid != null && price > 0) ? ((price - solid) / price) * 100 : null;
    const solidBroken = solid != null && price <= solid;

    if (args.includes('--json')) {
      return {
        code, name, qty: pos.qty, avgCost: pos.avgCost, price,
        stopSolid: solid, stopSolidSource: pos.stopSource || null,
        violationStreak: pos.violationStreak || 0, stopBroken: solidBroken, ...st,
      };
    }

    console.log(`${code}${name ? ' ' + name : ''} 持仓 ${pos.qty} 股 / 成本 ${r2(pos.avgCost)} / 现价 ${r2(price)}`);
    console.log(renderKV([
      { label: '固化止损', value: solid != null
          ? `${r2(solid)}（${pos.stopSource}${pos.stopSetAt ? '·' + pos.stopSetAt.slice(0, 10) : ''}，距现价 ${solidDist != null ? sign(solidDist.toFixed(1)) + '%' : '-'}${pos.violationStreak ? `，连续违规 ${pos.violationStreak} 天` : ''}${solidBroken ? '，⚠ 已破位' : ''}）`
          : '未固化（旧台账）——`--stop <价> --save` 补设' },
      { label: '现算建议', value: `${r2(st.stopPrice)}（${st.stopSource}，距现价 -${st.stopDistPct != null ? st.stopDistPct.toFixed(1) : '-'}%）` },
      { label: '目标价', value: st.targetPrice != null ? `${r2(st.targetPrice)}（${st.targetSource}，上方 +${st.upsidePct != null ? st.upsidePct.toFixed(1) : '-'}%）` : '-（无上方压力位，--target 指定）' },
      { label: '盈亏比', value: st.riskReward != null ? `${st.riskReward.toFixed(1)}（${st.rrGrade}）` : '-' },
    ]));
    console.log('\n大师提醒: 止损跌破即走；盈亏比 < 2 可减仓；浮盈后止损上移到成本线 —— `ths portfolio risk <code> --stop <价> --save` 固化。');
    return undefined;
  }

  // ── 交易流水 ──
  if (action === 'history' || action === 'log') {
    const code = args[1] ? args[1].trim() : null;
    const positions = code ? [cache.positionGet(code)].filter(Boolean) : cache.positionsList();
    if (!positions.length) { console.log('无交易记录。'); return undefined; }
    const trades = positions.flatMap(p => (p.trades || []).map(t => ({ ...t, code: p.code, name: p.name })))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (args.includes('--json')) return trades;
    console.log(`交易流水 ${trades.length} 笔:`);
    console.log(renderTable(trades.map(t => ({
      date: (t.date || '').slice(0, 10),
      code: t.code,
      name: t.name || '-',
      action: t.action === 'buy' ? '买入' : '卖出',
      qty: t.qty,
      price: r2(t.price),
      fee: t.fee || 0,
      note: t.note || '',
    })), [
      { header: '日期', key: 'date' },
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '方向', key: 'action' },
      { header: '数量', key: 'qty', align: 'r' },
      { header: '价格', key: 'price', align: 'r' },
      { header: '费用', key: 'fee', align: 'r' },
      { header: '备注', key: 'note' },
    ]));
    return undefined;
  }

  // ── 移除 / 清空 ──
  if (action === 'remove') {
    const code = (args[1] || '').trim();
    if (!code) throw new Error('用法: ths portfolio remove <code>');
    if (!cache.positionsRemove(code)) throw new Error(`持仓中不存在 ${code}`);
    console.log(`✓ 已移除持仓 ${code}`);
    return undefined;
  }
  if (action === 'clear') {
    cache.positionsClear();
    console.log('✓ 已清空持仓台账');
    return undefined;
  }

  throw new Error('用法: ths portfolio add|sell|list|risk|history|remove|clear');
}

module.exports = cmdPortfolio;
