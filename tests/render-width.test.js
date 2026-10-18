// tests/render-width.test.js — 终端显示宽度/裁剪/换行

import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  displayWidth,
  padEndW,
  padStartW,
  truncateW,
  wrapW,
  sliceW,
  graphemeWidth,
} from '../lib/render/width.js';

describe('displayWidth', () => {
  it('ASCII', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('')).toBe(0);
  });

  it('中文按双宽', () => {
    expect(displayWidth('贵州茅台')).toBe(8);
    expect(displayWidth('京东方A')).toBe(7);
  });

  it('ANSI 不计宽', () => {
    expect(displayWidth('\x1b[31m红\x1b[0m')).toBe(2);
    expect(stripAnsi('\x1b[1;31m贵州\x1b[0m')).toBe('贵州');
  });

  it('emoji 按 2 宽，ZWJ 组合整体 2 宽', () => {
    expect(displayWidth('🔴')).toBe(2);
    expect(displayWidth('👨‍👩‍👧')).toBe(2);
  });

  it('组合字符 0 宽', () => {
    expect(displayWidth('é')).toBe(1);
  });

  it('几何符号/块字符/盲文 1 宽', () => {
    expect(displayWidth('●▲◆✓▸')).toBe(5);
    expect(displayWidth('█▁⠿')).toBe(3);
  });

  it('graphemeWidth 单独可用', () => {
    expect(graphemeWidth('中')).toBe(2);
    expect(graphemeWidth('a')).toBe(1);
    expect(graphemeWidth('🔴')).toBe(2);
  });
});

describe('pad', () => {
  it('padEndW 按显示宽度补齐', () => {
    expect(displayWidth(padEndW('贵州', 6))).toBe(6);
    expect(padEndW('abc', 6)).toBe('abc   ');
    expect(padEndW('abcdef', 3)).toBe('abcdef');
  });

  it('padStartW 按显示宽度补齐', () => {
    expect(displayWidth(padStartW('茅台', 6))).toBe(6);
    expect(padStartW('12', 4)).toBe('  12');
  });
});

describe('truncateW', () => {
  it('ASCII 截断带省略号', () => {
    expect(truncateW('abcdef', 4)).toBe('abc…');
    expect(truncateW('abc', 4)).toBe('abc');
  });

  it('中文截断不超宽', () => {
    const out = truncateW('贵州茅台', 5);
    expect(out).toBe('贵州…');
    expect(displayWidth(out)).toBe(5);
  });

  it('宽度为 0/负数', () => {
    expect(truncateW('abc', 0)).toBe('');
    expect(truncateW('abc', -1)).toBe('');
  });

  it('省略号本身放不下时只保留省略号', () => {
    expect(truncateW('abcdef', 1)).toBe('…');
  });
});

describe('wrapW', () => {
  it('中文按宽度断行', () => {
    expect(wrapW('中文测试换行', 4)).toEqual(['中文', '测试', '换行']);
  });

  it('英文优先在空格断行', () => {
    expect(wrapW('hello world', 7)).toEqual(['hello', 'world']);
  });

  it('保留空行', () => {
    expect(wrapW('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
});

describe('sliceW', () => {
  it('按显示宽度切片', () => {
    expect(sliceW('贵州茅台', 0, 4)).toBe('贵州');
    expect(sliceW('贵州茅台', 4, 8)).toBe('茅台');
  });
});
