// tests/watch-journal.test.js — 盘中状态/告警/tick 持久化

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WatchJournal } from '../lib/realtime/watch-journal.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-journal-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('WatchJournal', () => {
  it('告警追加/读取/去重', () => {
    const j = new WatchJournal({ dir, date: '2026-10-18' });
    const first = j.appendAlerts([
      { code: '000725', name: '京东方A', kind: 'stop', level: 'critical', message: '破位' },
    ], 1000);
    expect(first).toHaveLength(1);
    expect(first[0].id).toContain('000725');
    // 同一 id 再写一次不会重复
    j.appendAlerts([{ ...first[0] }], 1000);
    const list = j.listAlerts();
    expect(list).toHaveLength(1);
    expect(list[0].message).toBe('破位');
    expect(list[0].acked).toBe(false);
  });

  it('ack 事件生效', () => {
    const j = new WatchJournal({ dir, date: '2026-10-18' });
    const [a] = j.appendAlerts([{ code: '002185', name: '华天科技', kind: 'vol', level: 'info', message: '放量' }], 2000);
    j.appendAck(a.id, 3000);
    expect(j.listAlerts()[0].acked).toBe(true);
  });

  it('tick 紧凑存储', () => {
    const j = new WatchJournal({ dir, date: '2026-10-18' });
    j.appendTick({
      ts: 1000,
      phase: 'am',
      quotes: { '000725': { price: 5.79, pct: 0.52, volumeRatio: 2.63, amount: 999 } },
    });
    const ticks = j.listTicks();
    expect(ticks).toHaveLength(1);
    expect(ticks[0].quotes['000725']).toEqual({ price: 5.79, pct: 0.52, vr: 2.63 });
  });

  it('state 原子写/按日期隔离', () => {
    const j = new WatchJournal({ dir, date: '2026-10-18' });
    j.saveState({ prevState: { '000725': { cond: { stop: false } } }, tickNo: 3 });
    const s = j.loadState();
    expect(s.tickNo).toBe(3);
    expect(s.prevState['000725'].cond.stop).toBe(false);
    expect(s.date).toBe('2026-10-18');

    const other = new WatchJournal({ dir, date: '2026-10-19' });
    expect(other.loadState()).toBeNull();
  });

  it('listDates 汇总告警/tick 日期', () => {
    const a = new WatchJournal({ dir, date: '2026-10-18' });
    a.appendAlerts([{ code: '000725', kind: 'stop', level: 'critical', message: 'x' }], 1);
    const b = new WatchJournal({ dir, date: '2026-10-19' });
    b.appendTick({ ts: 1, quotes: { '000725': { price: 1 } } });
    expect(a.listDates()).toEqual(['2026-10-18', '2026-10-19']);
  });

  it('坏行跳过', () => {
    const j = new WatchJournal({ dir, date: '2026-10-18' });
    fs.mkdirSync(path.join(dir, 'alerts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'alerts', '2026-10-18.jsonl'), '{"type":"alert","id":"x","code":"000725","ts":1}\nnot-json\n');
    expect(j.listAlerts()).toHaveLength(1);
  });
});
