// tests/render-table.test.js — 响应式表格 / CJK 对齐 / 宽度约束 / 颜色

import { describe, it, expect } from 'vitest';
import { renderTable } from '../lib/render/table.js';
import { displayWidth, stripAnsi } from '../lib/render/width.js';
import { resolveTheme } from '../lib/render/theme.js';

const ROWS = [
  { code: '000725', name: '京东方A', price: 5.79, pct: 0.52 },
  { code: '002185', name: '华天科技', price: 16.05, pct: 1.0 },
  { code: '881129', name: '通信设备', price: 9509.8, pct: 0.7 },
];

const COLS = [
  { header: '代码', key: 'code' },
  { header: '名称', key: 'name' },
  { header: '现价', key: 'price', align: 'r' },
  { header: '涨跌%', key: 'pct', align: 'r' },
];

describe('renderTable', () => {
  it('空数据', () => {
    expect(renderTable([], COLS)).toBe('(空)');
  });

  it('保持旧 API：ASCII 边框 + 内容', () => {
    const t = renderTable(ROWS, COLS);
    expect(t).toContain('+');
    expect(t).toContain('京东方A');
    expect(t).toContain('002185');
    expect(t).toContain('16.05');
  });

  it('中文表格每行显示宽度一致（CJK 对齐）', () => {
    const lines = renderTable(ROWS, COLS).split('\n');
    const widths = new Set(lines.map(displayWidth));
    expect(widths.size).toBe(1);
  });

  it('fmt 与右对齐', () => {
    const t = renderTable(ROWS, [
      { header: '名称', key: 'name' },
      { header: '现价', key: 'price', align: 'r', fmt: v => Number(v).toFixed(2) },
    ]);
    expect(t).toContain('5.79');
    expect(t).toContain('9509.80');
  });

  it('width 约束：所有行不超过目标宽度', () => {
    for (const w of [40, 60, 80, 120]) {
      const lines = renderTable(ROWS, COLS, { width: w, border: 'round' }).split('\n');
      for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(w);
    }
  });

  it('priority 列在窄宽度下被隐藏', () => {
    const cols = [
      { header: '代码', key: 'code', priority: 0 },
      { header: '名称', key: 'name', priority: 0 },
      { header: '换手率', key: 'turnover', priority: 1 },
      { header: '市盈率', key: 'pe', priority: 1 },
      { header: '备注', key: 'note', priority: 2 },
    ];
    const rows = [{
      code: '600519', name: '贵州茅台', turnover: '2.35%', pe: '31.2',
      note: '这是一段很长很长的备注文本，窄屏下应该被隐藏',
    }];
    const wide = renderTable(rows, cols, { width: 120 });
    const narrow = renderTable(rows, cols, { width: 60 });
    expect(wide).toContain('备注');
    expect(narrow).not.toContain('备注');
    expect(narrow).toContain('600519');
  });

  it('圆角边框', () => {
    const t = renderTable(ROWS, COLS, { border: 'round' });
    expect(t).toContain('╭');
    expect(t).toContain('╯');
  });

  it('compact 边框含表头分隔线', () => {
    const t = renderTable(ROWS, COLS, { border: 'compact' });
    expect(t).toContain('─');
    expect(t).not.toContain('╭');
  });

  it('颜色关闭/开启的可见文本一致', () => {
    const caps = { colorDepth: 'ansi16', unicode: 'full', emoji: false };
    const theme = resolveTheme('cn', caps);
    const plain = renderTable(ROWS, COLS, { border: 'round' });
    const colored = renderTable(ROWS, COLS, { border: 'round', color: true, theme });
    expect(colored).toContain('\x1b[');
    expect(stripAnsi(colored)).toBe(plain);
  });

  it('maxRows 截断并提示', () => {
    const t = renderTable(ROWS, COLS, { maxRows: 1 });
    expect(t).toContain('还有 2 行');
  });

  it('窄于 60 列自动切堆叠模式', () => {
    const cols = [
      { header: '代码', key: 'code' },
      { header: '名称', key: 'name' },
      { header: '现价', key: 'price' },
      { header: '涨跌%', key: 'pct' },
      { header: '量比', key: 'vr' },
    ];
    const rows = [{ code: '000725', name: '京东方A', price: 5.79, pct: 0.52, vr: 2.63 }];
    const t = renderTable(rows, cols, { width: 50 });
    expect(t).toContain('000725');
    expect(t).toContain('现价: 5.79');
    for (const line of t.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(50);
  });
});
