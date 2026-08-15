// lib/commands/portfolio.js — 持仓台账（记录买卖 → 盈亏/止损/盈亏比）
//
// 用法:
//   ths portfolio add <code> --qty N --price X [--name X] [--date X] [--fee X] [--note X]
//   ths portfolio sell <code> --qty N --price X [--date X] [--fee X]
//   ths portfolio list [--capital N] [--risk] [--json]
//   ths portfolio risk <code> [--json]         # 止损/目标/盈亏比（calcStopTarget）
//   ths portfolio history [code] [--json]
//   ths portfolio remove <code> | clear
//
// 数据: 持仓存 data/cache/ths.json（positions），与自选股/K线缓存同文件。

const { getFlag, renderTable, renderKV, fmtNum, inferMarket } = require('./helpers');
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

  // ── 建仓 / 加仓 ──
  if (action === 'add') {
    const code = (args[1] || '').trim();
    if (!code || !/^\d{6}$/.test(code)) throw new Error('用法: ths portfolio add <code> --qty N --price X [--name X]');
    const qty = parseInt(getFlag(args, '--qty', '0'), 10);
    const price = parseFloat(getFlag(args, '--price', '0'));
    if (!(qty > 0) || !(price > 0)) throw new Error('--qty 与 --price 必须为正数');
    const name = getFlag(args, '--name', null) || cache.positionGet(code)?.name
      || (await resolveName(ctx, cache, code));
    const pos = applyTrade(cache.positionGet(code), {
      code, name, action: 'buy', qty, price,
      fee: getFlag(args, '--fee', null) != null ? parseFloat(getFlag(args, '--fee')) : 0,
      date: getFlag(args, '--date', null), note: getFlag(args, '--note', null),
    });
    cache.positionsUpsert(pos);
    console.log(`✓ 买入 ${code}${name ? ' ' + name : ''} ${qty} 股 @ ${price}，持仓 ${pos.qty} 股，均价 ${r2(pos.avgCost)}`);
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
      if (wantRisk && mkt && mkt.price != null) {
        try {
          const bars = await loadKline(ctx, cache, { code: p.code, market: inferMarket(p.code) || '', period: 'day_1', count: 250, adjust: 'forward' }, { maxAgeMs: ttlMsForPeriod(ctx.config, 'day') });
          const st = calcStopTarget(bars, { price: mkt.price });
          s.stop = st.stopPrice; s.rr = st.riskReward;
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
      stop: s.stop != null ? r2(s.stop) : '-',
      rr: s.rr != null ? s.rr.toFixed(1) : '-',
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
      { header: '占资金', key: 'pctOf', align: 'r' },
    ]));

    console.log(`\n总市值 ${fmtNum(total.marketValue)} | 总成本 ${fmtNum(total.cost)} | 浮动 ${sign(total.floatPnl.toFixed(0))}（${sign(total.floatPct.toFixed(1))}%）| 已实现 ${sign(total.realizedPnl.toFixed(0))} 元`);
    console.log(wantRisk
      ? '\n大师提醒: 止损跌破即走（先走人再研究）；盈亏比 < 2 可减仓；浮盈后止损上移到成本线。'
      : '\n提示: 加 --risk 显示每只止损位/盈亏比；--capital N 显示仓位占比。跌破止损线即可清仓。');
    return undefined;
  }

  // ── 单只止损/目标/盈亏比 ──
  if (action === 'risk') {
    const code = (args[1] || '').trim();
    if (!code) throw new Error('用法: ths portfolio risk <code> [--json]');
    const pos = cache.positionGet(code);
    if (!pos) throw new Error(`未持有 ${code}，先 ths portfolio add`);
    const params = parseKlineArgs([code, ...args.slice(2)]);
    const bars = await loadKline(ctx, cache, params, { maxAgeMs: ttlMsForPeriod(ctx.config, params.period) });
    const mkt = (await fetchPrices(ctx, [code]))[code] || {};
    const price = mkt.price != null ? mkt.price : bars[bars.length - 1].close;
    const st = calcStopTarget(bars, { price, stop: getFlag(args, '--stop', null), target: getFlag(args, '--target', null) });
    const name = pos.name || (await resolveName(ctx, cache, code));

    if (args.includes('--json')) return { code, name, qty: pos.qty, avgCost: pos.avgCost, price, ...st };

    console.log(`${code}${name ? ' ' + name : ''} 持仓 ${pos.qty} 股 / 成本 ${r2(pos.avgCost)} / 现价 ${r2(price)}`);
    console.log(renderKV([
      { label: '止损价', value: `${r2(st.stopPrice)}（${st.stopSource}，距现价 -${st.stopDistPct != null ? st.stopDistPct.toFixed(1) : '-'}%）` },
      { label: '目标价', value: st.targetPrice != null ? `${r2(st.targetPrice)}（${st.targetSource}，上方 +${st.upsidePct != null ? st.upsidePct.toFixed(1) : '-'}%）` : '-（无上方压力位，--target 指定）' },
      { label: '盈亏比', value: st.riskReward != null ? `${st.riskReward.toFixed(1)}（${st.rrGrade}）` : '-' },
    ]));
    console.log('\n大师提醒: 止损跌破即走；盈亏比 < 2 可减仓；浮盈后止损上移到成本线。');
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
