// tests/cache-concurrency.test.js — 多实例读-改-写不丢更新；坏文件隔离

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KlineCache } from '../lib/cache.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-cache-conc-'));
  file = path.join(dir, 'ths.json');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

const BAR = { date: '2026-01-01', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 };

describe('KlineCache 多实例合并', () => {
  it('自选股：两个实例各加一只，最终都在', () => {
    const a = new KlineCache(file);
    const b = new KlineCache(file);
    expect(a.watchlistAdd({ code: '600519', name: '贵州茅台' })).toBe(true);
    expect(b.watchlistAdd({ code: '000001', name: '平安银行' })).toBe(true);
    const c = new KlineCache(file);
    expect(c.watchlistList().map(w => w.code).sort()).toEqual(['000001', '600519']);
  });

  it('K线：两个实例各写一个 key，最终都在', () => {
    const a = new KlineCache(file);
    const b = new KlineCache(file);
    a.setKline('600519_day_forward', '17', [BAR], 1);
    b.setKline('000001_day_forward', '33', [BAR], 1);
    const c = new KlineCache(file);
    expect(c.getKline('600519_day_forward')).toBeTruthy();
    expect(c.getKline('000001_day_forward')).toBeTruthy();
  });

  it('持仓：两个实例各加一只，最终都在', () => {
    const a = new KlineCache(file);
    const b = new KlineCache(file);
    a.positionsUpsert({ code: '600519', name: '贵州茅台', qty: 100, avgCost: 1000, trades: [] });
    b.positionsUpsert({ code: '000001', name: '平安银行', qty: 1000, avgCost: 10, trades: [] });
    const c = new KlineCache(file);
    expect(c.positionsList().map(p => p.code).sort()).toEqual(['000001', '600519']);
  });

  it('长驻实例能看到其他实例的写入', () => {
    const a = new KlineCache(file);
    const b = new KlineCache(file);
    a.setName('600519', '贵州茅台');
    // b 之前已加载；getName 通过 mtime 检测重新加载
    expect(b.getName('600519')).toBe('贵州茅台');
  });

  it('清空 K线不会误删其他实例新增的自选股', () => {
    const a = new KlineCache(file);
    const b = new KlineCache(file);
    a.setKline('k', '17', [BAR], 1);
    b.watchlistAdd({ code: '600519', name: '贵州茅台' });
    a.clearKline();
    const c = new KlineCache(file);
    expect(c.getKline('k')).toBeNull();
    expect(c.watchlistList()).toHaveLength(1);
  });
});

describe('坏文件隔离', () => {
  it('损坏 JSON 被隔离，不静默覆盖原文件', () => {
    fs.writeFileSync(file, '{not-json');
    const c = new KlineCache(file);
    expect(c.watchlistList()).toHaveLength(0);
    const archived = fs.readdirSync(dir).filter(n => n.includes('.corrupt-'));
    expect(archived).toHaveLength(1);
    // 后续写入创建新文件
    c.watchlistAdd({ code: '600519' });
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
  });
});
