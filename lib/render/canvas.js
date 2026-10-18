// lib/render/canvas.js — 字符单元格画布（零依赖）
//
// 用途：
// - 终端静态图表（K 线、线图、热力图）先画到 Canvas，再一次性输出
// - TUI 用 Canvas 做整屏合成 + 行级 diff，避免闪烁
//
// 关键规则：
// - 宽字符（中文/emoji）占两格；第二格是 continuation，渲染时跳过
// - 覆盖宽字符时同时清理另一半，避免残影
// - 样式与文本分离；color=false 时完全不出 ANSI
// - 控制字符不允许进入画布（替换为空格），防止终端注入

const { splitGraphemes, graphemeWidth, displayWidth } = require('./width');

class Canvas {
  /**
   * @param {number} width
   * @param {number} height
   */
  constructor(width, height) {
    this.width = Math.max(1, Math.floor(width || 1));
    this.height = Math.max(1, Math.floor(height || 1));
    /** @type {Array<null|{ch:string, style:string, cont?:boolean}>} */
    this.cells = new Array(this.width * this.height).fill(null);
  }

  _idx(x, y) {
    return y * this.width + x;
  }

  _inside(x, y) {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** 清理某个位置及其可能关联的宽字符另一半 */
  _clearAt(x, y) {
    if (!this._inside(x, y)) return;
    const i = this._idx(x, y);
    const cell = this.cells[i];
    if (!cell) return;
    if (cell.cont) {
      // 当前是宽字符的第二格 → 清掉左边本体
      const left = this._idx(x - 1, y);
      if (x - 1 >= 0) this.cells[left] = null;
    } else if (graphemeWidth(cell.ch) === 2) {
      // 当前是宽字符本体 → 清掉右边 continuation
      if (x + 1 < this.width) this.cells[this._idx(x + 1, y)] = null;
    }
    this.cells[i] = null;
  }

  /**
   * 写入一个 grapheme。
   * @param {number} x
   * @param {number} y
   * @param {string} ch
   * @param {string} [style] SGR 参数串
   */
  set(x, y, ch, style = '') {
    if (!this._inside(x, y)) return;
    let g = String(ch == null ? '' : ch);
    if (!g) return;

    if (g === '\t') {
      for (let i = 0; i < 4; i++) this.set(x + i, y, ' ', style);
      return;
    }

    // 控制字符/换行不允许进入画布
    let gw = graphemeWidth(g);
    const cp = g.codePointAt(0);
    const isControlChar = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    if (g === '\n' || g === '\r' || isControlChar) {
      g = ' ';
      gw = 1;
    } else if (gw === 0) {
      // 组合字符：附着到前一个非 continuation 单元格
      if (x > 0) {
        const prev = this.cells[this._idx(x - 1, y)];
        if (prev && !prev.cont) prev.ch += g;
      }
      return;
    }
    if (gw !== 1 && gw !== 2) {
      g = '?';
      gw = 1;
    }

    this._clearAt(x, y);
    if (gw === 2) {
      // 右边放不下 → 退化为空格，保证行宽不越界
      if (x + 1 >= this.width) {
        this.cells[this._idx(x, y)] = { ch: ' ', style };
        return;
      }
      this._clearAt(x + 1, y);
      this.cells[this._idx(x, y)] = { ch: g, style };
      this.cells[this._idx(x + 1, y)] = { ch: '', style, cont: true };
      return;
    }

    this.cells[this._idx(x, y)] = { ch: g, style };
  }

  /**
   * 写字符串（不换行；超宽裁剪）。
   * @returns {number} 结束 x
   */
  text(x, y, str, style = '') {
    let cx = x;
    for (const g of splitGraphemes(String(str == null ? '' : str))) {
      if (g === '\n') { cx += 1; continue; }
      const gw = graphemeWidth(g);
      this.set(cx, y, g, style);
      if (g === '\t') cx += 4;
      else if (gw > 0) cx += gw;
      if (cx >= this.width) break;
    }
    return cx;
  }

  fillRect(x, y, w, h, ch = ' ', style = '') {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, style);
    }
  }

  hline(x, y, w, ch = '─', style = '') {
    for (let i = 0; i < w; i++) this.set(x + i, y, ch, style);
  }

  vline(x, y, h, ch = '│', style = '') {
    for (let i = 0; i < h; i++) this.set(x, y + i, ch, style);
  }

  /**
   * 画一个边框。
   * @param {object} p
   * @param {number} p.x
   * @param {number} p.y
   * @param {number} p.w
   * @param {number} p.h
   * @param {string} [p.title]
   * @param {'round'|'square'|'ascii'|'none'} [p.border='round']
   * @param {string} [p.titleStyle]
   * @param {string} [p.borderStyle]
   * @returns {{x:number,y:number,width:number,height:number}} 内容区
   */
  box(p = {}) {
    const { x, y, w, h, title = '', border = 'round', titleStyle = '', borderStyle = '' } = p;
    if (w <= 0 || h <= 0) return { x, y, width: 0, height: 0 };
    if (border !== 'none') {
      const chars = borderChars(border);
      this.set(x, y, chars.tl, borderStyle);
      this.set(x + w - 1, y, chars.tr, borderStyle);
      this.set(x, y + h - 1, chars.bl, borderStyle);
      this.set(x + w - 1, y + h - 1, chars.br, borderStyle);
      this.hline(x + 1, y, Math.max(0, w - 2), chars.h, borderStyle);
      this.hline(x + 1, y + h - 1, Math.max(0, w - 2), chars.h, borderStyle);
      this.vline(x, y + 1, Math.max(0, h - 2), chars.v, borderStyle);
      this.vline(x + w - 1, y + 1, Math.max(0, h - 2), chars.v, borderStyle);
      if (title) {
        const t = truncateTitle(title, Math.max(0, w - 4));
        this.text(x + 2, y, t, titleStyle);
      }
      return { x: x + 1, y: y + 1, width: Math.max(0, w - 2), height: Math.max(0, h - 2) };
    }
    return { x, y, width: w, height: h };
  }

  /**
   * 渲染为行数组。
   * @param {boolean} [color=true] 是否输出 ANSI 样式
   * @returns {string[]}
   */
  toString(color = true) {
    const lines = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      let visible = 0;
      let currentStyle = null;
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[this._idx(x, y)];
        if (!cell) {
          line += ' ';
          visible += 1;
          continue;
        }
        if (cell.cont) continue;
        const gw = Math.max(1, graphemeWidth(cell.ch));
        if (color && cell.style !== currentStyle) {
          if (currentStyle) line += '\x1b[0m';
          if (cell.style) line += `\x1b[${cell.style}m`;
          currentStyle = cell.style;
        }
        line += cell.ch || ' ';
        visible += gw;
      }
      if (color && currentStyle) line += '\x1b[0m';
      if (visible < this.width) line += ' '.repeat(this.width - visible);
      lines.push(line);
    }
    return lines;
  }

  /** 纯文本行（无 ANSI） */
  toText() {
    return this.toString(false);
  }

  /**
   * 与上一帧做行级 diff。
   * @param {Canvas|null} prev
   * @param {boolean} [color=true]
   * @returns {string} 可直接写 stdout 的 ANSI 串
   */
  diff(prev, color = true) {
    const lines = this.toString(color);
    if (!prev || prev.width !== this.width || prev.height !== this.height) {
      return '\x1b[2J' + lines.map((line, i) => `\x1b[${i + 1};1H${line}`).join('');
    }
    const prevLines = prev.toString(color);
    let out = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== prevLines[i]) {
        out += `\x1b[${i + 1};1H${lines[i]}\x1b[K`;
      }
    }
    return out;
  }
}

function borderChars(border) {
  if (border === 'ascii') {
    return { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };
  }
  if (border === 'square') {
    return { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  }
  return { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
}

function truncateTitle(title, width) {
  if (width <= 0) return '';
  let out = '';
  let w = 0;
  for (const g of splitGraphemes(String(title))) {
    const gw = graphemeWidth(g);
    if (w + gw > width) break;
    out += g;
    w += gw;
  }
  return out;
}

module.exports = { Canvas, borderChars, truncateTitle };
