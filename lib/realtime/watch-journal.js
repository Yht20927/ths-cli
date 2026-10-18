// lib/realtime/watch-journal.js — 盘中状态/告警/行情 tick 的本地持久化
//
// 目标：让 watch 从“只看当前进程内存”变成“可恢复、可回放、可分析”。
// 存储：
//   data/realtime/watch-state.json        当日状态（prevState/priceHistory/...）
//   data/realtime/alerts/YYYY-MM-DD.jsonl 告警事件 + ack 事件（append-only）
//   data/realtime/ticks/YYYY-MM-DD.jsonl  每次轮询的紧凑行情快照（append-only）
//
// 约定：
// - 日期一律用北京时间（trading-hours.toBeijingClock）
// - JSONL 追加写；单行独立，坏行读取时跳过
// - state 用唯一 tmp + rename 原子替换
// - 所有失败都不阻塞盯盘（调用方应 try/catch 或由本模块吞掉）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { toBeijingClock } = require('../trading-hours');

const DEFAULT_DIR = process.env.THS_REALTIME_DIR ||
  path.join(__dirname, '..', '..', 'data', 'realtime');

function todayBeijing() {
  return toBeijingClock().dateStr;
}

class WatchJournal {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]
   * @param {string} [opts.date] YYYY-MM-DD（默认北京今天）
   */
  constructor(opts = {}) {
    this.dir = opts.dir || DEFAULT_DIR;
    this.date = opts.date || todayBeijing();
    this.stateFile = path.join(this.dir, 'watch-state.json');
    this.alertFile = path.join(this.dir, 'alerts', `${this.date}.jsonl`);
    this.tickFile = path.join(this.dir, 'ticks', `${this.date}.jsonl`);
    this._alertIds = null;
  }

  _ensure(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _append(file, obj) {
    this._ensure(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  }

  _readJsonl(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch (e) { /* 跳过坏行 */ }
    }
    return out;
  }

  // ── 状态 ──

  /** @returns {object|null} 仅返回当日状态 */
  loadState() {
    try {
      const obj = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!obj || obj.date !== this.date) return null;
      return obj;
    } catch (e) {
      return null;
    }
  }

  /**
   * 原子写状态。字段自由扩展，但必须有 version/date/updatedAt。
   * @param {object} state
   */
  saveState(state = {}) {
    this._ensure(this.dir);
    const payload = {
      version: 1,
      date: this.date,
      updatedAt: new Date().toISOString(),
      ...state,
    };
    const tmp = `${this.stateFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, this.stateFile);
  }

  // ── 告警 ──

  _loadAlertIds() {
    if (this._alertIds) return this._alertIds;
    const ids = new Set();
    for (const e of this._readJsonl(this.alertFile)) {
      if (e && e.type === 'alert' && e.id) ids.add(e.id);
    }
    this._alertIds = ids;
    return ids;
  }

  /**
   * 追加告警；自动补 id/ts；重复 id 跳过。
   * @param {Array<object>} alerts evaluateTick 的输出
   * @param {number} [ts]
   * @returns {Array<object>} 带 id/at/acked 的警报（与输入同序）
   */
  appendAlerts(alerts, ts = Date.now()) {
    const ids = this._loadAlertIds();
    const out = [];
    for (const a of alerts || []) {
      const id = a.id || `${ts}-${a.code}-${a.kind}`;
      const rec = { ...a, id, at: a.at || ts, acked: !!a.acked };
      out.push(rec);
      if (ids.has(id)) continue;
      ids.add(id);
      this._append(this.alertFile, {
        type: 'alert',
        id,
        ts,
        date: this.date,
        code: a.code,
        name: a.name || null,
        kind: a.kind,
        level: a.level,
        message: a.message || '',
        startup: !!a.startup,
      });
    }
    return out;
  }

  /** 追加一条确认事件 */
  appendAck(id, ts = Date.now()) {
    if (!id) return;
    this._append(this.alertFile, { type: 'ack', id, ts, date: this.date });
  }

  /**
   * 读取当日告警（按时间升序），应用 ack。
   * @returns {Array<object>}
   */
  listAlerts() {
    const map = new Map();
    for (const e of this._readJsonl(this.alertFile)) {
      if (!e) continue;
      if (e.type === 'alert' && e.id) {
        map.set(e.id, {
          id: e.id,
          at: e.ts || Date.parse(e.at) || 0,
          code: e.code,
          name: e.name,
          kind: e.kind,
          level: e.level,
          message: e.message,
          startup: !!e.startup,
          acked: false,
        });
      } else if (e.type === 'ack' && e.id && map.has(e.id)) {
        map.get(e.id).acked = true;
      }
    }
    return [...map.values()].sort((a, b) => a.at - b.at);
  }

  // ── tick ──

  /**
   * 追加一次轮询的紧凑行情。
   * @param {object} p { ts, phase, quotes: { code: {code,price,pct,volumeRatio,prevClose} } }
   */
  appendTick(p) {
    const quotes = {};
    for (const [code, q] of Object.entries((p && p.quotes) || {})) {
      if (!q) continue;
      quotes[code] = {
        price: q.price,
        pct: q.pct,
        vr: q.volumeRatio,
      };
    }
    this._append(this.tickFile, {
      type: 'tick',
      ts: p.ts || Date.now(),
      phase: p.phase || null,
      quotes,
    });
  }

  /** @returns {Array<object>} 当日 tick（升序） */
  listTicks() {
    return this._readJsonl(this.tickFile)
      .filter(e => e && e.type === 'tick')
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  /** 有记录的交易日期（告警或 tick） */
  listDates() {
    const dates = new Set();
    for (const sub of ['alerts', 'ticks']) {
      const dir = path.join(this.dir, sub);
      let names = [];
      try { names = fs.readdirSync(dir); } catch (e) { continue; }
      for (const n of names) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n);
        if (m) dates.add(m[1]);
      }
    }
    return [...dates].sort();
  }
}

module.exports = { WatchJournal, todayBeijing, DEFAULT_DIR };
