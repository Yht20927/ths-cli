// lib/commands/helpers.js — 命令共享的辅助函数和上下文

const SITE = '10jqka.com.cn';

/**
 * 转义字符串用于 JS 表达式拼接
 */
function escapeExpression(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 从参数列表中提取 --flag value 形式的选项
 */
function getFlag(args, flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultValue;
  const val = args[idx + 1];
  if (val === undefined || typeof val !== 'string' || val.startsWith('--')) return defaultValue;
  return val;
}

/**
 * K 线周期 → 接口 time_period 映射
 */
const PERIODS = {
  day: 'day_1',
  week: 'week_1',
  month: 'month_1',
  quarter: 'quarter_1',
  '60min': 'min_60',
  '120min': 'min_120',
};

/**
 * API time_period → CLI 周期 key（缓存 key / TTL 用）
 * 'day_1' → 'day'，'day' → 'day'（幂等）
 */
const API_TO_CLI_PERIOD = {
  day_1: 'day',
  week_1: 'week',
  month_1: 'month',
  quarter_1: 'quarter',
  min_60: '60min',
  min_120: '120min',
};

function periodKey(period) {
  return API_TO_CLI_PERIOD[period] || period;
}

/**
 * 从证券代码推断市场码
 * @param {string|number} code
 * @returns {string|null} '17'(沪) / '33'(深) / null(需 --market)
 */
function inferMarket(code) {
  const c = String(code);
  if (/^6/.test(c)) return '17';    // 沪: 600/601/603/605/688 科创
  if (/^[03]/.test(c)) return '33'; // 深: 000/001/002/003/300/301
  if (/^88/.test(c)) return '48';   // 同花顺板块指数: 886100 等
  return null;                      // 4/8 开头北交所等 → 需 --market
}

/**
 * K 线原始数组 → 结构化对象
 * value = [ts, open, high, low, close, volume, amount]（对应 data_fields 1/7/8/9/11/13/19）
 */
function formatKline(value) {
  const d = new Date(value[0]);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    open: value[1],
    high: value[2],
    low: value[3],
    close: value[4],
    volume: value[5],
    amount: value[6],
  };
}

/**
 * 搜索行 → 结构化对象（按 head 列名映射）
 */
function formatSearchRow(row, head) {
  const map = {};
  if (Array.isArray(head)) {
    head.forEach((h, i) => { map[h.id] = row[i]; });
  }
  return {
    code: map.hq_code != null ? map.hq_code : row[0],
    name: map.stock_name != null ? map.stock_name : row[1],
    spell: map.simple_spell != null ? map.simple_spell : row[2],
    market: map.market_label != null ? map.market_label : (map.hq_market != null ? map.hq_market : ''),
  };
}

/**
 * 数字格式化:>=1e8 → x.xx亿, >=1e4 → x.xx万, 否则原样
 */
function fmtNum(n, digits = 2) {
  if (typeof n !== 'number' || !isFinite(n)) return n == null ? '' : String(n);
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(digits) + '亿';
  if (abs >= 1e4) return (n / 1e4).toFixed(digits) + '万';
  return String(Math.round(n * 100) / 100);
}

/**
 * 渲染 ASCII 表格
 * @param {Array<object>} rows
 * @param {Array<{header: string, key: string, fmt?: Function, align?: 'l'|'r'}>} cols
 */
function renderTable(rows, cols) {
  if (!Array.isArray(rows) || rows.length === 0) return '(空)';
  const headers = cols.map(c => c.header);
  const widths = headers.map((h, i) => h.length);
  const cells = rows.map(row =>
    cols.map((c, i) => {
      const raw = c.fmt ? c.fmt(row[c.key]) : row[c.key];
      const s = raw == null ? '' : String(raw);
      widths[i] = Math.max(widths[i], s.length);
      return s;
    })
  );
  const line = w => '+' + w.map(x => '-'.repeat(x + 2)).join('+') + '+';
  const fmtRow = (arr, aligns) =>
    '|' + arr.map((s, i) => {
      const pad = aligns[i] === 'r' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
      return ' ' + pad + ' ';
    }).join('|') + '|';
  const aligns = cols.map(c => (c.align === 'r' ? 'r' : 'l'));
  const out = [line(widths), fmtRow(headers, aligns), line(widths)];
  cells.forEach(r => out.push(fmtRow(r, aligns)));
  out.push(line(widths));
  return out.join('\n');
}

/**
 * 输出 CSV 行（含转义）
 */
function toCsv(rows, cols) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = cols.map(c => esc(c.header)).join(',');
  const body = rows.map(r => cols.map(c => esc(r[c.key])).join(','));
  return [header, ...body].join('\n');
}

/**
 * 渲染键值对（用于 quote/analyze 摘要等）
 * 按显示宽度对齐（CJK 字符按双宽计），避免中文标签长短不一导致 ':' 错位。
 * @param {Array<{label: string, value: string|number}>} items
 * @param {number} [labelWidth=12]
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.charCodeAt(0) >= 0x2e80 ? 2 : 1;
  return w;
}

function renderKV(items, labelWidth = 12) {
  return items.map(it => {
    const label = String(it.label);
    const pad = ' '.repeat(Math.max(0, labelWidth - displayWidth(label)));
    return `  ${label}${pad}: ${it.value == null ? '-' : it.value}`;
  }).join('\n');
}

// ── 实时行情快照字段映射（multi_last_snapshot data_fields）──
const QUOTE_FIELDS = {
  '6': 'price',       // 最新价
  '7': 'open',        // 开盘
  '8': 'high',        // 最高
  '9': 'low',         // 最低
  '10': 'prevClose',  // 昨收
  '18': 'volume',     // 成交量
  '19': 'amount',     // 成交额
  '199112': 'pct',    // 涨跌幅 %
  '264648': 'change', // 涨跌额
  '13': 'extra',      // 附加量/额（部分接口）
};

/**
 * 实时行情快照解析：按响应 data_fields 位置映射
 * @param {object} qd - quote_data[0]
 * @returns {object|null} {code, market, price, open, high, low, prevClose, volume, amount, pct, change, raw}
 */
function formatQuote(qd) {
  if (!qd || !Array.isArray(qd.data_fields) || !Array.isArray(qd.value) || !Array.isArray(qd.value[0])) return null;
  const row = qd.value[0];
  const out = { code: qd.code, market: qd.market, raw: row };
  qd.data_fields.forEach((f, i) => {
    const name = QUOTE_FIELDS[f];
    if (name) out[name] = row[i];
  });
  return out;
}

/**
 * 时间戳 → 本地 HH:MM（分时用）
 */
function fmtTime(ts) {
  if (ts == null) return '-';
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 分时解析：data_fields ["1","10","13","19"] → [时间, 价, 量, 额]
 * @returns {Array<{time, price, volume, amount}>}
 */
function formatTrend(qd) {
  if (!qd || !Array.isArray(qd.value)) return [];
  const idx = {};
  (qd.data_fields || []).forEach((f, i) => { idx[f] = i; });
  const tsIdx = idx['1'], priceIdx = idx['10'], volIdx = idx['13'], amtIdx = idx['19'];
  return qd.value.map(row => ({
    time: tsIdx != null ? fmtTime(row[tsIdx]) : '-',
    price: priceIdx != null ? row[priceIdx] : undefined,
    volume: volIdx != null ? row[volIdx] : undefined,
    amount: amtIdx != null ? row[amtIdx] : undefined,
  }));
}

/**
 * 大盘成交额解析（dq get_chart_data）
 * @returns {object} {name, header: {key: {name, value}}, points: [{ts, value}]}
 */
function formatTurnover(charts) {
  if (!charts) return null;
  const header = {};
  (charts.header || []).forEach(h => { header[h.key] = { name: h.name, value: h.val }; });
  const points = (charts.point_list || []).map(p => ({ ts: p[0], value: p[1] }));
  return { name: charts.name, header, points };
}

module.exports = {
  SITE,
  escapeExpression,
  getFlag,
  PERIODS,
  periodKey,
  inferMarket,
  formatKline,
  formatSearchRow,
  fmtNum,
  renderTable,
  toCsv,
  renderKV,
  QUOTE_FIELDS,
  formatQuote,
  formatTrend,
  formatTurnover,
  fmtTime,
};
