// tests/render-output.test.js — 输出上下文 / capabilities / theme / format

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  configureRender, getRenderOptions, resetRenderOptions,
  configureOutput, getOutputOptions, resetOutputOptions,
  emit, warn, error,
} from '../lib/render/output.js';
import { detectCapabilities } from '../lib/render/capabilities.js';
import { resolveTheme } from '../lib/render/theme.js';
import {
  fmtPrice, fmtPct, fmtMoney, fmtVolume, fmtRatio,
  fmtDate, fmtDateTime, fmtAge, toneOf, toNum,
} from '../lib/render/format.js';

let tmp;

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `ths-render-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  resetRenderOptions();
  resetOutputOptions();
});

afterEach(() => {
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
});

describe('render options', () => {
  it('默认值与合并', () => {
    expect(getRenderOptions().border).toBe('ascii');
    expect(getRenderOptions().color).toBe(false);
    configureRender({ width: 100, color: true });
    expect(getRenderOptions().width).toBe(100);
    expect(getRenderOptions().color).toBe(true);
  });

  it('output 默认值', () => {
    expect(getOutputOptions().format).toBe('text');
    configureOutput({ format: 'json', out: tmp });
    expect(getOutputOptions().format).toBe('json');
  });
});

describe('emit', () => {
  it('json 写入文件且可解析', () => {
    emit({ a: 1, b: [2, 3] }, { format: 'json', out: tmp });
    expect(JSON.parse(fs.readFileSync(tmp, 'utf8'))).toEqual({ a: 1, b: [2, 3] });
  });

  it('text 行数组', () => {
    emit(['a', 'b'], { format: 'text', out: tmp });
    expect(fs.readFileSync(tmp, 'utf8')).toBe('a\nb\n');
  });

  it('csv 字符串', () => {
    emit('a,b\n1,2', { format: 'csv', out: tmp });
    expect(fs.readFileSync(tmp, 'utf8')).toBe('a,b\n1,2\n');
  });

  it('text 模式拒绝对象', () => {
    expect(() => emit({ a: 1 }, { format: 'text', out: tmp })).toThrow(/字符串或行数组/);
  });

  it('warn/error 写 stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      warn('注意');
      error('失败');
      expect(spy.mock.calls[0][0]).toContain('⚠');
      expect(spy.mock.calls[1][0]).toContain('✖');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('detectCapabilities', () => {
  const tty = { isTTY: true, columns: 120, rows: 40 };

  it('TTY + UTF-8 + 16 色', () => {
    const caps = detectCapabilities({ env: { LANG: 'zh_CN.UTF-8', TERM: 'xterm' }, stdout: tty });
    expect(caps.isTTY).toBe(true);
    expect(caps.width).toBe(120);
    expect(caps.height).toBe(40);
    expect(caps.unicode).toBe('full');
    expect(caps.colorDepth).toBe('ansi16');
  });

  it('NO_COLOR / 非 TTY → none', () => {
    expect(detectCapabilities({ env: { NO_COLOR: '1' }, stdout: tty }).colorDepth).toBe('none');
    expect(detectCapabilities({ env: { LANG: 'zh_CN.UTF-8' }, stdout: { isTTY: false } }).colorDepth).toBe('none');
  });

  it('256/truecolor 检测', () => {
    expect(detectCapabilities({ env: { TERM: 'xterm-256color' }, stdout: tty }).colorDepth).toBe('ansi256');
    expect(detectCapabilities({ env: { COLORTERM: 'truecolor' }, stdout: tty }).colorDepth).toBe('truecolor');
  });

  it('ascii / 宽度夹取', () => {
    const caps = detectCapabilities({ ascii: true, width: 500, env: {}, stdout: tty });
    expect(caps.unicode).toBe('ascii');
    expect(caps.width).toBe(200);
    expect(detectCapabilities({ width: 1, env: {}, stdout: tty }).width).toBe(40);
  });
});

describe('resolveTheme', () => {
  const caps = { colorDepth: 'ansi16', unicode: 'full', emoji: false };

  it('cn 默认红涨绿跌', () => {
    const t = resolveTheme('cn', caps);
    expect(t.sgr('up')).toBe('31');
    expect(t.sgr('down')).toBe('32');
  });

  it('intl 交换涨跌', () => {
    const t = resolveTheme('intl', caps);
    expect(t.sgr('up')).toBe('32');
    expect(t.sgr('down')).toBe('31');
  });

  it('mono/none 无色', () => {
    const none = { colorDepth: 'none', unicode: 'basic', emoji: false };
    const t = resolveTheme('mono', none);
    expect(t.sgr('up')).toBe('');
    expect(t.symbols.up).toBe('^');
  });

  it('ascii 符号回退', () => {
    const t = resolveTheme('cn', { colorDepth: 'none', unicode: 'ascii', emoji: false });
    expect(t.symbols.critical).toBe('[X]');
    expect(t.symbols.missing).toBe('-');
  });
});

describe('format', () => {
  it('价格/百分比/金额/量/比率', () => {
    expect(fmtPrice(5.7)).toBe('5.70');
    expect(fmtPrice(null)).toBe('—');
    expect(fmtPct(5.23)).toBe('+5.2%');
    expect(fmtPct(-0.8)).toBe('-0.8%');
    expect(fmtMoney(123456789)).toBe('1.23亿');
    expect(fmtMoney(-123456789)).toBe('-1.23亿');
    expect(fmtVolume(1.2e8)).toBe('1.20亿股');
    expect(fmtRatio(0.756)).toBe('0.76');
  });

  it('日期时间按北京时间', () => {
    const ts = Date.UTC(2026, 9, 18, 2, 23, 45); // 北京 10:23:45
    expect(fmtDate(ts)).toBe('2026-10-18');
    expect(fmtDateTime(ts)).toBe('2026-10-18 10:23:45');
    expect(fmtDate('2026-10-18')).toBe('2026-10-18');
  });

  it('时长/tone/数值', () => {
    expect(fmtAge(1200)).toBe('1.2s');
    expect(fmtAge(90_000)).toBe('1.5m');
    expect(toneOf(1)).toBe('up');
    expect(toneOf(-1)).toBe('down');
    expect(toneOf(0)).toBe('flat');
    expect(toNum('5.2')).toBe(5.2);
    expect(toNum('')).toBeNull();
  });
});
