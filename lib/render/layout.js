// lib/render/layout.js — 极简布局（零依赖）
//
// 只提供 TUI/图表需要的积木：
// - hstack: 横向分配宽度（fixed + flex）
// - vstack: 纵向分配高度（fixed + flex）
// - panel:  在 Canvas 上画边框并返回内容区
//
// 不做约束求解；足够覆盖 1-3 栏即可。

/**
 * @param {Array<{width?:number,flex?:number}>} specs
 * @param {object} opts { width, gap=1 }
 * @returns {Array<{x:number,width:number}>}
 */
function hstack(specs, opts = {}) {
  const width = Math.max(0, Math.floor(opts.width || 0));
  const gap = Math.max(0, Math.floor(opts.gap == null ? 1 : opts.gap));
  const n = specs.length;
  if (!n) return [];

  const fixed = specs.map(s => (Number.isFinite(s.width) ? Math.max(0, Math.floor(s.width)) : null));
  const flexTotal = specs.reduce((a, s, i) => a + (fixed[i] == null ? Math.max(0, s.flex || 1) : 0), 0);
  const fixedSum = fixed.reduce((a, v) => a + (v || 0), 0);
  const remaining = Math.max(0, width - fixedSum - gap * (n - 1));

  let used = 0;
  let flexSeen = 0;
  const widths = specs.map((s, i) => {
    if (fixed[i] != null) return fixed[i];
    flexSeen += 1;
    if (!flexTotal) return 0;
    const base = Math.floor(remaining * (Math.max(0, s.flex || 1) / flexTotal));
    used += base;
    return base;
  });

  // 把余数给最后一个 flex 列，保证总宽精确
  if (flexSeen) {
    const lastFlex = widths.map((w, i) => (fixed[i] == null ? i : -1)).filter(i => i >= 0).pop();
    if (lastFlex != null) widths[lastFlex] += remaining - used;
  }

  let x = 0;
  return widths.map(w => {
    const out = { x, width: Math.max(0, w) };
    x += out.width + gap;
    return out;
  });
}

/**
 * @param {Array<{height?:number,flex?:number}>} specs
 * @param {object} opts { height, gap=0 }
 * @returns {Array<{y:number,height:number}>}
 */
function vstack(specs, opts = {}) {
  const height = Math.max(0, Math.floor(opts.height || 0));
  const gap = Math.max(0, Math.floor(opts.gap == null ? 0 : opts.gap));
  const n = specs.length;
  if (!n) return [];

  const fixed = specs.map(s => (Number.isFinite(s.height) ? Math.max(0, Math.floor(s.height)) : null));
  const flexTotal = specs.reduce((a, s, i) => a + (fixed[i] == null ? Math.max(0, s.flex || 1) : 0), 0);
  const fixedSum = fixed.reduce((a, v) => a + (v || 0), 0);
  const remaining = Math.max(0, height - fixedSum - gap * (n - 1));

  let used = 0;
  const heights = specs.map((s, i) => {
    if (fixed[i] != null) return fixed[i];
    if (!flexTotal) return 0;
    const base = Math.floor(remaining * (Math.max(0, s.flex || 1) / flexTotal));
    used += base;
    return base;
  });
  const lastFlex = heights.map((h, i) => (fixed[i] == null ? i : -1)).filter(i => i >= 0).pop();
  if (lastFlex != null) heights[lastFlex] += remaining - used;

  let y = 0;
  return heights.map(h => {
    const out = { y, height: Math.max(0, h) };
    y += out.height + gap;
    return out;
  });
}

/**
 * 在 Canvas 上画面板。
 * @param {import('./canvas').Canvas} canvas
 * @param {object} p
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function panel(canvas, p = {}) {
  const { x = 0, y = 0, w = canvas.width, h = canvas.height } = p;
  return canvas.box({
    x, y, w, h,
    title: p.title,
    border: p.border || 'round',
    titleStyle: p.titleStyle || '',
    borderStyle: p.borderStyle || '',
  });
}

module.exports = { hstack, vstack, panel };
