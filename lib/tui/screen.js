// lib/tui/screen.js — 备用屏 + 行级 diff 渲染（零依赖）
//
// 只负责终端输出，不关心业务。渲染层给出“整屏行数组”，Screen 负责：
// - 裁剪/补齐到终端宽高
// - 首帧/尺寸变化全量重绘
// - 后续只重绘发生变化的行（避免闪烁）

const { displayWidth, padEndW, truncateW } = require('../render/width');

class Screen {
  /**
   * @param {object} [stdout] 默认 process.stdout
   * @param {object} [opts] { width, height }
   */
  constructor(stdout = process.stdout, opts = {}) {
    this.stdout = stdout;
    this.width = opts.width || stdout.columns || 80;
    this.height = opts.height || stdout.rows || 24;
    this.prev = [];
    this.entered = false;
  }

  enter() {
    if (this.entered) return;
    this.entered = true;
    this.write('\x1b[?1049h\x1b[?25l'); // alt screen + hide cursor
  }

  exit() {
    if (!this.entered) return;
    this.entered = false;
    this.write('\x1b[?25h\x1b[?1049l'); // show cursor + main screen
  }

  resize(width, height) {
    this.width = Math.max(20, Math.floor(width || this.stdout.columns || 80));
    this.height = Math.max(5, Math.floor(height || this.stdout.rows || 24));
    this.prev = [];
  }

  /**
   * @param {string[]} lines
   * @param {object} [opts] { full }
   */
  render(lines, opts = {}) {
    const next = normalize(lines, this.width, this.height);
    const full = opts.full || this.prev.length !== next.length || !this.prev.length;
    let out = '';
    if (full) {
      out += '\x1b[2J';
      for (let i = 0; i < next.length; i++) {
        out += `\x1b[${i + 1};1H${next[i]}\x1b[K`;
      }
    } else {
      for (let i = 0; i < next.length; i++) {
        if (next[i] !== this.prev[i]) out += `\x1b[${i + 1};1H${next[i]}\x1b[K`;
      }
    }
    this.prev = next;
    if (out) this.write(out);
  }

  write(s) {
    try { this.stdout.write(s); } catch (e) { /* 终端已关闭 */ }
  }
}

/** 裁剪/补齐到 width×height */
function normalize(lines, width, height) {
  const src = Array.isArray(lines) ? lines : [];
  const out = [];
  for (let i = 0; i < height; i++) {
    let line = src[i] == null ? '' : String(src[i]);
    line = line.replace(/\r/g, '');
    if (displayWidth(line) > width) line = truncateW(line, width);
    out.push(padEndW(line, width));
  }
  return out;
}

module.exports = { Screen, normalize };
