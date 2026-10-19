// lib/render/widgets/tiles.js — 指标卡（零依赖）

const { displayWidth, padEndW, truncateW, padStartW } = require('../width');

/**
 * @param {Array<{label:string,value:string|number,delta?:string,tone?:string,spark?:string}>} items
 * @param {object} [opts]
 * @param {number} [opts.width=80]
 * @param {boolean} [opts.color]
 * @param {object} [opts.theme]
 * @param {'round'|'square'|'ascii'} [opts.border='round']
 * @returns {string}
 */
function renderTiles(items, opts = {}) {
  const list = items || [];
  if (!list.length) return '';
  const width = Math.max(20, Math.floor(opts.width || 80));
  const color = !!opts.color && !!opts.theme;
  const theme = opts.theme;
  const border = opts.border || (theme && theme.symbols && theme.symbols.missing === '-' ? 'ascii' : 'round');
  const chars = borderChars(border);
  const gap = 1;
  const perRow = width >= 100 ? 4 : width >= 60 ? 2 : 1;
  const tileW = Math.max(10, Math.floor((width - gap * (perRow - 1)) / perRow));
  const contentW = tileW - 2;

  const tiles = list.map(it => {
    const label = String(it.label == null ? '' : it.label);
    const value = String(it.value == null ? '' : it.value);
    const spark = it.spark ? String(it.spark) : '';
    const tone = it.tone || null;

    const topTitle = ' ' + truncateW(label, Math.max(0, contentW - 2)) + ' ';
    const top = chars.tl + padEndW(topTitle, contentW, chars.h) + chars.tr;

    const valueText = truncateW(value, contentW - 1);
    const valueLine = color && tone
      ? `\x1b[${theme.sgr(tone)}m${padEndW(' ' + valueText, contentW)}\x1b[0m`
      : padEndW(' ' + valueText, contentW);

    const lines = [top, chars.v + valueLine + chars.v];
    if (spark) {
      const sparkText = truncateW(spark, contentW - 1);
      const sparkLine = color && tone
        ? `\x1b[${theme.sgr(tone)}m${padEndW(' ' + sparkText, contentW)}\x1b[0m`
        : padEndW(' ' + sparkText, contentW);
      lines.push(chars.v + sparkLine + chars.v);
    }
    if (it.delta) {
      const deltaText = truncateW(String(it.delta), contentW - 1);
      lines.push(chars.v + padEndW(' ' + deltaText, contentW) + chars.v);
    }
    lines.push(chars.bl + chars.h.repeat(contentW) + chars.br);
    return lines;
  });

  const height = Math.max(...tiles.map(t => t.length));
  // 统一卡片高度：短卡片在底边前补空白内容行，横向拼接才不会出现“半截框”
  const blank = chars.v + ' '.repeat(contentW) + chars.v;
  for (const t of tiles) {
    while (t.length < height) t.splice(t.length - 1, 0, blank);
  }
  const out = [];
  // 先按“卡片行”分组，再逐行拼接；若按行号在外层循环，
  // 多行卡片会与下一组卡片交错（上/下边框跑到中间）。
  for (let i = 0; i < tiles.length; i += perRow) {
    const group = tiles.slice(i, i + perRow);
    for (let r = 0; r < height; r++) {
      const parts = group.map(t => t[r] || ' '.repeat(tileW));
      out.push(parts.join(' '.repeat(gap)));
    }
  }
  return out.join('\n');
}

function borderChars(border) {
  if (border === 'ascii') return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  if (border === 'square') return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
}

module.exports = { renderTiles };
