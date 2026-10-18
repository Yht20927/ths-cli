// lib/render/widgets/candles.js — 终端 K 线图（零依赖）
//
// 结构：价格区（K 线 + MA 叠加） + 成交量区 + 日期轴 + 图例。
// 数据过多时按桶聚合：open=首、close=尾、high=max、low=min、volume=sum。
// 颜色：红涨绿跌（由 theme 决定）；--ascii 时退化为 |/#/./=。

const { displayWidth, padStartW, truncateW } = require('../width');
const { placeLabels } = require('./line');

/**
 * @param {Array<{date,open,high,low,close,volume}>} bars 升序
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {number} [opts.height=12]
 * @param {number} [opts.volumeHeight=3]
 * @param {number} [opts.labelWidth=7]
 * @param {boolean} [opts.showMA=true]
 * @param {boolean} [opts.color]
 * @param {object} [opts.theme]
 * @param {boolean} [opts.ascii]
 * @param {function} [opts.fmt]
 * @param {string} [opts.title]
 * @returns {string}
 */
function candlestickChart(bars, opts = {}) {
  if (!Array.isArray(bars) || bars.length === 0) return '(无K线数据)';

  const width = Math.max(30, Math.floor(opts.width || 80));
  const height = Math.max(4, Math.floor(opts.height || 12));
  const volumeHeight = Math.max(0, Math.floor(opts.volumeHeight == null ? 3 : opts.volumeHeight));
  const ascii = !!opts.ascii;
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme;
  const fmt = opts.fmt || (v => (v == null ? '-' : Number(v).toFixed(2)));

  // 先用原始 bars 的极值算 Y 轴标签宽度，再决定绘图区宽度
  const rawMin = Math.min(...bars.map(b => b.low));
  const rawMax = Math.max(...bars.map(b => b.high));
  const pad = (rawMax - rawMin) * 0.02 || 1;
  const yMin = rawMin - pad;
  const yMax = rawMax + pad;
  const tickVals = Array.from({ length: 5 }, (_, i) =>
    yMax - ((yMax - yMin) * i) / 4);
  const labelWidth = Math.max(
    4,
    Math.floor(opts.labelWidth || 7),
    ...tickVals.map(v => displayWidth(fmt(v)))
  );
  const plotW = Math.max(10, width - labelWidth - 2);

  const buckets = resampleBuckets(bars, plotW);
  const data = buckets.map(b => b.bar);
  const n = data.length;
  const xs = xPositions(n, plotW);

  const upStyle = color ? theme.sgr('up') : '';
  const downStyle = color ? theme.sgr('down') : '';
  const ma5Style = color ? theme.sgr('accent') : '';
  const ma20Style = color ? theme.sgr('warn') : '';
  const axisStyle = color ? theme.sgr('border') : '';
  const mutedStyle = color ? theme.sgr('muted') : '';

  // 价格网格：{ ch, style, prio }；prio: 1=影线 2=MA 3=实体
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: plotW }, () => ({ ch: ' ', style: '', prio: 0 }))
  );

  const yRow = v => clamp(Math.round(((yMax - v) / (yMax - yMin)) * (height - 1)), 0, height - 1);

  for (let i = 0; i < n; i++) {
    const b = data[i];
    const x = xs[i];
    const tone = b.close >= b.open ? upStyle : downStyle;
    const wickCh = ascii ? '|' : '│';
    const bodyCh = ascii ? '#' : '█';
    const dojiCh = ascii ? '-' : '─';

    const hi = yRow(b.high);
    const lo = yRow(b.low);
    for (let y = hi; y <= lo; y++) {
      const cell = grid[y][x];
      if (cell.prio <= 1) grid[y][x] = { ch: wickCh, style: tone, prio: 1 };
    }

    const ro = yRow(b.open);
    const rc = yRow(b.close);
    const top = Math.min(ro, rc);
    const bottom = Math.max(ro, rc);
    if (top === bottom) {
      grid[top][x] = { ch: dojiCh, style: tone, prio: 3 };
    } else {
      for (let y = top; y <= bottom; y++) {
        grid[y][x] = { ch: bodyCh, style: tone, prio: 3 };
      }
    }
  }

  // MA 叠加（绘制在实体下方，不覆盖实体）
  const closes = bars.map(b => b.close);
  const ma5 = smaSeries(closes, 5);
  const ma20 = smaSeries(closes, 20);
  if (opts.showMA !== false) {
    for (let i = 0; i < n; i++) {
      const endIdx = buckets[i].endIdx;
      drawMA(grid, xs[i], ma5[endIdx], yRow, ma5Style, ascii);
      drawMA(grid, xs[i], ma20[endIdx], yRow, ma20Style, ascii);
    }
  }

  const lines = [];
  if (opts.title) lines.push(truncateW(opts.title, width));

  // 价格区 + 左侧刻度
  const tickRows = tickRowSet(height, 5);
  for (let r = 0; r < height; r++) {
    const tick = tickRows.has(r);
    const value = yMax - ((yMax - yMin) * r) / Math.max(1, height - 1);
    const label = tick ? padStartW(fmt(value), labelWidth) : ' '.repeat(labelWidth);
    const axis = apply(tick ? '┤' : '│', axisStyle);
    lines.push(`${label} ${axis}${renderCells(grid[r], color)}`);
  }
  lines.push(' '.repeat(labelWidth + 1) + apply('└' + (ascii ? '-' : '─').repeat(plotW), axisStyle));

  // 日期轴
  const xLabels = pickLabels(data, 4);
  if (xLabels.length) {
    lines.push(' '.repeat(labelWidth + 2) + placeLabels(plotW, xLabels, ascii ? '...' : '…'));
  }

  // 成交量区
  if (volumeHeight > 0) {
    const maxVol = Math.max(...data.map(b => Number(b.volume) || 0), 1);
    const volCells = Array.from({ length: volumeHeight }, () =>
      Array.from({ length: plotW }, () => ({ ch: ' ', style: '' }))
    );
    for (let i = 0; i < n; i++) {
      const b = data[i];
      const h = Math.round(((Number(b.volume) || 0) / maxVol) * volumeHeight);
      const tone = b.close >= b.open ? upStyle : downStyle;
      for (let r = volumeHeight - h; r < volumeHeight; r++) {
        if (r >= 0) volCells[r][xs[i]] = { ch: ascii ? '=' : '█', style: tone };
      }
    }
    for (let r = 0; r < volumeHeight; r++) {
      const label = r === Math.floor(volumeHeight / 2) ? padStartW('量', labelWidth) : ' '.repeat(labelWidth);
      lines.push(`${label} ${apply('│', axisStyle)}${renderCells(volCells[r], color)}`);
    }
  }

  // 图例
  if (opts.showMA !== false) {
    const dot = ascii ? '+' : '·';
    const legend = [
      color ? theme.style('accent', dot) : dot,
      'MA5',
      color ? theme.style('warn', dot) : dot,
      'MA20',
    ].join(' ');
    lines.push(' '.repeat(labelWidth + 2) + apply(legend, mutedStyle));
  }

  return lines.join('\n');
}

/**
 * 把 bars 聚合成最多 target 根。
 * @returns {Array<{bar:object,endIdx:number}>}
 */
function resampleBuckets(bars, target) {
  const n = bars.length;
  if (n <= target) return bars.map((b, i) => ({ bar: b, endIdx: i }));
  const out = [];
  for (let i = 0; i < target; i++) {
    const start = Math.floor((i * n) / target);
    const end = Math.max(start + 1, Math.floor(((i + 1) * n) / target));
    const chunk = bars.slice(start, end);
    const last = chunk[chunk.length - 1];
    out.push({
      bar: {
        date: last.date,
        open: chunk[0].open,
        close: last.close,
        high: Math.max(...chunk.map(b => b.high)),
        low: Math.min(...chunk.map(b => b.low)),
        volume: chunk.reduce((s, b) => s + (Number(b.volume) || 0), 0),
      },
      endIdx: end - 1,
    });
  }
  return out;
}

/** 只返回聚合后的 OHLC 数组 */
function resampleOHLC(bars, target) {
  return resampleBuckets(bars, target).map(x => x.bar);
}

function smaSeries(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function drawMA(grid, x, value, yRow, style, ascii) {
  if (value == null || !Number.isFinite(value)) return;
  const y = yRow(value);
  if (!grid[y] || !grid[y][x]) return;
  if (grid[y][x].prio <= 2) {
    grid[y][x] = { ch: ascii ? '+' : '·', style, prio: 2 };
  }
}

function renderCells(cells, color) {
  let out = '';
  let current = null;
  for (const cell of cells) {
    const ch = cell.ch || ' ';
    const style = color ? (cell.style || '') : '';
    if (style !== current) {
      if (current) out += '\x1b[0m';
      if (style) out += `\x1b[${style}m`;
      current = style;
    }
    out += ch;
  }
  if (current) out += '\x1b[0m';
  return out;
}

function apply(text, style) {
  return style ? `\x1b[${style}m${text}\x1b[0m` : text;
}

function tickRowSet(height, count) {
  const set = new Set();
  for (let i = 0; i < count; i++) {
    set.add(Math.round((i * (height - 1)) / (count - 1)));
  }
  return set;
}

function xPositions(n, width) {
  const out = new Array(n);
  if (n <= 0) return out;
  if (n === 1) { out[0] = Math.floor(width / 2); return out; }
  for (let i = 0; i < n; i++) out[i] = Math.round((i * (width - 1)) / (n - 1));
  return out;
}

function pickLabels(data, count) {
  if (!data.length) return [];
  const out = [];
  const n = data.length;
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (n - 1)) / Math.max(1, count - 1));
    const d = data[idx].date;
    out.push(d ? String(d).slice(5) : '');
  }
  return out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { candlestickChart, resampleOHLC, resampleBuckets, smaSeries };
