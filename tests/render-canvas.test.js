// tests/render-canvas.test.js — Canvas 绘制 / 宽字符 / diff / 颜色

import { describe, it, expect } from 'vitest';
import { Canvas } from '../lib/render/canvas.js';
import { displayWidth, stripAnsi } from '../lib/render/width.js';

describe('Canvas', () => {
  it('文本写入与行宽', () => {
    const c = new Canvas(10, 3);
    c.text(0, 0, '贵州茅台');
    const lines = c.toText();
    expect(lines).toHaveLength(3);
    expect(lines[0].startsWith('贵州茅台')).toBe(true);
    expect(displayWidth(lines[0])).toBe(10);
  });

  it('宽字符占两格，超出右边界退化为空格', () => {
    const c = new Canvas(3, 1);
    c.set(2, 0, '中');
    expect(c.toText()[0]).toBe('   ');
    expect(displayWidth(c.toText()[0])).toBe(3);
  });

  it('覆盖宽字符时清理另一半', () => {
    const c = new Canvas(4, 1);
    c.set(0, 0, '中');
    c.set(1, 0, 'x');
    expect(c.toText()[0].startsWith(' x')).toBe(true);
  });

  it('组合字符附着到前一个单元格', () => {
    const c = new Canvas(4, 1);
    c.set(0, 0, 'e');
    c.set(1, 0, '́');
    expect(c.toText()[0].startsWith('é')).toBe(true);
  });

  it('控制字符替换为空格，防止终端注入', () => {
    const c = new Canvas(4, 1);
    c.set(0, 0, '\x1b');
    c.set(1, 0, '\n');
    expect(c.toText()[0]).toBe('    ');
    expect(c.toString(true).join('\n')).not.toContain('\x1b');
  });

  it('box 边框与标题', () => {
    const c = new Canvas(20, 5);
    const content = c.box({ x: 0, y: 0, w: 20, h: 5, title: '告警', border: 'round' });
    const lines = c.toText();
    expect(lines[0]).toContain('╭');
    expect(lines[0]).toContain('告警');
    expect(lines[4]).toContain('╯');
    expect(content).toEqual({ x: 1, y: 1, width: 18, height: 3 });
  });

  it('ASCII 边框', () => {
    const c = new Canvas(10, 3);
    c.box({ x: 0, y: 0, w: 10, h: 3, border: 'ascii' });
    expect(c.toText()[0]).toBe('+--------+');
  });

  it('颜色开/关可见文本一致', () => {
    const c = new Canvas(6, 1);
    c.text(0, 0, '红', '31');
    c.text(2, 0, 'OK');
    const colored = c.toString(true);
    const plain = c.toString(false);
    expect(colored.join('\n')).toContain('\x1b[31m');
    expect(stripAnsi(colored.join('\n'))).toBe(plain.join('\n'));
    expect(displayWidth(colored.join('\n'))).toBe(6);
  });

  it('diff：无变化返回空串，变化行带光标定位', () => {
    const a = new Canvas(8, 2);
    a.text(0, 0, 'hello');
    const b = new Canvas(8, 2);
    b.text(0, 0, 'hello');
    expect(b.diff(a, false)).toBe('');
    b.text(0, 1, 'world');
    const d = b.diff(a, false);
    expect(d).toContain('\x1b[2;1H');
    expect(d).toContain('world');
  });

  it('尺寸变化时全量重绘', () => {
    const a = new Canvas(4, 1);
    const b = new Canvas(5, 1);
    expect(b.diff(a, false)).toContain('\x1b[2J');
  });

  it('越界写入不抛错', () => {
    const c = new Canvas(3, 2);
    expect(() => c.set(-1, 0, 'x')).not.toThrow();
    expect(() => c.set(99, 99, 'x')).not.toThrow();
    expect(() => c.text(2, 1, 'abcdef')).not.toThrow();
  });
});
