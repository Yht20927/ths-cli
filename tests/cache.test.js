// tests/cache.test.js — 本地缓存 + 自选股 + loadKline

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache, loadKline, isFormingBarNow, closedBars } from '../lib/cache.js';

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

describe('名称缓存', () => {
  it('getName/setName 往返并持久化', () => {
    const c1 = new KlineCache(tmpFile);
    c1.setName('600519', '贵州茅台');
    expect(c1.getName('600519')).toBe('贵州茅台');
    const c2 = new KlineCache(tmpFile);
    expect(c2.getName('600519')).toBe('贵州茅台');
  });

  it('clearAll 清空 K线/名称/自选股', () => {
    const c = new KlineCache(tmpFile);
    c.setKline('k', '17', bars, 3);
    c.setName('600519', '贵州茅台');
    c.watchlistAdd({ code: '600519', name: '贵州茅台' });
    c.clearAll();
    expect(c.getKline('k')).toBeNull();
    expect(c.getName('600519')).toBeNull();
    expect(c.watchlistList()).toHaveLength(0);
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

// ── 半截 K 线判定 ──────────────────────────────────────────────
// 北京时钟：注入 nowMs 决定"今天"；bar 日期字符串与 toBeijingClock 同源，避免 CI 时区错位。
function bjMs(day, hm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 8 * 3600 * 1000;
}
// 生成末根为 endDate 的 n 根升序日 K（日期用 UTC 拼，仅供测试）
function mkBars(n, endDate) {
  const [y, m, d] = endDate.split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    const ds = dt.toISOString().slice(0, 10);
    out.push({ date: ds, open: 10, high: 11, low: 9, close: 10 + i * 0.1, volume: 1000, amount: 1e4 });
  }
  return out;
}

describe('isFormingBarNow / closedBars', () => {
  it('盘中(周四 10:00)末根==北京今天 → 判定在途并剔除', () => {
    const now = bjMs('2026-09-03', '10:00');
    const b = mkBars(10, '2026-09-03');
    expect(isFormingBarNow(b, now)).toBe(true);
    const out = closedBars(b, now);
    expect(out).toHaveLength(9);
    expect(out[out.length - 1].date).toBe('2026-09-02');
  });

  it('no-op：末根是昨天（停牌/开盘前/收盘后场景）→ 原样等长', () => {
    const now = bjMs('2026-09-03', '10:00');
    const b = mkBars(10, '2026-09-02'); // 今天还没出新 bar
    expect(isFormingBarNow(b, now)).toBe(false);
    expect(closedBars(b, now)).toHaveLength(10);
  });

  it('no-op：周末当天末根==周末日期也不剔除（周六不该有在途 bar）', () => {
    const now = bjMs('2026-09-05', '10:00'); // 周六
    const b = mkBars(10, '2026-09-05');
    expect(isFormingBarNow(b, now)).toBe(false);
    expect(closedBars(b, now)).toHaveLength(10);
  });

  it('no-op：收盘后(15:30)末根==今天 → 已定型不剔除', () => {
    const now = bjMs('2026-09-03', '15:30');
    const b = mkBars(10, '2026-09-03');
    expect(isFormingBarNow(b, now)).toBe(false);
  });

  it('15:00–15:05 缓冲窗口内今日 bar 仍判在途（文档注明）', () => {
    const now = bjMs('2026-09-03', '15:03');
    const b = mkBars(10, '2026-09-03');
    expect(isFormingBarNow(b, now)).toBe(true);
  });

  it('空数组 → false / 原样返回', () => {
    expect(isFormingBarNow([], bjMs('2026-09-03', '10:00'))).toBe(false);
    expect(closedBars([], bjMs('2026-09-03', '10:00'))).toEqual([]);
  });
});

describe('loadKline excludeForming', () => {
  const NOW = bjMs('2026-09-03', '10:00');
  const full = mkBars(15, '2026-09-03'); // 末根在途

  it('缓存命中 + excludeForming → 剔除在途末根，但缓存存储不被截断', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', full, 15);
    const ctx = { get fetchKlineBars() { throw new Error('不应走网络'); } };
    const out = await loadKline(ctx, c, { code: '600519', period: 'day_1', adjust: 'forward', market: '17', count: 15 },
      { maxAgeMs: 60000, excludeForming: true, nowMs: NOW });
    expect(out).toHaveLength(14);
    expect(out[out.length - 1].date).toBe('2026-09-02');
    // 缓存里仍保留完整（含在途）bar——绝不写回截断
    expect(c.getKline('600519_day_forward').bars).toHaveLength(15);
  });

  it('excludeForming=false 默认不动（含在途）', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', full, 15);
    const ctx = { get fetchKlineBars() { throw new Error('不应走网络'); } };
    const out = await loadKline(ctx, c, { code: '600519', period: 'day_1', adjust: 'forward', market: '17', count: 15 },
      { maxAgeMs: 60000, nowMs: NOW });
    expect(out).toHaveLength(15);
    expect(out[out.length - 1].date).toBe('2026-09-03');
  });

  it('网络刷新 + excludeForming → 返回剔除后，缓存存原始含在途', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', [{ date: 'old', open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 1 }], 1);
    const ctx = {
      loggedCall: async () => ({ value: full.map(b => [Date.parse(`${b.date}T04:00:00Z`), b.open, b.high, b.low, b.close, b.volume, b.amount]) }),
      audit: { startOperation: () => {}, endOperation: () => {} },
    };
    const out = await loadKline(ctx, c, { code: '600519', period: 'day_1', adjust: 'forward', market: '17', count: 15 },
      { maxAgeMs: 60000, refresh: true, excludeForming: true, nowMs: NOW });
    expect(out).toHaveLength(14);
    expect(c.getKline('600519_day_forward').bars).toHaveLength(15);
  });
});
