// lib/commands/search.js — 搜索股票

const { escapeExpression, formatSearchRow, renderTable } = require('./helpers');

/**
 * 搜索股票
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [keyword, --json]
 * @returns {Array<object>|undefined} --json 时返回结构化数组，否则打印表格返回 undefined
 */
async function cmdSearch(ctx, args) {
  const kw = args[0];
  if (!kw) throw new Error('用法: ths search <keyword> [--json]');
  const asJson = args.includes('--json');

  const expr = `window.__ths.searchStock('${escapeExpression(kw)}')`;
  ctx.audit.startOperation('search', { keyword: kw });

  const data = await ctx.loggedCall('search', { keyword: kw }, expr);
  const head = data && data.head;
  const rows = ((data && data.body) || []).map(r => formatSearchRow(r, head));
  ctx.audit.endOperation('success', { count: rows.length }, { keyword: kw, rows });

  if (asJson) return rows;

  console.log(renderTable(rows, [
    { header: '代码', key: 'code' },
    { header: '名称', key: 'name' },
    { header: '拼音', key: 'spell' },
    { header: '市场', key: 'market' },
  ]));
  return undefined;
}

module.exports = cmdSearch;
