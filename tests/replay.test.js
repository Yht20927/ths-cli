// tests/replay.test.js — ths replay 命令

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WatchJournal } from '../lib/realtime/watch-journal.js';
import cmdReplay from '../lib/commands/replay.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-replay-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function seed() {
  const j = new WatchJournal({ dir, date: '2026-10-18' });
  const alerts = j.appendAlerts([
    { code: '000725', name: '京东方A', kind: 'stop', level: 'critical', message: '跌破固化止损' },
    { code: '002185', name: '华天科技', kind: 'vol', level: 'info', message: '放量异动' },
  ], 1000);
  j.appendAck(alerts[0].id, 2000);
  j.appendTick({ ts: 3000, phase: 'am', quotes: { '000725': { price: 5.79, pct: 0.5 } } });
  j.appendTick({ ts: 4000, phase: 'am', quotes: { '000725': { price: 5.85, pct: 1.5 } } });
}

function ctx() {
  return { cache: { getName: code => (code === '000725' ? '京东方A' : '') } };
}

describe('ths replay', () => {
  it('文本模式输出告警时间线与 tick 摘要', async () => {
    seed();
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(String(s)));
    try {
      const ret = await cmdReplay(ctx(), ['2026-10-18', '--dir', dir, '--ticks']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('盯盘回放 2026-10-18');
    expect(out).toContain('跌破固化止损');
    expect(out).toContain('放量异动');
    expect(out).toContain('tick 摘要');
    expect(out).toContain('000725');
  });

  it('--json 返回结构化记录', async () => {
    seed();
    const res = await cmdReplay(ctx(), ['2026-10-18', '--dir', dir, '--ticks', '--json']);
    expect(res.date).toBe('2026-10-18');
    expect(res.alerts).toHaveLength(2);
    expect(res.alerts[0].acked).toBe(true);
    expect(res.ticks).toHaveLength(2);
    expect(res.tickCount).toBe(2);
    expect(res.summary[0].code).toBe('000725');
    expect(res.summary[0].count).toBe(2);
  });

  it('无记录', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(String(s)));
    try {
      await cmdReplay(ctx(), ['2026-10-18', '--dir', dir]);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join('\n')).toContain('无告警记录');
  });
});
