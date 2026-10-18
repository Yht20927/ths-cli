// tests/report.test.js — ths report daily/review（HTML/Markdown/JSON）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cmdReport from '../lib/commands/report.js';
import { KlineCache } from '../lib/cache.js';

let dir;
let cacheFile;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-report-'));
  cacheFile = path.join(dir, 'cache.json');
  fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function snapshot(date, closes) {
  return {
    date,
    marketEnv: {
      totalUp: 3000, totalDown: 2000, totalAmount: 1.2e12,
      mood: '👍 涨多跌少',
      indices: {
        '1A0001': { close: 3400, aboveMA20: true, maGapPct: 1.2, maAlignment: '多头排列' },
        '399006': { close: 2200, aboveMA20: false, maGapPct: -0.8, maAlignment: '空头排列' },
      },
    },
    direction: {
      boardMood: { label: '强', topSector: '通信设备', topPct: 2.1 },
      fundDir: { label: '进攻', positiveRatio: 0.7 },
      lhbJoin: { label: '强', count: 5 },
    },
    stocks: {
      '000725': {
        code: '000725', name: '京东方A', date, close: closes[0], score: 65,
        signal: '看多', signalLabel: '看多(存疑)', maAlignment: '多头排列',
        macdStatus: '空头', kdj: { k: 72, d: 68 }, rsi6: 64, adx: 28, atrPct: 3.2,
        support: 5.62, resistance: 6.10,
        dir: { boardLeader: '通信设备', fundTop: true, lhb: 100, dirCount: 3 },
      },
      '002185': {
        code: '002185', name: '华天科技', date, close: closes[1], score: 52,
        signal: '观望', maAlignment: '交叉/缠绕', macdStatus: '多头',
        kdj: { k: 40, d: 44 }, rsi6: 48, adx: 19, atrPct: 4.5,
        support: 15.0, resistance: 17.0,
        dir: null,
      },
    },
  };
}

function seed() {
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-10-16.json'),
    JSON.stringify(snapshot('2026-10-16', [5.6, 15.8])));
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-10-17.json'),
    JSON.stringify(snapshot('2026-10-17', [5.79, 16.05])));
}

function ctx(format = 'md') {
  return {
    output: { format },
    cache: {
      positionsList: () => [{
        code: '000725', name: '京东方A', qty: 1000, avgCost: 5.5,
        stopPrice: 5.5, realizedPnl: 0, trades: [],
      }],
      getName: code => (code === '000725' ? '京东方A' : ''),
    },
  };
}

function capture() {
  const chunks = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(s => {
    chunks.push(String(s));
    return true;
  });
  return { chunks, spy };
}

describe('ths report daily', () => {
  it('HTML 输出包含标题/快照表/持仓', async () => {
    seed();
    const { chunks, spy } = capture();
    try {
      const ret = await cmdReport(ctx('html'), ['daily', '--date', '2026-10-17', '--dir', dir, '--min-n', '1']);
      expect(ret).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('<!doctype html>');
    expect(out).toContain('每日监控报告');
    expect(out).toContain('京东方A');
    expect(out).toContain('持仓联动');
    expect(out).toContain('<table');
  });

  it('Markdown 输出包含表头', async () => {
    seed();
    const { chunks, spy } = capture();
    try {
      await cmdReport(ctx('md'), ['daily', '--date', '2026-10-17', '--dir', dir, '--min-n', '1']);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('# 每日监控报告');
    expect(out).toContain('| 代码 |');
    expect(out).toContain('京东方A');
  });

  it('JSON 返回报告模型', async () => {
    seed();
    const res = await cmdReport(ctx('json'), ['daily', '--date', '2026-10-17', '--dir', dir, '--min-n', '1']);
    expect(res.kind).toBe('daily');
    expect(res.title).toContain('2026-10-17');
    expect(res.sections.some(s => s.type === 'table')).toBe(true);
    expect(res.sections.some(s => s.type === 'tiles')).toBe(true);
  });

  it('无快照时报错', async () => {
    await expect(cmdReport(ctx(), ['daily', '--dir', dir])).rejects.toThrow(/没有每日快照/);
  });
});

describe('ths report review', () => {
  it('Markdown 输出复盘报告', async () => {
    seed();
    const { chunks, spy } = capture();
    try {
      await cmdReport(ctx('md'), ['review', '--dir', dir, '--since', '90', '--min-n', '1']);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('# 复盘命中率报告');
    expect(out).toContain('特征桶命中率');
    expect(out).toContain('3日命中率分布');
  });

  it('JSON 返回 kind=review', async () => {
    seed();
    const res = await cmdReport(ctx('json'), ['review', '--dir', dir, '--min-n', '1']);
    expect(res.kind).toBe('review');
    expect(res.sections.some(s => s.type === 'chart')).toBe(true);
  });
});

// ── backtest / risk ─────────────────────────────────────────

function priceBars(n = 80, mul = 1) {
  const out = [];
  let c = 100;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = c;
    const close = c * (1 + (i % 6 === 0 ? -0.01 : 0.007));
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open: open * mul, close: close * mul,
      high: Math.max(open, close) * 1.008 * mul,
      low: Math.min(open, close) * 0.992 * mul,
      volume: 1e6 + i * 1000,
      amount: 1e8 + i,
    });
    c = close;
  }
  return out;
}

function seedCache() {
  const c = new KlineCache(cacheFile);
  const a = priceBars(80);
  c.setKline('600519_day_forward', '17', a, 80);
  c.setName('600519', '贵州茅台');
  c.setKline('000725_day_forward', '33', a, 80);
  c.setName('000725', '京东方A');
  c.setKline('603881_day_forward', '17', priceBars(80, 2), 80);
  c.setName('603881', '数据港');
  return c;
}

function cacheCtx(format = 'json', withPositions = false) {
  const cache = seedCache();
  if (withPositions) {
    cache.positionsUpsert({
      code: '600519', name: '贵州茅台', qty: 100, avgCost: 100,
      realizedPnl: 50, trades: [], stopPrice: 200, // 高于现价 → 破位
      stopSource: '手动', stopSetAt: '2026-01-01', violationStreak: 0,
    });
  }
  return {
    output: { format },
    cache,
    config: {},
    audit: { startOperation: () => {}, endOperation: () => {} },
    loggedCall: async () => { throw new Error('离线测试：不应走网络'); },
    bridgeCall: async () => { throw new Error('离线测试：不应走 bridge'); },
  };
}

describe('ths report backtest', () => {
  it('JSON：指标 + 权益/回撤 + 交易表', async () => {
    const res = await cmdReport(cacheCtx('json'), ['backtest', '600519', '--strategy', 'buy-hold', '--count', '60']);
    expect(res.kind).toBe('backtest');
    expect(res.title).toContain('600519');
    expect(res.sections.some(s => s.type === 'tiles')).toBe(true);
    expect(res.sections.filter(s => s.type === 'chart' && s.chart === 'line')).toHaveLength(2);
    expect(res.sections.some(s => s.type === 'table')).toBe(true);
  });

  it('HTML：包含 SVG 与回测标题', async () => {
    const { chunks, spy } = capture();
    try {
      await cmdReport(cacheCtx('html'), ['backtest', '600519', '--strategy', 'buy-hold', '--count', '60']);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('回测报告');
    expect(out).toContain('<svg');
  });

  it('未知策略报错', async () => {
    await expect(cmdReport(cacheCtx('json'), ['backtest', '600519', '--strategy', 'nope']))
      .rejects.toThrow(/未知策略/);
  });
});

describe('ths report risk', () => {
  it('JSON：热力图矩阵 + 单票表', async () => {
    const res = await cmdReport(cacheCtx('json'), ['risk', '--codes', '000725,603881', '--count', '60']);
    expect(res.kind).toBe('risk');
    expect(res.sections.some(s => s.type === 'chart' && s.chart === 'heatmap')).toBe(true);
    const heat = res.sections.find(s => s.chart === 'heatmap');
    expect(heat.labels).toEqual(['000725', '603881']);
    expect(heat.matrix).toHaveLength(2);
    expect(res.sections.some(s => s.type === 'table')).toBe(true);
  });

  it('Markdown：包含风险提示与热力图文本', async () => {
    const { chunks, spy } = capture();
    try {
      await cmdReport(cacheCtx('md'), ['risk', '--codes', '000725,603881', '--count', '60']);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('# 组合风险报告');
    expect(out).toContain('相关系数矩阵');
    expect(out).toContain('单票画像');
  });
});

describe('ths report portfolio', () => {
  it('JSON：组合概览 + 持仓明细 + 破位标记', async () => {
    const res = await cmdReport(cacheCtx('json', true), ['portfolio', '--offline']);
    expect(res.kind).toBe('portfolio');
    expect(res.title).toContain('持仓报告');
    const table = res.sections.find(s => s.type === 'table');
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].code).toBe('600519');
    expect(table.rows[0].status).toBe('破位');
    expect(table.rows[0].source).toBe('缓存日K');
    const tiles = res.sections.find(s => s.type === 'tiles');
    expect(tiles.items.some(i => i.label === '破位标的' && i.value === '1')).toBe(true);
  });

  it('HTML：包含标题与持仓表', async () => {
    const { chunks, spy } = capture();
    try {
      await cmdReport(cacheCtx('html', true), ['portfolio', '--offline']);
    } finally {
      spy.mockRestore();
    }
    const out = chunks.join('');
    expect(out).toContain('持仓报告');
    expect(out).toContain('持仓明细');
    expect(out).toContain('贵州茅台');
  });

  it('空台账报错', async () => {
    await expect(cmdReport(cacheCtx('json'), ['portfolio', '--offline']))
      .rejects.toThrow(/持仓台账为空/);
  });
});
