// tests/cache.test.js — 本地缓存 + 自选股 + loadKline

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache, loadKline } from '../lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

const bars = [
  { date: '2026-01-01', open: 10, high: 11, low: 9, close: 10.5, volume: 1000, amount: 1e4 },
  { date: '2026-01-02', open: 10.5, high: 12, low: 10, close: 11, volume: 1100, amount: 1.1e4 },
  { date: '2026-01-03', open: 11, high: 12, low: 10, close: 11.5, volume: 1200, amount: 1.2e4 },
];

describe('KlineCache 基础', () => {
  it('set/get 往返', () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', bars, 3);
    const e = c.getKline('600519_day_forward');
    expect(e.bars).toHaveLength(3);
    expect(e.market).toBe('17');
    expect(e.count).toBe(3);
  });

  it('isFresh 按 TTL 判断', () => {
    const c = new KlineCache(tmpFile);
    c.setKline('k', '17', bars, 3);
    // 人为把 fetchedAt 拨回 5 秒前，使判断确定
    c.getKline('k').fetchedAt = new Date(Date.now() - 5000).toISOString();
    expect(c.isFresh('k', 60 * 1000)).toBe(true);
    expect(c.isFresh('k', 1000)).toBe(false);
  });

  it('clearKline 清空 K线但保留自选股', () => {
    const c = new KlineCache(tmpFile);
    c.setKline('k', '17', bars, 3);
    c.watchlistAdd({ code: '600519', name: '贵州茅台' });
    c.clearKline();
    expect(c.getKline('k')).toBeNull();
    expect(c.watchlistList()).toHaveLength(1);
  });

  it('持久化到磁盘后可重读', () => {
    const c1 = new KlineCache(tmpFile);
    c1.setKline('k', '17', bars, 3);
    const c2 = new KlineCache(tmpFile);
    expect(c2.getKline('k').bars).toHaveLength(3);
  });
});

describe('自选股', () => {
  it('add / list / remove', () => {
    const c = new KlineCache(tmpFile);
    expect(c.watchlistAdd({ code: '600519', name: '贵州茅台', market: '17' })).toBe(true);
    expect(c.watchlistAdd({ code: '600519', name: '重复' })).toBe(false); // 去重
    expect(c.watchlistList()).toHaveLength(1);
    expect(c.watchlistList()[0].name).toBe('贵州茅台');
    expect(c.watchlistRemove('600519')).toBe(true);
    expect(c.watchlistRemove('600519')).toBe(false);
    expect(c.watchlistList()).toHaveLength(0);
  });

  it('空 code 拒绝添加', () => {
    const c = new KlineCache(tmpFile);
    expect(c.watchlistAdd({ name: '无代码' })).toBe(false);
  });
});

describe('loadKline', () => {
  it('缓存新鲜且条数够 → 不触发网络拉取', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', bars, 3);
    let fetched = false;
    const ctx = {
      get fetchKlineBars() { fetched = true; throw new Error('不应走网络'); },
    };
    const out = await loadKline(ctx, c, { code: '600519', period: 'day', adjust: 'forward', market: '17', count: 3 }, { maxAgeMs: 60000 });
    expect(fetched).toBe(false);
    expect(out).toHaveLength(3);
    expect(out[0].close).toBe(10.5);
  });

  it('缓存过期 → 走 fetchKlineBars 并回填', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', [{ date: 'old', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }], 1);
    const ctx = {
      loggedCall: async () => ({ value: [[1700000000000, 10, 11, 9, 10.5, 1000, 1e4]] }),
      audit: { startOperation: () => {}, endOperation: () => {} },
    };
    // loadKline 内部 require('./commands/kline').fetchKlineBars，它调用 ctx.loggedCall
    const out = await loadKline(ctx, c, { code: '600519', period: 'day', adjust: 'forward', market: '17', count: 3 }, { maxAgeMs: 1, refresh: false });
    expect(out).toHaveLength(1);
    // 回填成功
    expect(c.getKline('600519_day_forward').bars[0].close).toBe(10.5);
  });

  it('refresh=true → 强制走网络', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', bars, 3);
    const ctx = {
      loggedCall: async () => ({ value: [[1700000000000, 20, 21, 19, 20.5, 1000, 1e4]] }),
      audit: { startOperation: () => {}, endOperation: () => {} },
    };
    const out = await loadKline(ctx, c, { code: '600519', period: 'day', adjust: 'forward', market: '17', count: 3 }, { maxAgeMs: 60000, refresh: true });
    expect(out[0].close).toBe(20.5);
    expect(c.getKline('600519_day_forward').bars[0].close).toBe(20.5);
  });
});
