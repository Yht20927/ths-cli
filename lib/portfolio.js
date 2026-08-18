// lib/portfolio.js — 持仓台账逻辑（纯函数，可单测）
//
// 记账规则（先进先摊薄成本）：
//   - 买入: 新平均成本 = (旧数量×旧成本 + 买入数量×买入价) / 新数量
//   - 卖出: 已实现盈亏 = (卖出价 - 平均成本) × 卖出数量 - 费用
//   - 每笔交易追加 trades 流水，日期可注入（默认为当前）
//
// 持仓记录形如：
//   { code, name, qty, avgCost, openedAt, realizedPnl, trades: [{action, qty, price, fee, date, note}],
//     stopPrice, stopSource, stopSetAt,                    // 建仓时固化的止损（M1-1）
//     violationStreak, violationStart, lastViolationDate } // 破位违规计数（daily run 写回）}

const now = () => new Date().toISOString();

function isNum(v) { return typeof v === 'number' && isFinite(v); }

/**
 * 应用一笔交易（buy/sell）到持仓，返回新持仓记录。
 * @param {object|null} pos - 当前持仓；buy 时可 null（新开）
 * @param {object} trade - { code?, name?, action, qty, price, fee?, date?, note?, stopPrice?, stopSource? }
 *   stopPrice: 显式提供（如 --stop）则固化/覆盖止损；加仓不传则保留原止损
 * @returns {object} 新持仓记录
 */
function applyTrade(pos, trade = {}) {
  const { action, qty, price } = trade;
  if (!['buy', 'sell'].includes(action)) throw new Error(`未知操作 ${action}，可选 buy|sell`);
  if (!(Number(qty) > 0)) throw new Error('数量必须为正');
  if (!(Number(price) > 0)) throw new Error('价格必须为正');
  const fee = trade.fee != null && isNum(Number(trade.fee)) ? Number(trade.fee) : 0;
  const date = trade.date || now();
  const record = { action, qty: Number(qty), price: Number(price), fee, date, note: trade.note || null };

  if (action === 'buy') {
    const curQty = pos ? pos.qty : 0;
    const curCost = pos ? pos.qty * pos.avgCost : 0;
    const newQty = curQty + Number(qty);
    // 止损固化：新开仓取 trade 值（可为 null）；加仓默认保留原止损，仅显式 --stop 才覆盖
    const setStop = trade.stopPrice != null && isNum(Number(trade.stopPrice));
    const stopPrice = setStop ? Number(trade.stopPrice)
      : (pos && pos.stopPrice != null ? pos.stopPrice : null);
    const stopSource = setStop ? (trade.stopSource || '手动')
      : (pos && pos.stopSource != null ? pos.stopSource : null);
    return {
      code: pos ? pos.code : String(trade.code),
      name: pos ? pos.name : (trade.name || null),
      qty: newQty,
      avgCost: newQty ? (curCost + Number(qty) * Number(price)) / newQty : 0,
      openedAt: pos ? pos.openedAt : date,
      realizedPnl: pos ? pos.realizedPnl : 0,
      stopPrice,
      stopSource,
      stopSetAt: setStop ? date : (pos ? pos.stopSetAt : null),
      violationStreak: pos && pos.violationStreak ? pos.violationStreak : 0,
      violationStart: pos && pos.violationStart != null ? pos.violationStart : null,
      lastViolationDate: pos && pos.lastViolationDate != null ? pos.lastViolationDate : null,
      trades: [...(pos ? pos.trades : []), record],
    };
  }

  // sell
  if (!pos) throw new Error('未持有该股票，无法卖出');
  if (Number(qty) > pos.qty) throw new Error(`卖出数量 ${Number(qty)} 超过持仓 ${pos.qty}`);
  const realized = (Number(price) - pos.avgCost) * Number(qty) - fee;
  return {
    ...pos,
    qty: pos.qty - Number(qty),
    realizedPnl: pos.realizedPnl + realized,
    trades: [...pos.trades, record],
  };
}

/**
 * 单只持仓摘要（给定现价）。
 * @param {object} pos
 * @param {object} [mkt] - { price, pct, name } 当前行情（无则用成本价）
 * @returns {object} { code, name, qty, avgCost, price, marketValue, cost, floatPnl, floatPct, realizedPnl }
 */
function summarizePosition(pos, mkt = null) {
  const price = mkt && isNum(Number(mkt.price)) ? Number(mkt.price) : pos.avgCost;
  const cost = pos.qty * pos.avgCost;
  const marketValue = pos.qty * price;
  const floatPnl = marketValue - cost;
  const floatPct = cost > 0 ? (floatPnl / cost) * 100 : 0;
  return {
    code: pos.code,
    name: mkt && mkt.name ? mkt.name : (pos.name || null),
    qty: pos.qty,
    avgCost: pos.avgCost,
    price,
    pct: mkt && mkt.pct != null ? mkt.pct : null,
    marketValue,
    cost,
    floatPnl,
    floatPct,
    realizedPnl: pos.realizedPnl,
  };
}

/**
 * 组合总览（把单只摘要聚合成总额）。
 * @param {Array<object>} summaries
 * @returns {object} { marketValue, cost, floatPnl, floatPct, realizedPnl }
 */
function portfolioSummary(summaries) {
  const total = summaries.reduce((acc, s) => ({
    marketValue: acc.marketValue + s.marketValue,
    cost: acc.cost + s.cost,
    floatPnl: acc.floatPnl + s.floatPnl,
    realizedPnl: acc.realizedPnl + s.realizedPnl,
  }), { marketValue: 0, cost: 0, floatPnl: 0, realizedPnl: 0 });
  total.floatPct = total.cost > 0 ? (total.floatPnl / total.cost) * 100 : 0;
  return total;
}

module.exports = { applyTrade, summarizePosition, portfolioSummary };
