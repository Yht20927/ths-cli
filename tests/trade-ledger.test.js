// tests/trade-ledger.test.js — append-only 交易流水

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TradeLedger } from '../lib/trade-ledger.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-ledger-'));
  file = path.join(dir, 'trades.jsonl');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('TradeLedger', () => {
  it('追加/读取/过滤', () => {
    const l = new TradeLedger(file);
    l.append({ code: '600519', action: 'buy', qty: 100, price: 100, date: '2026-10-17', name: '贵州茅台' });
    l.append({ code: '000001', action: 'buy', qty: 1000, price: 10, date: '2026-10-18' });
    expect(l.count()).toBe(2);
    expect(l.list().map(t => t.code)).toEqual(['600519', '000001']);
    expect(l.list({ code: '600519' })).toHaveLength(1);
    expect(l.list({ since: '2026-10-18' })).toHaveLength(1);
  });

  it('同 id 幂等', () => {
    const l = new TradeLedger(file);
    l.append({ id: 'x', code: '600519', action: 'buy', qty: 1, price: 1, date: '2026-10-18' });
    l.append({ id: 'x', code: '600519', action: 'buy', qty: 1, price: 1, date: '2026-10-18' });
    expect(l.count()).toBe(1);
  });

  it('从 positions[].trades 迁移并去重', () => {
    const positions = [{
      code: '600519', name: '贵州茅台',
      trades: [
        { action: 'buy', qty: 100, price: 100, fee: 5, date: '2026-10-01', note: '首仓' },
        { action: 'sell', qty: 100, price: 110, fee: 6, date: '2026-10-10' },
      ],
    }];
    const l = new TradeLedger(file);
    expect(l.migrateFromPositions(positions)).toBe(2);
    expect(l.migrateFromPositions(positions)).toBe(0);
    expect(l.count()).toBe(2);
    expect(l.list()[0].source).toBe('legacy');
  });

  it('坏行跳过', () => {
    fs.writeFileSync(file, '{"code":"600519","action":"buy","qty":1,"price":1,"date":"2026-10-18"}\nnot-json\n');
    expect(new TradeLedger(file).count()).toBe(1);
  });

  it('缺少 code/action 抛错', () => {
    const l = new TradeLedger(file);
    expect(() => l.append({ code: '600519' })).toThrow(/code\/action/);
  });
});
