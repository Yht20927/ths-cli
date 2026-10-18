// lib/render/format.js — 数字/单位/日期格式化（零依赖）
//
// 约定：
// - 价格：元，2 位小数
// - 百分比：百分数（5.2 表示 +5.2%）
// - 金额：元 → 万/亿
// - 成交量：股 → 万/亿
// - 所有函数对 null/undefined/NaN 返回 '—'，不用 0 冒充缺失
// - 日期时间统一按北京时间（UTC+8）

const MISSING = '—';
const BJ_OFFSET_MS = 8 * 3600 * 1000;
const pad2 = n => String(n).padStart(2, '0');

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, digits) {
  const n = toNum(v);
  if (n === null) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** 价格：1482.00 */
function fmtPrice(v, digits = 2) {
  const n = round(v, digits);
  return n === null ? MISSING : n.toFixed(digits);
}

/** 数量：整数/千分位（默认不加千分位，保持终端紧凑） */
function fmtInt(v) {
  const n = toNum(v);
  return n === null ? MISSING : String(Math.round(n));
}

/** 百分比：+5.2% / -0.8% / — */
function fmtPct(v, digits = 1) {
  const n = round(v, digits);
  if (n === null) return MISSING;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

/** 带符号数字：+3 / -2 / 0 */
function fmtSigned(v, digits = 0) {
  const n = round(v, digits);
  if (n === null) return MISSING;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}`;
}

/** 金额：元 → 万/亿 */
function fmtMoney(v, digits = 2) {
  const n = toNum(v);
  if (n === null) return MISSING;
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(digits)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(digits)}万`;
  return `${Math.round(n * 100) / 100}`;
}

/** 成交量：股 → 万股/亿股 */
function fmtVolume(v, digits = 2) {
  const n = toNum(v);
  if (n === null) return MISSING;
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(digits)}亿股`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(digits)}万股`;
  return `${Math.round(n)}股`;
}

/** 比率：0.75 */
function fmtRatio(v, digits = 2) {
  const n = round(v, digits);
  return n === null ? MISSING : n.toFixed(digits);
}

/** 北京时间分量（UTC+8，不依赖进程 TZ） */
function beijingParts(ts) {
  let t;
  if (ts instanceof Date) t = ts.getTime();
  else if (typeof ts === 'string' && !/^\d+$/.test(ts)) t = Date.parse(ts);
  else t = Number(ts);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + BJ_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}

/** 日期：2026-10-18（已是 YYYY-MM-DD 字符串则原样返回） */
function fmtDate(v) {
  if (v == null) return MISSING;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const p = beijingParts(v);
  return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : MISSING;
}

/** 日期时间：2026-10-18 10:23:45（北京时间） */
function fmtDateTime(v, withSeconds = true) {
  if (v == null) return MISSING;
  const p = beijingParts(v);
  if (!p) return MISSING;
  const base = `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.min)}`;
  return withSeconds ? `${base}:${pad2(p.sec)}` : base;
}

/** 时间：10:23:45 */
function fmtTime(v, withSeconds = true) {
  if (v == null) return MISSING;
  const p = beijingParts(v);
  if (!p) return MISSING;
  return withSeconds
    ? `${pad2(p.hour)}:${pad2(p.min)}:${pad2(p.sec)}`
    : `${pad2(p.hour)}:${pad2(p.min)}`;
}

/** 时长：3s / 1.2m / 2h */
function fmtAge(ms) {
  const n = toNum(ms);
  if (n === null) return MISSING;
  const abs = Math.abs(n);
  if (abs < 1000) return `${Math.round(abs)}ms`;
  if (abs < 60_000) return `${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}s`;
  if (abs < 3_600_000) return `${(abs / 60_000).toFixed(1)}m`;
  return `${(abs / 3_600_000).toFixed(1)}h`;
}

/** 涨跌/正负 → 语义 tone */
function toneOf(v) {
  const n = toNum(v);
  if (n === null) return null;
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

/** 缺失值占位符（供 renderer 统一替换） */
function missing(symbol) {
  return symbol || MISSING;
}

module.exports = {
  MISSING,
  toNum,
  round,
  fmtPrice,
  fmtInt,
  fmtPct,
  fmtSigned,
  fmtMoney,
  fmtVolume,
  fmtRatio,
  beijingParts,
  fmtDate,
  fmtDateTime,
  fmtTime,
  fmtAge,
  toneOf,
  missing,
};
