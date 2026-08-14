// lib/commands/turnover.js — 大盘成交额（dq.10jqka.com.cn）

const { escapeExpression, getFlag, formatTurnover, fmtNum, fmtTime, renderKV } = require('./helpers');

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
  const parsed = formatTurnover(charts);
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
    const t = period === 'day' ? new Date(p.ts).toISOString().slice(0, 10) : fmtTime(p.ts);
    console.log(`  ${t}  ${fmtNum(p.value)}`);
  });
  return undefined;
}

module.exports = cmdTurnover;
