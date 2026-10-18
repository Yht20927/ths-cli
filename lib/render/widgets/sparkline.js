// lib/render/widgets/sparkline.js — 单行走势迷你图（零依赖）

const UNICODE_LEVELS = '▁▂▃▄▅▆▇█';
const ASCII_LEVELS = ' .:-=+*#';

/**
 * @param {Array<number|null>} values
 * @param {object} [opts]
 * @param {number} [opts.width]  目标列数（超出时按桶平均降采样）
 * @param {number} [opts.min]
 * @param {number} [opts.max]
 * @param {boolean} [opts.ascii]
 * @returns {string}
 */
function sparkline(values, opts = {}) {
  const levels = opts.ascii ? ASCII_LEVELS : UNICODE_LEVELS;
  const width = Math.max(1, Math.floor(opts.width || (values ? values.length : 1)));
  const data = resample(values || [], width);
  const valid = data.filter(v => Number.isFinite(v));
  if (!valid.length) return ' '.repeat(width);

  let min = opts.min != null ? Number(opts.min) : Math.min(...valid);
  let max = opts.max != null ? Number(opts.max) : Math.max(...valid);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return ' '.repeat(width);
  if (max === min) {
    return levels[Math.floor(levels.length / 2)].repeat(data.length);
  }
  if (max < min) { const t = min; min = max; max = t; }

  const last = levels.length - 1;
  return data.map(v => {
    if (!Number.isFinite(v)) return ' ';
    const idx = Math.round(((v - min) / (max - min)) * last);
    return levels[Math.max(0, Math.min(last, idx))];
  }).join('');
}

/** 把任意长度序列按桶平均降到 width 个点（保留趋势） */
function resample(values, width) {
  const src = (values || []).map(v => (v == null ? null : Number(v)));
  if (src.length <= width) return src.slice();
  const out = [];
  for (let i = 0; i < width; i++) {
    const start = Math.floor((i * src.length) / width);
    const end = Math.max(start + 1, Math.floor(((i + 1) * src.length) / width));
    const slice = src.slice(start, end).filter(v => Number.isFinite(v));
    out.push(slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : null);
  }
  return out;
}

module.exports = { sparkline, resample, UNICODE_LEVELS, ASCII_LEVELS };
