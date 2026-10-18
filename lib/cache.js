// lib/cache.js — 本地 JSON 缓存（K线）+ 用户状态（自选/名称/持仓）
//
// 文件:
//   data/cache/ths.json   K线（大文件，可重建）
//   data/state.json       自选/名称/持仓（小文件，用户数据；StateStore 管理）
//
// 设计要点：
// - K线按 `code_period_adjust` 为 key，记录 fetchedAt/count/market/bars
// - loadKline：新鲜且条数够 → 直接读缓存，否则走 fetchKlineBars 回填
// - 所有写路径：锁 → 重新读盘 → 合并 → 唯一 tmp + fsync + rename
// - 旧版 ths.json 的 watchlist/names/positions 首次启动自动迁移到 state.json

const fs = require('fs');
const path = require('path');
const { periodKey } = require('./commands/helpers');
const { toBeijingClock } = require('./trading-hours');

const DEFAULT_FILE = process.env.THS_CACHE_FILE || path.join(__dirname, '..', 'data', 'cache', 'ths.json');

const { atomicWriteJson, withLock, readJson, quarantineFile } = require('./store/atomic');
const { StateStore } = require('./state-store');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

/** 默认生产路径用 data/state.json；测试/自定义缓存用同名 .state.json sidecar */
function deriveStateFile(file) {
  if (file === DEFAULT_FILE) return DEFAULT_STATE_FILE;
  return file.replace(/\.json$/, '.state.json');
}

function emptyData() {
  return { version: 3, kline: {} };
}

function normalizeData(parsed) {
  return {
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    version: 3,
    kline: parsed && parsed.kline && typeof parsed.kline === 'object' ? parsed.kline : {},
  };
}

class KlineCache {
  /**
   * @param {string} [file] 缓存文件路径（测试可注入临时路径）
   * @param {object} [opts] { stateFile }
   */
  constructor(file = DEFAULT_FILE, opts = {}) {
    this.file = file;
    this.stateFile = opts.stateFile || deriveStateFile(file);
    this.data = emptyData();
    this._mtime = 0;
    this._legacyState = null;
    this._load();
    // 自选/名称/持仓放到独立小文件；旧版 ths.json 字段自动迁移
    this.state = new StateStore(this.stateFile);
    if (this._legacyState) this.state.migrateFrom(this._legacyState);
  }

  _load() {
    const r = readJson(this.file);
    if (r.ok) {
      this.data = normalizeData(r.data);
      const d = r.data || {};
      if (Array.isArray(d.watchlist) || (d.names && typeof d.names === 'object') || Array.isArray(d.positions)) {
        this._legacyState = {
          watchlist: Array.isArray(d.watchlist) ? d.watchlist : [],
          names: d.names && typeof d.names === 'object' ? d.names : {},
          positions: Array.isArray(d.positions) ? d.positions : [],
        };
      }
    } else {
      if (r.corrupt) quarantineFile(this.file);
      this.data = emptyData();
    }
    this._mtime = this._diskMtime();
  }

  _diskMtime() {
    try { return fs.statSync(this.file).mtimeMs; } catch (e) { return 0; }
  }

  /** 其他进程改过 K 线文件 → 重新加载 */
  _maybeReloadKline() {
    const m = this._diskMtime();
    if (m && m !== this._mtime) this._load();
  }

  _readFresh() {
    const r = readJson(this.file);
    if (r.ok) return normalizeData(r.data);
    if (r.corrupt) quarantineFile(this.file);
    return emptyData();
  }

  /**
   * 锁内“重新读盘 → 修改 → 原子写回”；只写 K 线，不再携带用户数据。
   * 首次写入时会顺手清掉旧版 ths.json 里的 watchlist/names/positions。
   */
  _mutateKline(fn, opts = {}) {
    const strict = !!opts.strict;
    try {
      return withLock(this.file, () => {
        const data = this._readFresh();
        const ret = fn(data);
        data.version = 3;
        const out = { ...data, version: 3 };
        delete out.watchlist;
        delete out.names;
        delete out.positions;
        atomicWriteJson(this.file, out);
        this.data = out;
        this._mtime = this._diskMtime();
        return ret;
      });
    } catch (e) {
      if (strict) throw e;
      process.stderr.write(`⚠ 缓存写入失败（${this.file}）: ${e.message}\n`);
      return undefined;
    }
  }

  // ── K线缓存 ──

  /** @returns {object|null} { fetchedAt, market, count, bars } */
  getKline(key) {
    this._maybeReloadKline();
    return this.data.kline[key] || null;
  }

  isFresh(key, maxAgeMs) {
    const e = this.getKline(key);
    if (!e || !e.fetchedAt) return false;
    return Date.now() - Date.parse(e.fetchedAt) < maxAgeMs;
  }

  setKline(key, market, bars, count) {
    this._mutateKline(d => {
      d.kline[key] = {
        fetchedAt: new Date().toISOString(),
        market: market || '',
        count: count != null ? count : bars.length,
        bars,
      };
    }, { strict: false });
  }

  clearKline() {
    this._mutateKline(d => { d.kline = {}; }, { strict: false });
  }

  // ── 名称 / 自选 / 持仓：委托独立 state store ──

  getName(code) { return this.state.getName(code); }
  setName(code, name) { this.state.setName(code, name); }
  watchlistAdd(item) { return this.state.watchlistAdd(item); }
  watchlistRemove(code) { return this.state.watchlistRemove(code); }
  watchlistList() { return this.state.watchlistList(); }
  positionsList() { return this.state.positionsList(); }
  positionsUpsert(pos) { this.state.positionsUpsert(pos); }
  positionGet(code) { return this.state.positionGet(code); }
  positionsRemove(code) { return this.state.positionsRemove(code); }
  positionsClear() { this.state.positionsClear(); }

  // ── 全量清空（K线 + 名称 + 自选股；持仓台账不在其中）──

  clearAll() {
    this._mutateKline(d => { d.kline = {}; }, { strict: true });
    this.state.clearWatchlistAndNames();
  }
}

/**
 * 缓存感知的 K 线加载：新鲜且条数够 → 缓存；否则网络拉取并回填。
 * @param {object} ctx - CLI 上下文（含 fetchKlineBars 所需 audit/loggedCall）
 * @param {KlineCache} cache
 * @param {object} params - { code, market, period, count, adjust }
 * @param {object} [opts] - { maxAgeMs, refresh, excludeForming, nowMs }
 *   excludeForming: 剔除在途末根再返回（历史引擎用；只作用返回数组，不回写缓存）
 *   nowMs: 测试注入 forming 判定时钟
 * @returns {Promise<Array<{date, open, high, low, close, volume, amount}>>}
 */
async function loadKline(ctx, cache, params, opts = {}) {
  const { code, period, adjust, market, count } = params;
  // 周期名归一化：'day_1' 与 'day' 共用同一缓存（见 helpers.periodKey）
  const key = `${code}_${periodKey(period)}_${adjust || 'forward'}`;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : 10 * 60 * 1000;

  if (!opts.refresh && cache.isFresh(key, maxAgeMs)) {
    const entry = cache.getKline(key);
    // 条数守卫用未过滤长度；过滤发生在 slice 之后
    if (entry.bars && entry.bars.length >= count) {
      const sliced = entry.bars.slice(-count);
      return opts.excludeForming ? closedBars(sliced, opts.nowMs) : sliced;
    }
  }

  const { fetchKlineBars } = require('./commands/kline');
  const bars = await fetchKlineBars(ctx, params);
  if (Array.isArray(bars) && bars.length > 0) {
    cache.setKline(key, market, bars, count);
  }
  if (opts.excludeForming) return closedBars(bars, opts.nowMs);
  return bars;
}

// ── 半截 K 线判定（数据卫生）──────────────────────────────────────────
//
// 盘中（<15:05 北京、工作日）拉到的日/周 K，末根若是"今天"，则该根是**在途未收盘
// bar**——close/high/low 都是截至此刻的盘中值。把它当完整历史 bar 算 MA/RSI/支撑压力/
// 回测会污染结果，直到收盘定型。判定规则见 isFormingBarNow。
//
// 硬规则（改这里务必保持）：
// - 只对**返回数组**剔除，绝不写回 cache.data.kline[key].bars（防缓存被永久截断）；
// - loadKline 在 slice(-count) **之后**才过滤；
// - 条数守卫用**未过滤**长度（否则 forming 期每次 loadKline 会误判条数不足反复打网络）。

/**
 * 末根是否"在途/未收盘"bar（相对北京今天与 15:05 判定，无交易日历依赖）。
 * 停牌/周末/节假日/开盘前：末根日期≠北京今天 → false（no-op 关键分支）。
 * @param {Array<{date:string,...}>} bars 升序 K 线
 * @param {number} [nowMs] 测试注入
 * @returns {boolean}
 */
function isFormingBarNow(bars, nowMs) {
  if (!Array.isArray(bars) || bars.length === 0) return false;
  const { dateStr, minutes, wd } = toBeijingClock(nowMs);
  if (wd === 0 || wd === 6) return false;
  const last = bars[bars.length - 1];
  if (!last || !last.date) return false;
  const settle = 15 * 60 + 5; // 15:05 K 线定型缓冲
  return String(last.date) === dateStr && minutes < settle;
}

/**
 * 剔除在途末根（若 forming）。恒返回新数组/原引用，不修改入参。
 * @param {Array<{date:string,...}>} bars
 * @param {number} [nowMs]
 * @returns {Array<{date:string,...}>}
 */
function closedBars(bars, nowMs) {
  if (!isFormingBarNow(bars, nowMs)) return bars;
  return bars.slice(0, -1);
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

module.exports = {
  DEFAULT_FILE,
  DEFAULT_STATE_FILE,
  deriveStateFile,
  KlineCache,
  loadKline,
  ttlMsForPeriod,
  resolveName,
  codeExists,
  isFormingBarNow,
  closedBars,
};

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
