// lib/commands/position.js — 仓位计算命令（SKILL.md 仓位铁律落地）
//
// 用法: ths position <code> --risk 5000 [--stop X] [--target X] [--atr-mult 2]
//       [--capital N] [--price X] [--period day] [--count 250] [--market N] [--json]

const { renderKV, fmtNum } = require('./helpers');
const { loadKline, ttlMsForPeriod, resolveName } = require('../cache');
const { calcPosition } = require('../position');
const { parseKlineArgs } = require('./kline');

/**
 * 仓位计算
 * @param {object} ctx
 * @param {string[]} args - [code, --risk, --stop, --atr-mult, --capital, --price, --period, --count, --json]
 */
async function cmdPosition(ctx, args) {
  const params = parseKlineArgs(args);
  const bars = await loadKline(ctx, ctx.cache, params, {
    maxAgeMs: ttlMsForPeriod(ctx.config, params.period),
    refresh: args.includes('--refresh'),
  });

  const flag = (name, dft) => {
    const idx = args.indexOf(name);
    if (idx === -1) return dft;
    const v = args[idx + 1];
    return v === undefined || String(v).startsWith('--') ? dft : v;
  };

  // risk 优先级: --risk > config.position.risk
  const risk = flag('--risk', null) || (ctx.config.position && ctx.config.position.risk) || null;
  const opts = {
    risk,
    atrMult: flag('--atr-mult', null),
    stop: flag('--stop', null),
    target: flag('--target', null),
    price: flag('--price', null),
    capital: flag('--capital', null),
  };

  const r = calcPosition(bars, opts);

  const name = (await resolveName(ctx, ctx.cache, params.code)) || null;
  const { code, period } = params;
  const r2 = v => (v == null ? '-' : Number(v.toFixed(2)));
  const r1 = v => (v == null ? '-' : Number(v.toFixed(1)));

  if (args.includes('--json')) return { code, name, period, ...r };

  console.log(`仓位计算 ${code}${name ? ' ' + name : ''}（${period} K，${bars.length} 根）`);
  console.log(renderKV([
    { label: '买入价(收盘)', value: r2(r.price) },
    { label: 'ATR14', value: `${r2(r.atrValue)}（${r1(r.atrPct)}%）` },
    { label: '止损价', value: `${r2(r.stopPrice)}（${r.stopSource}，距现价 -${r1(r.stopDistPct)}%）` },
    { label: '目标价', value: r.targetPrice != null ? `${r2(r.targetPrice)}（${r.targetSource}，上方 +${r1(r.upsidePct)}%）` : '-（无上方压力位，--target 指定）' },
    { label: '盈亏比', value: r.riskReward != null ? `${r1(r.riskReward)}（${r.rrGrade}）` : '-' },
    { label: '每股风险', value: r2(r.riskPerShare) },
    { label: '目标止损额', value: fmtNum(opts.risk) },
    { label: '建议仓位', value: r.feasible ? fmtNum(r.positionValue) : '-' },
    { label: '建议股数', value: r.feasible ? `${r.shares} 股（${r.lots} 手）` : '-' },
    { label: '占总资金', value: r.capitalPct != null ? `${r1(r.capitalPct)}%` : '-（--capital 查看）' },
  ]));
  if (r.warning) console.log(`⚠ ${r.warning}`);
  if (r.feasible && r.capitalPct != null) {
    console.log('\n大师提醒: 单只 ≤ 20% 铁律；盈亏比 ≥ 2 才值得动手（目标距现价 ÷ 止损距现价）；首仓 1/3 分批，浮盈后止损上移到成本线。');
  }
  return undefined;
}

module.exports = cmdPosition;
