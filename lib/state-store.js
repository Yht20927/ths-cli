// lib/state-store.js — 自选股/名称/持仓台账（独立于 K 线缓存的小文件）
//
// 为什么拆：data/cache/ths.json 主要是 K 线（数 MB），每次 watchlist/positions
// 变更都全量重写整个文件既慢又容易与缓存写互相覆盖。用户数据放到独立
// data/state.json（或测试注入的 sidecar），小文件、锁内读改写。

const fs = require('fs');
const { atomicWriteJson, withLock, readJson, quarantineFile } = require('./store/atomic');

function emptyState() {
  return { version: 1, watchlist: [], names: {}, positions: [] };
}

function normalizeState(parsed) {
  return {
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    version: 1,
    watchlist: parsed && Array.isArray(parsed.watchlist) ? parsed.watchlist : [],
    names: parsed && parsed.names && typeof parsed.names === 'object' ? parsed.names : {},
    positions: parsed && Array.isArray(parsed.positions) ? parsed.positions : [],
  };
}

class StateStore {
  /** @param {string} file */
  constructor(file) {
    this.file = file;
    this.data = emptyState();
    this._mtime = 0;
    this._load();
  }

  _load() {
    const r = readJson(this.file);
    if (r.ok) {
      this.data = normalizeState(r.data);
    } else {
      if (r.corrupt) quarantineFile(this.file);
      this.data = emptyState();
    }
    this._mtime = this._diskMtime();
  }

  _diskMtime() {
    try { return fs.statSync(this.file).mtimeMs; } catch (e) { return 0; }
  }

  _maybeReload() {
    const m = this._diskMtime();
    if (m && m !== this._mtime) this._load();
  }

  /**
   * 从旧版 ths.json 的 watchlist/names/positions 迁移。
   * 只有 state 文件不存在时才写，避免覆盖已有用户数据。
   */
  migrateFrom(legacy) {
    if (!legacy) return false;
    const has = (Array.isArray(legacy.watchlist) && legacy.watchlist.length) ||
      (legacy.names && Object.keys(legacy.names).length) ||
      (Array.isArray(legacy.positions) && legacy.positions.length);
    if (!has) return false;
    if (fs.existsSync(this.file)) return false;
    this.data = normalizeState({
      watchlist: legacy.watchlist,
      names: legacy.names,
      positions: legacy.positions,
    });
    atomicWriteJson(this.file, this.data);
    this._mtime = this._diskMtime();
    return true;
  }

  _mutate(fn, opts = {}) {
    const strict = opts.strict !== false;
    try {
      return withLock(this.file, () => {
        const r = readJson(this.file);
        if (r.corrupt) quarantineFile(this.file);
        const data = r.ok ? normalizeState(r.data) : emptyState();
        const ret = fn(data);
        data.version = 1;
        atomicWriteJson(this.file, data);
        this.data = data;
        this._mtime = this._diskMtime();
        return ret;
      });
    } catch (e) {
      if (strict) throw e;
      process.stderr.write(`⚠ 状态写入失败（${this.file}）: ${e.message}\n`);
      return undefined;
    }
  }

  // ── 名称 ──

  getName(code) {
    this._maybeReload();
    return this.data.names[String(code)] || null;
  }

  setName(code, name) {
    if (!code || !name) return;
    this._mutate(d => { d.names[String(code)] = String(name); }, { strict: false });
  }

  // ── 自选股 ──

  watchlistAdd(item) {
    if (!item || !item.code) return false;
    return this._mutate(d => {
      if (d.watchlist.some(w => w.code === item.code)) return false;
      d.watchlist.push({ addedAt: new Date().toISOString(), ...item });
      return true;
    });
  }

  watchlistRemove(code) {
    return this._mutate(d => {
      const i = d.watchlist.findIndex(w => w.code === String(code));
      if (i === -1) return false;
      d.watchlist.splice(i, 1);
      return true;
    });
  }

  watchlistList() {
    this._maybeReload();
    return this.data.watchlist.slice();
  }

  // ── 持仓台账 ──

  positionsList() {
    this._maybeReload();
    return this.data.positions.slice();
  }

  positionsUpsert(pos) {
    this._mutate(d => {
      const i = d.positions.findIndex(p => p.code === pos.code);
      if (i >= 0) d.positions[i] = pos;
      else d.positions.push(pos);
    });
  }

  positionGet(code) {
    this._maybeReload();
    return this.data.positions.find(p => p.code === String(code)) || null;
  }

  positionsRemove(code) {
    return this._mutate(d => {
      const i = d.positions.findIndex(p => p.code === String(code));
      if (i === -1) return false;
      d.positions.splice(i, 1);
      return true;
    });
  }

  positionsClear() {
    this._mutate(d => { d.positions = []; });
  }

  /** 清空自选+名称（保留持仓） */
  clearWatchlistAndNames() {
    this._mutate(d => { d.watchlist = []; d.names = {}; });
  }

  /**
   * 合并导入（自选去重、名称只补缺失）。
   * @returns {{added:number,names:number}}
   */
  merge({ watchlist = [], names = {} } = {}) {
    return this._mutate(d => {
      let added = 0, nameAdded = 0;
      for (const w of watchlist || []) {
        if (w && w.code && !d.watchlist.some(x => x.code === w.code)) {
          d.watchlist.push(w);
          added++;
        }
      }
      for (const [k, v] of Object.entries(names || {})) {
        if (v && !d.names[k]) { d.names[k] = v; nameAdded++; }
      }
      return { added, names: nameAdded };
    });
  }
}

module.exports = { StateStore, emptyState, normalizeState };
