// tests/scanner-gate.test.js — scan 方向门控（--only-hot / marketCold）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache } from '../lib/cache.js';
import { runScan } from '../lib/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-scangate-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

// 稳步多头（score 达 70+），160 根恒为过去
function bull(n = 160) {
  const out = [];
  let p = 100;
  const d0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const dt = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: dt, open: p, high: p * 1.004, low: p * 0.996, close: p, volume: 2e6 });
    p *= 1.0035;
  }
  return out;
}

function ctxFor(cache) {
  return {
    cache,
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('不应走网络'); },
  };
}

describe('runScan marketCold 门控', () => {
  const base = () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', bull(), 160);
    return c;
  };

  it('多头命中（score-gt≥60）在无门控时 passed=true', async () => {
    const cache = base();
    const items = [{ code: '600519', name: '贵州茅台', market: '17' }];
    const res = await runScan(ctxFor(cache), cache, items, ['score-gt'], { count: 120, scoreThreshold: 60 });
    const rec = res[0];
    expect(rec.passed).toBe(true);
    expect(rec.matched.some(m => m.name === 'score-gt')).toBe(true);
  });

  it('marketCold=true（大盘普跌 + --only-hot）→ 命中被抑制、记 gateNote', async () => {
    const cache = base();
    const items = [{ code: '600519', name: '贵州茅台', market: '17' }];
    const res = await runScan(ctxFor(cache), cache, items, ['score-gt'], { count: 120, scoreThreshold: 60, marketCold: true });
    const rec = res[0];
    expect(rec.passed).toBe(false);
    expect(rec.matched.length).toBeGreaterThan(0); // 技术条件本身命中，被环境门控拦下
    expect(rec.gateNote).toContain('--only-hot');
  });
});
