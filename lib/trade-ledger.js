// lib/trade-ledger.js — 交易流水（append-only JSONL，独立于持仓快照）
//
// 为什么拆：positions 只保存“当前持仓”，清仓后记录会被删除；交易历史是复盘资产，
// 必须独立保留。每笔交易一行 JSON，追加写，天然可 grep/tail/流式分析。
//
// 文件: data/ledger/trades.jsonl（生产）；测试/自定义缓存用 sidecar。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock } = require('./store/atomic');
const { toBeijingClock } = require('./trading-hours');

const DEFAULT_LEDGER_FILE = process.env.THS_LEDGER_FILE ||
  path.join(__dirname, '..', 'data', 'ledger', 'trades.jsonl');

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

class TradeLedger {
  /** @param {string} [file] */
  constructor(file = DEFAULT_LEDGER_FILE) {
    this.file = file;
  }

  _readLines() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (rec && rec.code && rec.action) out.push(rec);
      } catch (e) { /* 跳过坏行 */ }
    }
    return out;
  }

  /** @returns {Array<object>} 按时间升序 */
  list(opts = {}) {
    const { code, since, until } = opts;
    return this._readLines()
      .filter(t => !code || t.code === String(code))
      .filter(t => !since || String(t.date || '').slice(0, 10) >= since)
      .filter(t => !until || String(t.date || '').slice(0, 10) <= until)
      .sort((a, b) => {
        const byDate = String(a.date || '').localeCompare(String(b.date || ''));
        return byDate || (Number(a.ts) || 0) - (Number(b.ts) || 0);
      });
  }

  /**
   * 追加一笔交易。带 id 且已存在则跳过（幂等）。
   * @param {object} rec
   * @returns {object} 实际写入/已存在的记录
   */
  append(rec = {}) {
    const record = {
      id: rec.id || newId(),
      ts: rec.ts || Date.now(),
      date: rec.date || toBeijingClock(rec.ts || Date.now()).dateStr,
      code: String(rec.code || ''),
      name: rec.name || null,
      action: rec.action,
      qty: Number(rec.qty),
      price: Number(rec.price),
      fee: Number(rec.fee || 0),
      note: rec.note || null,
      stopPrice: rec.stopPrice != null ? Number(rec.stopPrice) : null,
      stopSource: rec.stopSource || null,
      realized: rec.realized != null ? Number(rec.realized) : null,
      source: rec.source || 'portfolio',
    };
    if (!record.code || !['buy', 'sell'].includes(record.action)) {
      throw new Error('交易流水缺少 code/action');
    }
    ensureDir(this.file);
    return withLock(this.file, () => {
      const existing = this._readLines();
      if (rec.id && existing.some(t => t.id === rec.id)) return rec;
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n');
      return record;
    });
  }

  /**
   * 从旧版 positions[].trades 迁移（按确定性 legacy id 去重）。
   * @param {Array<object>} positions
   * @returns {number} 新增条数
   */
  migrateFromPositions(positions) {
    if (!Array.isArray(positions) || !positions.length) return 0;
    const lines = this._readLines();
    const existing = new Set(lines.map(t => t.id));
    // 内容指纹：新版本 portfolio 命令会同时写 ledger 与 position.trades，
    // 若只按 legacy id 去重，每次启动都会把同一笔交易再迁移一遍。
    // 对已由 portfolio 写入的流水按「代码/方向/数量/价格/费用/交易日」去重。
    const fp = t => [t.code, t.action, Number(t.qty), Number(t.price),
      Number(t.fee || 0), String(t.date || '').slice(0, 10)].join('|');
    const served = new Set(lines.filter(t => t.source !== 'legacy').map(fp));

    const pending = [];
    for (const pos of positions) {
      const trades = Array.isArray(pos.trades) ? pos.trades : [];
      trades.forEach((t, i) => {
        if (!t || !t.action) return;
        const id = `legacy-${pos.code}-${i}-${t.date || ''}-${t.action}-${t.qty}-${t.price}`;
        const rec = {
          id,
          ts: Date.parse(t.date) || 0,
          date: t.date || null,
          code: pos.code,
          name: pos.name || null,
          action: t.action,
          qty: t.qty,
          price: t.price,
          fee: t.fee || 0,
          note: t.note || null,
          stopPrice: t.stopPrice != null ? t.stopPrice : null,
          source: 'legacy',
        };
        if (existing.has(id) || served.has(fp(rec))) return;
        existing.add(id);
        pending.push(rec);
      });
    }
    if (!pending.length) return 0;
    ensureDir(this.file);
    let added = 0;
    withLock(this.file, () => {
      // 锁内再查一次，避免两个进程同时迁移同一批 legacy 流水
      const currentLines = this._readLines();
      const current = new Set(currentLines.map(t => t.id));
      const currentServed = new Set(currentLines.filter(t => t.source !== 'legacy').map(fp));
      const fresh = pending.filter(r => !current.has(r.id) && !currentServed.has(fp(r)));
      if (fresh.length) {
        fs.appendFileSync(this.file, fresh.map(r => JSON.stringify(r)).join('\n') + '\n');
        added = fresh.length;
      }
    });
    return added;
  }

  /** 条数 */
  count() {
    return this._readLines().length;
  }
}

module.exports = { TradeLedger, DEFAULT_LEDGER_FILE, newId };
