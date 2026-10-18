// tests/portfolio-command.test.js — 买卖写 append-only 流水；清仓后历史不丢

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KlineCache } from '../lib/cache.js';
import cmdPortfolio from '../lib/commands/portfolio.js';

let dir;
let cacheFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-pfcmd-'));
  cacheFile = path.join(dir, 'cache.json');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function ctxFor(cache) {
  return {
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('离线测试：不应走网络'); },
    bridgeCall: async () => { throw new Error('离线测试：不应走 bridge'); },
  };
}

function quiet(fn) {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  return Promise.resolve(fn()).finally(() => { spy.mockRestore(); err.mockRestore(); });
}

describe('portfolio 交易流水', () => {
  it('买入/卖出写 ledger；清仓后 history 仍可查', async () => {
    const cache = new KlineCache(cacheFile);
    const ctx = ctxFor(cache);
    await quiet(() => cmdPortfolio(ctx, ['add', '600519', '--qty', '100', '--price', '100', '--stop', '90', '--name', '贵州茅台']));
    await quiet(() => cmdPortfolio(ctx, ['sell', '600519', '--qty', '100', '--price', '110', '--name', '贵州茅台']));

    expect(cache.positionsList()).toHaveLength(0);
    expect(cache.countTrades()).toBe(2);

    const trades = await cmdPortfolio(ctx, ['history', '--json']);
    expect(trades).toHaveLength(2);
    expect(trades.map(t => t.action).sort()).toEqual(['buy', 'sell']);
    expect(trades.find(t => t.action === 'sell').realized).toBeGreaterThan(0);

    const byCode = await cmdPortfolio(ctx, ['history', '600519', '--json']);
    expect(byCode).toHaveLength(2);
  });

  it('旧 state 中的 positions[].trades 在构造时迁移到 ledger', () => {
    const stateFile = cacheFile.replace(/\.json$/, '.state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      watchlist: [],
      names: {},
      positions: [{
        code: '600519', name: '贵州茅台', qty: 100, avgCost: 100,
        trades: [{ action: 'buy', qty: 100, price: 100, fee: 0, date: '2026-10-01' }],
      }],
    }));
    const cache = new KlineCache(cacheFile);
    expect(cache.countTrades()).toBe(1);
    expect(cache.listTrades()[0].source).toBe('legacy');
  });
});
