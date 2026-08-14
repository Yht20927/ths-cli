// tests/indicators-extra.test.js — 新增指标 + 增量算法与朴素实现等价性

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  sma, boll, kdj, atr, adx, cci, obv, wr, sar, roc, vwap, mfi,
} from '../lib/indicators.js';
import { formatKline } from '../lib/commands/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 与朴素 O(n·k) 实现等价 ──

function naiveSma(v, n) {
  const out = [];
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += v[j];
    out.push(s / n);
  }
  return out;
}

function naiveBoll(c, n = 20, k = 2) {
  const mid = [], up = [], low = [];
  for (let i = 0; i < c.length; i++) {
    if (i < n - 1) { mid.push(null); up.push(null); low.push(null); continue; }
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += c[j];
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (c[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    mid.push(m); up.push(m + k * sd); low.push(m - k * sd);
  }
  return { mid, up, low };
}

function naiveKdj(c, h, l, n = 9) {
  const kArr = [], dArr = [], jArr = [];
  let pk = 50, pd = 50;
  for (let i = 0; i < c.length; i++) {
    const start = Math.max(0, i - n + 1);
    let hh = -Infinity, ll = Infinity;
    for (let j = start; j <= i; j++) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    const rsv = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
    const k = (2 / 3) * pk + (1 / 3) * rsv;
    const d = (2 / 3) * pd + (1 / 3) * k;
    kArr.push(k); dArr.push(d); jArr.push(3 * k - 2 * d);
    pk = k; pd = d;
  }
  return { k: kArr, d: dArr, j: jArr };
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '日K-quote.json'), 'utf8'));
const bars = fixture.value.map(formatKline);
const closes = bars.map(b => b.close);
const highs = bars.map(b => b.high);
const lows = bars.map(b => b.low);
const vols = bars.map(b => b.volume);

describe('增量算法与朴素实现等价（真实 374 根 fixture）', () => {
  it('sma 全量等价', () => {
    [5, 10, 20, 60].forEach(n => {
      const a = sma(closes, n), b = naiveSma(closes, n);
      for (let i = 0; i < closes.length; i++) expect(a[i]).toBeCloseTo(b[i], 10);
    });
  });

  it('boll 全量等价（±1e-8 容差）', () => {
    const a = boll(closes), b = naiveBoll(closes);
    for (let i = 0; i < closes.length; i++) {
      expect(a.mid[i]).toBeCloseTo(b.mid[i], 8);
      expect(a.up[i]).toBeCloseTo(b.up[i], 8);
      expect(a.low[i]).toBeCloseTo(b.low[i], 8);
    }
  });

  it('kdj 全量等价', () => {
    const a = kdj(closes, highs, lows), b = naiveKdj(closes, highs, lows);
    for (let i = 0; i < closes.length; i++) {
      expect(a.k[i]).toBeCloseTo(b.k[i], 10);
      expect(a.d[i]).toBeCloseTo(b.d[i], 10);
      expect(a.j[i]).toBeCloseTo(b.j[i], 10);
    }
  });
});

describe('atr', () => {
  it('恒定 TR 收敛到该值', () => {
    const h = Array(40).fill(110), l = Array(40).fill(100), c = Array(40).fill(105);
    const a = atr(h, l, c, 14);
    expect(a[a.length - 1]).toBeCloseTo(10, 5);
  });
  it('首 13 根为 null，第 14 根有值', () => {
    const a = atr(highs, lows, closes, 14);
    expect(a[12]).toBeNull();
    expect(a[13]).not.toBeNull();
  });
});

describe('adx', () => {
  it('单调上行 → +DI 占优、ADX 高', () => {
    const bars2 = [];
    let h = 100, l = 90;
    for (let i = 0; i < 60; i++) { h += 2; l += 2; bars2.push({ high: h, low: l, close: (h + l) / 2 }); }
    const h2 = bars2.map(b => b.high), l2 = bars2.map(b => b.low), c2 = bars2.map(b => b.close);
    const d = adx(h2, l2, c2, 14);
    const i = c2.length - 1;
    expect(d.pdi[i]).toBeGreaterThan(d.mdi[i]);
    expect(d.adx[i]).toBeGreaterThan(50);
  });
  it('单调下行 → -DI 占优', () => {
    const bars2 = [];
    let h = 200, l = 190;
    for (let i = 0; i < 60; i++) { h -= 2; l -= 2; bars2.push({ high: h, low: l, close: (h + l) / 2 }); }
    const h2 = bars2.map(b => b.high), l2 = bars2.map(b => b.low), c2 = bars2.map(b => b.close);
    const d = adx(h2, l2, c2, 14);
    const i = c2.length - 1;
    expect(d.mdi[i]).toBeGreaterThan(d.pdi[i]);
  });
});

describe('cci', () => {
  it('恒定 TP → CCI = 0', () => {
    const c = Array(30).fill(100), h = Array(30).fill(101), l = Array(30).fill(99);
    const out = cci(h, l, c, 20);
    expect(out[out.length - 1]).toBe(0);
  });
  it('fixture 上有有限值', () => {
    const out = cci(highs, lows, closes, 20);
    expect(Number.isFinite(out[out.length - 1])).toBe(true);
  });
});

describe('obv', () => {
  it('单调上涨 → 逐根累加', () => {
    const c = [10, 11, 12, 13, 14], v = [100, 200, 300, 400, 500];
    const o = obv(c, v);
    expect(o[0]).toBe(0);
    expect(o[4]).toBe(200 + 300 + 400 + 500);
    for (let i = 1; i < 5; i++) expect(o[i]).toBeGreaterThan(o[i - 1]);
  });
});

describe('wr', () => {
  it('单调上涨 → 接近 0（强），单调下跌 → 接近 -100', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const upH = up.map(x => x + 1), upL = up.map(x => x - 1);
    expect(wr(up, upH, upL, 14)[up.length - 1]).toBeGreaterThan(-10);

    const dn = Array.from({ length: 40 }, (_, i) => 200 - i);
    const dnH = dn.map(x => x + 1), dnL = dn.map(x => x - 1);
    expect(wr(dn, dnH, dnL, 14)[dn.length - 1]).toBeLessThan(-90);
  });
});

describe('sar', () => {
  it('单调上涨 → SAR 定义且不高于最高价', () => {
    const bars2 = [];
    let p = 100;
    for (let i = 0; i < 40; i++) { p += 1; bars2.push({ high: p + 0.5, low: p - 0.5 }); }
    const h = bars2.map(b => b.high), l = bars2.map(b => b.low);
    const s = sar(h, l);
    const i = h.length - 1;
    expect(s[i]).not.toBeNull();
    expect(Number.isFinite(s[i])).toBe(true);
    expect(s[i]).toBeLessThanOrEqual(h[i]);
  });
  it('首个值为 null', () => {
    expect(sar(highs, lows)[0]).toBeNull();
  });
});

describe('roc', () => {
  it('前 n 根 null，单调上涨为正', () => {
    const c = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = roc(c, 12);
    expect(r[11]).toBeNull();
    expect(r[12]).not.toBeNull();
    expect(r[r.length - 1]).toBeGreaterThan(0);
  });
});

describe('vwap', () => {
  it('恒定价格 → VWAP = 价格', () => {
    const c = Array(20).fill(50), h = Array(20).fill(51), l = Array(20).fill(49), v = Array(20).fill(1000);
    const w = vwap(h, l, c, v);
    expect(w[w.length - 1]).toBeCloseTo(50, 6);
  });
});

describe('mfi', () => {
  it('恒定 TP → 无负流 → 100', () => {
    const c = Array(30).fill(50), h = Array(30).fill(51), l = Array(30).fill(49), v = Array(30).fill(1000);
    const m = mfi(h, l, c, v, 14);
    expect(m[m.length - 1]).toBe(100);
  });
  it('值域 0-100', () => {
    const m = mfi(highs, lows, closes, vols, 14);
    for (const x of m) { if (x != null) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100); } }
  });
});
