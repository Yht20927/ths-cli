// lib/position.js — 仓位计算引擎（纯函数，可单测）
//
// 把 SKILL.md 的仓位铁律落地成公式：
//   止损距离% = atrMult × ATR%          （默认 2 倍 ATR，对应"波动率定仓"）
//   建议仓位   = 目标止损额 / 止损距离%
//   股数       = 按 100 股一手向下取整（A 股一手 = 100 股）
//   每股风险   = 现价 - 止损价
//
// 语义: 若价格从买入价下跌"止损距离%"，账户亏损恰好等于目标止损额，
//       即"这笔亏多少我先定好，再反推买多少"。
// 附带输出盈亏比 = 目标空间 / 止损空间，落地 SKILL 纪律"盈亏比 ≥ 2 才动手"。

const { atr } = require('./indicators');
const { detectSR } = require('./support-resistance');

/**
 * 计算建议仓位 + 盈亏比。
 * @param {Array<{open,high,low,close,volume}>} bars
 * @param {object} opts
 *   - risk:     本笔最大可亏金额（元），必填 > 0
 *   - atrMult:  ATR 倍数（默认 2）
 *   - stop:     手动止损价（可选；不给则用 支撑位 或 现价 - atrMult×ATR）
 *   - target:   手动目标价（可选；不给则用最近压力位，须在现价上方）
 *   - price:    买入价（默认最新收盘）
 *   - capital:  总资金（可选，用于输出仓位占比）
 * @returns {object} { price, atrPct, atrValue, stopPrice, stopDistPct,
 *                     targetPrice, targetSource, upsidePct, riskReward, rrGrade,
 *                     riskPerShare, positionValue, shares, lots,
 *                     capitalPct, feasible, warning }
 */
function calcPosition(bars, opts = {}) {
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('K 线数据为空，无法计算仓位');
  const risk = Number(opts.risk);
  if (!(risk > 0)) throw new Error('--risk 必须为正数（本笔最大可亏金额，元）');

  const atrMult = opts.atrMult != null ? Number(opts.atrMult) : 2;
  if (!(atrMult > 0)) throw new Error('--atr-mult 必须为正数');

  const n = bars.length;
  const last = n - 1;
  const price = opts.price != null ? Number(opts.price) : bars[last].close;
  if (!(price > 0)) throw new Error('买入价无效');

  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const atrS = atr(highs, lows, closes, 14);
  const atrV = atrS[last];
  if (!(atrV > 0)) throw new Error('ATR 计算失败（数据太短？）');
  const atrPct = (atrV / price) * 100;

  // 支撑 / 压力位（止损与盈亏比目标共用一次检测）
  const sr = detectSR(bars);

  // 止损价:
  //  - 手动 --stop 永远优先（用户显式指定）
  //  - 否则取「支撑位」与「现价 - atrMult×ATR」中离现价更远的那个（更保守），
  //    避免支撑位贴着现价导致"一个正常波动就扫损"（SKILL.md 陷阱 6）
  let stopPrice = null;
  let stopSource = null;
  if (opts.stop != null) {
    stopPrice = Number(opts.stop);
    stopSource = '手动';
  } else {
    const candidates = [];
    const sup = sr.support && sr.support[0] ? sr.support[0].price : null;
    if (sup != null && sup < price) candidates.push({ price: sup, source: '支撑位' });
    candidates.push({ price: price - atrMult * atrV, source: 'ATR' });
    candidates.sort((a, b) => a.price - b.price); // 价格最低 = 离现价最远 = 最保守
    stopPrice = candidates[0].price;
    stopSource = candidates[0].source;
  }
  const riskPerShare = price - stopPrice;

  // 目标价 / 盈亏比: --target 优先，其次取最近压力位（须在现价上方）
  let targetPrice = null;
  let targetSource = null;
  if (opts.target != null && Number(opts.target) > 0) {
    targetPrice = Number(opts.target);
    targetSource = '手动';
  } else {
    const res = sr.resistance && sr.resistance[0] ? sr.resistance[0].price : null;
    if (res != null && res > price) {
      targetPrice = res;
      targetSource = '压力位';
    }
  }
  const upside = targetPrice != null ? targetPrice - price : null;
  const upsidePct = upside != null ? (upside / price) * 100 : null;
  // 盈亏比 = 目标空间 / 止损空间；≥2 达标（SKILL 纪律），<1 不划算
  const riskReward = upside != null && riskPerShare > 0 ? upside / riskPerShare : null;
  const rrGrade = riskReward != null
    ? (riskReward >= 2 ? '达标' : riskReward >= 1 ? '一般' : '不划算')
    : null;

  if (!(riskPerShare > 0)) {
    // 手动止损价高于现价 → 无风险空间
    return {
      price, atrPct, atrValue: atrV, stopPrice, stopDistPct: 0,
      riskPerShare: -riskPerShare, positionValue: 0, shares: 0, lots: 0,
      capitalPct: null, feasible: false,
      targetPrice, targetSource, upsidePct, riskReward, rrGrade,
      warning: `止损价 ${stopPrice} 高于现价 ${price}（${stopSource}），无风险空间——请检查止损设置`,
    };
  }
  const stopDistPct = (riskPerShare / price) * 100;

  // 建议仓位 = 目标止损额 / 止损距离%
  let positionValue = risk / (stopDistPct / 100);

  // 按手向下取整（A 股一手 = 100 股）
  const shares = Math.floor(positionValue / price / 100) * 100;
  const lots = shares / 100;
  positionValue = shares * price;

  const capitalPct = opts.capital != null && Number(opts.capital) > 0
    ? (positionValue / Number(opts.capital)) * 100
    : null;

  let warning = null;
  if (shares === 0) {
    warning = `按一手(100股)计算不足 1 手（需 ≥ ${(100 * price).toFixed(0)} 元）——提高 --risk 或买入更低价的标的`;
  } else if (capitalPct != null && capitalPct > 20) {
    warning = `仓位占资金 ${capitalPct.toFixed(1)}% > 20% 铁律上限，建议减仓`;
  } else if (stopDistPct > 10) {
    warning = `止损距离 ${stopDistPct.toFixed(1)}% 偏大，注意单笔风险敞口`;
  } else if (riskReward != null && riskReward < 1) {
    warning = `盈亏比 ${riskReward.toFixed(1)} < 1：目标空间小于止损空间，这笔不划算`;
  } else if (riskReward != null && riskReward < 2) {
    warning = `盈亏比 ${riskReward.toFixed(1)} 未达 2 倍铁律：目标空间偏窄，可用 --target 指定更远目标`;
  }

  return {
    price, atrPct, atrValue: atrV, stopPrice, stopSource, stopDistPct,
    targetPrice, targetSource, upsidePct, riskReward, rrGrade,
    riskPerShare, positionValue, shares, lots, capitalPct, feasible: true, warning,
  };
}

module.exports = { calcPosition };
