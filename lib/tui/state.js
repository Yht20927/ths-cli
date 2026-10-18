// lib/tui/state.js — watch TUI 状态机（纯函数，可单测）
//
// 设计：状态不可变；输入/行情事件 → 新状态。
// 渲染层只读取状态，不修改状态。

const SORTS = [
  { key: 'code', label: '代码' },
  { key: 'name', label: '名称' },
  { key: 'price', label: '现价' },
  { key: 'pct', label: '涨跌%' },
  { key: 'vr', label: '量比' },
  { key: 'status', label: '状态' },
];

const STATUS_RANK = { critical: 0, warn: 1, info: 2, '': 9 };

/**
 * @param {object} p
 * @param {Array<{code,name,market}>} p.items 池
 * @param {object} p.levels 参照位
 * @param {object} p.rules 告警阈值
 * @returns {object}
 */
function createState({ items = [], levels = {}, rules = {}, alerts = [], priceHistory = {} } = {}) {
  return {
    tab: 0,                // 0=总览 1=告警 2=详情 3=帮助
    selected: 0,
    sortKey: 'code',
    sortDir: 1,
    filter: '',
    filterMode: false,
    paused: false,
    items,
    levels,
    rules,
    quotes: {},            // code -> formatQuote 原始对象
    statusByCode: {},      // code -> 'critical'|'warn'|'info'|''
    alerts: Array.isArray(alerts) ? alerts.slice(0, 200) : [], // 最近的告警（新在前）
    priceHistory: priceHistory || {}, // code -> number[]
    tickNo: 0,
    phase: '',
    inSession: false,
    label: '',
    lastTickAt: null,
    lastError: null,
    consecFails: 0,
    now: Date.now(),
  };
}

/** 当前可见行（过滤 + 排序） */
function visibleCodes(state) {
  const q = String(state.filter || '').trim().toLowerCase();
  let items = state.items || [];
  if (q) {
    items = items.filter(it => {
      const name = String(it.name || '');
      return it.code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    });
  }
  const key = state.sortKey;
  const dir = state.sortDir === -1 ? -1 : 1;
  const val = it => {
    const qd = state.quotes[it.code] || {};
    switch (key) {
      case 'name': return String(it.name || '');
      case 'price': return num(qd.price);
      case 'pct': return num(qd.pct);
      case 'vr': return num(qd.volumeRatio);
      case 'status': return STATUS_RANK[state.statusByCode[it.code] || ''] ?? 9;
      default: return it.code;
    }
  };
  return items.slice().sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb)) * dir;
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });
}

/** 当前选中池条目 */
function selectedItem(state) {
  const codes = visibleCodes(state);
  if (!codes.length) return null;
  const idx = clamp(state.selected, 0, codes.length - 1);
  return codes[idx];
}

/**
 * 行情 tick → 新状态。
 * @param {object} state
 * @param {object} p { ts, phase, inSession, label, quotes, statusByCode, alerts, maxHistory }
 */
function onTick(state, p = {}) {
  const quotes = p.quotes || {};
  const priceHistory = { ...state.priceHistory };
  const max = p.maxHistory != null ? p.maxHistory : 40;
  for (const [code, q] of Object.entries(quotes)) {
    const price = Number(q && q.price);
    if (!Number.isFinite(price)) continue;
    const hist = (priceHistory[code] || []).concat(price);
    priceHistory[code] = hist.slice(-max);
  }

  const incoming = (p.alerts || []).map(a => ({
    ...a,
    id: `${p.ts || Date.now()}-${a.code}-${a.kind}`,
    at: Date.now(),
    acked: false,
  }));
  // 新告警在前；最多保留 200 条
  const alerts = [...incoming].reverse().concat(state.alerts).slice(0, 200);

  return {
    ...state,
    quotes,
    statusByCode: p.statusByCode || {},
    alerts,
    priceHistory,
    tickNo: state.tickNo + 1,
    phase: p.phase != null ? p.phase : state.phase,
    inSession: p.inSession != null ? p.inSession : state.inSession,
    label: p.label != null ? p.label : state.label,
    lastTickAt: Date.now(),
    lastError: null,
    consecFails: 0,
    now: Date.now(),
  };
}

/** 错误事件 */
function onError(state, err) {
  return {
    ...state,
    lastError: err && err.message ? err.message : String(err),
    consecFails: (state.consecFails || 0) + 1,
    now: Date.now(),
  };
}

/** 每秒时钟 */
function onClock(state, now = Date.now()) {
  return { ...state, now };
}

/**
 * 键位处理。
 * @param {object} state
 * @param {string} str 可打印字符
 * @param {object} key readline key 对象
 * @returns {{state:object, quit?:boolean, refresh?:boolean}}
 */
function handleKey(state, str, key = {}) {
  const name = key.name || '';

  // Ctrl+C 永远退出（包括过滤输入模式）
  if (key.ctrl && name === 'c') return { state, quit: true };

  // 过滤输入模式：除 Esc/Enter/Backspace 外都作为文本
  if (state.filterMode) {
    if (name === 'escape') return { state: { ...state, filterMode: false } };
    if (name === 'return' || name === 'enter') return { state: { ...state, filterMode: false, selected: 0 } };
    if (name === 'backspace') {
      return { state: { ...state, filter: trimLastGrapheme(state.filter), selected: 0 } };
    }
    if (str && !key.ctrl && !key.meta && str >= ' ') {
      return { state: { ...state, filter: state.filter + str, selected: 0 } };
    }
    return { state };
  }

  if (key.ctrl && name === 'c') return { state, quit: true };
  if (str === 'q') return { state, quit: true };

  if (str === 'p') return { state: { ...state, paused: !state.paused } };
  if (str === 'r') return { state, refresh: true };
  if (str === '?') return { state: { ...state, tab: 3, selected: 0 } };
  if (str === '1') return { state: { ...state, tab: 0 } };
  if (str === '2') return { state: { ...state, tab: 1, selected: 0 } };
  if (str === '3') return { state: { ...state, tab: 2 } };
  if (str === '4') return { state: { ...state, tab: 3, selected: 0 } };

  const listLen = state.tab === 1 ? state.alerts.length : visibleCodes(state).length;
  const last = Math.max(0, listLen - 1);
  const move = delta => ({ state: { ...state, selected: clamp(state.selected + delta, 0, last) } });

  if (name === 'up' || str === 'k') return move(-1);
  if (name === 'down' || str === 'j') return move(1);
  if (str === 'g') return { state: { ...state, selected: 0 } };
  if (str === 'G') return { state: { ...state, selected: last } };

  if (name === 'return' || name === 'enter') {
    if (state.tab === 1) {
      const alert = state.alerts[clamp(state.selected, 0, Math.max(0, state.alerts.length - 1))];
      if (!alert) return { state };
      const idx = visibleCodes(state).findIndex(it => it.code === alert.code);
      return { state: { ...state, tab: 2, selected: idx >= 0 ? idx : 0 } };
    }
    return { state: { ...state, tab: 2 } };
  }
  if (name === 'escape') return { state: { ...state, tab: 0, filterMode: false } };

  if (str === 's') {
    const i = SORTS.findIndex(x => x.key === state.sortKey);
    const next = SORTS[(i + 1) % SORTS.length];
    return { state: { ...state, sortKey: next.key, sortDir: 1 } };
  }
  if (str === 'S') return { state: { ...state, sortDir: state.sortDir === 1 ? -1 : 1 } };
  if (str === '/') return { state: { ...state, filterMode: true, filter: '' } };

  if (str === 'a' && state.tab === 1) {
    const alert = state.alerts[clamp(state.selected, 0, Math.max(0, state.alerts.length - 1))];
    if (!alert) return { state };
    const alerts = state.alerts.map(a => (a.id === alert.id ? { ...a, acked: true } : a));
    return { state: { ...state, alerts } };
  }

  return { state };
}

function sortLabel(key, dir) {
  const meta = SORTS.find(s => s.key === key);
  return `${meta ? meta.label : key}${dir === 1 ? '↑' : '↓'}`;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function trimLastGrapheme(s) {
  const arr = Array.from(String(s || ''));
  arr.pop();
  return arr.join('');
}

module.exports = {
  SORTS,
  STATUS_RANK,
  createState,
  visibleCodes,
  selectedItem,
  onTick,
  onError,
  onClock,
  handleKey,
  sortLabel,
};
