// lib/parsers/market.js — 大盘 realhead JSONP 解析（纯函数）
//
// 数据源: https://d.10jqka.com.cn/v2/realhead/hs_1A0001/last.js
// 响应形如: quotebridge_v2_realhead_hs_1A0001_last({ items: {...} })
// 字段（实测，指数与个股同一套 realhead 字段码）:
//   6昨收 / 7今开 / 8最高 / 9最低 / 10最新价 / 19成交额 /
//   37上涨家数 / 38下跌家数 / 39平盘家数 / name / updateTime
// 校验：科创50 6=1358.65（=10-16 收盘）, 10=1324.24, 264648=-34.41, 199112=-2.53%

/** 从 JSONP 文本中抽出 items 对象 */
function parseRealheadJsonp(text) {
  const s = String(text || '');
  const m = s.match(/\(([\s\S]+)\)\s*;?\s*$/);
  if (!m) throw new Error('realhead 响应不是 JSONP 格式');
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (e) {
    throw new Error('realhead JSON 解析失败: ' + e.message);
  }
  return (parsed && parsed.items) || {};
}

/**
 * items → 统一的指数快照。
 * @param {string} code - hs_1A0001 / hs_399001 / hs_399006
 * @param {object} items
 */
function snapshotFromItems(code, items) {
  const it = items || {};
  return {
    code: String(code).replace(/^hs_/, ''),
    name: it.name,
    price: it['10'],
    prevClose: it['6'],
    open: it['7'],
    high: it['8'],
    low: it['9'],
    change: it['264648'],
    pct: it['199112'],
    amount: it['19'],
    upCount: it['37'],
    downCount: it['38'],
    flatCount: it['39'],
    updateTime: it.updateTime,
  };
}

module.exports = { parseRealheadJsonp, snapshotFromItems };
