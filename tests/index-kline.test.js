// tests/index-kline.test.js — 大盘指数日 K（解析 + 趋势摘要，纯函数）

import { describe, it, expect } from 'vitest';
import { parseIndexDailyText, summarizeIndexTrend, fmtDate } from '../lib/index-kline.js';

function toYmd(dt) {
  const s = new Date(dt).toISOString().slice(0, 10).replace(/-/g, '');
  return s;
}

// 用 bars 拼 JSONP 文本
function wrapText(bars) {
  const rows = bars.map(b => `${b.date.replace(/-/g, '')},${b.open},${b.high},${b.low},${b.close},${b.volume},${b.amount},1.0,,,0`).join(';');
  return `quotebridge_v6_line_hs_1A0001_01_last({"name":"\\u4e0a\\u8bc1\\u6307\\u6570","total":${bars.length},"data":"${rows}"})`;
}

function barsOf(n, step) {
  const out = [];
  const d0 = Date.UTC(2024, 0, 1);
  let p = 3000;
  for (let i = 0; i < n; i++) {
    const dt = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    out.push({ date: dt, open: p, high: p * (1 + step * 0.8), low: p * (1 - step * 0.8), close: p, volume: 5e9, amount: 5e11 });
    p *= 1 + step;
  }
  return out;
}

describe('fmtDate / parseIndexDailyText', () => {
  it('fmtDate YYYYMMDD → YYYY-MM-DD', () => {
    expect(fmtDate('20260902')).toBe('2026-09-02');
  });

  it('解析 JSONP → 升序 bars（数量/字段/末根正确）', () => {
    const src = barsOf(5, 0.001);
    const bars = parseIndexDailyText(wrapText(src));
    expect(bars).toHaveLength(5);
    expect(bars[0].date).toBe(src[0].date);
    expect(bars[4].close).toBeCloseTo(src[4].close, 6);
    expect(typeof bars[0].open).toBe('number');
    expect(bars[0].amount).toBe(5e11);
  });

  it('垃圾输入 → []', () => {
    expect(parseIndexDailyText('not json')).toEqual([]);
    expect(parseIndexDailyText('quotebridge_1_last({ "data": "" })')).toEqual([]);
  });
});

describe('summarizeIndexTrend', () => {
  it('稳步上行 → aboveMA20、多头排列、5日为正', () => {
    const s = summarizeIndexTrend(barsOf(90, 0.003));
    expect(s).not.toBeNull();
    expect(s.aboveMA20).toBe(true);
    expect(s.maAlignment).toBe('多头排列');
    expect(s.maGapPct).toBeGreaterThan(0);
    expect(s.ret5Pct).toBeGreaterThan(0);
    expect(s.close).toBeGreaterThan(s.ma20);
  });

  it('持续下行 → below MA20（aboveMA20=false）', () => {
    const s = summarizeIndexTrend(barsOf(90, -0.003));
    expect(s.aboveMA20).toBe(false);
    expect(s.ret5Pct).toBeLessThan(0);
  });

  it('bar 不足暖机 → null', () => {
    expect(summarizeIndexTrend(barsOf(10, 0.003))).toBeNull();
    expect(summarizeIndexTrend([])).toBeNull();
  });
});
