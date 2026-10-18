// lib/tui/render.js — watch TUI 屏幕渲染（纯函数，可单测）
//
// 输入：state（lib/tui/state.js） + 终端尺寸/主题
// 输出：string[]，每行不超过 width；Screen 负责 diff/输出。

const { displayWidth, padEndW, padStartW, truncateW } = require('../render/width');
const { sparkline } = require('../render/widgets/sparkline');
const { candlestickChart } = require('../render/widgets/candles');
const { fmtPrice, fmtPct, fmtTime } = require('../render/format');
const { visibleCodes, sortLabel } = require('./state');

const DEFAULT_RULES = { chasePct: 7, dropPct: -5, volRatio: 3 };

/**
 * @param {object} state
 * @param {object} opts { width, height, color, theme }
 * @returns {string[]}
 */
function renderScreen(state, opts = {}) {
  const width = Math.max(40, Math.floor(opts.width || 80));
  const theme = opts.theme || null;
  const color = !!opts.color && !!theme;
  const sym = theme ? theme.symbols : {
    up: '^', down: 'v', flat: '-', critical: '[X]', warn: '[!]', info: '[i]',
    success: '[ok]', selected: '>', missing: '-', ellipsis: '...', bullet: '*',
  };
  const style = (token, text) => (color && theme ? theme.style(token, text) : String(text));

  let lines;
  switch (state.tab) {
    case 1: lines = renderAlerts(state, { width, style, sym, color, theme }); break;
    case 2: lines = renderDetail(state, { width, style, sym, color, theme, height: opts.height || 24 }); break;
    case 3: lines = renderHelp({ width, style, sym, color }); break;
    default: lines = renderDashboard(state, { width, style, sym, color, theme, height: opts.height || 24 });
  }

  // 统一补齐/裁剪
  return lines.map(line => {
    const s = String(line == null ? '' : line);
    return padEndW(displayWidth(s) > width ? truncateW(s, width) : s, width);
  });
}

// ── 总览 ────────────────────────────────────────────────────

function renderDashboard(state, o) {
  const { width, style, sym, color, theme, height } = o;
  const rules = { ...DEFAULT_RULES, ...(state.rules || {}) };
  const codes = visibleCodes(state);
  const selected = clamp(state.selected, 0, Math.max(0, codes.length - 1));
  const selectedItem = codes[selected] || null;

  const lines = [];
  lines.push(headerLine(state, { width, style, sym, color }));
  lines.push(tabLine(state, { width, style, sym }));

  const alertBox = renderAlertBox(state, { width, style, sym, color, max: 3 });
  const detailBox = renderSelectedSummary(state, selectedItem, { width, style, sym, color, theme, rules });
  const reserved = 1 + alertBox.length + detailBox.length; // footer + panels
  const tableSpace = Math.max(3, height - 2 - reserved - 2);
  const table = renderWatchTable(state, codes, selected, { width, style, sym, color, theme, rules, maxRows: tableSpace });

  lines.push(...table);
  lines.push(...alertBox);
  lines.push(...detailBox);
  lines.push(footerLine({ width, style, sym }));
  return lines;
}

function headerLine(state, o) {
  const { width, style, sym, color } = o;
  const time = fmtTime(state.now || Date.now());
  const last = state.lastTickAt ? `${Math.max(0, Math.round(((state.now || Date.now()) - state.lastTickAt) / 1000))}s前` : '-';
  const conn = state.lastError ? `${sym.warn} 异常` : `${sym.success} 正常`;
  const paused = state.paused ? '是' : '否';
  const parts = [
    'ths watch',
    `${time} ${state.label || ''}`.trim(),
    `连接 ${conn}`,
    `最近tick ${last}`,
    `间隔 ${state.interval || '-'}s`,
    `池 ${state.items.length}`,
    `告警 ${state.alerts.length}`,
    `暂停 ${paused}`,
  ];
  let line = parts.join(' · ');
  if (state.lastError) line += ` · ${truncateW(state.lastError, Math.max(0, width - displayWidth(line) - 3))}`;
  return padEndW(truncateW(line, width), width);
}

function tabLine(state, o) {
  const { width, style, sym } = o;
  const tabs = ['[1]总览', '[2]告警', '[3]详情', '[4]帮助'];
  const cur = state.tab;
  const rendered = tabs.map((t, i) => (i === cur ? style('accent', `▸${t}`) : t)).join('  ');
  const s = `排序 ${sortLabel(state.sortKey, state.sortDir)}${state.filter ? `  过滤 "${state.filter}"` : ''}${state.filterMode ? '  /输入中' : ''}`;
  const line = rendered + '    ' + s;
  return padEndW(truncateW(line, width), width);
}

function renderWatchTable(state, codes, selected, o) {
  const { width, style, color, theme, rules, maxRows } = o;
  const cols = tableColumns(width);
  const lines = [];
  const head = cols.map(c => c.align === 'r'
    ? padStartW(c.header, c.w)
    : padEndW(c.header, c.w)).join(' ');
  lines.push(style('header', head));

  if (!codes.length) {
    lines.push(state.filter ? '（无匹配标的）' : '（池为空）');
    return lines;
  }

  const rowsMax = Math.max(1, maxRows);
  const sel = clamp(selected, 0, Math.max(0, codes.length - 1));
  const start = sel >= rowsMax ? sel - rowsMax + 1 : 0;
  const shown = codes.slice(start, start + rowsMax);
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    const q = state.quotes[it.code] || {};
    const lvl = state.levels[it.code] || {};
    const st = statusOf(state, it.code, q, lvl, rules);
    const cells = cols.map(c => {
      const v = cellValue(c.key, it, q, lvl, st, state);
      return c.align === 'r' ? padStartW(v, c.w) : padEndW(v, c.w);
    });
    let line = cells.join(' ');
    const isSel = start + i === sel;
    const prefix = isSel ? (color ? '▸' : '>') : ' ';
    line = prefix + ' ' + line;
    if (isSel && color) line = `\x1b[7m${line}\x1b[0m`;
    else {
      // 涨跌/状态上色（选中行用反显，不再叠加前景色）
      const pct = Number(q.pct);
      if (Number.isFinite(pct)) {
        line = line.replace(/[+\-]\d+(\.\d+)?%/, m => style(pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat', m));
      }
      if (st.label) line = line.replace(st.label, style(st.tone, st.label));
    }
    lines.push(line);
  }
  const above = start;
  const below = Math.max(0, codes.length - (start + shown.length));
  if (above || below) {
    lines.push(`… 上方 ${above} 只 / 下方 ${below} 只（↑↓滚动）`);
  }
  return lines;
}

function tableColumns(width) {
  if (width >= 118) {
    return [
      { key: 'code', header: '代码', w: 6 },
      { key: 'name', header: '名称', w: 10 },
      { key: 'price', header: '现价', w: 8, align: 'r' },
      { key: 'pct', header: '涨跌%', w: 7, align: 'r' },
      { key: 'distSup', header: '距支撑', w: 7, align: 'r' },
      { key: 'distRes', header: '距压力', w: 7, align: 'r' },
      { key: 'stop', header: '止损', w: 7, align: 'r' },
      { key: 'vr', header: '量比', w: 5, align: 'r' },
      { key: 'status', header: '状态', w: 8 },
    ];
  }
  if (width >= 92) {
    return [
      { key: 'code', header: '代码', w: 6 },
      { key: 'name', header: '名称', w: 10 },
      { key: 'price', header: '现价', w: 8, align: 'r' },
      { key: 'pct', header: '涨跌%', w: 7, align: 'r' },
      { key: 'distSup', header: '距支撑', w: 7, align: 'r' },
      { key: 'distRes', header: '距压力', w: 7, align: 'r' },
      { key: 'status', header: '状态', w: 8 },
    ];
  }
  if (width >= 70) {
    return [
      { key: 'code', header: '代码', w: 6 },
      { key: 'name', header: '名称', w: 8 },
      { key: 'price', header: '现价', w: 8, align: 'r' },
      { key: 'pct', header: '涨跌%', w: 7, align: 'r' },
      { key: 'status', header: '状态', w: 8 },
    ];
  }
  return [
    { key: 'code', header: '代码', w: 6 },
    { key: 'price', header: '现价', w: 8, align: 'r' },
    { key: 'pct', header: '涨跌%', w: 7, align: 'r' },
    { key: 'status', header: '状态', w: 8 },
  ];
}

function cellValue(key, it, q, lvl, st, state) {
  switch (key) {
    case 'code': return it.code;
    case 'name': return it.name || it.code;
    case 'price': return q.price == null ? '-' : fmtPrice(q.price);
    case 'pct': return q.pct == null ? '-' : fmtPct(q.pct);
    case 'distSup': return dist(q.price, lvl.support);
    case 'distRes': return dist(q.price, lvl.resistance);
    case 'stop': return lvl.stop == null ? '-' : fmtPrice(lvl.stop);
    case 'vr': return q.volumeRatio == null ? '-' : String(round2(q.volumeRatio));
    case 'status': return st.label || '';
    default: return '';
  }
}

function statusOf(state, code, q, lvl, rules) {
  if (lvl.isBoard) return { tone: 'info', label: '板块风向' };
  if (!q || q.price == null) return { tone: 'muted', label: '' };
  const price = Number(q.price);
  const pct = Number(q.pct);
  const vr = q.volumeRatio == null ? null : Number(q.volumeRatio);
  const up = lvl.limitUp != null ? lvl.limitUp : q.limitUp;
  const down = lvl.limitDown != null ? lvl.limitDown : q.limitDown;

  // 直接按当前值派生状态标签，避免只靠 severity 猜具体原因
  if (lvl.stop != null && price <= Number(lvl.stop)) return { tone: 'critical', label: '破止损' };
  if (lvl.support != null && price <= Number(lvl.support)) return { tone: 'critical', label: '破支撑' };
  if (lvl.resistance != null && price >= Number(lvl.resistance)) return { tone: 'warn', label: '触压力' };
  if (Number.isFinite(pct) && pct >= rules.chasePct) return { tone: 'warn', label: '追高' };
  if (Number.isFinite(pct) && pct <= rules.dropPct) return { tone: 'warn', label: '急跌' };
  if (vr != null && vr >= rules.volRatio) return { tone: 'info', label: '放量' };
  if (up != null && price >= Number(up)) return { tone: 'info', label: '涨停' };
  if (down != null && price <= Number(down)) return { tone: 'info', label: '跌停' };
  return { tone: '', label: '' };
}

function renderAlertBox(state, o) {
  const { width, style, sym, color, max } = o;
  const lines = [style('muted', '── 告警 ─────────────────────────────────────────')];
  if (!state.alerts.length) {
    lines.push('  （本 tick 无触发）');
    return lines;
  }
  for (const a of state.alerts.slice(0, max)) {
    const icon = a.level === 'critical' ? sym.critical : a.level === 'warn' ? sym.warn : sym.info;
    const tone = a.level || 'info';
    const time = fmtTime(a.at || Date.now());
    const head = `${a.acked ? sym.success : icon} ${time} ${a.code} ${a.name || ''}`;
    const msg = a.message || '';
    let line = `${head}  ${msg}`;
    if (color) line = style(tone, line);
    lines.push('  ' + padEndW(truncateW(line, width - 2), width - 2));
  }
  return lines;
}

function renderSelectedSummary(state, item, o) {
  const { width, style, sym, color, theme, rules } = o;
  if (!item) return [style('muted', '── 选中 ──'), '  （无标的）'];
  const q = state.quotes[item.code] || {};
  const lvl = state.levels[item.code] || {};
  const s = lvl.summary || null;
  const parts = [
    `选中 ${item.code} ${item.name || ''}`,
    s ? `评分 ${s.score} ${s.signalLabel || s.signal}` : null,
    `支撑 ${lvl.support != null ? fmtPrice(lvl.support) : '-'}`,
    `压力 ${lvl.resistance != null ? fmtPrice(lvl.resistance) : '-'}`,
    `止损 ${lvl.stop != null ? fmtPrice(lvl.stop) : '-'}`,
    s && s.atrPct != null ? `ATR ${s.atrPct}%` : null,
  ].filter(Boolean);
  const hist = state.priceHistory[item.code] || [];
  const spark = hist.length > 1 ? sparkline(hist, { width: Math.min(30, Math.max(10, width - 20)) }) : '';
  const lines = [style('muted', '── 选中 ──')];
  lines.push('  ' + truncateW(parts.join('  '), width - 2));
  if (spark) lines.push('  ' + style(toneOfPct(q.pct), spark) + '  ' + (q.pct != null ? fmtPct(q.pct) : ''));
  return lines;
}

// ── 告警页 ──────────────────────────────────────────────────

function renderAlerts(state, o) {
  const { width, style, sym, color } = o;
  const lines = [];
  lines.push(headerLine(state, o));
  lines.push(tabLine(state, o));
  lines.push(style('muted', '── 今日告警（a 确认，↑↓选择）────────────────────'));
  if (!state.alerts.length) {
    lines.push('  （暂无告警）');
    lines.push(footerLine(o));
    return lines;
  }
  const sel = clamp(state.selected, 0, state.alerts.length - 1);
  state.alerts.forEach((a, i) => {
    const icon = a.acked ? sym.success : a.level === 'critical' ? sym.critical : a.level === 'warn' ? sym.warn : sym.info;
    const time = fmtTime(a.at || Date.now());
    let line = `${icon} ${time} ${a.code} ${a.name || ''}  ${a.message || ''}`;
    if (a.acked) line = style('muted', line);
    else if (color) line = style(a.level || 'info', line);
    const prefix = i === sel ? (color ? '\x1b[7m▸\x1b[0m ' : '> ') : '  ';
    lines.push(prefix + truncateW(line, width - 2));
  });
  lines.push(footerLine(o));
  return lines;
}

// ── 详情页 ──────────────────────────────────────────────────

function renderDetail(state, o) {
  const { width, style, sym, color, theme, height } = o;
  const item = selectedItemSafe(state);
  const lines = [];
  lines.push(headerLine(state, o));
  lines.push(tabLine(state, o));
  if (!item) {
    lines.push('  （无标的）');
    lines.push(footerLine(o));
    return lines;
  }
  const q = state.quotes[item.code] || {};
  const lvl = state.levels[item.code] || {};
  const s = lvl.summary || null;
  lines.push(`  ${item.code} ${item.name || ''} · ${q.price != null ? fmtPrice(q.price) : '-'}  ${q.pct != null ? fmtPct(q.pct) : ''}`);
  if (Array.isArray(lvl.bars) && lvl.bars.length) {
    const chart = candlestickChart(lvl.bars.slice(-80), {
      width,
      height: Math.max(6, Math.min(14, height - 9)),
      volumeHeight: 3,
      color,
      theme,
      ascii: !color && !(theme && theme.symbols && theme.symbols.missing === '—'),
      showMA: true,
    });
    lines.push(chart);
  } else {
    lines.push('  （无日K数据）');
  }
  if (s) {
    lines.push(`  评分 ${s.score} ${s.signalLabel || s.signal}  |  ${s.maAlignment}  |  MACD ${s.macdStatus}  |  ADX ${s.adx}  |  ATR ${s.atrPct}%`);
    lines.push(`  支撑 ${lvl.support != null ? fmtPrice(lvl.support) : '-'}  压力 ${lvl.resistance != null ? fmtPrice(lvl.resistance) : '-'}  固化止损 ${lvl.stop != null ? fmtPrice(lvl.stop) : '-'}`);
    if (s.conflicts && s.conflicts.length) lines.push(`  矛盾: ${s.conflicts.join(' / ')}`);
  }
  const hist = state.priceHistory[item.code] || [];
  if (hist.length > 1) lines.push('  近 ' + hist.length + ' tick  ' + sparkline(hist, { width: Math.min(50, width - 16) }));
  lines.push(footerLine(o));
  return lines;
}

// ── 帮助页 ──────────────────────────────────────────────────

function renderHelp(o) {
  const { width, style } = o;
  const rows = [
    ['q / Ctrl+C', '退出'],
    ['p', '暂停/恢复轮询'],
    ['r', '立即刷新'],
    ['1 2 3 4', '总览 / 告警 / 详情 / 帮助'],
    ['↑↓ / k j', '移动选中'],
    ['g / G', '首行 / 末行'],
    ['Enter', '详情'],
    ['Esc', '返回 / 取消输入'],
    ['s / S', '切换排序 / 反向'],
    ['/', '过滤代码或名称'],
    ['a', '确认告警（告警页）'],
    ['?', '帮助'],
  ];
  const lines = [style('header', 'ths watch TUI · 帮助')];
  for (const [k, v] of rows) lines.push(`  ${padEndW(k, 12)} ${v}`);
  lines.push('');
  lines.push('  颜色: 红=上涨/破位  绿=下跌/正常  黄=警告  蓝=提示');
  lines.push('  数据: 行情来自浏览器 Bridge；告警只做提醒，不自动交易。');
  lines.push('  按 q 退出。');
  return lines;
}

// ── 公共 ────────────────────────────────────────────────────

function footerLine(o) {
  const { width, style } = o;
  return style('muted', truncateW(
    '[q]退出 [p]暂停 [r]刷新 [1-4]页面 ↑↓选择 Enter详情 s排序 /过滤 ?帮助',
    width
  ));
}

function selectedItemSafe(state) {
  const codes = visibleCodes(state);
  if (!codes.length) return null;
  return codes[clamp(state.selected, 0, codes.length - 1)];
}

function dist(price, ref) {
  const p = Number(price), r = Number(ref);
  if (!Number.isFinite(p) || !Number.isFinite(r) || r === 0) return '-';
  const v = ((p - r) / r) * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function toneOfPct(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? 'up' : Number.isFinite(n) && n < 0 ? 'down' : 'flat';
}

function round2(v) {
  return Math.round(Number(v) * 100) / 100;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

module.exports = { renderScreen, statusOf, tableColumns };
