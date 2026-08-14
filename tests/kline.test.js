// tests/kline.test.js — 用真实抓包 fixture 验证 K 线解析链路
// fixture 由 data/日K.har 提取（已提交仓库，避免测试依赖 gitignore 的抓包样本）

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatKline } from '../lib/commands/helpers.js';
import { parseKlineArgs } from '../lib/commands/kline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', '日K-quote.json');

// 读取已提交的 quote_data[0] fixture（模拟油猴脚本返回的结构）
function loadKlineFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

describe('K 线解析链路（真实 HAR fixture）', () => {
  const qd = loadKlineFixture();

  it('quote_data 结构正确', () => {
    expect(qd.code).toBe('886100');
    expect(qd.market).toBe('48');
    expect(qd.delay).toBe(false);
    expect(qd.data_fields).toEqual(['1', '7', '8', '9', '11', '13', '19']);
  });

  it('条数与真实抓包一致（374 根）', () => {
    expect(qd.value.length).toBe(374);
  });

  it('首根映射为 OHLCV', () => {
    const row = formatKline(qd.value[0]);
    expect(row.date).toBe('2025-02-05');
    expect(row.open).toBeCloseTo(1127.478, 3);
    expect(row.close).toBeCloseTo(1147.271, 3);
    expect(row.amount).toBe(18384232000);
  });

  it('末根是最新交易日', () => {
    const last = formatKline(qd.value[qd.value.length - 1]);
    // 末根 ts 1786636800000 = 2026-08-14（抓包当日）
    expect(last.date).toBe('2026-08-14');
  });

  it('每根都是 7 个字段', () => {
    qd.value.forEach(v => expect(v.length).toBe(7));
  });

  it('时间戳严格递增（按时间排序）', () => {
    for (let i = 1; i < qd.value.length; i++) {
      expect(qd.value[i][0]).toBeGreaterThan(qd.value[i - 1][0]);
    }
  });
});

describe('parseKlineArgs', () => {
  it('默认值：day/250/forward，自动推断市场码', () => {
    expect(parseKlineArgs(['600519'])).toEqual({ code: '600519', market: '17', period: 'day_1', count: 250, adjust: 'forward' });
    expect(parseKlineArgs(['886100']).market).toBe('48'); // 88 开头 → 板块指数
  });

  it('显式参数覆盖默认', () => {
    expect(parseKlineArgs(['000001', '--period', 'week', '--count', '52', '--market', '33']))
      .toEqual({ code: '000001', market: '33', period: 'week_1', count: 52, adjust: 'forward' });
  });

  it('缺 code / 未知周期抛错', () => {
    expect(() => parseKlineArgs([])).toThrow(/用法/);
    expect(() => parseKlineArgs(['600519', '--period', 'year'])).toThrow(/未知周期/);
  });
});
