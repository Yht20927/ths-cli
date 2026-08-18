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

const DEFAULT_DIR = process.env.THS_DAILY_DIR || path.join(__dirname, '..', 'data', 'daily');
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 本地日期（避免 toISOString 的 UTC 在凌晨差一天） */
function TODAY() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class DailyStore {
  /**
   * @param {object} [opts] { snapDir, lessonsFile }
   */
  constructor(opts = {}) {
    this.snapDir = opts.snapDir || path.join(DEFAULT_DIR, 'snapshots');
    this.lessonsFile = opts.lessonsFile || path.join(DEFAULT_DIR, 'lessons.json');
    this.lessonsData = { version: 1, lessons: [], poolSuggestions: [] };
    this._loadLessons();
  }

  // ── 底层：原子写 ──

  /** @param {boolean} strict 严格模式写失败抛错（快照可静默，用户经验/建议不可静默丢） */
  _atomicWrite(file, obj, strict = false) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      if (strict) throw e; /* 否则写失败不阻塞主流程 */
    }
  }

  _snapFile(dateStr) {
    return path.join(this.snapDir, `${dateStr}.json`);
  }

  /** 读某日期快照文件；不存在或损坏 → null */
  loadSnapshotFile(dateStr) {
    if (!DATE_RE.test(String(dateStr))) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this._snapFile(dateStr), 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      return {
        date: String(dateStr),
        marketEnv: parsed.marketEnv && typeof parsed.marketEnv === 'object' ? parsed.marketEnv : {},
        direction: parsed.direction && typeof parsed.direction === 'object' ? parsed.direction : {},
        stocks: parsed.stocks && typeof parsed.stocks === 'object' ? parsed.stocks : {},
      };
    } catch (e) {
      return null;
    }
  }

  _writeSnapshot(dateStr, fileData) {
    this._atomicWrite(this._snapFile(dateStr), {
      date: String(dateStr),
      marketEnv: fileData.marketEnv || {},
      direction: fileData.direction || {},
      stocks: fileData.stocks || {},
    });
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
    const file = this.loadSnapshotFile(dateStr) || { date: dateStr, marketEnv: {}, stocks: {} };
    const existing = file.stocks[snap.code] || {};
    file.stocks[snap.code] = {
      ...existing, // 保留旧快照里新 snap 没带的字段（schema 演化防御）
      ...snap,
      // 保护字段
      note: existing.note != null ? existing.note : (snap.note != null ? snap.note : null),
      removedAt: existing.removedAt != null ? existing.removedAt : null,
      outcome: existing.outcome != null ? existing.outcome : null,
    };
    this._writeSnapshot(dateStr, file);
  }

  /** 设置某日期某股的 marketEnv（文件级；写入时保留 stocks） */
  setMarketEnv(dateStr, marketEnv) {
    const file = this.loadSnapshotFile(dateStr) || { date: dateStr, marketEnv: {}, direction: {}, stocks: {} };
    file.marketEnv = marketEnv || {};
    this._writeSnapshot(dateStr, file);
  }

  /** 设置某日期的大盘方向环境 boardMood/fundDir/lhbJoin（文件级；M2-1） */
  setDirection(dateStr, direction) {
    const file = this.loadSnapshotFile(dateStr) || { date: dateStr, marketEnv: {}, direction: {}, stocks: {} };
    file.direction = direction || {};
    this._writeSnapshot(dateStr, file);
  }

  /** 回填某日期某股的复盘 outcome（3/5 日窗口已闭合的结果） */
  setOutcome(dateStr, code, outcome) {
    const file = this.loadSnapshotFile(dateStr);
    if (file && file.stocks[code]) {
      file.stocks[code].outcome = outcome || null;
      this._writeSnapshot(dateStr, file);
    }
  }

  /**
   * 批量回填 outcome：{ [dateStr]: { [code]: outcome } }，按日期文件合并写入（每日期一次落盘）。
   * 已闭合结果写入，不动的字段不重写。
   * @param {object} batch { '2026-08-17': { '600519': {3:{…},5:{…}} } }
   */
  backfillOutcomes(batch) {
    for (const [dateStr, outcomesByCode] of Object.entries(batch || {})) {
      const file = this.loadSnapshotFile(dateStr);
      if (!file) continue;
      let changed = false;
      for (const [code, outcome] of Object.entries(outcomesByCode || {})) {
        if (!file.stocks[code]) continue;
        const prev = file.stocks[code].outcome;
        if (JSON.stringify(prev) !== JSON.stringify(outcome)) {
          file.stocks[code].outcome = outcome;
          changed = true;
        }
      }
      if (changed) this._writeSnapshot(dateStr, file);
    }
  }

  /** 记录某股被移除（给该股全部未闭合快照打 removedAt，统计时排除） */
  setRemovedAt(dateStr, code, removedAt) {
    const file = this.loadSnapshotFile(dateStr);
    if (file && file.stocks[code]) {
      file.stocks[code].removedAt = removedAt || TODAY();
      this._writeSnapshot(dateStr, file);
    }
  }

  /** 写手动复盘笔记 */
  setNote(dateStr, code, note) {
    const file = this.loadSnapshotFile(dateStr);
    if (file && file.stocks[code]) {
      file.stocks[code].note = note;
      this._writeSnapshot(dateStr, file);
    }
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
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lessonsFile, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        this.lessonsData = {
          version: 1,
          lessons: Array.isArray(parsed.lessons) ? parsed.lessons : [],
          poolSuggestions: Array.isArray(parsed.poolSuggestions) ? parsed.poolSuggestions : [],
        };
      }
    } catch (e) { /* 首次运行无文件 */ }
  }

  _saveLessons() {
    this._atomicWrite(this.lessonsFile, this.lessonsData, true); // 经验/建议写失败必须抛错
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
    const lesson = {
      id: this._nextId(this.lessonsData.lessons, 'L'),
      text: String(p.text || '').trim(),
      category: p.category || '复盘',
      code: p.code || null,
      date: p.date || TODAY(),
      createdAt: new Date().toISOString(),
    };
    if (!lesson.text) throw new Error('经验内容不能为空');
    this.lessonsData.lessons.push(lesson);
    this._saveLessons();
    return lesson;
  }

  /** @param {object} [opts] { category, code, since } */
  listLessons(opts = {}) {
    const { category, code, since } = opts;
    return this.lessonsData.lessons
      .filter(l => !category || l.category === category)
      .filter(l => !code || l.code === code)
      .filter(l => !since || !l.date || l.date >= since)
      .slice();
  }

  /** @returns {boolean} 是否存在并移除 */
  removeLesson(id) {
    const i = this.lessonsData.lessons.findIndex(l => l.id === String(id));
    if (i === -1) return false;
    this.lessonsData.lessons.splice(i, 1);
    this._saveLessons();
    return true;
  }

  // ── 池建议 ──

  /**
   * 追加一条池建议（remove/reduce/add）。同 code 同 type 已有 open 建议则去重返回 null。
   * @returns {object|null}
   */
  addSuggestion(s = {}) {
    if (!s.code || !s.type) return null;
    const dup = this.lessonsData.poolSuggestions.find(x =>
      x.code === s.code && x.type === s.type && x.status === 'open');
    if (dup) return null;
    const sug = {
      id: this._nextId(this.lessonsData.poolSuggestions, 'S'),
      type: s.type, // 'remove' | 'reduce' | 'add'
      code: s.code,
      name: s.name || null,
      reason: s.reason || '',
      strength: s.strength || 'normal', // 'strong' | 'normal' | 'weak'
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.lessonsData.poolSuggestions.push(sug);
    this._saveLessons();
    return sug;
  }

  /** @param {object} [opts] { status='open' } */
  listSuggestions(opts = {}) {
    const { status } = opts;
    const all = this.lessonsData.poolSuggestions.slice();
    return status ? all.filter(s => s.status === status) : all;
  }

  /** @returns {boolean} 是否存在并更新状态 */
  markSuggestion(id, status) {
    const s = this.lessonsData.poolSuggestions.find(x => x.id === String(id));
    if (!s) return false;
    s.status = status;
    this._saveLessons();
    return true;
  }
}

module.exports = { DailyStore };
