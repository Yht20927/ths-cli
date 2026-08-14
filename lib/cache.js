// lib/cache.js — 本地 JSON 缓存（K线 + 自选股），原子写
//
// 文件: data/cache/ths.json（data/ 已 gitignore）。与 audit.json 相同的最小持久化：
// tmp 写入 + rename 原子替换，读写失败不阻塞主流程。
//
// 设计要点：
// - K线按 `code_period_adjust` 为 key，记录 fetchedAt/count/market/bars
// - loadKline：新鲜且条数够 → 直接读缓存，否则走 fetchKlineBars 回填
// - 自选股：watchlist 数组 CRUD，dedupe 按 code

const fs = require('fs');
const path = require('path');
const { periodKey } = require('./commands/helpers');

const DEFAULT_FILE = process.env.THS_CACHE_FILE || path.join(__dirname, '..', 'data', 'cache', 'ths.json');

class KlineCache {
  /**
   * @param {string} [file] 缓存文件路径（测试可注入临时路径）
   */
  constructor(file = DEFAULT_FILE) {
    this.file = file;
    this.data = { version: 1, kline: {}, watchlist: [], names: {} };
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.data = {
          version: 1,
          kline: parsed.kline && typeof parsed.kline === 'object' ? parsed.kline : {},
          watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
          names: parsed.names && typeof parsed.names === 'object' ? parsed.names : {},
        };
      }
    } catch (e) { /* 首次运行无文件 */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { /* 缓存失败不阻塞主流程 */ }
  }

  // ── K线缓存 ──

  /** @returns {object|null} { fetchedAt, market, count, bars } */
  getKline(key) {
    return this.data.kline[key] || null;
  }

  /** 是否新鲜（fetchedAt 距今 < maxAgeMs） */
  isFresh(key, maxAgeMs) {
    const e = this.getKline(key);
    if (!e || !e.fetchedAt) return false;
    return Date.now() - Date.parse(e.fetchedAt) < maxAgeMs;
  }

  setKline(key, market, bars, count) {
    this.data.kline[key] = {
      fetchedAt: new Date().toISOString(),
      market: market || '',
      count: count != null ? count : bars.length,
      bars,
    };
    this._save();
  }

  clearKline() {
    this.data.kline = {};
    this._save();
  }

  // ── 名称缓存（code → name）──

  getName(code) {
    return this.data.names[String(code)] || null;
  }

  setName(code, name) {
    if (!code || !name) return;
    this.data.names[String(code)] = String(name);
    this._save();
  }

  // ── 全量清空（K线 + 名称 + 自选股）──

  clearAll() {
    this.data.kline = {};
    this.data.names = {};
    this.data.watchlist = [];
    this._save();
  }

  // ── 自选股 ──

  /** @returns {boolean} 是否新增成功（重复 code 返回 false） */
  watchlistAdd(item) {
    if (!item || !item.code) return false;
    if (this.data.watchlist.some(w => w.code === item.code)) return false;
    this.data.watchlist.push({ addedAt: new Date().toISOString(), ...item });
    this._save();
    return true;
  }

  /** @returns {boolean} 是否存在并移除 */
  watchlistRemove(code) {
    const i = this.data.watchlist.findIndex(w => w.code === String(code));
    if (i === -1) return false;
    this.data.watchlist.splice(i, 1);
    this._save();
    return true;
  }

  watchlistList() {
    return this.data.watchlist.slice();
  }
}

/**
 * 缓存感知的 K 线加载：新鲜且条数够 → 缓存；否则网络拉取并回填。
 * @param {object} ctx - CLI 上下文（含 fetchKlineBars 所需 audit/loggedCall）
 * @param {KlineCache} cache
 * @param {object} params - { code, market, period, count, adjust }
 * @param {object} [opts] - { maxAgeMs, refresh }
 * @returns {Promise<Array<{date, open, high, low, close, volume, amount}>>}
 */
async function loadKline(ctx, cache, params, opts = {}) {
  const { code, period, adjust, market, count } = params;
  // 周期名归一化：'day_1' 与 'day' 共用同一缓存（见 helpers.periodKey）
  const key = `${code}_${periodKey(period)}_${adjust || 'forward'}`;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 10 * 60 * 1000;

  if (!opts.refresh && cache.isFresh(key, maxAgeMs)) {
    const entry = cache.getKline(key);
    if (entry.bars && entry.bars.length >= count) {
      return entry.bars.slice(-count);
    }
  }

  const { fetchKlineBars } = require('./commands/kline');
  const bars = await fetchKlineBars(ctx, params);
  if (Array.isArray(bars) && bars.length > 0) {
    cache.setKline(key, market, bars, count);
  }
  return bars;
}

/**
 * 解析股票名称：优先缓存，miss 时走 search 接口并回填。
 * @param {object} ctx - CLI 上下文（含 bridgeCall）
 * @param {KlineCache} cache
 * @param {string} code
 * @returns {Promise<string|null>}
 */
async function resolveName(ctx, cache, code) {
  const c = String(code);
  const hit = cache.getName(c);
  if (hit) return hit;
  try {
    const data = await ctx.bridgeCall(`window.__ths.searchStock('${c}')`);
    const rows = ((data && data.body) || []).map(r => Array.isArray(r) ? r : []);
    const head = (data && data.head) || [];
    let name = null;
    for (const row of rows) {
      const map = {};
      head.forEach((h, i) => { map[h.id] = row[i]; });
      const nm = map.stock_name != null ? map.stock_name : row[1];
      const hq = map.hq_code != null ? map.hq_code : row[0];
      if (String(hq) === c && nm != null) { name = nm; break; }
    }
    if (!name && rows.length) name = rows[0][1] || null;
    if (name) cache.setName(c, name);
    return name;
  } catch (e) {
    return null;
  }
}

/**
 * 判断代码是否存在于同花顺（用于区分代码错/退市/停牌）。
 * @returns {boolean|null} true 存在 / false 不存在 / null 无法判断
 */
async function codeExists(ctx, code) {
  try {
    const data = await ctx.bridgeCall(`window.__ths.searchStock('${code}')`);
    const rows = ((data && data.body) || []).map(r => (Array.isArray(r) ? r : []));
    const head = (data && data.head) || [];
    for (const row of rows) {
      const map = {};
      head.forEach((h, i) => { map[h.id] = row[i]; });
      const hq = map.hq_code != null ? map.hq_code : row[0];
      if (String(hq) === String(code)) return true;
    }
    return rows.length > 0;
  } catch (e) {
    return null;
  }
}

module.exports = { KlineCache, loadKline, ttlMsForPeriod, resolveName, codeExists };

// ── TTL 默认值（分钟），可被 config.cache.ttlMinutes[period] 覆盖 ──
const DEFAULT_TTL_BY_PERIOD = { day: 10, week: 30, month: 60, quarter: 60, '60min': 1, '120min': 1 };

/**
 * 周期 → 缓存 TTL（毫秒）。
 * @param {object} [config] config.json 内容（可选）
 * @param {string} period PERIODS 的 key（day/week/...）
 */
function ttlMsForPeriod(config, period) {
  const k = periodKey(period);
  const ttlMin = (config && config.cache && config.cache.ttlMinutes)
    ? config.cache.ttlMinutes[k]
    : DEFAULT_TTL_BY_PERIOD[k];
  return ((ttlMin != null ? ttlMin : 10) * 60 * 1000);
}
