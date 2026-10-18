// lib/report/svg.js — 报告用内联 SVG 图表（零依赖）
//
// 只生成静态 SVG 字符串，无外部资源/JS；颜色使用 A 股习惯（红涨绿跌）。

const { resampleOHLC } = require('../render/widgets/candles');

// 使用 CSS 变量，便于 HTML 报告跟随明暗主题
const UP = 'var(--up)';
const DOWN = 'var(--down)';
const MUTED = 'var(--muted)';
const GRID = 'var(--grid)';
const TEXT = 'var(--fg)';
const BG = 'transparent';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 折线图（权益曲线/收盘线/回撤）
 * @param {Array<number|null>} values
 * @param {object} [opts] { width,height,color,fill,title,fmt,yMin,yMax }
 */
function lineSVG(values, opts = {}) {
  const src = (values || []).map(v => (v == null ? null : Number(v)));
  const valid = src.filter(v => Number.isFinite(v));
  if (!valid.length) return '<p class="muted">(无数据)</p>';

  const W = opts.width || 820, H = opts.height || 240;
  const padL = 54, padR = 18, padT = 18, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const fmt = opts.fmt || (v => Number(v).toFixed(2));
  let min = opts.yMin != null ? Number(opts.yMin) : Math.min(...valid);
  let max = opts.yMax != null ? Number(opts.yMax) : Math.max(...valid);
  if (max === min) { max += 1; min -= 1; }
  const pad = (max - min) * 0.06;
  if (opts.yMin == null) min -= pad;
  if (opts.yMax == null) max += pad;

  const x = i => (src.length <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (src.length - 1));
  const y = v => padT + ((max - v) / (max - min)) * plotH;
  const color = opts.color || UP;

  const pts = [];
  for (let i = 0; i < src.length; i++) {
    if (!Number.isFinite(src[i])) continue;
    pts.push(`${x(i).toFixed(1)},${y(src[i]).toFixed(1)}`);
  }

  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || '折线图')}">`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`;
  // 网格 + Y 轴
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = max - ((max - min) * i) / ticks;
    const yy = padT + (plotH * i) / ticks;
    out += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    out += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}">${esc(fmt(v))}</text>`;
  }
  // X 轴标签
  const xLabels = opts.xLabels || [];
  if (xLabels.length) {
    const idxs = [0, Math.floor((src.length - 1) / 2), src.length - 1];
    for (const i of [...new Set(idxs)]) {
      if (!xLabels[i]) continue;
      out += `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(xLabels[i])}</text>`;
    }
  }
  if (opts.fill) {
    const first = pts[0] ? pts[0].split(',')[0] : padL;
    const last = pts[pts.length - 1] ? pts[pts.length - 1].split(',')[0] : W - padR;
    out += `<path d="M${first},${padT + plotH} L${pts.join(' L')} L${last},${padT + plotH} Z" fill="${color}" opacity="0.12"/>`;
  }
  out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  out += '</svg>';
  return out;
}

/**
 * 横向条形图（命中率/板块净流入/评分分布）
 * @param {Array<{label,value,max?,note?}>} items
 */
function barsSVG(items, opts = {}) {
  const rows = items || [];
  if (!rows.length) return '<p class="muted">(无数据)</p>';
  const W = opts.width || 820;
  const rowH = opts.rowH || 26;
  const labelW = opts.labelW || 150;
  const valueW = 60;
  const barW = W - labelW - valueW - 20;
  const H = rows.length * rowH + 12;
  const max = opts.max != null ? Number(opts.max) : Math.max(...rows.map(r => Number(r.value) || 0), 1);

  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title || '条形图')}">`;
  rows.forEach((r, i) => {
    const y = 6 + i * rowH;
    const v = Number(r.value) || 0;
    const w = Math.max(0, Math.min(1, v / max)) * barW;
    const color = r.tone === 'down' ? DOWN : r.tone === 'warn' ? '#9a6700' : r.tone === 'flat' ? MUTED : UP;
    out += `<text x="0" y="${y + 17}" font-size="12" fill="${TEXT}">${esc(r.label)}</text>`;
    out += `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" fill="#eef1f4" rx="2"/>`;
    out += `<rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="16" fill="${color}" rx="2"/>`;
    out += `<text x="${W - 4}" y="${y + 17}" text-anchor="end" font-size="12" fill="${TEXT}">${esc(r.note != null ? r.note : String(v))}</text>`;
  });
  out += '</svg>';
  return out;
}

/**
 * 相关矩阵热力图
 */
function heatmapSVG(labels, matrix, opts = {}) {
  const n = labels.length;
  if (!n) return '<p class="muted">(无数据)</p>';
  const cell = opts.cell || 54;
  const labelW = opts.labelW || 70;
  const W = labelW + n * cell + 12;
  const H = n * cell + labelW + 12;
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="相关矩阵">`;
  for (let j = 0; j < n; j++) {
    out += `<text x="${labelW + j * cell + cell / 2}" y="${labelW - 8}" text-anchor="middle" font-size="10" fill="${MUTED}">${esc(labels[j])}</text>`;
  }
  for (let i = 0; i < n; i++) {
    out += `<text x="${labelW - 6}" y="${labelW + i * cell + cell / 2 + 4}" text-anchor="end" font-size="10" fill="${MUTED}">${esc(labels[i])}</text>`;
    for (let j = 0; j < n; j++) {
      const v = Number(matrix[i][j]);
      const fill = heatColor(v);
      out += `<rect x="${labelW + j * cell + 2}" y="${labelW + i * cell + 2}" width="${cell - 4}" height="${cell - 4}" fill="${fill}" rx="3"/>`;
      out += `<text x="${labelW + j * cell + cell / 2}" y="${labelW + i * cell + cell / 2 + 4}" text-anchor="middle" font-size="11" fill="#fff">${Number.isFinite(v) ? v.toFixed(2) : '—'}</text>`;
    }
  }
  out += '</svg>';
  return out;
}

/**
 * K 线图（OHLC + 成交量）
 */
function candlesSVG(bars, opts = {}) {
  if (!Array.isArray(bars) || !bars.length) return '<p class="muted">(无K线数据)</p>';
  const W = opts.width || 820, H = opts.height || 340;
  const padL = 54, padR = 12, padT = 14, padB = 34, volH = 54;
  const plotW = W - padL - padR;
  const priceH = H - padT - padB - volH;
  const maxBars = Math.max(10, Math.floor(plotW / 6));
  const data = resampleOHLC(bars, maxBars);
  const min = Math.min(...data.map(b => b.low));
  const max = Math.max(...data.map(b => b.high));
  const pad = (max - min) * 0.03 || 1;
  const yMin = min - pad, yMax = max + pad;
  const step = plotW / data.length;
  const y = v => padT + ((yMax - v) / (yMax - yMin)) * priceH;
  const maxVol = Math.max(...data.map(b => Number(b.volume) || 0), 1);

  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="K线图">`;
  out += `<rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>`;
  for (let i = 0; i <= 4; i++) {
    const v = yMax - ((yMax - yMin) * i) / 4;
    const yy = padT + (priceH * i) / 4;
    out += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="${GRID}"/>`;
    out += `<text x="${padL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="${MUTED}">${v.toFixed(2)}</text>`;
  }
  data.forEach((b, i) => {
    const cx = padL + step * (i + 0.5);
    const up = b.close >= b.open;
    const color = up ? UP : DOWN;
    const bw = Math.max(1.5, step * 0.55);
    out += `<line x1="${cx.toFixed(1)}" y1="${y(b.high).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b.low).toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
    const y1 = y(Math.max(b.open, b.close));
    const y2 = y(Math.min(b.open, b.close));
    out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" fill="${color}"/>`;
    const vh = ((Number(b.volume) || 0) / maxVol) * (volH - 8);
    out += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${(H - padB - vh).toFixed(1)}" width="${bw.toFixed(1)}" height="${vh.toFixed(1)}" fill="${color}" opacity="0.55"/>`;
  });
  // X 轴标签
  if (data.length) {
    const idxs = [0, Math.floor(data.length / 2), data.length - 1];
    for (const i of [...new Set(idxs)]) {
      const cx = padL + step * (i + 0.5);
      out += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${MUTED}">${esc(String(data[i].date || '').slice(5))}</text>`;
    }
  }
  out += '</svg>';
  return out;
}

function heatColor(v) {
  if (!Number.isFinite(v)) return '#8b949e';
  if (v <= -0.5) return '#1f4f9c';
  if (v <= -0.2) return '#4b7cc4';
  if (v < 0.2) return '#6e7781';
  if (v <= 0.5) return '#d16b6b';
  return '#a40e26';
}

module.exports = { lineSVG, barsSVG, heatmapSVG, candlesSVG, esc };
