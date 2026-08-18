// tests/helpers.test.js — 命令共享辅助函数

import { describe, it, expect } from 'vitest';
import {
  escapeExpression,
  getFlag,
  PERIODS,
  inferMarket,
  formatKline,
  fmtNum,
  toCsv,
  renderTable,
  isBoardIndex,
} from '../lib/commands/helpers.js';

describe('escapeExpression', () => {
  it('转义反斜杠与单引号', () => {
    expect(escapeExpression("600'519\\")).toBe("600\\'519\\\\");
  });
  it('普通字符串不变', () => {
    expect(escapeExpression('茅台')).toBe('茅台');
  });
});

describe('getFlag', () => {
  it('取到值', () => {
    expect(getFlag(['--count', '5'], '--count', 1)).toBe('5');
  });
  it('缺值用默认', () => {
    expect(getFlag(['--count'], '--count', 1)).toBe(1);
  });
  it('值以 -- 开头视为缺省', () => {
    expect(getFlag(['--count', '--json'], '--count', 7)).toBe(7);
  });
});

describe('PERIODS', () => {
  it('6 个周期映射', () => {
    expect(PERIODS).toEqual({
      day: 'day_1',
      week: 'week_1',
      month: 'month_1',
      quarter: 'quarter_1',
      '60min': 'min_60',
      '120min': 'min_120',
    });
  });
});

describe('inferMarket', () => {
  it('6 开头 → 沪 17', () => {
    expect(inferMarket('600519')).toBe('17');
    expect(inferMarket('688981')).toBe('17');
  });
  it('0/3 开头 → 深 33', () => {
    expect(inferMarket('000001')).toBe('33');
    expect(inferMarket('300604')).toBe('33');
  });
  it('88 开头 → 同花顺板块指数 48', () => {
    expect(inferMarket('886100')).toBe('48');
    expect(inferMarket('885000')).toBe('48');
  });
  it('4/8 开头(北交所等)无法推断', () => {
    expect(inferMarket('830799')).toBeNull();
    expect(inferMarket('875266')).toBeNull(); // 港股/其他 → 需 --market
  });
});

describe('isBoardIndex', () => {
  it('88xxxx 板块指数为 true（不可直接买入）', () => {
    expect(isBoardIndex('881129')).toBe(true);
    expect(isBoardIndex('886100')).toBe(true);
    expect(isBoardIndex('885000')).toBe(true);
  });
  it('真实个股/普通代码为 false', () => {
    expect(isBoardIndex('600519')).toBe(false);
    expect(isBoardIndex('000725')).toBe(false);
    expect(isBoardIndex('300604')).toBe(false);
  });
  it('非 6 位代码为 false', () => {
    expect(isBoardIndex('88112')).toBe(false);
    expect(isBoardIndex('8811299')).toBe(false);
    expect(isBoardIndex('')).toBe(false);
  });
});

describe('formatKline', () => {
  it('映射 data_fields 1/7/8/9/11/13/19', () => {
    // 来自 data/日K.har 的真实首根
    const row = formatKline([1738684800000, 1127.478, 1147.271, 1124.988, 1147.271, 501616000, 18384232000]);
    expect(row).toEqual({
      date: '2025-02-05',
      open: 1127.478,
      high: 1147.271,
      low: 1124.988,
      close: 1147.271,
      volume: 501616000,
      amount: 18384232000,
    });
  });
});

describe('fmtNum', () => {
  it('亿/万/普通', () => {
    expect(fmtNum(18384232000)).toBe('183.84亿');
    expect(fmtNum(501616000)).toBe('5.02亿');
    expect(fmtNum(50161)).toBe('5.02万');
    expect(fmtNum(123)).toBe('123');
  });
  it('空值', () => {
    expect(fmtNum(null)).toBe('');
    expect(fmtNum(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('生成含表头的 CSV 并转义逗号', () => {
    const rows = [{ name: '贵州茅台', close: 1206.91 }];
    const csv = toCsv(rows, [
      { header: '名称', key: 'name' },
      { header: '收盘', key: 'close' },
    ]);
    expect(csv).toBe('名称,收盘\n贵州茅台,1206.91');
  });
});

describe('renderTable', () => {
  it('渲染 ASCII 表格', () => {
    const tbl = renderTable(
      [{ code: '600519', name: '贵州茅台' }],
      [
        { header: '代码', key: 'code' },
        { header: '名称', key: 'name' },
      ]
    );
    expect(tbl).toContain('代码');
    expect(tbl).toContain('贵州茅台');
    expect(tbl).toContain('+');
  });
  it('空数据', () => {
    expect(renderTable([], [{ header: 'x', key: 'x' }])).toBe('(空)');
  });
});
