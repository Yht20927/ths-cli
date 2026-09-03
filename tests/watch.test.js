// tests/watch.test.js — ths watch 命令（--once 路径）确定性测试
//
// 说明：命令层不依赖当前 phase 断言（B8）——只断言表格渲染、--json 结构、基线不误报；
// 告警边沿语义由 tests/watch-engine.test.js 注入 phase 覆盖。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { KlineCache } from '../lib/cache.js';
import cmdWatch from '../lib/commands/watch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpFile;

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `ths-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});
afterEach(() => {
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
});

// 130 根恒为"过去"的日 K（osc 于 10 上下，支撑/压力围绕 10）
function bars(n = 130) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = 10 + 2 * Math.sin(i / 8);
    const dt = new Date(Date.UTC(2024, 0, 1 + i));
    out.push({
      date: dt.toISOString().slice(0, 10),
      open: close - 0.1, high: close + 0.6, low: close - 0.6, close,
      volume: 1e6 + i, amount: 1e8 + i,
    });
  }
  return out;
}

// quote_data fixture（quota-h 字段码）
function qd(code, market, price) {
  return {
    market: String(market), code,
    data_fields: ['6', '10', '13', '19', '199112', '1771976', '69', '70'],
    value: [[price, price, 1000000, price * 1e6, 0, 0.5, price * 1.1, price * 0.9]],
  };
}

function seededCache() {
  const c = new KlineCache(tmpFile);
  c.watchlistAdd({ code: '000725', name: '京东方A', market: '33' });
  c.watchlistAdd({ code: '603881', name: '数据港', market: '17' });
  c.setKline('000725_day_forward', '33', bars(), 130);
  c.setKline('603881_day_forward', '17', bars(), 130);
  c.positionsUpsert({ code: '000725', qty: 100, name: '京东方A', avgCost: 10, openedAt: '2026-08-01', stopPrice: 9 });
  return c;
}

function ctxFor(cache, quoteList) {
  return {
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('watch 不应走 loggedCall（防刷 audit）'); },
    bridgeCall: async expr => {
      if (/__ths\.quotes/.test(expr)) return quoteList;
      throw new Error(`watch 测试未预期的 bridge 表达式: ${expr}`);
    },
  };
}

describe('ths watch --once', () => {
  it('--json：返回结构化结果，已破位是基线不告警但状态栏标红', async () => {
    const cache = seededCache();
    // 000725 现价 8.8 < 固化止损 9（破位）；603881 健康
    const res = await cmdWatch(ctxFor(cache, [qd('000725', '33', 8.8), qd('603881', '17', 10)]), ['--once', '--json']);
    expect(res.quotes).toHaveLength(2);
    expect(typeof res.phase).toBe('string');
    expect(typeof res.inSession).toBe('boolean');
    expect(typeof res.label).toBe('string');
    // 基线：首次进入不误报（状态照常记录为破位）
    expect(res.alerts).toHaveLength(0);
    const a = res.quotes.find(r => r.code === '000725');
    const b = res.quotes.find(r => r.code === '603881');
    expect(a.status).toBe('🔴破止损');
    expect(b.status).toBe('');
    expect(a.stopTxt).toContain('9'); // 固化止损显示
    expect(b.stopTxt).toBe('-');
  });

  it('打印路径：表格含代码/名称/现价，破位行带 🔴', async () => {
    const cache = seededCache();
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(s));
    try {
      const ret = await cmdWatch(ctxFor(cache, [qd('000725', '33', 8.8), qd('603881', '17', 10)]), ['--once']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = logs.join('\n');
    expect(out).toContain('000725');
    expect(out).toContain('京东方A');
    expect(out).toContain('603881');
    expect(out).toContain('🔴破止损');
    expect(out).toContain('无触发');
  });

  it('--codes 指定池同样可用', async () => {
    const cache = seededCache();
    const res = await cmdWatch(ctxFor(cache, [qd('603881', '17', 10)]), ['--once', '--json', '--codes', '603881']);
    expect(res.quotes).toHaveLength(1);
    expect(res.quotes[0].code).toBe('603881');
  });
});
