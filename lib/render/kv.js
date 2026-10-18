// lib/render/kv.js — 键值对渲染（零依赖）
//
// 兼容旧 API：renderKV(items, labelWidth = 12)
// - items: { label, value, fmt?, tone? }
// - 值可以是数组（用 ' / ' 连接）
// - 标签按显示宽度对齐（CJK/emoji 不再错位）

const { displayWidth } = require('./width');

/**
 * @param {Array<{label:string,value:any,fmt?:Function,tone?:string}>} items
 * @param {number} [labelWidth=12]
 * @param {object} [opts] { color, theme }
 * @returns {string}
 */
function renderKV(items, labelWidth = 12, opts = {}) {
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme || null;
  return (items || []).map(it => {
    const label = String(it.label == null ? '' : it.label);
    const pad = ' '.repeat(Math.max(0, labelWidth - displayWidth(label)));
    let value = it.value;
    if (Array.isArray(value)) value = value.join(' / ');
    if (typeof it.fmt === 'function') value = it.fmt(value);
    if (value == null || value === '') value = theme ? theme.symbols.missing : '-';
    const text = `  ${label}${pad}: ${value}`;
    if (color && it.tone) return `\x1b[${theme.sgr(it.tone)}m${text}\x1b[0m`;
    return text;
  }).join('\n');
}

module.exports = { renderKV };
