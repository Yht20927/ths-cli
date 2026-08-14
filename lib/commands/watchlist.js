// lib/commands/watchlist.js — 自选股管理

const { getFlag, inferMarket, renderTable } = require('./helpers');

/**
 * 自选股
 * @param {object} ctx
 * @param {string[]} args - add <code> [--name X] | remove <code> | list [--json]
 */
async function cmdWatchlist(ctx, args) {
  const cache = ctx.cache;
  const action = (args[0] || '').toLowerCase();

  if (action === 'add') {
    const code = args[1];
    if (!code) throw new Error('用法: ths watchlist add <code> [--name 名称] [--market N]');
    const name = getFlag(args, '--name', null);
    const market = getFlag(args, '--market', null) || inferMarket(code) || '';
    const ok = cache.watchlistAdd({ code, name: name || '', market });
    if (!ok) throw new Error(`自选股中已存在 ${code}`);
    console.log(`✓ 已加入自选: ${code}${name ? '（' + name + '）' : ''}`);
    return undefined;
  }

  if (action === 'remove') {
    const code = args[1];
    if (!code) throw new Error('用法: ths watchlist remove <code>');
    const ok = cache.watchlistRemove(code);
    if (!ok) throw new Error(`自选股中不存在 ${code}`);
    console.log(`✓ 已移除: ${code}`);
    return undefined;
  }

  if (action === 'list' || action === 'ls') {
    const list = cache.watchlistList();
    if (args.includes('--json')) return list;
    if (!list.length) {
      console.log('自选股为空。`ths watchlist add <code>` 添加。');
      return undefined;
    }
    console.log(renderTable(list.map(w => ({
      code: w.code,
      name: w.name || '-',
      market: w.market || '-',
      addedAt: (w.addedAt || '').slice(0, 16).replace('T', ' '),
    })), [
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '市场', key: 'market' },
      { header: '加入时间', key: 'addedAt' },
    ]));
    return undefined;
  }

  if (action === 'prices' || action === 'ls-prices') {
    // 复用批量行情：一次请求多只 + 名称 + 换手/量比/PE/市值
    const cmdQuotes = require('./quotes');
    const rest = args.slice(1).filter(a => a !== action);
    return cmdQuotes(ctx, ['--pool', 'watchlist', ...rest]);
  }

  if (action === 'clear') {
    cache.clearAll();
    console.log('✓ 已清空自选股、名称缓存与 K线缓存');
    return undefined;
  }

  throw new Error('用法: ths watchlist add/remove/list/prices/clear [--json]');
}

module.exports = cmdWatchlist;
