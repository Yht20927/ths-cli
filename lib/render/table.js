// lib/render/table.js — 响应式终端表格（零依赖）
//
// 兼容旧 API：renderTable(rows, cols)
// - columns: { header, key, fmt?, align?: 'l'|'r'|'c', width?, priority?, tone?, truncate? }
// - 默认 ASCII 边框、无颜色、不约束宽度（保持旧命令输出兼容），
//   由 CLI 通过 render options 打开圆角/颜色/终端宽度约束。
//
// 宽度全部基于 displayWidth：中文/emoji 对齐、ANSI 不计宽。

const { displayWidth, padEndW, padStartW, truncateW } = require('./width');

/**
 * @param {Array<object>} rows
 * @param {Array<object>} cols
 * @param {object} [opts]
 * @param {number|null} [opts.width]      目标宽度；null = 自然宽度
 * @param {'ascii'|'round'|'square'|'compact'|'none'} [opts.border='ascii']
 * @param {boolean} [opts.color=false]
 * @param {object|null} [opts.theme]      resolveTheme() 结果
 * @param {number|null} [opts.maxRows]
 * @param {number|null} [opts.selectedIndex]
 * @returns {string}
 */
function renderTable(rows, cols, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return '(空)';
  if (!Array.isArray(cols) || cols.length === 0) return '(空)';

  const border = opts.border || 'ascii';
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme || null;
  const maxWidth = opts.width != null ? Math.max(1, Math.floor(opts.width)) : null;
  const normalized = cols.map(normalizeCol);

  if (maxWidth != null && maxWidth < 60 && normalized.length > 2) {
    return renderStacked(rows, normalized, { ...opts, width: maxWidth });
  }

  const visible = selectVisibleCols(rows, normalized, maxWidth, border);
  if (visible.length === 0) return '(空)';

  const widths = computeWidths(rows, visible, maxWidth, border);
  const total = tableWidth(widths, border);

  let shownRows = rows;
  let hidden = 0;
  if (opts.maxRows != null && rows.length > opts.maxRows) {
    shownRows = rows.slice(0, opts.maxRows);
    hidden = rows.length - shownRows.length;
  }

  const styled = {
    header: color ? theme.sgr('header') : '',
    border: color ? theme.sgr('border') : '',
    muted: color ? theme.sgr('muted') : '',
  };

  const lines = [];
  const box = border === 'ascii' || border === 'round' || border === 'square';
  const chars = borderChars(border);

  if (box) lines.push(borderLine('top', widths, chars, styled.border));
  lines.push(dataLine(visible.flatMap(c => c.idx), headerValues(visible), widths, visible, {
    style: styled.header,
    chars,
    border,
    isHeader: true,
  }));

  if (box) lines.push(borderLine('mid', widths, chars, styled.border));
  else if (border === 'compact') lines.push(widths.map(w => '─'.repeat(w)).join('  '));

  shownRows.forEach((row, ri) => {
    const values = visible.map(col => cellText(col, row));
    const tones = visible.map(col => (col.tone ? col.tone(row[col.key], row) : null));
    lines.push(dataLine(visible.map(c => c.idx), values, widths, visible, {
      styles: tones.map(t => (color && t ? theme.sgr(t) : '')),
      chars,
      border,
      selected: opts.selectedIndex === ri,
    }));
  });

  if (box) lines.push(borderLine('bottom', widths, chars, styled.border));

  if (hidden > 0) {
    lines.push(truncateW(`… 还有 ${hidden} 行`, maxWidth || Infinity, theme ? theme.symbols.ellipsis : '…'));
  }
  if (opts.footer) lines.push(String(opts.footer));

  // 最后兜底：任何行都不得超过目标宽度（图表/边框字符均为单宽，正常不会触发）
  if (maxWidth != null) {
    return lines.map(line => (displayWidth(line) > maxWidth ? truncateW(line, maxWidth) : line)).join('\n');
  }
  return lines.join('\n');
}

function normalizeCol(c, idx) {
  return {
    idx,
    key: c.key,
    header: String(c.header != null ? c.header : (c.key != null ? c.key : '')),
    fmt: typeof c.fmt === 'function' ? c.fmt : null,
    align: c.align === 'r' ? 'r' : c.align === 'c' ? 'c' : 'l',
    width: typeof c.width === 'number' && c.width > 0 ? Math.floor(c.width) : c.width && typeof c.width === 'object' ? c.width : null,
    priority: Number.isFinite(c.priority) ? c.priority : 0,
    tone: typeof c.tone === 'function' ? c.tone : null,
    truncate: c.truncate !== false,
    hidden: !!c.hidden,
  };
}

function cellText(col, row) {
  const raw = col.fmt ? col.fmt(row[col.key], row) : row[col.key];
  return raw == null ? '' : String(raw);
}

function headerValues(cols) {
  return cols.map(c => c.header);
}

function naturalWidths(rows, cols) {
  return cols.map(col => {
    if (typeof col.width === 'number') return col.width;
    let w = displayWidth(col.header);
    for (const row of rows) w = Math.max(w, displayWidth(cellText(col, row)));
    return Math.max(1, w);
  });
}

function selectVisibleCols(rows, cols, maxWidth, border) {
  let visible = cols.filter(c => !c.hidden);
  if (visible.length <= 1 || maxWidth == null) return visible;

  // 先判断“自然宽度”是否放得下：放不下才按优先级隐藏列；
  // 隐藏后仍放不下，再交给 computeWidths 收缩/截断。
  const fits = () => tableWidth(naturalWidths(rows, visible), border) <= maxWidth;

  // 先隐藏 priority 2，再隐藏 priority 1（至少保留一列）
  for (const p of [2, 1]) {
    while (!fits()) {
      const candidates = visible.filter(c => c.priority === p);
      if (!candidates.length) break;
      // 隐藏自然宽度最大的一列
      const widths = naturalWidths(rows, visible);
      let worst = -1;
      let worstW = -1;
      for (const c of candidates) {
        const i = visible.indexOf(c);
        if (widths[i] > worstW) { worstW = widths[i]; worst = i; }
      }
      if (worst < 0 || visible.length <= 1) break;
      visible.splice(worst, 1);
    }
  }
  return visible;
}

function computeWidths(rows, cols, maxWidth, border) {
  const widths = naturalWidths(rows, cols);
  const overhead = tableOverhead(cols.length, border);
  if (maxWidth == null) return widths;

  // flex 列：先按自然宽度，再把剩余空间分给 flex
  const flexIdx = [];
  for (let i = 0; i < cols.length; i++) {
    if (cols[i].width && typeof cols[i].width === 'object') flexIdx.push(i);
  }
  const currentTotal = () => widths.reduce((a, b) => a + b, 0) + overhead;
  if (flexIdx.length && currentTotal() < maxWidth) {
    const remaining = maxWidth - currentTotal();
    const flexSum = flexIdx.reduce((s, i) => s + (Number(cols[i].width.flex) || 1), 0);
    for (const i of flexIdx) {
      const spec = cols[i].width;
      const share = Math.floor(remaining * ((Number(spec.flex) || 1) / flexSum));
      const min = Number.isFinite(spec.min) ? spec.min : 1;
      const max = Number.isFinite(spec.max) ? spec.max : Infinity;
      widths[i] = Math.max(min, Math.min(max, widths[i] + share));
    }
  }

  // 仍超宽：从最宽的列开始逐格收缩，最低 3（或列头截断后的宽度）
  let guard = 0;
  while (currentTotal() > maxWidth && guard++ < 10000) {
    let idx = -1;
    let best = 3;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] > best && widths[i] > 3) { best = widths[i]; idx = i; }
    }
    if (idx < 0) break;
    widths[idx] -= 1;
  }
  return widths;
}

function tableOverhead(n, border) {
  if (border === 'none' || border === 'compact') return Math.max(0, 2 * (n - 1));
  return 3 * n + 1;
}

function tableWidth(widths, border) {
  return widths.reduce((a, b) => a + b, 0) + tableOverhead(widths.length, border);
}

function borderChars(border) {
  if (border === 'ascii') return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|', ltee: '+', rtee: '+', ttee: '+', btee: '+', cross: '+' };
  if (border === 'square') return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│', ltee: '├', rtee: '┤', ttee: '┬', btee: '┴', cross: '┼' };
  return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', ltee: '├', rtee: '┤', ttee: '┬', btee: '┴', cross: '┼' };
}

function borderLine(kind, widths, chars, style) {
  const left = kind === 'top' ? chars.tl : kind === 'bottom' ? chars.bl : chars.ltee;
  const right = kind === 'top' ? chars.tr : kind === 'bottom' ? chars.br : chars.rtee;
  const joint = kind === 'top' ? chars.ttee : kind === 'bottom' ? chars.btee : chars.cross;
  const seg = w => chars.h.repeat(w + 2);
  const line = left + widths.map(seg).join(joint) + right;
  return style ? `\x1b[${style}m${line}\x1b[0m` : line;
}

function dataLine(_idxs, values, widths, cols, o) {
  const border = o.border;
  const chars = o.chars;
  const cells = values.map((v, i) => {
    const col = cols[i];
    const w = widths[i];
    let text = v;
    if (o.isHeader) {
      text = truncateW(text, w, '…');
    } else if (col.truncate && displayWidth(text) > w) {
      text = truncateW(text, w, '…');
    }
    const pad = col.align === 'r' ? padStartW(text, w) : col.align === 'c' ? centerW(text, w) : padEndW(text, w);
    let styled = pad;
    if (o.isHeader && o.style) styled = `\x1b[${o.style}m${pad}\x1b[0m`;
    else if (o.styles && o.styles[i]) styled = `\x1b[${o.styles[i]}m${pad}\x1b[0m`;
    if (o.selected) styled = `\x1b[7m${stripStyle(styled)}\x1b[0m`;
    return styled;
  });

  if (border === 'none') return cells.join('  ').replace(/\s+$/, '');
  if (border === 'compact') return cells.join('  ').replace(/\s+$/, '');
  return chars.v + ' ' + cells.join(' ' + chars.v + ' ') + ' ' + chars.v;
}

function centerW(text, width) {
  const w = displayWidth(text);
  if (w >= width) return text;
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - w - left);
}

function stripStyle(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function renderStacked(rows, cols, opts) {
  const width = opts.width || 80;
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme;
  const lines = [];
  for (const row of rows) {
    const headCols = cols.slice(0, 2);
    const head = headCols.map(c => cellText(c, row)).filter(Boolean).join(' ');
    lines.push(truncateW(head, width));
    for (const col of cols.slice(2)) {
      const v = cellText(col, row);
      if (!v) continue;
      const label = `${col.header}: `;
      const tone = col.tone ? col.tone(row[col.key], row) : null;
      const text = truncateW(label + v, width);
      lines.push(color && tone ? `\x1b[${theme.sgr(tone)}m${text}\x1b[0m` : text);
    }
  }
  return lines.join('\n');
}

module.exports = { renderTable, borderChars };
