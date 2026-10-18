// lib/render/width.js — 终端显示宽度与文本裁剪（零依赖）
//
// 终端里的“宽度”不是 String.length：
// - 中文/全角字符占 2 格
// - emoji / ZWJ 组合序列占 2 格
// - 组合附加符号占 0 格
// - ANSI 转义序列占 0 格
//
// 本模块是渲染层唯一的宽度来源。表格、Canvas、截断、换行都必须走这里，
// 否则中文列会错位、ANSI 会破坏裁剪。

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** 去掉 ANSI 转义序列（SGR + OSC） */
function stripAnsi(s) {
  return String(s == null ? '' : s).replace(ANSI_RE, '');
}

let segmenter = null;

/**
 * 按 grapheme cluster 切分。优先用内置 Intl.Segmenter（Node 18+），
 * 这样 ZWJ emoji（👨‍👩‍👧）、旗帜、组合字符会作为一个整体处理。
 * @param {string} s
 * @returns {string[]}
 */
function splitGraphemes(s) {
  const str = String(s == null ? '' : s);
  if (!str) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    if (!segmenter) segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(str), x => x.segment);
  }
  return Array.from(str);
}

// 组合附加符号 / 零宽字符：宽度 0
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x05bf, 0x05bf],
  [0x05c1, 0x05c2], [0x05c4, 0x05c5], [0x05c7, 0x05c7], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x06df, 0x06e4],
  [0x06e7, 0x06e8], [0x06ea, 0x06ed], [0x0711, 0x0711], [0x0730, 0x074a],
  [0x07a6, 0x07b0], [0x07eb, 0x07f3], [0x0816, 0x0819], [0x081b, 0x0823],
  [0x0825, 0x0827], [0x0829, 0x082d], [0x0859, 0x085b], [0x08d3, 0x08e1],
  [0x08e3, 0x0902], [0x093a, 0x093a], [0x093c, 0x093c], [0x0941, 0x0948],
  [0x094d, 0x094d], [0x0951, 0x0957], [0x0962, 0x0963], [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a], [0x0e47, 0x0e4e], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
];

// 东亚宽字符（CJK / 全角 / Hangul 等）：宽度 2
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1b000, 0x1b2ff],
  [0x1f200, 0x1f2ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function inRanges(cp, ranges) {
  // ranges 已按区间起点升序；线性扫描足够（数量很小）
  for (const [a, b] of ranges) {
    if (cp < a) return false;
    if (cp <= b) return true;
  }
  return false;
}

function isZeroWidth(cp) {
  return cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 ||
    cp === 0xfeff || cp === 0xfe0e || cp === 0xfe0f || inRanges(cp, ZERO_WIDTH_RANGES);
}

function isControl(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

function isWide(cp) {
  return inRanges(cp, WIDE_RANGES);
}

/** 单个 grapheme 是否按 emoji 宽度（2）处理 */
function isEmojiGrapheme(g) {
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfe0f || cp === 0x20e3) return true;
    if (cp >= 0x1f000 && cp <= 0x1faff) return true;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true; // 区域旗帜
  }
  return false;
}

/** 单个 grapheme 的显示宽度 */
function graphemeWidth(g) {
  if (!g) return 0;
  if (isEmojiGrapheme(g)) return 2;
  let w = 0;
  for (const ch of g) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09) { w += 4; continue; } // tab
    if (isControl(cp) || isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/**
 * 字符串显示宽度（ANSI 不计宽，组合字符 0，CJK/emoji 2）。
 * @param {string} s
 * @returns {number}
 */
function displayWidth(s) {
  const plain = stripAnsi(s);
  let w = 0;
  for (const g of splitGraphemes(plain)) w += graphemeWidth(g);
  return w;
}

/** 右侧补空格到指定显示宽度（已超宽则原样返回） */
function padEndW(s, width, pad = ' ') {
  const str = String(s == null ? '' : s);
  const diff = width - displayWidth(str);
  return diff > 0 ? str + pad.repeat(diff) : str;
}

/** 左侧补空格到指定显示宽度 */
function padStartW(s, width, pad = ' ') {
  const str = String(s == null ? '' : s);
  const diff = width - displayWidth(str);
  return diff > 0 ? pad.repeat(diff) + str : str;
}

/**
 * 按显示宽度截断（返回纯文本；输入若含 ANSI 会先剥离）。
 * @param {string} s
 * @param {number} width
 * @param {string} [ellipsis='…']
 */
function truncateW(s, width, ellipsis = '…') {
  const plain = stripAnsi(s);
  if (width <= 0) return '';
  if (displayWidth(plain) <= width) return plain;
  const eW = displayWidth(ellipsis);
  if (eW >= width) return truncateW(ellipsis, width, '');
  const limit = width - eW;
  let out = '';
  let w = 0;
  for (const g of splitGraphemes(plain)) {
    const gw = graphemeWidth(g);
    if (w + gw > limit) break;
    out += g;
    w += gw;
  }
  return out + ellipsis;
}

/**
 * 按显示宽度换行。中文可在任意字符间断行；英文优先在最后一个空格断。
 * @param {string} s
 * @param {number} width
 * @returns {string[]}
 */
function wrapW(s, width) {
  const plain = stripAnsi(s);
  if (width <= 0) return [''];
  const out = [];
  for (const rawLine of String(plain).split('\n')) {
    if (rawLine === '') { out.push(''); continue; }
    let line = '';
    let lineW = 0;
    let lastSpace = -1;
    for (const g of splitGraphemes(rawLine)) {
      const gw = graphemeWidth(g);
      if (lineW + gw > width && line !== '') {
        // 优先在最近的空格处断行（仅当断点后仍有内容）
        if (lastSpace > 0 && lastSpace < line.length) {
          out.push(line.slice(0, lastSpace).trimEnd());
          line = line.slice(lastSpace + 1);
          lineW = displayWidth(line);
        } else {
          out.push(line);
          line = '';
          lineW = 0;
        }
        lastSpace = -1;
      }
      line += g;
      lineW += gw;
      if (g === ' ') lastSpace = line.length - 1;
    }
    if (line !== '') out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * 按显示宽度切片（用于测试/调试；不保留 ANSI）。
 * @param {string} s
 * @param {number} start
 * @param {number} [end]
 */
function sliceW(s, start, end) {
  const plain = stripAnsi(s);
  const targetEnd = end == null ? Infinity : end;
  let out = '';
  let w = 0;
  for (const g of splitGraphemes(plain)) {
    const gw = graphemeWidth(g);
    if (w >= start && w < targetEnd) out += g;
    w += gw;
    if (w >= targetEnd) break;
  }
  return out;
}

module.exports = {
  stripAnsi,
  splitGraphemes,
  graphemeWidth,
  displayWidth,
  padEndW,
  padStartW,
  truncateW,
  wrapW,
  sliceW,
};
