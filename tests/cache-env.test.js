// tests/cache-env.test.js — THS_CACHE_FILE 隔离：state/ledger 必须落到 sidecar
//
// 回归：此前 deriveStateFile 拿被环境变量覆盖后的 DEFAULT_FILE 做比较，
// 设置 THS_CACHE_FILE 时仍会读写生产 data/state.json（测试/脚本隔离失效）。

import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';

const ORIG = {
  cache: process.env.THS_CACHE_FILE,
  state: process.env.THS_STATE_FILE,
  ledger: process.env.THS_LEDGER_FILE,
};

afterEach(() => {
  for (const [k, v] of [['THS_CACHE_FILE', ORIG.cache], ['THS_STATE_FILE', ORIG.state], ['THS_LEDGER_FILE', ORIG.ledger]]) {
    if (v == null) delete process.env[k]; else process.env[k] = v;
  }
  vi.resetModules();
});

describe('THS_CACHE_FILE 派生路径', () => {
  it('自定义缓存文件 → state/ledger 使用同名 sidecar', async () => {
    process.env.THS_CACHE_FILE = '/tmp/ths-isolated/ths.json';
    delete process.env.THS_STATE_FILE;
    delete process.env.THS_LEDGER_FILE;
    vi.resetModules();
    const mod = await import('../lib/cache.js');
    expect(mod.DEFAULT_FILE).toBe('/tmp/ths-isolated/ths.json');
    expect(mod.deriveStateFile(mod.DEFAULT_FILE)).toBe('/tmp/ths-isolated/ths.state.json');
    expect(mod.deriveLedgerFile(mod.DEFAULT_FILE)).toBe('/tmp/ths-isolated/ths.trades.jsonl');
  });

  it('生产缓存路径仍映射到 data/state.json', async () => {
    delete process.env.THS_CACHE_FILE;
    delete process.env.THS_STATE_FILE;
    vi.resetModules();
    const mod = await import('../lib/cache.js');
    const prod = path.join(process.cwd(), 'data', 'cache', 'ths.json');
    expect(mod.deriveStateFile(prod)).toBe(path.join(process.cwd(), 'data', 'state.json'));
  });

  it('THS_STATE_FILE 可显式覆盖', async () => {
    process.env.THS_STATE_FILE = '/tmp/custom-state.json';
    vi.resetModules();
    const mod = await import('../lib/cache.js');
    expect(mod.DEFAULT_STATE_FILE).toBe('/tmp/custom-state.json');
  });
});
