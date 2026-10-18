// lib/render/capabilities.js — 终端能力探测（零依赖）
//
// 只负责“环境是什么”，不解析 CLI 参数。CLI 的 --width/--no-color 等
// 由 cli.js 读取后作为 overrides 传入。

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 24;

function firstEnv(env, keys) {
  for (const k of keys) {
    if (env && env[k]) return env[k];
  }
  return '';
}

/**
 * 探测终端能力。
 * @param {object} [overrides]
 * @param {object} [overrides.env]    默认 process.env
 * @param {object} [overrides.stdout] 默认 process.stdout
 * @param {number} [overrides.width]
 * @param {number} [overrides.height]
 * @param {boolean} [overrides.color] 显式关闭/开启颜色
 * @param {boolean} [overrides.ascii] 强制 ASCII 符号
 * @param {boolean} [overrides.emoji]
 * @returns {{
 *   isTTY:boolean, width:number, height:number,
 *   colorDepth:'none'|'ansi16'|'ansi256'|'truecolor',
 *   unicode:'full'|'basic'|'ascii', emoji:boolean
 * }}
 */
function detectCapabilities(overrides = {}) {
  const env = overrides.env || process.env || {};
  const stdout = overrides.stdout || process.stdout || {};
  const isTTY = !!stdout.isTTY;

  const cols = Number(overrides.width != null ? overrides.width : (env.COLUMNS || stdout.columns));
  const rows = Number(overrides.height != null ? overrides.height : (env.LINES || stdout.rows));
  const width = clamp(Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : DEFAULT_WIDTH, 40, 200);
  const height = clamp(Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_HEIGHT, 10, 100);

  const noColor = overrides.color === false || !!env.NO_COLOR || env.TERM === 'dumb' || !isTTY;
  let colorDepth = 'none';
  if (!noColor) {
    const colorterm = String(env.COLORTERM || '').toLowerCase();
    const term = String(env.TERM || '').toLowerCase();
    if (colorterm === 'truecolor' || colorterm === '24bit') colorDepth = 'truecolor';
    else if (term.includes('256color') || term.includes('truecolor')) colorDepth = 'ansi256';
    else colorDepth = 'ansi16';
  }

  const locale = firstEnv(env, ['LC_ALL', 'LC_CTYPE', 'LANG']);
  let unicode = 'full';
  if (overrides.ascii) unicode = 'ascii';
  else if (!/utf-?8/i.test(locale)) unicode = 'basic';

  return {
    isTTY,
    width,
    height,
    colorDepth,
    unicode,
    emoji: !!overrides.emoji,
  };
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { detectCapabilities, DEFAULT_WIDTH, DEFAULT_HEIGHT };
