// lib/render/theme.js — 颜色 token → SGR 代码（零依赖）
//
// 设计：
// - 主题只提供语义 token（up/down/critical/...），渲染器不写死颜色。
// - 根据 colorDepth 自动选择 ansi16 / ansi256 / truecolor。
// - cn（默认）红涨绿跌；intl 交换；mono 只用粗体/暗色；high-contrast 强化。
// - colorDepth='none' 时所有颜色为空字符串，但符号仍然有效。

const { hexFg } = require('./ansi');

const ANSI16 = {
  text: '',
  muted: '90',
  dim: '2',
  accent: '36',
  up: '31',
  down: '32',
  flat: '37',
  critical: '1;31',
  warn: '33',
  info: '34',
  success: '32',
  border: '90',
  header: '1',
  selection: '7',
};

const ANSI256 = {
  text: '',
  muted: '38;5;244',
  dim: '2',
  accent: '38;5;43',
  up: '38;5;203',
  down: '38;5;41',
  flat: '38;5;250',
  critical: '1;38;5;196',
  warn: '38;5;178',
  info: '38;5;75',
  success: '38;5;41',
  border: '38;5;238',
  header: '1',
  selection: '7',
};

function truecolorPalette() {
  return {
    text: '',
    muted: hexFg('#8b949e'),
    dim: '2',
    accent: hexFg('#39c5cf'),
    up: hexFg('#f85149'),
    down: hexFg('#3fb950'),
    flat: hexFg('#c9d1d9'),
    critical: '1;' + hexFg('#ff6b6b'),
    warn: hexFg('#d29922'),
    info: hexFg('#58a6ff'),
    success: hexFg('#3fb950'),
    border: hexFg('#30363d'),
    header: '1',
    selection: '7',
  };
}

const SYMBOLS_UNICODE = {
  up: '▲',
  down: '▼',
  flat: '■',
  critical: '●',
  warn: '▲',
  info: '◆',
  success: '✓',
  selected: '▸',
  missing: '—',
  ellipsis: '…',
  bullet: '•',
};

const SYMBOLS_ASCII = {
  up: '^',
  down: 'v',
  flat: '-',
  critical: '[X]',
  warn: '[!]',
  info: '[i]',
  success: '[ok]',
  selected: '>',
  missing: '-',
  ellipsis: '...',
  bullet: '*',
};

const SYMBOLS_EMOJI = {
  ...SYMBOLS_UNICODE,
  critical: '🔴',
  warn: '🟠',
  info: '🟡',
};

const MONO = {
  text: '',
  muted: '2',
  dim: '2',
  accent: '1',
  up: '1',
  down: '2',
  flat: '',
  critical: '1;4',
  warn: '1',
  info: '',
  success: '1',
  border: '2',
  header: '1',
  selection: '7',
};

const HIGH_CONTRAST = {
  text: '',
  muted: '2',
  dim: '2',
  accent: '1;36',
  up: '1;31',
  down: '1;32',
  flat: '1',
  critical: '1;31;4',
  warn: '1;33',
  info: '1;34',
  success: '1;32',
  border: '1;90',
  header: '1;4',
  selection: '7',
};

function basePalette(colorDepth) {
  if (colorDepth === 'none') {
    return Object.fromEntries(Object.keys(ANSI16).map(k => [k, '']));
  }
  if (colorDepth === 'truecolor') return truecolorPalette();
  if (colorDepth === 'ansi256') return { ...ANSI256 };
  return { ...ANSI16 };
}

function normalizeThemeName(name) {
  const n = String(name || 'cn').toLowerCase();
  if (n === 'intl' || n === 'mono' || n === 'high-contrast' || n === 'hc') return n === 'hc' ? 'high-contrast' : n;
  return 'cn';
}

/**
 * 解析主题。
 * @param {string} [name='cn']
 * @param {object} caps detectCapabilities() 的输出
 */
function resolveTheme(name, caps = {}) {
  const themeName = normalizeThemeName(name);
  const colorDepth = caps.colorDepth || 'none';
  const colors = basePalette(colorDepth);

  if (themeName === 'intl') {
    const up = colors.up;
    colors.up = colors.down;
    colors.down = up;
  } else if (themeName === 'mono') {
    Object.assign(colors, colorDepth === 'none'
      ? Object.fromEntries(Object.keys(MONO).map(k => [k, '']))
      : MONO);
  } else if (themeName === 'high-contrast') {
    Object.assign(colors, colorDepth === 'none'
      ? Object.fromEntries(Object.keys(HIGH_CONTRAST).map(k => [k, '']))
      : HIGH_CONTRAST);
  }

  const symbols = caps.unicode === 'full'
    ? { ...SYMBOLS_UNICODE }
    : { ...SYMBOLS_ASCII };
  if (caps.emoji && caps.unicode === 'full') Object.assign(symbols, SYMBOLS_EMOJI);

  return {
    name: themeName,
    colorDepth,
    colors,
    symbols,
    /**
     * 用某个 token 包装文本。
     * @param {string} token
     * @param {string} text
     */
    style(token, text) {
      const s = String(text == null ? '' : text);
      const code = colors[token] || '';
      if (!code || colorDepth === 'none') return s;
      return `\x1b[${code}m${s}\x1b[0m`;
    },
    sgr(token) {
      return colors[token] || '';
    },
  };
}

module.exports = {
  resolveTheme,
  normalizeThemeName,
  ANSI16,
  ANSI256,
  MONO,
  HIGH_CONTRAST,
  SYMBOLS_UNICODE,
  SYMBOLS_ASCII,
};
