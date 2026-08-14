// tests/indicators.test.js — 技术指标纯函数 + 综合分析

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sma, ema, macd, kdj, rsi, boll, analyzeBars } from '../lib/indicators.js';
import { formatKline } from '../lib/commands/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('sma', () => {
  it('MA5 最后一位 = 末5个均值', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const s = sma(v, 5);
    expect(s[s.length - 1]).toBeCloseTo(8, 10); // (6+7+8+9+10)/5
    expect(s[3]).toBeNull(); // 暖机期
    expect(s.length).toBe(v.length);
  });
});

describe('ema', () => {
  it('恒值序列收敛到该值', () => {
    const v = Array.from({ length: 50 }, () => 100);
    const e = ema(v, 12);
    expect(e[e.length - 1]).toBeCloseTo(100, 6);
  });
});

describe('macd', () => {
  it('恒值序列 DIF/DEA/柱 都接近 0', () => {
    const v = Array.from({ length: 60 }, () => 50);
    const m = macd(v);
    expect(Math.abs(m.dif[m.dif.length - 1])).toBeLessThan(1e-6);
    expect(Math.abs(m.dea[m.dea.length - 1])).toBeLessThan(1e-6);
    expect(Math.abs(m.hist[m.hist.length - 1])).toBeLessThan(1e-6);
  });
  it('上涨行情 DIF > 0', () => {
    const v = Array.from({ length: 60 }, (_, i) => 100 + i * 2);
    const m = macd(v);
    expect(m.dif[m.dif.length - 1]).toBeGreaterThan(0);
  });
});

describe('kdj', () => {
  it('K/D 在 0~100 区间', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 10);
    const highs = closes.map(c => c + 1);
    const lows = closes.map(c => c - 1);
    const { k, d } = kdj(closes, highs, lows);
    k.forEach(x => expect(x).toBeGreaterThanOrEqual(0));
    k.forEach(x => expect(x).toBeLessThanOrEqual(100));
    d.forEach(x => expect(x).toBeGreaterThanOrEqual(0));
    d.forEach(x => expect(x).toBeLessThanOrEqual(100));
  });
});

describe('rsi', () => {
  it('值域 0~100，单调上涨 → 100', () => {
    const v = Array.from({ length: 40 }, (_, i) => 100 + i);
    const r = rsi(v, 14);
    expect(r[r.length - 1]).toBeGreaterThan(90);
    r.forEach(x => { if (x != null) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100); } });
  });
  it('单调下跌 → 接近 0', () => {
    const v = Array.from({ length: 40 }, (_, i) => 200 - i);
    const r = rsi(v, 14);
    expect(r[r.length - 1]).toBeLessThan(10);
  });
});

describe('boll', () => {
  it('上轨 ≥ 中轨 ≥ 下轨，中轨 = MA20', () => {
    const v = Array.from({ length: 30 }, (_, i) => 50 + Math.sin(i / 3) * 5);
    const b = boll(v);
    const i = v.length - 1;
    expect(b.up[i]).toBeGreaterThan(b.mid[i]);
    expect(b.low[i]).toBeLessThan(b.mid[i]);
    expect(b.mid[i]).toBeCloseTo(sma(v, 20)[i], 8);
  });
});

describe('analyzeBars（真实抓包 fixture）', () => {
  const qd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '日K-quote.json'), 'utf8'));
  const bars = qd.value.map(formatKline);

  it('条数与结构', () => {
    const a = analyzeBars(bars);
    expect(a.count).toBe(374);
    expect(a.firstDate).toBe('2025-02-05');
    expect(a.latest.close).toBe(bars[bars.length - 1].close);
  });

  it('MA5 = 末5根收盘均值（analyzeBars 四舍五入到2位）', () => {
    const a = analyzeBars(bars);
    const last5 = bars.slice(-5).reduce((s, b) => s + b.close, 0) / 5;
    expect(a.ma.ma5).toBeCloseTo(last5, 1);
  });

  it('全部指标为有限值或 null（无 NaN/Infinity）', () => {
    const a = analyzeBars(bars);
    const fin = x => x == null || (typeof x === 'number' && isFinite(x));
    expect(fin(a.macd.dif)).toBe(true);
    expect(fin(a.macd.dea)).toBe(true);
    expect(fin(a.macd.hist)).toBe(true);
    expect(fin(a.kdj.k)).toBe(true);
    expect(fin(a.kdj.d)).toBe(true);
    expect(fin(a.kdj.j)).toBe(true);
    expect(fin(a.rsi.rsi6)).toBe(true);
    expect(fin(a.rsi.rsi12)).toBe(true);
    expect(fin(a.boll.up)).toBe(true);
    expect(fin(a.boll.mid)).toBe(true);
    expect(fin(a.boll.low)).toBe(true);
    expect(fin(a.stats.rangePct)).toBe(true);
    expect(fin(a.stats.rangeAmp)).toBe(true);
  });

  it('区间涨跌幅与首末收盘一致（四舍五入到2位）', () => {
    const a = analyzeBars(bars);
    const first = bars[0].close, last = bars[bars.length - 1].close;
    expect(a.stats.rangePct).toBeCloseTo(((last - first) / first) * 100, 1);
  });

  it('均线排列状态合法', () => {
    const a = analyzeBars(bars);
    expect(['多头排列', '空头排列', '交叉/缠绕']).toContain(a.ma.alignment);
  });
});

describe('analyzeBars 边界', () => {
  it('空数组抛清晰错误', () => {
    expect(() => analyzeBars([])).toThrow(/K 线数据为空/);
    expect(() => analyzeBars(null)).toThrow(/K 线数据为空/);
  });

  it('首根 close=0 不产生 NaN/Infinity', () => {
    const bars = Array.from({ length: 40 }, (_, i) => ({
      date: 'd' + i, open: 1, high: 2, low: 0.5,
      close: i === 0 ? 0 : 100 + i, volume: 1000, amount: 1e6,
    }));
    const a = analyzeBars(bars);
    expect(a.stats.rangePct).toBeNull();
    expect(Number.isFinite(a.ma.ma5)).toBe(true);
  });
});
