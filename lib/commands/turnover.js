// lib/commands/turnover.js — 大盘成交额（dq.10jqka.com.cn）

const { escapeExpression, getFlag, formatTurnover, fmtNum, renderKV } = require('./helpers');
const { fmtDate, fmtTime: fmtTimeBJ } = require('../render/format');

/**
 * 接口的 average_turnover 实测常返回 0。
 * - 日 K：用最近 60 个交易日自行计算；
 * - 分时：点的单位是"分钟"，不能拿来当日均，直接隐藏该无效字段。
 * @param {object} parsed formatTurnover 结果
 * @param {'day'|'minute'} [period='day']
 * @returns {object} 同一对象（原地补齐 header）
 */
function fillAverage(parsed, period = 'day') {
  if (!parsed || !Array.isArray(parsed.points)) return parsed;
  const cur = parsed.header && parsed.header.average_turnover;
  if (cur && Number(cur.value) > 0) return parsed;
  if (period !== 'day') {
    if (parsed.header) delete parsed.header.average_turnover;
    return parsed;
  }
  const last60 = parsed.points.slice(-60).filter(p => Number.isFinite(Number(p.value)));
  if (!last60.length) return parsed;
  const avg = Math.round(last60.reduce((s, p) => s + Number(p.value), 0) / last60.length);
  parsed.header = parsed.header || {};
  parsed.header.average_turnover = { name: '近60日平均成交额', value: avg };
  return parsed;
}

/**
 * 大盘成交额
 * @param {object} ctx
 * @param {string[]} args - [--period minute|day, --count N, --json]
 */
async function cmdTurnover(ctx, args) {
  const period = getFlag(args, '--period', 'minute');
  if (!['minute', 'day'].includes(period)) {
    throw new Error('未知 --period，可选: minute|day');
  }
  const count = Math.max(1, parseInt(getFlag(args, '--count', 10), 10) || 10);

  const expr = `window.__ths.turnover('${escapeExpression(period)}')`;
  ctx.audit.startOperation('turnover', { period });

  const charts = await ctx.loggedCall('turnover', { period }, expr);
  const parsed = fillAverage(formatTurnover(charts), period);
  ctx.audit.endOperation('success', parsed ? { points: parsed.points.length } : {}, { period, parsed });
  if (!parsed) throw new Error('未返回成交额数据');

  if (args.includes('--json')) return parsed;

  console.log(parsed.name);
  const summary = Object.values(parsed.header).map(h => ({ label: h.name, value: fmtNum(h.value) }));
  console.log(renderKV(summary));

  // 最近 count 个点
  const recent = parsed.points.slice(-count);
  const label = period === 'day' ? '日期' : '时间';
  console.log(`\n最近 ${recent.length} 个点（${label}）:`);
  recent.forEach(p => {
    const t = period === 'day' ? fmtDate(p.ts) : fmtTimeBJ(p.ts);
    console.log(`  ${t}  ${fmtNum(p.value)}`);
  });
  return undefined;
}

module.exports = cmdTurnover;
module.exports.fillAverage = fillAverage;
