// tests/signal.test.js — 信号矛盾检测 + 共振分级（M1-3）
import { describe, it, expect } from 'vitest';
import { classifySignal } from '../lib/signal.js';

const score = (signal, factors = {}) => ({ total: signal === '看多' ? 70 : signal === '看空' ? 30 : 50, signal, factors });
const ctx = (extra = {}) => ({
  maAlignment: '多头排列', macdStatus: '多头', adx: 25, patterns: [],
  kdj: { k: 60, d: 55 }, rsi6: 60, support: 9, resistance: 11, close: 10, ...extra,
});

describe('共振升级', () => {
  it('看多 + 多头排列 + MACD多头 + ADX≥25 + 无看跌形态 → 强看多', () => {
    const r = classifySignal(score('看多'), ctx());
    expect(r.grade).toBe('strong-bull');
    expect(r.label).toBe('强看多');
    expect(r.conflicts).toEqual([]);
  });

  it('看空 + 空头排列 + MACD空头 + ADX≥25 + 无看涨形态 → 强看空', () => {
    const r = classifySignal(score('看空'), ctx({ maAlignment: '空头排列', macdStatus: '空头' }));
    expect(r.grade).toBe('strong-bear');
    expect(r.label).toBe('强看空');
    expect(r.conflicts).toEqual([]);
  });

  it('看多但 ADX 不足 25（无趋势）→ 普通看多，不升级', () => {
    const r = classifySignal(score('看多'), ctx({ adx: 18 }));
    expect(r.grade).toBe('bull');
    expect(r.label).toBe('看多');
  });
});

describe('矛盾降级（看多）', () => {
  it('看多但 MACD 空头 → 看多(存疑)，列出 MACD 矛盾', () => {
    const r = classifySignal(score('看多'), ctx({ macdStatus: '空头' }));
    expect(r.grade).toBe('bull-doubt');
    expect(r.label).toBe('看多(存疑)');
    expect(r.conflicts).toContain('MACD空头');
  });

  it('看多但近 3 形态含看跌吞没 → 看多(存疑)', () => {
    const r = classifySignal(score('看多'), ctx({ patterns: [{ label: '看跌吞没', direction: 'bear' }] }));
    expect(r.grade).toBe('bull-doubt');
    expect(r.conflicts).toContain('含看跌形态');
  });

  it('看多 + KDJ≥80 且距压力<3% → 追高矛盾', () => {
    const r = classifySignal(score('看多'), ctx({ kdj: { k: 85, d: 70 }, resistance: 10.2, close: 10 }));
    expect(r.grade).toBe('bull-doubt');
    expect(r.conflicts.some(c => c.includes('追高'))).toBe(true);
  });

  it('看多 + RSI6>75 → 严重超买矛盾', () => {
    const r = classifySignal(score('看多'), ctx({ rsi6: 78 }));
    expect(r.grade).toBe('bull-doubt');
    expect(r.conflicts).toContain('严重超买');
  });

  it('看多 + risk factor<40（高波动）→ 波动风险矛盾', () => {
    const r = classifySignal(score('看多', { risk: 30 }), ctx());
    expect(r.grade).toBe('bull-doubt');
    expect(r.conflicts).toContain('波动风险偏高');
  });

  it('多条矛盾并列列出', () => {
    const r = classifySignal(score('看多', { risk: 30 }), ctx({
      macdStatus: '空头',
      patterns: [{ label: '乌云盖顶', direction: 'bear' }],
      kdj: { k: 88, d: 80 }, rsi6: 80, resistance: 10.2, close: 10,
    }));
    expect(r.grade).toBe('bull-doubt');
    for (const c of ['MACD空头', '含看跌形态', '超买且近压力位（追高风险）', '波动风险偏高']) {
      expect(r.conflicts).toContain(c);
    }
  });
});

describe('矛盾降级（看空）', () => {
  it('看空但含看涨形态 → 看空(存疑)', () => {
    const r = classifySignal(score('看空'), ctx({ maAlignment: '空头排列', macdStatus: '空头', patterns: [{ label: '看涨吞没', direction: 'bull' }] }));
    expect(r.grade).toBe('bear-doubt');
    expect(r.conflicts).toContain('含看涨形态');
  });

  it('看空但 MACD 多头 → 看空(存疑)', () => {
    const r = classifySignal(score('看空'), ctx({ maAlignment: '空头排列', macdStatus: '多头' }));
    expect(r.grade).toBe('bear-doubt');
    expect(r.conflicts).toContain('MACD多头');
  });
});

describe('观望', () => {
  it('观望 → watch', () => {
    const r = classifySignal(score('观望'));
    expect(r.grade).toBe('watch');
    expect(r.label).toBe('观望');
    expect(r.conflicts).toEqual([]);
  });
});
