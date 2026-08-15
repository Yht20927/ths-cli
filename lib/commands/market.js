// lib/commands/market.js — 大盘情绪（指数快照 + 涨跌家数 + 市场温度）
//
// 数据源: d.10jqka.com.cn realhead JSONP（上证 1A0001 / 深成 399001 / 创业板 399006）
// 字段: 7最新价 9昨收 19成交额 37上涨家数 38下跌家数 39平盘家数（各市场口径）
//
// 依赖油猴脚本 v1.2.0+（window.__ths.market）。旧版脚本报错时提示升级。

const { renderTable, fmtNum, getFlag } = require('./helpers');

/** 涨跌幅（%） */
function pctOf(price, prevClose) {
  if (price == null || prevClose == null || Number(prevClose) === 0) return null;
  return ((Number(price) / Number(prevClose)) - 1) * 100;
}

/** 市场温度标签：涨跌比 → 情绪描述 */
function moodLabel(up, down) {
  if (up == null || down == null || Number(down) === 0) return '-';
  const ratio = Number(up) / Number(down);
  if (ratio >= 2) return '🔥 普涨强势';
  if (ratio >= 1.2) return '👍 涨多跌少';
  if (ratio > 0.8) return '😐 分化震荡';
  if (ratio > 0.4) return '👎 跌多涨少';
  return '❄️ 普跌弱势';
}

/**
 * 大盘情绪
 * @param {object} ctx
 * @param {string[]} args - [--json]
 */
async function cmdMarket(ctx, args) {
  const data = await ctx.loggedCall('market', {},
    'window.__ths.market()');
  if (!Array.isArray(data) || !data.length) {
    throw new Error('未返回大盘数据（油猴脚本需 v1.2.0+，请在 Tampermonkey 更新并刷新 10jqka 页面）');
  }

  const sign = n => (n == null ? '-' : (n > 0 ? '+' : '') + Math.round(n * 100) / 100);
  const rows = data.map(d => {
    const pct = pctOf(d.price, d.prevClose);
    return {
      code: d.code,
      name: d.name,
      price: d.price != null ? Number(d.price) : null,
      pct,
      amount: d.amount != null ? Number(d.amount) : null,
      up: d.upCount != null ? Number(d.upCount) : null,
      down: d.downCount != null ? Number(d.downCount) : null,
      flat: d.flatCount != null ? Number(d.flatCount) : null,
    };
  });

  // 全市场涨跌家数 = 沪市(1A0001) + 深市(399001)；创业板(399006) 为深市子集，仅展示不重复合计
  const sh = rows.find(r => r.code === '1A0001');
  const sz = rows.find(r => r.code === '399001');
  const cyb = rows.find(r => r.code === '399006');
  const totalUp = (sh && sz && sh.up != null && sz.up != null) ? sh.up + sz.up : null;
  const totalDown = (sh && sz && sh.down != null && sz.down != null) ? sh.down + sz.down : null;
  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0);

  const out = { indices: rows, market: { totalUp, totalDown, totalAmount, mood: moodLabel(totalUp, totalDown) } };
  if (args.includes('--json')) return out;

  console.log(`大盘情绪（${data[0].updateTime || ''}）`);
  console.log(renderTable(rows.map(r => ({
    name: r.name,
    price: r.price != null ? r.price.toFixed(2) : '-',
    pct: sign(r.pct) + '%',
    amount: r.amount != null ? fmtNum(r.amount) : '-',
    up: r.up ?? '-',
    down: r.down ?? '-',
    flat: r.flat ?? '-',
  })), [
    { header: '指数', key: 'name' },
    { header: '最新', key: 'price', align: 'r' },
    { header: '涨跌', key: 'pct', align: 'r' },
    { header: '成交额', key: 'amount', align: 'r' },
    { header: '涨家数', key: 'up', align: 'r' },
    { header: '跌家数', key: 'down', align: 'r' },
    { header: '平盘', key: 'flat', align: 'r' },
  ]));

  if (totalUp != null && totalDown != null) {
    const mood = moodLabel(totalUp, totalDown);
    console.log(`\n市场温度: 涨 ${totalUp} / 跌 ${totalDown}（${mood}）  |  两市成交额 ${fmtNum(totalAmount)}`);
    const env = mood.includes('普涨') ? '环境偏暖，可积极' : mood.includes('普跌') ? '环境冷，只做最强且快进快出' : '存量博弈，仓位减半';
    console.log(`大师解读: ${env}`);
  }
  if (getFlag(args, '--verbose', null) != null) {
    console.log('（涨跌家数口径: 各市场证券合计，以同花顺 realhead 接口为准）');
  }
  return undefined;
}

module.exports = cmdMarket;
