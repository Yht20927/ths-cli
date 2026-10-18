// lib/render/ansi.js — ANSI SGR 样式构造（零依赖）
//
// 约定：
// - 样式只在渲染的最外层应用；表格单元格内容本身不携带 ANSI。
// - 颜色代码由 theme.js 提供，本模块只负责拼装/重置。
// - displayWidth 会自动忽略 ANSI，但裁剪前仍建议先 stripAnsi。

const { stripAnsi, displayWidth } = require('./width');

const SGR = {
  reset: '0',
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  inverse: '7',
  fg: n => String(n),
  bg: n => String(n + 10),
};

/**
 * 包装文本为 SGR 样式。
 * @param {string} text
 * @param {string|string[]|null} codes 例如 '1;31' 或 ['1','31']
 */
function style(text, codes) {
  const s = String(text == null ? '' : text);
  if (!codes || (Array.isArray(codes) && codes.length === 0)) return s;
  const seq = Array.isArray(codes) ? codes.filter(Boolean).join(';') : String(codes);
  if (!seq) return s;
  return `\x1b[${seq}m${s}\x1b[0m`;
}

/** 组合多个 SGR 代码为分号串 */
function sgr(...codes) {
  return codes
    .flat()
    .filter(c => c != null && c !== '')
    .map(c => String(c))
    .join(';');
}

/** 十六进制颜色 → truecolor 前景/背景 SGR 参数 */
function hexFg(hex) {
  const { r, g, b } = parseHex(hex);
  return `38;2;${r};${g};${b}`;
}

function hexBg(hex) {
  const { r, g, b } = parseHex(hex);
  return `48;2;${r};${g};${b}`;
}

function parseHex(hex) {
  const h = String(hex || '').replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return { r: 255, g: 255, b: 255 };
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** 可见宽度（别名，便于阅读） */
function visibleWidth(s) {
  return displayWidth(s);
}

module.exports = {
  SGR,
  style,
  sgr,
  hexFg,
  hexBg,
  stripAnsi,
  visibleWidth,
};
