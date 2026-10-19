// tests/render-charts.test.js — sparkline / bars / line / candles / heatmap / tiles

import { describe, it, expect } from 'vitest';
import { sparkline } from '../lib/render/widgets/sparkline.js';
import { bar, renderBars } from '../lib/render/widgets/bars.js';
import { lineChart } from '../lib/render/widgets/line.js';
import { candlestickChart, resampleOHLC } from '../lib/render/widgets/candles.js';
import { heatmap } from '../lib/render/widgets/heatmap.js';
import { renderTiles } from '../lib/render/widgets/tiles.js';
import { displayWidth, stripAnsi } from '../lib/render/width.js';
import { resolveTheme } from '../lib/render/theme.js';

function bars(n = 40) {
  const out = [];
  let c = 100;
  const start = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const open = c;
    const close = c * (1 + (i % 5 === 0 ? -0.02 : 0.01));
    out.push({
      date: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      volume: 1e6 + i * 10000,
    });
    c = close;
  }
  return out;
}

const CAPS = { colorDepth: 'ansi16', unicode: 'full', emoji: false };
const THEME = resolveTheme('cn', CAPS);

describe('sparkline', () => {
  it('上升序列使用高强度块字符', () => {
    const s = sparkline([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s).toHaveLength(8);
    expect(s[0]).toBe('▁');
    expect(s[s.length - 1]).toBe('█');
  });

  it('平盘序列', () => {
    expect(sparkline([5, 5, 5])).toBe('▅▅▅');
  });

  it('width 降采样', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], { width: 4 })).toHaveLength(4);
  });

  it('ascii 模式', () => {
    const s = sparkline([1, 2, 3], { ascii: true });
    expect(s).toMatch(/^[ .:\-=+*#]{3}$/);
  });
});

describe('bars', () => {
  it('满条/空条/分数块', () => {
    expect(bar(10, 10, 10)).toBe('██████████');
    expect(bar(0, 10, 10)).toBe('░░░░░░░░░░');
    const half = bar(5, 10, 10);
    expect(half).toContain('█');
    expect(half).toContain('░');
    expect(displayWidth(half)).toBe(10);
  });

  it('renderBars 行宽与颜色', () => {
    const out = renderBars([
      { label: '看多', value: 68, max: 100, note: 'n=25' },
      { label: '看空', value: 27, max: 100, note: 'n=22' },
    ], { width: 60, color: true, theme: THEME });
    expect(out).toContain('看多');
    expect(out).toContain('n=25');
    expect(out).toContain('\x1b[');
    const plain = renderBars([
      { label: '看多', value: 68, max: 100, note: 'n=25' },
      { label: '看空', value: 27, max: 100, note: 'n=22' },
    ], { width: 60 });
    expect(stripAnsi(out)).toBe(plain);
  });
});

describe('lineChart', () => {
  it('Braille 线图有内容且不超宽', () => {
    const values = Array.from({ length: 50 }, (_, i) => 1 + Math.sin(i / 5) * 0.1);
    const out = lineChart(values, { width: 60, height: 8, color: false });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(9);
    expect(out).toMatch(/[⠁-⣿]/);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });

  it('ASCII 退化', () => {
    const out = lineChart([1, 2, 3, 4], { width: 40, height: 5, ascii: true });
    expect(out).toContain('*');
    expect(out).toContain('└');
  });

  it('颜色开/关可见文本一致', () => {
    const v = [1, 2, 1.5, 3, 2.5];
    const plain = lineChart(v, { width: 40, height: 5 });
    const colored = lineChart(v, { width: 40, height: 5, color: true, theme: THEME, tone: 'up' });
    expect(colored).toContain('\x1b[');
    expect(stripAnsi(colored)).toBe(plain);
  });
});

describe('candlestickChart', () => {
  it('渲染 K 线/量/M A 且不超宽', () => {
    const out = candlestickChart(bars(40), { width: 70, height: 10, volumeHeight: 2 });
    expect(out).toContain('│');
    expect(out).toContain('█');
    expect(out).toContain('MA5');
    expect(out).toContain('量');
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(70);
  });

  it('数据过多时聚合到绘图宽度', () => {
    const d = bars(300);
    const out = candlestickChart(d, { width: 60, height: 8, volumeHeight: 0 });
    expect(out).toBeTruthy();
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(60);
  });

  it('resampleOHLC 聚合规则', () => {
    const d = bars(10);
    const r = resampleOHLC(d, 2);
    expect(r).toHaveLength(2);
    expect(r[0].open).toBe(d[0].open);
    expect(r[0].close).toBe(d[4].close);
    expect(r[0].high).toBe(Math.max(...d.slice(0, 5).map(b => b.high)));
    expect(r[0].low).toBe(Math.min(...d.slice(0, 5).map(b => b.low)));
    expect(r[0].volume).toBe(d.slice(0, 5).reduce((s, b) => s + b.volume, 0));
  });

  it('空数据', () => {
    expect(candlestickChart([], {})).toBe('(无K线数据)');
  });
});

describe('heatmap', () => {
  const labels = ['000725', '000100', '002185'];
  const m = [
    [1, 0.75, -0.2],
    [0.75, 1, 0.1],
    [-0.2, 0.1, 1],
  ];

  it('数值矩阵', () => {
    const out = heatmap(labels, m, { width: 80 });
    expect(out).toContain('000725');
    expect(out).toContain('0.75');
    expect(out).toContain('图例');
  });

  it('颜色开/关可见文本一致', () => {
    const plain = heatmap(labels, m, { width: 80 });
    const colored = heatmap(labels, m, { width: 80, color: true, theme: THEME });
    expect(colored).toContain('\x1b[');
    expect(stripAnsi(colored)).toBe(plain);
  });
});

describe('tiles', () => {
  it('指标卡对齐且不超宽', () => {
    const out = renderTiles([
      { label: '总收益', value: '+63.9%', tone: 'up', spark: '▁▂▃▅▆▇█' },
      { label: '最大回撤', value: '-18.2%', tone: 'down' },
    ], { width: 80 });
    expect(out).toContain('总收益');
    expect(out).toContain('+63.9%');
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('4 张卡片按行分组，不交错边框', () => {
    const out = renderTiles([
      { label: 'A', value: '1' },
      { label: 'B', value: '2' },
      { label: 'C', value: '3' },
      { label: 'D', value: '4' },
    ], { width: 80, border: 'ascii' });
    const lines = out.split('\n');
    // 第一组的上下边框必须连续出现，第三行才是 C/D 的顶边
    expect(lines[0]).toContain('A');
    expect(lines[1]).toContain('1');
    expect(lines[2]).toMatch(/^\+-+\+\s+\+-+\+$/);
    expect(lines[3]).toContain('C');
    expect(lines[4]).toContain('3');
    expect(lines[5]).toMatch(/^\+-+\+\s+\+-+\+$/);
  });
});
