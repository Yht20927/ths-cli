// tests/tui-state.test.js — watch TUI 状态机

import { describe, it, expect } from 'vitest';
import {
  createState, visibleCodes, selectedItem, onTick, onError,
  handleKey, sortLabel,
} from '../lib/tui/state.js';

const ITEMS = [
  { code: '000725', name: '京东方A' },
  { code: '002185', name: '华天科技' },
  { code: '000100', name: 'TCL科技' },
];

function base() {
  return createState({ items: ITEMS, levels: {}, rules: {} });
}

function key(k, str = '') {
  return handleKey(k, str, { name: '' });
}

describe('TUI state', () => {
  it('初始状态', () => {
    const s = base();
    expect(s.tab).toBe(0);
    expect(s.selected).toBe(0);
    expect(visibleCodes(s).map(x => x.code)).toEqual(['000100', '000725', '002185']);
  });

  it('暂停/刷新/页面切换', () => {
    let s = base();
    s = key(s, 'p').state;
    expect(s.paused).toBe(true);
    s = key(s, 'p').state;
    expect(s.paused).toBe(false);
    expect(key(s, 'r').refresh).toBe(true);
    expect(key(s, '3').state.tab).toBe(2);
    expect(key(s, '4').state.tab).toBe(3);
  });

  it('q / Ctrl+C 退出', () => {
    expect(key(base(), 'q').quit).toBe(true);
    const r = handleKey(base(), '', { ctrl: true, name: 'c' });
    expect(r.quit).toBe(true);
  });

  it('方向键/移动夹取', () => {
    let s = base();
    s = key(s, 'j').state;
    expect(s.selected).toBe(1);
    s = key(s, 'j').state;
    s = key(s, 'j').state;
    expect(s.selected).toBe(2);
    s = key(s, 'g').state;
    expect(s.selected).toBe(0);
    s = key(s, 'G').state;
    expect(s.selected).toBe(2);
  });

  it('排序循环与反向', () => {
    let s = base();
    s = key(s, 's').state;
    expect(s.sortKey).toBe('name');
    expect(sortLabel(s.sortKey, s.sortDir)).toContain('名称');
    s = key(s, 'S').state;
    expect(s.sortDir).toBe(-1);
  });

  it('过滤输入', () => {
    let s = base();
    s = key(s, '/').state;
    expect(s.filterMode).toBe(true);
    s = handleKey(s, '京', { name: '' }).state;
    s = handleKey(s, '东', { name: '' }).state;
    s = handleKey(s, '', { name: 'return' }).state;
    expect(s.filterMode).toBe(false);
    expect(s.filter).toBe('京东');
    expect(visibleCodes(s).map(x => x.code)).toEqual(['000725']);
  });

  it('过滤退格', () => {
    let s = base();
    s = key(s, '/').state;
    s = handleKey(s, '京', { name: '' }).state;
    s = handleKey(s, '', { name: 'backspace' }).state;
    expect(s.filter).toBe('');
  });

  it('tick 更新行情/历史/告警', () => {
    let s = base();
    s = onTick(s, {
      ts: 1000,
      phase: 'am',
      inSession: true,
      label: '上午盘中',
      quotes: {
        '000725': { price: 5.79, pct: 0.52 },
        '002185': { price: 16.05, pct: 1 },
      },
      statusByCode: { '000725': 'warn' },
      alerts: [{ code: '002185', name: '华天科技', kind: 'vol', level: 'info', message: '放量' }],
    });
    expect(s.tickNo).toBe(1);
    expect(s.quotes['000725'].price).toBe(5.79);
    expect(s.priceHistory['000725']).toEqual([5.79]);
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0].acked).toBe(false);
    expect(s.lastError).toBeNull();
    expect(s.consecFails).toBe(0);
  });

  it('错误计数与恢复', () => {
    let s = onError(base(), new Error('boom'));
    expect(s.consecFails).toBe(1);
    expect(s.lastError).toContain('boom');
    s = onTick(s, { ts: 2, quotes: {}, statusByCode: {}, alerts: [] });
    expect(s.consecFails).toBe(0);
    expect(s.lastError).toBeNull();
  });

  it('告警页导航与确认', () => {
    let s = base();
    s = onTick(s, { ts: 1, quotes: {}, statusByCode: {}, alerts: [
      { code: '000725', name: '京东方A', kind: 'stop', level: 'critical', message: '破位' },
      { code: '002185', name: '华天科技', kind: 'vol', level: 'info', message: '放量' },
    ] });
    s = key(s, '2').state;
    expect(s.tab).toBe(1);
    s = key(s, 'j').state;
    expect(s.selected).toBe(1);
    s = key(s, 'a').state;
    expect(s.alerts[1].acked).toBe(true);
  });

  it('从告警页进入对应股票详情', () => {
    let s = base();
    s = onTick(s, { ts: 1, quotes: {}, statusByCode: {}, alerts: [
      { code: '000100', name: 'TCL科技', kind: 'vol', level: 'info', message: '放量' },
    ] });
    s = key(s, '2').state;
    s = handleKey(s, '', { name: 'return' }).state;
    expect(s.tab).toBe(2);
    expect(selectedItem(s).code).toBe('000100');
  });
});
