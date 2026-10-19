// tests/market-fundflow.test.js — 大盘情绪 / 资金流（纯函数 + 命令层集成）
import { describe, it, expect, vi } from 'vitest';
import { parseCnMoney } from '../lib/commands/fundflow.js';
import cmdFundflow from '../lib/commands/fundflow.js';
import cmdMarket from '../lib/commands/market.js';
import { parseRealheadJsonp, snapshotFromItems, parseFundflow } from '../lib/parsers/index.js';

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

function mockCtx(value, kind) {
  const ctx = {
    loggedCall: vi.fn(async () => value),
    audit: { startOperation() {}, endOperation() {} },
    config: {},
    cache: { watchlistList: () => [] },
  };
  // 命令优先使用注入的直连数据，避免单测触发真实网络
  if (kind === 'market') ctx.marketData = value;
  if (kind === 'fundflow') ctx.fundflowData = value;
  return ctx;
}

describe('market 命令层（真实数据形状）', () => {
  it('渲染指数表 + 市场温度', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(s));
    try {
      const ret = await cmdMarket(mockCtx(marketFixture, 'market'), []);
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
    const ret = await cmdMarket(mockCtx(marketFixture, 'market'), ['--json']);
    expect(ret.indices).toHaveLength(3);
    expect(ret.market.totalUp).toBe(2353 + 2934);
    expect(ret.market.totalDown).toBe(1012 + 1338);
    expect(ret.market.mood).toContain('普涨');
    // 创业板是深市子集，成交额不能把 399006 再算一次
    expect(ret.market.totalAmount).toBe(990371920000 + 1152471300000);
  });
});

describe('fundflow 命令层（真实数据形状）', () => {
  it('渲染资金流排行', async () => {
    const logs = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(s => logs.push(s));
    try {
      const ret = await cmdFundflow(mockCtx(fundflowFixture, 'fundflow'), ['--top', '5']);
      expect(ret).toBeUndefined();
      const out = logs.join('\n');
      expect(out).toContain('敏芯股份');
      expect(out).toContain('1.35亿');
      expect(out).toContain('资金流排行');
    } finally { spy.mockRestore(); }
  });

  it('--codes 筛选', async () => {
    const ret = await cmdFundflow(mockCtx(fundflowFixture, 'fundflow'), ['--codes', '300017', '--json']);
    expect(ret.rows).toHaveLength(1);
    expect(ret.rows[0].code).toBe('300017');
    expect(ret.rows[0].net).toBe(18.14e8);
  });

  it('默认按主力净额降序（页面原始顺序是按涨幅）', async () => {
    const ret = await cmdFundflow(mockCtx(fundflowFixture, 'fundflow'), ['--top', '3', '--json']);
    expect(ret.rows.map(r => r.code)).toEqual(['300017', '688286', '688485']);
    expect(ret.rows[0].net).toBe(18.14e8);
  });

  it('筛选不到时报错', async () => {
    await expect(cmdFundflow(mockCtx(fundflowFixture, 'fundflow'), ['--codes', '999999']))
      .rejects.toThrow(/未找到/);
  });
});

describe('realhead JSONP 解析（Node 直连路径）', () => {
  const jsonp = 'quotebridge_v2_realhead_hs_1A0001_last({"items":{'
    + '"5":"1A0001","6":"3716.28","7":"3694.12","8":"3714.03","9":"3692.29","10":"3704.53",'
    + '"264648":"-11.75","199112":"-0.32",'
    + '"19":"111732336000.00","37":"2359","38":"781","39":"1477",'
    + '"name":"\\u4e0a\\u8bc1\\u6307\\u6570","updateTime":"2026-10-19 09:40"}})';

  it('抽出 items 并映射成快照（6昨收/7开/8高/9低/10最新）', () => {
    const items = parseRealheadJsonp(jsonp);
    expect(items.name).toBe('上证指数');
    const s = snapshotFromItems('hs_1A0001', items);
    expect(s).toMatchObject({
      code: '1A0001', name: '上证指数',
      price: '3704.53', prevClose: '3716.28', open: '3694.12',
      high: '3714.03', low: '3692.29', change: '-11.75', pct: '-0.32',
      amount: '111732336000.00', upCount: '2359', downCount: '781', flatCount: '1477',
      updateTime: '2026-10-19 09:40',
    });
  });

  it('非 JSONP 文本抛错', () => {
    expect(() => parseRealheadJsonp('<html>bad</html>')).toThrow(/JSONP/);
  });
});

describe('资金流 HTML 解析（Node 直连路径）', () => {
  const html = `<html><body><table class="m-table">
    <tr><th>序号</th><th>股票代码</th><th>股票简称</th><th>最新价</th><th>涨跌幅</th>
    <th>换手率</th><th>流入资金(元)</th><th>流出资金(元)</th><th>净额(元)</th><th>成交额(元)</th><th>大单流入(元)</th></tr>
    <tr><td>1</td><td><a href="https://stockpage.10jqka.com.cn/600869/">600869</a></td><td>远东股份</td>
    <td>18.61</td><td>10.01%</td><td>5.23%</td><td>2.56亿</td><td>3.37亿</td><td>-8133.13万</td><td>5.93亿</td><td>1.30亿</td></tr>
    <tr><td>2</td><td>300852</td><td>四会富仕</td>
    <td>72.43</td><td>12.96%</td><td>5.23%</td><td>2.56亿</td><td>3.37亿</td><td>785.30万</td><td>5.93亿</td><td>1.30亿</td></tr>
  </table></body></html>`;

  it('解析表头与数据行', () => {
    const { headers, rows } = parseFundflow(html);
    expect(headers[0]).toBe('序号');
    expect(headers[8]).toBe('净额(元)');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      code: '600869', name: '远东股份', price: '18.61', pct: '10.01%', net: '-8133.13万',
    });
  });

  it('空表格返回空结果', () => {
    expect(parseFundflow('<html></html>')).toEqual({ headers: [], rows: [] });
  });
});
