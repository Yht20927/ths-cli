// lib/render/widgets/bars.js — 横向条形图（零依赖）

const { displayWidth, padEndW, padStartW, truncateW } = require('../width');

const FULL = '█';
const EMPTY = '░';
const FRACTIONS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/**
 * 单条横条。
 * @param {number} value
 * @param {number} max
 * @param {number} width 字符宽度
 * @param {object} [opts] { ascii }
 */
function bar(value, max, width, opts = {}) {
  const w = Math.max(0, Math.floor(width));
  const v = Number(value);
  const m = Number(max);
  if (!w) return '';
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) {
    return (opts.ascii ? '-' : EMPTY).repeat(w);
  }
  const ratio = Math.max(0, Math.min(1, v / m));
  if (opts.ascii) {
    const filled = Math.round(ratio * w);
    return '#'.repeat(filled) + '-'.repeat(w - filled);
  }
  const exact = ratio * w;
  const full = Math.floor(exact);
  const fracIdx = Math.min(FRACTIONS.length - 1, Math.floor((exact - full) * FRACTIONS.length));
  const frac = fracIdx > 0 && full < w ? FRACTIONS[fracIdx] : '';
  const used = full + (frac ? 1 : 0);
  return FULL.repeat(full) + frac + EMPTY.repeat(Math.max(0, w - used));
}

/**
 * 多行横向条形图。
 * items: [{ label, value, max?, note?, tone? }]
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {number} [opts.labelWidth] 自动
 * @param {number} [opts.barWidth]   自动
 * @param {boolean} [opts.color]
 * @param {object} [opts.theme] resolveTheme()
 * @param {function} [opts.fmt] 数值格式化
 * @returns {string}
 */
function renderBars(items, opts = {}) {
  const rows = items || [];
  if (!rows.length) return '';
  const width = Math.max(20, Math.floor(opts.width || 80));
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme;
  const ascii = !!opts.ascii || (theme && theme.symbols && theme.symbols.missing === '-');

  const labelWidth = opts.labelWidth != null
    ? opts.labelWidth
    : Math.min(24, Math.max(4, ...rows.map(r => displayWidth(String(r.label || '')))));
  const valueFmt = opts.fmt || (v => String(Math.round(v * 100) / 100));
  const valueWidth = Math.min(12, Math.max(3, ...rows.map(r => displayWidth(valueFmt(r.value)))));
  const noteWidth = Math.min(16, Math.max(0, ...rows.map(r => displayWidth(String(r.note || '')))));
  const barWidth = opts.barWidth != null
    ? opts.barWidth
    : Math.max(6, width - labelWidth - valueWidth - noteWidth - (noteWidth ? 4 : 3));

  return rows.map(row => {
    const max = row.max != null ? row.max : Math.max(...rows.map(r => Number(r.value) || 0), 1);
    const label = padEndW(truncateW(String(row.label || ''), labelWidth), labelWidth);
    const value = padStartW(valueFmt(row.value), valueWidth);
    const b = bar(row.value, max, barWidth, { ascii });
    const note = noteWidth ? ' ' + padEndW(truncateW(String(row.note || ''), noteWidth), noteWidth) : '';
    let line = `${label} ${b} ${value}${note}`;
    if (color) {
      // 只给条和值上色，标签保持默认
      const tone = row.tone || (Number(row.value) > 0 ? 'up' : Number(row.value) < 0 ? 'down' : 'flat');
      const styledBar = theme.style(tone, b);
      const styledValue = theme.style(tone, value);
      line = `${label} ${styledBar} ${styledValue}${note}`;
    }
    return line;
  }).join('\n');
}

module.exports = { bar, renderBars, FULL, EMPTY };
