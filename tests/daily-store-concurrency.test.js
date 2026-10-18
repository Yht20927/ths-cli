// tests/daily-store-concurrency.test.js — 多实例快照/经验合并；损坏隔离

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DailyStore } from '../lib/daily-store.js';

let dir;
let snapDir;
let lessonsFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-daily-conc-'));
  snapDir = path.join(dir, 'snapshots');
  lessonsFile = path.join(dir, 'lessons.json');
  fs.mkdirSync(snapDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function store() {
  return new DailyStore({ snapDir, lessonsFile });
}

describe('DailyStore 多实例合并', () => {
  it('两个实例各加一条经验，最终都在', () => {
    const a = store();
    const b = store();
    a.addLesson({ text: '经验A', category: '策略' });
    b.addLesson({ text: '经验B', category: '执行' });
    const c = store();
    expect(c.listLessons().map(l => l.text).sort()).toEqual(['经验A', '经验B']);
    expect(c.listLessons()[0].id).toMatch(/^L\d+$/);
  });

  it('两个实例写同日不同股票快照，合并保留', () => {
    const a = store();
    const b = store();
    a.upsertSnapshot('2026-10-18', { code: '000725', name: '京东方A', close: 5.79 });
    b.upsertSnapshot('2026-10-18', { code: '002185', name: '华天科技', close: 16.05 });
    const c = store();
    const file = c.loadSnapshotFile('2026-10-18');
    expect(Object.keys(file.stocks).sort()).toEqual(['000725', '002185']);
    expect(file.version).toBe(2);
  });

  it('并发写入不同字段（note/outcome）不互相覆盖', () => {
    const a = store();
    a.upsertSnapshot('2026-10-18', { code: '000725', name: '京东方A', close: 5.79 });
    const b = store();
    b.upsertSnapshot('2026-10-18', { code: '000725', name: '京东方A', close: 5.79 });
    a.setNote('2026-10-18', '000725', '复盘笔记');
    b.setOutcome('2026-10-18', '000725', { 3: { ret: 0.02, hit: true } });
    const c = store();
    const s = c.loadSnapshotFile('2026-10-18').stocks['000725'];
    expect(s.note).toBe('复盘笔记');
    expect(s.outcome[3].hit).toBe(true);
  });

  it('跨实例 open 建议去重', () => {
    const a = store();
    const b = store();
    const s1 = a.addSuggestion({ type: 'remove', code: '000001', reason: 'x' });
    const s2 = b.addSuggestion({ type: 'remove', code: '000001', reason: 'y' });
    expect(s1).not.toBeNull();
    expect(s2).toBeNull();
    expect(store().listSuggestions({ status: 'open' })).toHaveLength(1);
  });
});

describe('DailyStore 损坏隔离', () => {
  it('损坏快照被隔离，不静默覆盖', () => {
    const file = path.join(snapDir, '2026-10-18.json');
    fs.writeFileSync(file, '{bad');
    const s = store();
    expect(s.loadSnapshotFile('2026-10-18')).toBeNull();
    const archived = fs.readdirSync(snapDir).filter(n => n.includes('.corrupt-'));
    expect(archived).toHaveLength(1);
  });

  it('损坏 lessons 被隔离，后续写入可恢复', () => {
    fs.writeFileSync(lessonsFile, '{bad');
    const s = store();
    expect(s.listLessons()).toHaveLength(0);
    expect(fs.readdirSync(dir).some(n => n.includes('lessons.json.corrupt-'))).toBe(true);
    s.addLesson({ text: '恢复' });
    expect(store().listLessons()).toHaveLength(1);
  });
});
