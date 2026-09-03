// tests/risk.test.js — ths risk 命令（离线，临时 KlineCache）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache } from '../lib/cache.js';
import cmdRisk from '../lib/commands/risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-risk-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

function bars(n = 70) {
  const rs = Array.from({ length: n }, (_, i) => [0.012, -0.005, 0.003, 0.008, -0.011, 0.002][i % 6]);
  const out = [];
  let c = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < rs.length; i++) {
    const dt = new Date(start + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: dt, open: c, high: c + 0.5, low: c - 0.5, close: c });
    c = c * (1 + rs[i]);
  }
  return out;
}

function seeded() {
  const c = new KlineCache(tmpFile);
  const A = bars();
  const B = A.map(b => ({ ...b, close: b.close * 2, open: b.open * 2, high: b.high * 2, low: b.low * 2 }));
  c.setKline('000725_day_forward', '33', A, 70);
  c.setKline('603881_day_forward', '17', B, 70);
  c.setName('000725', '京东方A');
  c.setName('603881', '数据港');
  return c;
}

function ctxFor(cache) {
  return {
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('不应走网络'); },
  };
}

describe('ths risk --json', () => {
  it('两票完全相关：avgCorr≈1、有效独立≈1、高相关对+超重 flag、等权 0.5', async () => {
    const cache = seeded();
    const res = await cmdRisk(ctxFor(cache), ['--codes', '000725,603881', '--count', '60', '--json']);
    expect(res.codes.sort()).toEqual(['000725', '603881']);
    expect(res.weightsMode).toBe('等权纸面组合');
    expect(res.metrics.avgCorr).toBeGreaterThan(0.999);
    expect(res.metrics.effectiveBets).toBeLessThan(1.05);
    expect(res.weights['000725']).toBeCloseTo(0.5, 3);
    expect(res.highCorrPairs.some(p => (p.a === '000725' && p.b === '603881') || (p.a === '603881' && p.b === '000725'))).toBe(true);
    // 等权 2 票各 50% > 20% 铁律 → 双双 flag
    expect(res.metrics.overweight.sort()).toEqual(['000725', '603881']);
    expect(res.perCode['000725'].name).toBe('京东方A');
  });

  it('--weights 自定义权重生效', async () => {
    const cache = seeded();
    const res = await cmdRisk(ctxFor(cache), ['--codes', '000725,603881', '--count', '60', '--weights', '000725=0.8,603881=0.2', '--json']);
    expect(res.weightsMode).toBe('自定义权重');
    expect(res.weights['000725']).toBeCloseTo(0.8, 3);
    expect(res.metrics.overweight).toEqual(['000725']); // 0.8 > 0.2；0.2 恰在铁律线上不 flag
  });
});
