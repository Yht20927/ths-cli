// tests/summary.test.js — 紧凑摘要（compare / analyze --compact 共用）

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSummary } from '../lib/summary.js';
import { formatKline } from '../lib/commands/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('buildSummary', () => {
  const qd = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', '日K-quote.json'), 'utf8'));
  const bars = qd.value.map(formatKline);

  it('返回紧凑摘要关键字段', () => {
    const s = buildSummary('600519', bars);
    expect(s.code).toBe('600519');
    expect(s.close).toBeTypeOf('number');
    expect(s.score).toBeTypeOf('number');
    expect(['看多', '看空', '观望']).toContain(s.signal);
    expect(s.factors).toHaveProperty('trend');
    expect(s.factors).toHaveProperty('momentum');
    expect(s.factors).toHaveProperty('volume');
    expect(s.adx).toBeTypeOf('number');
    expect(s.support).toBeTypeOf('number');
    expect(s.resistance).toBeTypeOf('number');
    expect(Array.isArray(s.patterns)).toBe(true);
  });

  it('可复用传入的 analysis/patterns/score/sr', () => {
    const { analyzeBars } = require('../lib/indicators.js');
    const { detectPatterns } = require('../lib/patterns.js');
    const { detectSR } = require('../lib/support-resistance.js');
    const { scoreBars } = require('../lib/score.js');
    const a = analyzeBars(bars);
    const p = detectPatterns(bars);
    const score = scoreBars(bars, { analysis: a, patterns: p });
    const sr = detectSR(bars);
    const s = buildSummary('600519', bars, { analysis: a, patterns: p, score, sr });
    expect(s.score).toBe(score.total);
  });

  it('空数据不抛错（由底层 analyzeBars 报）', () => {
    expect(() => buildSummary('x', [])).toThrow(/K 线数据为空/);
  });
});
