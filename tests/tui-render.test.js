// tests/tui-render.test.js — watch TUI 屏幕渲染

import { describe, it, expect } from 'vitest';
import { createState, onTick, handleKey } from '../lib/tui/state.js';
import { renderScreen, statusOf } from '../lib/tui/render.js';
import { displayWidth } from '../lib/render/width.js';
import { resolveTheme } from '../lib/render/theme.js';

const ITEMS = [
  { code: '000725', name: '京东方A' },
  { code: '002185', name: '华天科技' },
  { code: '000100', name: 'TCL科技' },
];

const LEVELS = {
  '000725': { code: '000725', name: '京东方A', support: 5.62, resistance: 6.10, stop: 5.50, isBoard: false },
  '002185': { code: '002185', name: '华天科技', support: 15.0, resistance: 17.0, stop: null, isBoard: false },
  '000100': { code: '000100', name: 'TCL科技', support: 4.7, resistance: 5.2, stop: null, isBoard: false },
};

function bars(n = 40) {
  const out = [];
  let c = 100;
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = c;
    const close = c * (1 + (i % 5 === 0 ? -0.015 : 0.008));
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open, close,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      volume: 1e6 + i * 1000,
    });
    c = close;
  }
  return out;
}

function state() {
  let s = createState({ items: ITEMS, levels: LEVELS, rules: { chasePct: 7, dropPct: -5, volRatio: 3 } });
  s = { ...s, interval: 15, phase: 'am', inSession: true, label: '上午盘中', now: Date.UTC(2026, 9, 18, 2, 23, 45) };
  s = onTick(s, {
    ts: 1,
    phase: 'am',
    inSession: true,
    label: '上午盘中',
    quotes: {
      '000725': { price: 5.79, pct: 7.2, volumeRatio: 2.63 },
      '002185': { price: 16.05, pct: 1.0, volumeRatio: 3.62 },
      '000100': { price: 4.89, pct: -0.8, volumeRatio: 1.1 },
    },
    statusByCode: { '000725': 'warn', '002185': 'info', '000100': '' },
    alerts: [
      { code: '002185', name: '华天科技', kind: 'vol', level: 'info', message: '量比 3.62 ≥ 3 —— 放量异动' },
      { code: '000725', name: '京东方A', kind: 'chase', level: 'warn', message: '盘中涨幅 7.2% ≥ 7% —— 追高红线' },
    ],
  });
  return s;
}

const THEME = resolveTheme('cn', { colorDepth: 'ansi16', unicode: 'full', emoji: false });

function assertWidth(lines, width) {
  for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width);
}

describe('TUI dashboard', () => {
  it('80 列包含表头/行情/告警/页脚且不超宽', () => {
    const out = renderScreen(state(), { width: 80, height: 24, color: false, theme: THEME });
    const text = out.join('\n');
    expect(text).toContain('ths watch');
    expect(text).toContain('京东方A');
    expect(text).toContain('告警');
    expect(text).toContain('[q]退出');
    assertWidth(out, 80);
  });

  it('120 列展示更多列', () => {
    const out = renderScreen(state(), { width: 120, height: 30, color: false, theme: THEME });
    const text = out.join('\n');
    expect(text).toContain('距支撑');
    expect(text).toContain('量比');
    assertWidth(out, 120);
  });

  it('选中行有标记（无色模式 >）', () => {
    const s = state();
    const out = renderScreen({ ...s, selected: 1 }, { width: 100, height: 24, color: false, theme: THEME });
    expect(out.some(l => l.startsWith('> '))).toBe(true);
  });

  it('颜色模式产生 ANSI 且不超宽', () => {
    const out = renderScreen(state(), { width: 100, height: 24, color: true, theme: THEME });
    expect(out.join('\n')).toContain('\x1b[');
    assertWidth(out, 100);
  });

  it('空池/过滤无匹配', () => {
    const s = { ...state(), filter: '不存在' };
    const out = renderScreen(s, { width: 80, height: 20, color: false, theme: THEME });
    expect(out.join('\n')).toContain('无匹配');
    assertWidth(out, 80);
  });
});

describe('TUI other tabs', () => {
  it('告警页', () => {
    const s = handleKey(state(), '2', { name: '' }).state;
    const out = renderScreen(s, { width: 80, height: 24, color: false, theme: THEME });
    expect(out.join('\n')).toContain('今日告警');
    expect(out.join('\n')).toContain('放量异动');
    assertWidth(out, 80);
  });

  it('详情页（K 线）', () => {
    let s = state();
    s.levels['000725'].bars = bars(60);
    s.levels['000725'].summary = {
      score: 65, signal: '看多', signalLabel: '看多(存疑)', maAlignment: '多头排列',
      macdStatus: '空头', adx: 28, atrPct: 3.2, conflicts: ['MACD 空头 × 均线多头'],
    };
    // 默认按代码排序：000100, 000725, 002185
    s = { ...s, selected: 1 };
    s = handleKey(s, '3', { name: '' }).state;
    const out = renderScreen(s, { width: 100, height: 32, color: false, theme: THEME });
    const text = out.join('\n');
    expect(text).toContain('京东方A');
    expect(text).toContain('评分 65');
    assertWidth(out, 100);
  });

  it('帮助页', () => {
    const s = handleKey(state(), '4', { name: '' }).state;
    const out = renderScreen(s, { width: 80, height: 24, color: false, theme: THEME });
    expect(out.join('\n')).toContain('帮助');
    expect(out.join('\n')).toContain('退出');
    assertWidth(out, 80);
  });
});

describe('statusOf', () => {
  it('破止损/放量/追高', () => {
    const s = state();
    expect(statusOf(s, '000725', s.quotes['000725'], s.levels['000725'], s.rules).label).toBe('追高');
    expect(statusOf(s, '002185', s.quotes['002185'], s.levels['002185'], s.rules).label).toBe('放量');
    const broken = { ...s, statusByCode: { ...s.statusByCode, '000725': 'critical' } };
    expect(statusOf(broken, '000725', { ...s.quotes['000725'], price: 5.4 }, s.levels['000725'], s.rules).label).toBe('破止损');
  });
});
