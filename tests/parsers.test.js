// tests/parsers.test.js — GBK HTML 解析器（sectors/rank/lhb/fundamental）
// fixture 取自真实同花顺页面（2026-08-15 抓取），非手造。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseIndustrySectors, parseConceptSectors, parseBoardMembers,
  parseZdfph, parseTechRank, parseRank,
  parseLhb,
  parseFundamental,
} from '../lib/parsers';

const fix = n => readFileSync(join(__dirname, 'fixtures', n), 'utf8');

describe('parseIndustrySectors 行业板块', () => {
  const rows = parseIndustrySectors(fix('sectors-industry.html'));
  it('解析 50 行', () => expect(rows.length).toBe(50));
  it('含板块代码 881xxx 与领涨股', () => {
    const r = rows[0];
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.rank).toBe(1);
    expect(r.name).toBeTruthy();
    expect(r.pct).toBeTypeOf('number');
    expect(r.leadName).toBeTruthy();
    expect(r.leadCode).toMatch(/^\d{6}$/);
    expect(r.up).toBeTypeOf('number');
  });
  it('净流入/成交额为数值（可为负）', () => {
    expect(rows.some(r => r.netIn != null)).toBe(true);
    expect(rows.every(r => typeof r.amount === 'number' || r.amount == null)).toBe(true);
  });
});

describe('parseConceptSectors 概念板块', () => {
  const rows = parseConceptSectors(fix('sectors-concept.html'));
  it('解析日期/概念/事件', () => {
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].name).toBeTruthy();
    expect(rows[0].event).toBeTruthy();
  });
});

describe('parseZdfph 涨跌幅排行', () => {
  const rows = parseZdfph(fix('rank-zdfph.html'));
  it('解析 50 行，含代码/名称', () => {
    expect(rows.length).toBe(50);
    expect(rows[0].code).toMatch(/^\d{6}$/);
    expect(rows[0].name).toBeTruthy();
  });
  it('当日/三日/五日涨跌幅与净流入齐备', () => {
    const r = rows[0];
    expect(r.zdf).toBeTypeOf('number');
    expect(r.zdf3).toBeTypeOf('number');
    expect(r.zdf5).toBeTypeOf('number');
    expect(r.netIn).toBeTypeOf('number'); // 元
    expect(r.netIn).toBeGreaterThan(0);
  });
});

describe('parseTechRank 技术形态选股族（动态列）', () => {
  it('cxg: 解析 50 行，含动态列', () => {
    const rows = parseTechRank(fix('rank-cxg.html'));
    expect(rows.length).toBe(50);
    const r = rows[0];
    expect(r.code).toMatch(/^\d{6}$/);
    expect(r.name).toBeTruthy();
    expect(r['涨跌幅']).toBeTypeOf('number');
    expect(r['换手率']).toBeTypeOf('number');
    // 日期保持字符串，不被 num 截成年份
    expect(r['前期高点日期']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('ljqs: 不同列布局也能正确映射', () => {
    const rows = parseTechRank(fix('rank-ljqs.html'));
    expect(rows.length).toBeGreaterThan(0);
    const r = rows[0];
    expect(r['量价齐升天数']).toBeTypeOf('number');
    expect(r['阶段涨幅（%）']).toBeTypeOf('number');
    expect(r['所属行业']).toBeTruthy();
  });
  it('parseRank 按 kind 分发', () => {
    expect(parseRank(fix('rank-zdfph.html'), 'zdfph').length).toBe(50);
    expect(parseRank(fix('rank-cxg.html'), 'cxg').length).toBe(50);
  });
});

describe('parseLhb 龙虎榜', () => {
  const rows = parseLhb(fix('lhb.html'));
  it('解析 stockcont 块', () => {
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
  it('含名称/上榜原因/营业部席位', () => {
    const r = rows.find(x => x.name && x.name !== x.code);
    expect(r).toBeTruthy();
    expect(r.reason).toBeTruthy();
    expect(r.buyDealers.length).toBeGreaterThan(0);
    expect(r.buyDealers[0].name).toBeTruthy();
    expect(r.buyDealers[0].buy).toBeTypeOf('number');
    expect(r.sellDealers.length).toBeGreaterThanOrEqual(0);
  });
});

describe('parseFundamental F10 财务摘要', () => {
  const r = parseFundamental(fix('fundamental.html'));
  it('解析报告期与诊断结论', () => {
    expect(r.reportPeriod).toMatch(/报$/);
    expect(r.verdict).toBeTruthy();
    expect(r.diagnosis).toBeTruthy();
  });
  it('解析财务指标（值+去年同期+评价）', () => {
    expect(r.items.length).toBeGreaterThan(3);
    const gm = r.items.find(i => i.name.includes('毛利率'));
    expect(gm).toBeTruthy();
    expect(gm.value).toBeCloseTo(89.76, 1);
    expect(gm.prev).toBeCloseTo(91.97, 1);
    expect(gm.comment).toBeTruthy();
    expect(r.items.every(i => !/^\d+\./.test(i.name))).toBe(true); // 序号已剥离
  });
});

describe('parseBoardMembers 板块成分', () => {
  it('空/非成分表返回 []', () => {
    expect(parseBoardMembers('<table><tr><td>a</td></tr></table>')).toEqual([]);
  });
});
