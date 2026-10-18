// tests/audit.test.js — 审计日志：session 生命周期/轻量摘要/轮转

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AuditLogger, summarize } from '../lib/audit.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-audit-'));
  file = path.join(dir, 'audit.json');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function read() {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('AuditLogger', () => {
  it('start/end 记录操作，close 结束 session', () => {
    const a = new AuditLogger({ file });
    a.startOperation('quote', { code: '600519' });
    a.logApiCall('quote', { code: '600519' }, 12, 'success', { rows: Array(100).fill(1) });
    a.endOperation('success', { ok: true });
    a.close();

    const data = read();
    expect(data.sessions).toHaveLength(1);
    const s = data.sessions[0];
    expect(s.ended).toBeTruthy();
    expect(s.operations).toHaveLength(1);
    expect(s.operations[0].command).toBe('quote');
    expect(s.operations[0].status).toBe('success');
    // 大数组只保留长度
    expect(s.operations[0].apiCalls[0].summary.rows).toEqual({ type: 'array', length: 100 });
  });

  it('每个实例新建 session，不复用上一个进程的未结束 session', () => {
    const a = new AuditLogger({ file });
    a.startOperation('one', {});
    a.endOperation('success', {});
    // 不 close，模拟进程异常退出
    const b = new AuditLogger({ file });
    b.startOperation('two', {});
    b.endOperation('success', {});
    b.close();
    const data = read();
    expect(data.sessions).toHaveLength(2);
    expect(data.sessions[0].operations[0].command).toBe('one');
    expect(data.sessions[1].operations[0].command).toBe('two');
  });

  it('noLog 不写入', () => {
    const a = new AuditLogger({ file });
    a.setNoLog(true);
    a.startOperation('x', {});
    a.endOperation('success', {});
    a.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('超过 maxBytes 下次加载自动轮转', () => {
    fs.writeFileSync(file, JSON.stringify({ version: '1.1', sessions: [{ operations: [] }] }).padEnd(500, ' '));
    const a = new AuditLogger({ file, maxBytes: 100 });
    // 原文件被移走，当前实例从空数据开始
    expect(a.data.sessions).toHaveLength(0);
    const archived = fs.readdirSync(dir).filter(n => n.startsWith('audit-'));
    expect(archived.length).toBe(1);
  });

  it('summarize 截断大对象/长字符串', () => {
    const out = summarize({ rows: [1, 2, 3, 4, 5, 6], text: 'x'.repeat(800), nested: { a: [1, 2, 3, 4, 5, 6] } });
    expect(out.rows).toEqual({ type: 'array', length: 6 });
    expect(out.text.endsWith('…')).toBe(true);
    expect(out.nested.a).toEqual({ type: 'array', length: 6 });
  });
});
