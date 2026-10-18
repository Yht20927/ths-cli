// lib/render/widgets/line.js — Braille 线图 / 权益曲线 / 回撤图（零依赖）
//
// 终端一个字符格 = 2×4 个盲文点，线图分辨率提升 8 倍。
// 不支持 Braille 的终端（--ascii）退化为字符网格 '*'。

const { displayWidth, padStartW, truncateW } = require('../width');

// Braille dot bit map: (dx, dy) -> bit
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];

/**
 * @param {Array<number|null>} values
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {number} [opts.height=10]
 * @param {number} [opts.labelWidth=7]
 * @param {number} [opts.yMin]
 * @param {number} [opts.yMax]
 * @param {number} [opts.yTicks=5]
 * @param {Array<string>} [opts.xLabels]
 * @param {boolean} [opts.color]
 * @param {object} [opts.theme]
 * @param {string} [opts.tone]
 * @param {boolean} [opts.ascii]
 * @param {function} [opts.fmt]
 * @param {string} [opts.title]
 * @returns {string}
 */
function lineChart(values, opts = {}) {
  const src = (values || []).map(v => (v == null ? null : Number(v)));
  if (!src.some(v => Number.isFinite(v))) return '(无数据)';

  const width = Math.max(20, Math.floor(opts.width || 80));
  const height = Math.max(3, Math.floor(opts.height || 10));
  const fmt = opts.fmt || (v => Number(v).toFixed(2));

  const valid = src.filter(v => Number.isFinite(v));
  let min = opts.yMin != null ? Number(opts.yMin) : Math.min(...valid);
  let max = opts.yMax != null ? Number(opts.yMax) : Math.max(...valid);
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.05;
  min -= pad;
  max += pad;

  const yTicks = Math.max(2, Math.floor(opts.yTicks || 5));
  const tickValues = Array.from({ length: yTicks }, (_, i) =>
    max - ((max - min) * i) / (yTicks - 1));
  const labelWidth = Math.max(
    3,
    Math.floor(opts.labelWidth || 7),
    ...tickValues.map(v => displayWidth(fmt(v)))
  );
  const plotW = Math.max(8, width - labelWidth - 2);

  const lines = [];
  if (opts.title) lines.push(truncateW(opts.title, width));

  const tickRows = new Set();
  for (let i = 0; i < yTicks; i++) {
    tickRows.add(Math.round((i * (height - 1)) / (yTicks - 1)));
  }

  const plot = opts.ascii
    ? asciiPlot(src, plotW, height, min, max)
    : braillePlot(src, plotW, height, min, max);

  for (let r = 0; r < height; r++) {
    const tickValue = max - ((max - min) * r) / (height - 1);
    const label = tickRows.has(r) ? padStartW(fmt(tickValue), labelWidth) : ' '.repeat(labelWidth);
    const axis = tickRows.has(r) ? '┤' : '│';
    let row = plot[r];
    if (opts.color && opts.theme && opts.tone) row = opts.theme.style(opts.tone, row);
    lines.push(`${label} ${axis}${row}`);
  }

  lines.push(' '.repeat(labelWidth + 1) + '└' + (opts.ascii ? '-' : '─').repeat(plotW));
  if (opts.xLabels && opts.xLabels.length) {
    lines.push(' '.repeat(labelWidth + 2) + placeLabels(plotW, opts.xLabels, opts.ascii ? '...' : '…'));
  }
  return lines.join('\n');
}

/** 盲文点阵绘制 */
function braillePlot(values, width, height, min, max) {
  const w2 = width * 2;
  const h4 = height * 4;
  const dots = Array.from({ length: h4 }, () => new Uint8Array(w2));
  const xs = xPositions(values.length, w2);

  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { prev = null; continue; }
    const x = xs[i];
    const y = yPosition(v, min, max, h4);
    if (prev) lineDots(dots, prev.x, prev.y, x, y);
    else dots[y][x] = 1;
    prev = { x, y };
  }

  const rows = [];
  for (let r = 0; r < height; r++) {
    let s = '';
    for (let c = 0; c < width; c++) {
      let bits = 0;
      for (let dx = 0; dx < 2; dx++) {
        for (let dy = 0; dy < 4; dy++) {
          if (dots[r * 4 + dy][c * 2 + dx]) bits |= DOT_BITS[dx][dy];
        }
      }
      s += bits ? String.fromCharCode(0x2800 + bits) : ' ';
    }
    rows.push(s);
  }
  return rows;
}

/** ASCII 退化：字符网格 */
function asciiPlot(values, width, height, min, max) {
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));
  const xs = xPositions(values.length, width);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { prev = null; continue; }
    const x = xs[i];
    const y = yPosition(v, min, max, height);
    if (prev) lineCells(grid, prev.x, prev.y, x, y);
    else grid[y][x] = '*';
    prev = { x, y };
  }
  return grid.map(r => r.join(''));
}

function xPositions(n, width) {
  const out = new Array(n);
  if (n <= 0) return out;
  if (n === 1) { out[0] = Math.floor(width / 2); return out; }
  for (let i = 0; i < n; i++) out[i] = Math.round((i * (width - 1)) / (n - 1));
  return out;
}

function yPosition(v, min, max, height) {
  const t = (max - v) / (max - min || 1);
  return Math.max(0, Math.min(height - 1, Math.round(t * (height - 1))));
}

function lineDots(dots, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (dots[y0] && dots[y0][x0] !== undefined) dots[y0][x0] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

function lineCells(grid, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (grid[y0] && grid[y0][x0] !== undefined) grid[y0][x0] = '*';
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** 把标签均匀放到 plotW 宽的坐标轴上，避免重叠 */
function placeLabels(width, labels, ellipsis = '…') {
  const chars = new Array(width).fill(' ');
  const n = labels.length;
  for (let i = 0; i < n; i++) {
    const label = String(labels[i] == null ? '' : labels[i]);
    const pos = n === 1 ? Math.floor((width - displayWidth(label)) / 2)
      : Math.round((i * (width - 1)) / (n - 1));
    const lw = displayWidth(label);
    let start = pos;
    // 最后一项右对齐，避免超出
    if (start + lw > width) start = width - lw;
    start = Math.max(0, start);
    for (const ch of truncateW(label, width - start, ellipsis)) {
      const w = displayWidth(ch);
      if (start >= width) break;
      chars[start] = ch;
      if (w === 2 && start + 1 < width) chars[start + 1] = '';
      start += Math.max(1, w);
    }
  }
  return chars.join('');
}

module.exports = { lineChart, placeLabels };
