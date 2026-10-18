// tests/chart.test.js — chart / analyze --chart / backtest 图表接入（离线）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { KlineCache } from '../lib/cache.js';
import cmdChart from '../lib/commands/chart.js';
import cmdAnalyze from '../lib/commands/analyze.js';
import cmdBacktest from '../lib/commands/backtest.js';

let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-chart-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

function bars(n = 80) {
  const out = [];
  let c = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = c;
    const close = c * (1 + (i % 7 === 0 ? -0.012 : 0.006));
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close) * 1.008,
      low: Math.min(open, close) * 0.992,
      volume: 1e6 + i * 1000,
      amount: 1e8 + i,
    });
    c = close;
  }
  return out;
}

function seeded() {
  const c = new KlineCache(tmpFile);
  c.setKline('600519_day_forward', '17', bars(), 80);
  c.setName('600519', '贵州茅台');
  return c;
}

function ctxFor(cache) {
  return {
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('离线测试：不应走网络'); },
    bridgeCall: async () => { throw new Error('离线测试：不应走 bridge'); },
  };
}

describe('ths chart', () => {
  it('文本模式输出 K 线/MA/量', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(String(s)));
    try {
      const ret = await cmdChart(ctxFor(seeded()), ['600519', '--count', '60']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('600519');
    expect(out).toContain('贵州茅台');
    expect(out).toContain('MA5');
    expect(out).toContain('量');
  });

  it('--json 返回 bars', async () => {
    const res = await cmdChart(ctxFor(seeded()), ['600519', '--count', '40', '--json']);
    expect(res.code).toBe('600519');
    expect(res.bars).toHaveLength(40);
  });
});

describe('analyze --chart', () => {
  it('在文本分析后追加 K 线', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(String(s)));
    try {
      const ret = await cmdAnalyze(ctxFor(seeded()), ['600519', '--count', '80', '--chart']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('综合评分');
    expect(out).toContain('K 线:');
    expect(out).toContain('MA5');
  });
});

describe('backtest 权益曲线', () => {
  it('文本模式输出权益/回撤图', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(String(s)));
    try {
      const ret = await cmdBacktest(ctxFor(seeded()), ['600519', '--strategy', 'buy-hold', '--count', '60']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('权益曲线');
    expect(out).toContain('回撤 (%)');
    expect(out).toContain('总收益');
  });
});
