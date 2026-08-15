// tests/market-fundflow.test.js — 大盘情绪 / 资金流（纯函数 + 命令层集成）
import { describe, it, expect, vi } from 'vitest';
import { parseCnMoney } from '../lib/commands/fundflow.js';
import cmdFundflow from '../lib/commands/fundflow.js';
import cmdMarket from '../lib/commands/market.js';

describe('parseCnMoney 中文金额解析', () => {
  it('亿/万/元 单位', () => {
    expect(parseCnMoney('3.75亿')).toBe(3.75e8);
    expect(parseCnMoney('4216.13万')).toBe(4216.13e4);
    expect(parseCnMoney('0.00')).toBe(0);
    expect(parseCnMoney('1.68')).toBe(1.68);
  });

  it('负数', () => {
    expect(parseCnMoney('-2.86亿')).toBe(-2.86e8);
  });

  it('非法/空值返回 null', () => {
    expect(parseCnMoney(null)).toBeNull();
    expect(parseCnMoney('--')).toBeNull();
    expect(parseCnMoney('abc')).toBeNull();
    expect(parseCnMoney('')).toBeNull();
  });
});

// 真实探测数据（2026-08-15 从 d.10jqka.com.cn realhead 与 data.10jqka.com.cn 资金流页抓取）
const marketFixture = [
  { code: '1A0001', name: '上证指数', price: '3930.02', prevClose: '3903.70', open: '3932.64', high: '3927.18', amount: '990371920000.00', upCount: '2353', downCount: '1012', flatCount: '1254', updateTime: '2026-08-15 13:34:27' },
  { code: '399001', name: '深证成指', price: '14335.41', prevClose: '14203.99', amount: '1152471300000.00', upCount: '2934', downCount: '1338', flatCount: '1499', updateTime: '2026-08-15 13:34:27' },
  { code: '399006', name: '创业板指', price: '3610.19', prevClose: '3578.61', amount: '556471150000.00', upCount: '1402', downCount: '753', flatCount: '612', updateTime: '2026-08-15 13:34:27' },
];

const fundflowFixture = {
  headers: ['序号', '股票代码', '股票简称', '最新价', '涨跌幅', '换手率', '流入资金(元)', '流出资金(元)', '净额(元)', '成交额(元)', '大单流入(元)'],
  rows: [
    { rank: '1', code: '688286', name: '敏芯股份', price: '53.56', pct: '20.01%', turnoverRate: '15.57%', inflow: '3.75亿', outflow: '2.40亿', net: '1.35亿', amount: '6.15亿', bigIn: '1.68亿' },
    { rank: '2', code: '688485', name: '九州一轨', price: '72.10', pct: '20.01%', turnoverRate: '11.89%', inflow: '6.60亿', outflow: '6.18亿', net: '4216.13万', amount: '12.79亿', bigIn: '4.34亿' },
    { rank: '3', code: '300017', name: '网宿科技', price: '17.33', pct: '20.01%', turnoverRate: '20.30%', inflow: '47.38亿', outflow: '29.24亿', net: '18.14亿', amount: '76.62亿', bigIn: '30.67亿' },
  ],
};

function mockCtx(value) {
  return {
    loggedCall: vi.fn(async () => value),
    audit: { startOperation() {}, endOperation() {} },
    config: {},
    cache: { watchlistList: () => [] },
  };
}

describe('market 命令层（真实数据形状）', () => {
  it('渲染指数表 + 市场温度', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(s));
    try {
      const ret = await cmdMarket(mockCtx(marketFixture), []);
      expect(ret).toBeUndefined();
      const out = logs.join('\n');
      expect(out).toContain('上证指数');
      expect(out).toContain('深证成指');
      expect(out).toContain('创业板指');
      expect(out).toMatch(/市场温度: 涨 \d+ \/ 跌 \d+/);
      expect(out).toMatch(/两市成交额/);
    } finally { spy.mockRestore(); }
  });

  it('--json 返回结构化数据（含涨跌家数与情绪）', async () => {
    const ret = await cmdMarket(mockCtx(marketFixture), ['--json']);
    expect(ret.indices).toHaveLength(3);
    expect(ret.market.totalUp).toBe(2353 + 2934);
    expect(ret.market.totalDown).toBe(1012 + 1338);
    expect(ret.market.mood).toContain('普涨');
  });
});

describe('fundflow 命令层（真实数据形状）', () => {
  it('渲染资金流排行', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(s));
    try {
      const ret = await cmdFundflow(mockCtx(fundflowFixture), ['--top', '5']);
      expect(ret).toBeUndefined();
      const out = logs.join('\n');
      expect(out).toContain('敏芯股份');
      expect(out).toContain('1.35亿');
      expect(out).toContain('资金流排行');
    } finally { spy.mockRestore(); }
  });

  it('--codes 筛选', async () => {
    const ret = await cmdFundflow(mockCtx(fundflowFixture), ['--codes', '300017', '--json']);
    expect(ret.rows).toHaveLength(1);
    expect(ret.rows[0].code).toBe('300017');
    expect(ret.rows[0].net).toBe(18.14e8);
  });

  it('筛选不到时报错', async () => {
    await expect(cmdFundflow(mockCtx(fundflowFixture), ['--codes', '999999']))
      .rejects.toThrow(/未找到/);
  });
});
