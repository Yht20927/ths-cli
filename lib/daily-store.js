// lib/daily-store.js — 每日监控/复盘/经验积累的本地持久层（JSON 原子写）
//
// 与 cache.js 同款最小持久化：tmp 写入 + rename 原子替换，读写失败不阻塞主流程。
// 数据分两部分：
//   - 每日快照：data/daily/snapshots/YYYY-MM-DD.json（一交易日期一文件，
//     date = 该次取数 K 线最后一根的交易日期；含 marketEnv + stocks[code]）
//   - 经验与池建议：data/daily/lessons.json（{version, lessons[], poolSuggestions[]}）
//
// 注入方式（测试用）：构造函数传 { snapDir, lessonsFile }，或用 THS_DAILY_DIR 环境变量。

const fs = require('fs');
const path = require('path');
const { toBeijingClock } = require('./trading-hours');
const { atomicWriteJson, withLock, readJson, quarantineFile } = require('./store/atomic');

const DEFAULT_DIR = process.env.THS_DAILY_DIR || path.join(__dirname, '..', 'data', 'daily');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 北京时间日期（避免进程本地时区/UTC 在凌晨差一天） */
function TODAY() {
  return toBeijingClock().dateStr;
}

const SKIP = Symbol('skip-write');

function emptyLessons() {
  return { version: 1, lessons: [], poolSuggestions: [] };
}

function normalizeLessons(parsed) {
  return {
    ...(parsed && typeof parsed === 'object' ? parsed : {}),
    version: 1,
    lessons: parsed && Array.isArray(parsed.lessons) ? parsed.lessons : [],
    poolSuggestions: parsed && Array.isArray(parsed.poolSuggestions) ? parsed.poolSuggestions : [],
  };
}

class DailyStore {
  /**
   * @param {object} [opts] { snapDir, lessonsFile }
   */
  constructor(opts = {}) {
    this.snapDir = opts.snapDir || path.join(DEFAULT_DIR, 'snapshots');
    this.lessonsFile = opts.lessonsFile || path.join(DEFAULT_DIR, 'lessons.json');
    this.lessonsData = emptyLessons();
    this._lessonsMtime = 0;
    this._loadLessons();
  }

  // ── 底层：原子写 / 锁 ──

  _snapFile(dateStr) {
    return path.join(this.snapDir, `${dateStr}.json`);
  }

  /** 读某日期快照文件；不存在或损坏 → null（损坏文件隔离） */
  loadSnapshotFile(dateStr) {
    if (!DATE_RE.test(String(dateStr))) return null;
    const file = this._snapFile(dateStr);
    const r = readJson(file);
    if (!r.ok) {
      if (r.corrupt) quarantineFile(file);
      return null;
    }
    const parsed = r.data;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      ...parsed,
      date: String(dateStr),
      marketEnv: parsed.marketEnv && typeof parsed.marketEnv === 'object' ? parsed.marketEnv : {},
      direction: parsed.direction && typeof parsed.direction === 'object' ? parsed.direction : {},
      stocks: parsed.stocks && typeof parsed.stocks === 'object' ? parsed.stocks : {},
    };
  }

  _writeSnapshot(dateStr, fileData) {
    atomicWriteJson(this._snapFile(dateStr), {
      ...(fileData || {}),
      version: (fileData && fileData.version) || 2,
      updatedAt: new Date().toISOString(),
      date: String(dateStr),
      marketEnv: (fileData && fileData.marketEnv) || {},
      direction: (fileData && fileData.direction) || {},
      stocks: (fileData && fileData.stocks) || {},
    });
  }

  /**
   * 锁内“读快照 → 修改 → 原子写回”。
   * fn 返回 SKIP 时不写盘。
   */
  _mutateSnapshot(dateStr, fn, opts = {}) {
    if (!DATE_RE.test(String(dateStr))) return undefined;
    const file = this._snapFile(dateStr);
    try {
      return withLock(file, () => {
        const data = this.loadSnapshotFile(dateStr) || {
          version: 2, date: dateStr, marketEnv: {}, direction: {}, stocks: {},
        };
        const ret = fn(data);
        if (ret === SKIP) return undefined;
        this._writeSnapshot(dateStr, data);
        return ret;
      });
    } catch (e) {
      if (opts.strict) throw e;
      process.stderr.write(`⚠ 快照写入失败（${dateStr}）: ${e.message}\n`);
      return undefined;
    }
  }

  // ── 快照 ──

  /**
   * 写入/覆盖某交易日期某只股票的快照（幂等）。
   * 技术字段取 snap；已存在的 note / removedAt / outcome（已闭合复盘结果）保留不被覆盖。
   * @param {string} dateStr 交易日期 YYYY-MM-DD
   * @param {object} snap 单股快照（含 code）
   */
  upsertSnapshot(dateStr, snap) {
    if (!snap || !snap.code) return;
    this._mutateSnapshot(dateStr, file => {
      const existing = file.stocks[snap.code] || {};
      file.stocks[snap.code] = {
        ...existing, // 保留旧快照里新 snap 没带的字段（schema 演化防御）
        ...snap,
        // 保护字段
        note: existing.note != null ? existing.note : (snap.note != null ? snap.note : null),
        removedAt: existing.removedAt != null ? existing.removedAt : null,
        outcome: existing.outcome != null ? existing.outcome : null,
      };
    });
  }

  /** 设置某日期某股的 marketEnv（文件级；写入时保留 stocks） */
  setMarketEnv(dateStr, marketEnv) {
    this._mutateSnapshot(dateStr, file => { file.marketEnv = marketEnv || {}; });
  }

  /** 设置某日期的大盘方向环境 boardMood/fundDir/lhbJoin（文件级；M2-1） */
  setDirection(dateStr, direction) {
    this._mutateSnapshot(dateStr, file => { file.direction = direction || {}; });
  }

  /** 回填某日期某股的复盘 outcome（3/5 日窗口已闭合的结果） */
  setOutcome(dateStr, code, outcome) {
    this._mutateSnapshot(dateStr, file => {
      if (!file.stocks[code]) return SKIP;
      file.stocks[code].outcome = outcome || null;
    });
  }

  /**
   * 批量回填 outcome：{ [dateStr]: { [code]: outcome } }，按日期文件合并写入（每日期一次落盘）。
   * 已闭合结果写入，不动的字段不重写。
   * @param {object} batch { '2026-08-17': { '600519': {3:{…},5:{…}} } }
   */
  backfillOutcomes(batch) {
    for (const [dateStr, outcomesByCode] of Object.entries(batch || {})) {
      this._mutateSnapshot(dateStr, file => {
        let changed = false;
        for (const [code, outcome] of Object.entries(outcomesByCode || {})) {
          if (!file.stocks[code]) continue;
          const prev = file.stocks[code].outcome;
          if (JSON.stringify(prev) !== JSON.stringify(outcome)) {
            file.stocks[code].outcome = outcome;
            changed = true;
          }
        }
        return changed ? undefined : SKIP;
      });
    }
  }

  /** 记录某股被移除（给该股全部未闭合快照打 removedAt，统计时排除） */
  setRemovedAt(dateStr, code, removedAt) {
    this._mutateSnapshot(dateStr, file => {
      if (!file.stocks[code]) return SKIP;
      file.stocks[code].removedAt = removedAt || TODAY();
    });
  }

  /** 写手动复盘笔记 */
  setNote(dateStr, code, note) {
    this._mutateSnapshot(dateStr, file => {
      if (!file.stocks[code]) return SKIP;
      file.stocks[code].note = note;
    });
  }

  /** 已有快照的交易日期（升序） */
  listDates() {
    let names = [];
    try { names = fs.readdirSync(this.snapDir); } catch (e) { return []; }
    return names
      .filter(n => DATE_RE.test(n.replace(/\.json$/, '')))
      .map(n => n.replace(/\.json$/, ''))
      .sort();
  }

  /**
   * 扁平化读取快照（每只股票并入当日 marketEnv）。
   * @param {object} [opts] { since, until, code }
   * @returns {Array<object>} 按 date 升序，每项为 { ...stock, marketEnv }
   */
  loadSnapshots(opts = {}) {
    const { since, until, code } = opts;
    const out = [];
    for (const dateStr of this.listDates()) {
      if (since && dateStr < since) continue;
      if (until && dateStr > until) continue;
      const file = this.loadSnapshotFile(dateStr);
      if (!file) continue;
      const entries = code
        ? (file.stocks[code] ? [{ code, stock: file.stocks[code] }] : [])
        : Object.keys(file.stocks).map(k => ({ code: k, stock: file.stocks[k] }));
      for (const { stock } of entries) {
        if (!stock || !stock.code) continue;
        out.push({ ...stock, marketEnv: file.marketEnv, direction: file.direction });
      }
    }
    out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return out;
  }

  // ── 经验教训 ──

  _loadLessons() {
    const r = readJson(this.lessonsFile);
    if (r.ok) {
      this.lessonsData = normalizeLessons(r.data);
    } else {
      if (r.corrupt) quarantineFile(this.lessonsFile);
      this.lessonsData = emptyLessons();
    }
    this._lessonsMtime = this._lessonsDiskMtime();
  }

  _lessonsDiskMtime() {
    try { return fs.statSync(this.lessonsFile).mtimeMs; } catch (e) { return 0; }
  }

  _maybeReloadLessons() {
    const m = this._lessonsDiskMtime();
    if (m && m !== this._lessonsMtime) this._loadLessons();
  }

  /** 锁内“读经验 → 修改 → 原子写回”；用户数据写失败必须抛错 */
  _mutateLessons(fn) {
    return withLock(this.lessonsFile, () => {
      const r = readJson(this.lessonsFile);
      if (r.corrupt) quarantineFile(this.lessonsFile);
      const data = r.ok ? normalizeLessons(r.data) : emptyLessons();
      const ret = fn(data);
      data.version = 1;
      atomicWriteJson(this.lessonsFile, data);
      this.lessonsData = data;
      this._lessonsMtime = this._lessonsDiskMtime();
      return ret;
    });
  }

  _nextId(arr, prefix) {
    const max = arr.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0);
    return prefix + String(max + 1).padStart(2, '0');
  }

  /**
   * 手动记一条经验/教训。
   * @param {object} p { text, category='复盘', code=null, date=today }
   * @returns {object} 写入的 lesson
   */
  addLesson(p = {}) {
    const text = String(p.text || '').trim();
    if (!text) throw new Error('经验内容不能为空');
    return this._mutateLessons(data => {
      const lesson = {
        id: this._nextId(data.lessons, 'L'),
        text,
        category: p.category || '复盘',
        code: p.code || null,
        date: p.date || TODAY(),
        createdAt: new Date().toISOString(),
      };
      data.lessons.push(lesson);
      return lesson;
    });
  }

  /** @param {object} [opts] { category, code, since } */
  listLessons(opts = {}) {
    this._maybeReloadLessons();
    const { category, code, since } = opts;
    return this.lessonsData.lessons
      .filter(l => !category || l.category === category)
      .filter(l => !code || l.code === code)
      .filter(l => !since || !l.date || l.date >= since)
      .slice();
  }

  /** @returns {boolean} 是否存在并移除 */
  removeLesson(id) {
    return this._mutateLessons(data => {
      const i = data.lessons.findIndex(l => l.id === String(id));
      if (i === -1) return false;
      data.lessons.splice(i, 1);
      return true;
    });
  }

  // ── 池建议 ──

  /**
   * 追加一条池建议（remove/reduce/add）。同 code 同 type 已有 open 建议则去重返回 null。
   * @returns {object|null}
   */
  addSuggestion(s = {}) {
    if (!s.code || !s.type) return null;
    return this._mutateLessons(data => {
      const dup = data.poolSuggestions.find(x =>
        x.code === s.code && x.type === s.type && x.status === 'open');
      if (dup) return null;
      const sug = {
        id: this._nextId(data.poolSuggestions, 'S'),
        type: s.type, // 'remove' | 'reduce' | 'add'
        code: s.code,
        name: s.name || null,
        reason: s.reason || '',
        strength: s.strength || 'normal', // 'strong' | 'normal' | 'weak'
        status: 'open',
        createdAt: new Date().toISOString(),
      };
      data.poolSuggestions.push(sug);
      return sug;
    });
  }

  /** @param {object} [opts] { status='open' } */
  listSuggestions(opts = {}) {
    this._maybeReloadLessons();
    const { status } = opts;
    const all = this.lessonsData.poolSuggestions.slice();
    return status ? all.filter(s => s.status === status) : all;
  }

  /** @returns {boolean} 是否存在并更新状态 */
  markSuggestion(id, status) {
    return this._mutateLessons(data => {
      const s = data.poolSuggestions.find(x => x.id === String(id));
      if (!s) return false;
      s.status = status;
      return true;
    });
  }
}

module.exports = { DailyStore };
