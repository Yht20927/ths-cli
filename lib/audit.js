// lib/audit.js — 精简版审计日志（仅 logs/audit.json，原子写）
// 与 douyin-cli 的 AuditLogger 保持相同 API 面（startOperation/logApiCall/endOperation），
// v1 不依赖 SQLite。

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.THS_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.json');

class AuditLogger {
  constructor() {
    this.noLog = false;
    this.currentOp = null;
    this.data = { version: '1.0', sessions: [] };
    this._load();
  }

  setNoLog(v) {
    this.noLog = !!v;
  }

  _load() {
    try {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions)) this.data = parsed;
    } catch (e) { /* 首次运行无文件 */ }
  }

  _save() {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const tmp = LOG_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, LOG_FILE);
    } catch (e) { /* 审计失败不阻塞主流程 */ }
  }

  newSession() {
    const last = this.data.sessions[this.data.sessions.length - 1];
    if (last && !last.ended) return last;
    const session = {
      sessionId: Date.now().toString(36),
      started: new Date().toISOString(),
      operations: [],
    };
    this.data.sessions.push(session);
    if (this.data.sessions.length > 50) this.data.sessions = this.data.sessions.slice(-50);
    return session;
  }

  startOperation(cmd, args) {
    if (this.noLog) return;
    const session = this.newSession();
    this.currentOp = {
      command: cmd,
      args,
      started: new Date().toISOString(),
      status: 'running',
      apiCalls: [],
    };
    session.operations.push(this.currentOp);
  }

  logApiCall(endpoint, params, durationMs, status, summary) {
    if (this.noLog || !this.currentOp) return;
    this.currentOp.apiCalls.push({ endpoint, params, durationMs, status, summary });
  }

  endOperation(status, summary, resultData, error) {
    if (this.noLog || !this.currentOp) return;
    this.currentOp.status = status;
    this.currentOp.ended = new Date().toISOString();
    this.currentOp.durationMs = Date.now() - Date.parse(this.currentOp.started);
    if (summary) this.currentOp.summary = summary;
    if (resultData) this.currentOp.result = resultData;
    if (error) this.currentOp.error = error.message || String(error);
    this._save();
    this.currentOp = null;
  }
}

module.exports = { AuditLogger };
