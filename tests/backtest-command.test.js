// tests/backtest-command.test.js — backtest 命令层数据卫生回归
//
// 验证：默认 excludeForming 不会误伤"非在途"历史数据（末根日期≠今天 → 不剔除），
// 且 --include-forming 逃生口可用。forming 剔除本身的确定性单测在 cache.test.js
// （注入 nowMs）；命令层用真实 Date.now，故这里只保证 non-forming 场景恒等。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache } from '../lib/cache.js';
import cmdBacktest from '../lib/commands/backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-btcmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

// 恒为"过去"的 60 根日 K（末根日期绝不可能等于任意运行日"今天"，确保 non-forming）
function pastBars(n = 60) {
  const out = [];
  let close = 10;
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(2024, 0, 1 + i));
    close += (i % 10 === 0) ? 0.5 : 0.05;
    out.push({
      date: dt.toISOString().slice(0, 10),
      open: close - 0.1, high: close + 0.6, low: close - 0.5, close,
      volume: 1000000 + i * 1000, amount: 1e8 + i,
    });
  }
  return out;
}

function baseCtx(cache) {
  return {
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('不应走网络'); },
  };
}

describe('backtest 命令 excludeForming 回归', () => {
  it('默认：非在途历史数据不被剔除（res.bars == count）', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', pastBars(60), 60);
    const res = await cmdBacktest(baseCtx(c), ['600519', '--strategy', 'buy-hold', '--count', '60', '--json']);
    expect(res.bars).toBe(60);
    expect(typeof res.totalReturnPct).toBe('number');
  });

  it('--include-forming 逃生口可用（非在途数据结果一致）', async () => {
    const c = new KlineCache(tmpFile);
    c.setKline('600519_day_forward', '17', pastBars(60), 60);
    const res = await cmdBacktest(baseCtx(c), ['600519', '--strategy', 'buy-hold', '--count', '60', '--include-forming', '--json']);
    expect(res.bars).toBe(60);
  });
});
