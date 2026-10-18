// lib/render/widgets/heatmap.js — 相关矩阵/热力图（零依赖）
//
// 发散色阶：负=蓝、0=灰、正=红。颜色不是唯一信息：无色模式仍显示数值。

const { displayWidth, padEndW, padStartW } = require('../width');
const { hexFg, hexBg } = require('../ansi');

const CELL_CHARS = ['█', '▓', '░', '▓', '█']; // 负强/负弱/中性/正弱/正强

/**
 * @param {Array<string>} labels 行列标签（同一组）
 * @param {Array<Array<number>>} matrix N×N
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {boolean} [opts.color]
 * @param {object} [opts.theme]
 * @param {function} [opts.fmt]
 * @param {string} [opts.title]
 * @returns {string}
 */
function heatmap(labels, matrix, opts = {}) {
  const n = Array.isArray(labels) ? labels.length : 0;
  if (!n || !Array.isArray(matrix) || !matrix.length) return '(空)';
  const width = Math.max(20, Math.floor(opts.width || 80));
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme;
  const fmt = opts.fmt || (v => (v == null ? ' — ' : Number(v).toFixed(2)));
  const labelWidth = Math.max(...labels.map(l => displayWidth(String(l))));

  // 窄屏：1 字符热图（无数值）
  let cellWidth = Math.max(3, Math.max(...matrix.flat().map(v => displayWidth(fmt(v)))));
  const total = labelWidth + 1 + n * cellWidth + (n - 1);
  const compact = total > width || width < 80;
  if (compact) cellWidth = 1;

  const lines = [];
  if (opts.title) lines.push(opts.title);

  // 表头
  const head = ' '.repeat(labelWidth + 1) +
    labels.map(l => compact ? padStartW(String(l).slice(-1), cellWidth) : padStartW(String(l), cellWidth)).join(' ');
  lines.push(head);

  for (let i = 0; i < n; i++) {
    const rowLabel = padEndW(String(labels[i]), labelWidth);
    const cells = [];
    for (let j = 0; j < n; j++) {
      const v = Number(matrix[i][j]);
      if (compact) {
        const ch = Number.isFinite(v) ? CELL_CHARS[bucketOf(v)] : ' ';
        cells.push(color ? styleHeat(ch, v, theme) : ch);
      } else {
        const text = padStartW(fmt(v), cellWidth);
        cells.push(color ? styleHeat(text, v, theme) : text);
      }
    }
    lines.push(`${rowLabel} ${cells.join(' ')}`);
  }

  // 图例
  const legend = compact
    ? '图例: -1 █ 0 ░ +1 █'
    : '图例: -1 蓝 ███  0 灰 ░░░  +1 红 ███';
  lines.push(compact ? legend : ' '.repeat(labelWidth + 1) + legend);
  return lines.join('\n');
}

function bucketOf(v) {
  if (v <= -0.5) return 0;
  if (v <= -0.2) return 1;
  if (v < 0.2) return 2;
  if (v <= 0.5) return 3;
  return 4;
}

function styleHeat(text, value, theme) {
  const depth = theme.colorDepth || 'none';
  if (depth === 'none') return text;
  const b = bucketOf(Number.isFinite(Number(value)) ? Number(value) : 0);
  if (depth === 'ansi16') {
    const bg = ['44', '44', '100', '41', '41'][b];
    return `\x1b[${bg};97m${text}\x1b[0m`;
  }
  if (depth === 'ansi256') {
    const bg = ['48;5;24', '48;5;25', '48;5;240', '48;5;88', '48;5;124'][b];
    return `\x1b[${bg};38;5;231m${text}\x1b[0m`;
  }
  const bgHex = ['#1f6feb', '#388bfd', '#30363d', '#a40e26', '#f85149'][b];
  return `\x1b[${hexBg(bgHex)};${hexFg('#ffffff')}m${text}\x1b[0m`;
}

module.exports = { heatmap, bucketOf, CELL_CHARS };
