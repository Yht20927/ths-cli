// lib/audit.js — 精简版审计日志（logs/audit.json，原子写 + 自动轮转）
//
// 设计：
// - 每个 CLI 进程一个 session（不再复用上一个进程的未结束 session）
// - 操作只记录摘要，不保存整段 K 线/快照/回测结果（避免 20MB+）
// - 文件超过 maxBytes（默认 5MB）时，下次加载自动轮转为 audit-<ts>.json
// - 写失败不阻塞主流程；close() 幂等

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = process.env.THS_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.json');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SESSIONS = 50;

class AuditLogger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 测试注入
   * @param {number} [opts.maxBytes]
   */
  constructor(opts = {}) {
    this.file = opts.file || LOG_FILE;
    this.maxBytes = opts.maxBytes || MAX_BYTES;
    this.noLog = false;
    this.currentOp = null;
    this.session = null;
    this.data = { version: '1.1', sessions: [] };
    this._load();
  }

  setNoLog(v) {
    this.noLog = !!v;
  }

  _load() {
    // 超大文件先轮转，避免每次启动解析几十 MB
    try {
      const st = fs.statSync(this.file);
      if (st.size > this.maxBytes) {
        const archived = this.file.replace(/\.json$/, `-${Date.now()}.json`);
        fs.renameSync(this.file, archived);
      }
    } catch (e) { /* 不存在 */ }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.sessions)) this.data = parsed;
    } catch (e) { /* 首次运行/损坏 → 空 */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { /* 审计失败不阻塞主流程 */ }
  }

  newSession() {
    if (this.session) return this.session;
    const session = {
      sessionId: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      started: new Date().toISOString(),
      operations: [],
    };
    this.data.sessions.push(session);
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
    }
    this.session = session;
    return session;
  }

  startOperation(cmd, args) {
    if (this.noLog) return null;
    const session = this.newSession();
    const op = {
      command: cmd,
      args,
      started: new Date().toISOString(),
      status: 'running',
      apiCalls: [],
    };
    session.operations.push(op);
    this.currentOp = op;
    return op;
  }

  logApiCall(endpoint, params, durationMs, status, summary) {
    if (this.noLog || !this.currentOp) return;
    // 只保留轻量摘要；summary 由调用方保证不含大数组
    this.currentOp.apiCalls.push({
      endpoint,
      params,
      durationMs,
      status,
      summary: summarize(summary),
    });
  }

  /**
   * 结束当前操作。
   * @param {string} status
   * @param {object} [summary]
   * @param {object} [resultData] 兼容旧 API；默认不落盘（只记录 key 数量）
   * @param {Error} [error]
   */
  endOperation(status, summary, resultData, error) {
    if (this.noLog || !this.currentOp) return;
    this.currentOp.status = status;
    this.currentOp.ended = new Date().toISOString();
    this.currentOp.durationMs = Date.now() - Date.parse(this.currentOp.started);
    if (summary) this.currentOp.summary = summarize(summary);
    if (error) this.currentOp.error = error.message || String(error);
    // resultData 不再整段落盘；仅在调用方明确传布尔 false 以外的诊断时保留浅层键
    if (resultData && typeof resultData === 'object') {
      this.currentOp.resultKeys = Object.keys(resultData).slice(0, 20);
    }
    this._save();
    this.currentOp = null;
  }

  /** 结束当前 session（进程退出前调用；幂等） */
  close() {
    if (this.session) {
      this.session.ended = new Date().toISOString();
      this.session.endedAt = this.session.ended;
      this.session = null;
      this._save();
    }
    this.currentOp = null;
  }
}

/** 摘要值：大数组只留长度，避免 audit 膨胀 */
function summarize(v, depth = 0) {
  if (v == null) return v;
  if (Array.isArray(v)) {
    return v.length > 5 ? { type: 'array', length: v.length } : v.slice(0, 5).map(x => summarize(x, depth + 1));
  }
  if (typeof v === 'object') {
    if (depth >= 2) return { type: 'object', keys: Object.keys(v).slice(0, 10) };
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (Array.isArray(val) && val.length > 5) out[k] = { type: 'array', length: val.length };
      else if (typeof val === 'string' && val.length > 200) out[k] = val.slice(0, 200) + '…';
      else out[k] = summarize(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}

module.exports = { AuditLogger, summarize };
