// tests/quote-trend.test.js — 实时行情/分时/成交额解析（真实抓包 fixture）

import { describe, it, expect } from 'vitest';
import { formatQuote, formatQuotes, formatTrend, formatTurnover, fmtTime, QUOTE_FIELDS } from '../lib/commands/helpers.js';

describe('QUOTE_FIELDS 映射', () => {
  it('关键字段码', () => {
    expect(QUOTE_FIELDS['6']).toBe('prevClose');
    expect(QUOTE_FIELDS['10']).toBe('price');
    expect(QUOTE_FIELDS['13']).toBe('volume');      // 成交量(股)
    expect(QUOTE_FIELDS['19']).toBe('amount');
    expect(QUOTE_FIELDS['69']).toBe('limitUp');
    expect(QUOTE_FIELDS['3153']).toBe('pe');
    expect(QUOTE_FIELDS['592920']).toBe('pb');
    expect(QUOTE_FIELDS['3475914']).toBe('totalMv');
    expect(QUOTE_FIELDS['1968584']).toBe('turnoverRate');
    expect(QUOTE_FIELDS['1771976']).toBe('volumeRatio');
    expect(QUOTE_FIELDS['199112']).toBe('pct');
    expect(QUOTE_FIELDS['264648']).toBe('change');
  });
});

describe('formatQuote（真实 multi_last_snapshot 响应）', () => {
  const qd = {
    market: '17',
    code: '600519',
    data_fields: ['13', '6', '7', '18', '8', '19', '9', '264648', '199112', '10'],
    value: [[2921860, 1355.29, 1355.0, 23211, 1359.0, 3938909600.0, 1338.14, -12.88, -0.9504, 1342.41]],
  };

  it('按 data_fields 位置映射', () => {
    const q = formatQuote(qd);
    expect(q.code).toBe('600519');
    expect(q.market).toBe('17');
    expect(q.price).toBe(1342.41);      // 10 最新价
    expect(q.open).toBe(1355.0);        // 7 开盘
    expect(q.high).toBe(1359.0);        // 8 最高
    expect(q.low).toBe(1338.14);        // 9 最低
    expect(q.prevClose).toBe(1355.29);  // 6 昨收
    // 自洽性：涨跌额 = 最新价 - 昨收；涨跌幅 = 涨跌额 / 昨收
    expect(q.change).toBeCloseTo(q.price - q.prevClose, 2);
    expect(q.pct).toBeCloseTo((q.price / q.prevClose - 1) * 100, 3);
    expect(q.volume).toBe(2921860);     // 13 成交量(股)
    expect(q.amount).toBe(3938909600);  // 19 成交额
    expect(q.change).toBe(-12.88);      // 264648 涨跌额
    expect(q.pct).toBe(-0.9504);        // 199112 涨跌幅
  });

  it('扩展字段（换手/量比/PE/PB/市值/涨跌停）映射', () => {
    const qd2 = {
      code: '600519', market: '17',
      data_fields: ['10', '3153', '592920', '3475914', '3541450', '1968584', '1771976', '69', '70'],
      value: [[1355.29, 20.28, 6.2, 1677597000000, 1677597000000, 0.2388, 0.82, 1490.82, 1219.76]],
    };
    const q = formatQuote(qd2);
    expect(q.price).toBe(1355.29);
    expect(q.pe).toBe(20.28);
    expect(q.pb).toBe(6.2);
    expect(q.totalMv).toBe(1677597000000);
    expect(q.floatMv).toBe(1677597000000);
    expect(q.turnoverRate).toBe(0.2388);
    expect(q.volumeRatio).toBe(0.82);
    expect(q.limitUp).toBe(1490.82);
    expect(q.limitDown).toBe(1219.76);
  });

  it('formatQuotes 批量解析过滤空行', () => {
    const list = [qd, null, { code: 'x', data_fields: ['6'], value: [] }];
    const rows = formatQuotes(list);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('600519');
  });

  it('缺 data_fields/value 返回 null', () => {
    expect(formatQuote(null)).toBeNull();
    expect(formatQuote({ code: 'x' })).toBeNull();
  });
});

describe('formatTrend（真实 single_trend 响应）', () => {
  const qd = {
    market: '17',
    code: '600519',
    base_price: 1355.29,
    data_fields: ['1', '10', '13', '19'],
    value: [
      [1786671000000, 1355, 22667, 30713785],
      [1786671060000, 1353.27, 117200, 158617950],
    ],
  };

  it('映射为 [时间, 价, 量, 额]', () => {
    const rows = formatTrend(qd);
    expect(rows.length).toBe(2);
    expect(rows[0].price).toBe(1355);
    expect(rows[0].volume).toBe(22667);
    expect(rows[0].amount).toBe(30713785);
    expect(rows[1].price).toBe(1353.27);
    expect(rows[1].time).toBe(fmtTime(1786671060000));
  });

  it('空 value 返回空数组', () => {
    expect(formatTrend({ data_fields: ['1'], value: [] })).toEqual([]);
    expect(formatTrend(null)).toEqual([]);
  });
});

describe('formatTurnover（真实 dq get_chart_data 响应）', () => {
  const charts = {
    total: 241,
    name: '市场成交额分时',
    header: [
      { val: 2131256900000, name: '当日成交额', key: 'turnover' },
      { val: 2567977000000, name: '昨日成交额', key: 'turnover_pre' },
      { val: -410665800000, name: '较昨日变动', key: 'turnover_change' },
    ],
    point_list: [[1779292800000, 3507273600000, 0], [1779379200000, 2924655100000, 0]],
  };

  it('解析 header 与 points', () => {
    const t = formatTurnover(charts);
    expect(t.name).toBe('市场成交额分时');
    expect(t.header.turnover.value).toBe(2131256900000);
    expect(t.header.turnover.name).toBe('当日成交额');
    expect(t.points).toHaveLength(2);
    expect(t.points[0].ts).toBe(1779292800000);
    expect(t.points[0].value).toBe(3507273600000);
  });

  it('null 返回 null', () => {
    expect(formatTurnover(null)).toBeNull();
  });
});

describe('fmtTime', () => {
  it('毫秒时间戳 → HH:MM', () => {
    // 1786671060000 = 2026-08-13 09:31:00 (UTC+8 视为本地时区，值可能有偏差)
    const out = fmtTime(1786671060000);
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
  it('null → -', () => {
    expect(fmtTime(null)).toBe('-');
  });
});

describe('turnover.fillAverage', () => {
  it('接口平均值为 0 时用最近 60 点计算', async () => {
    const { fillAverage } = await import('../lib/commands/turnover.js');
    const points = Array.from({ length: 70 }, (_, i) => ({ ts: i, value: (i + 1) * 1e8 }));
    const parsed = {
      name: 'x',
      header: { average_turnover: { name: '近60日平均成交额', value: 0 } },
      points,
    };
    fillAverage(parsed);
    // 最近 60 点 = 11..70（单位 1e8）→ 平均 40.5e8
    expect(parsed.header.average_turnover.value).toBe(4050000000);
  });

  it('接口已有正值时保留', async () => {
    const { fillAverage } = await import('../lib/commands/turnover.js');
    const parsed = { header: { average_turnover: { value: 123 } }, points: [{ value: 1 }] };
    expect(fillAverage(parsed).header.average_turnover.value).toBe(123);
  });
});

describe('turnover.fillAverage 分时', () => {
  it('分时周期不把分钟合计误当日均（隐藏 0 值字段）', async () => {
    const { fillAverage } = await import('../lib/commands/turnover.js');
    const parsed = {
      header: {
        turnover: { name: '当日成交额', value: 1 },
        average_turnover: { name: '近60日平均成交额', value: 0 },
      },
      points: [{ value: 1e8 }],
    };
    fillAverage(parsed, 'minute');
    expect(parsed.header.average_turnover).toBeUndefined();
    expect(parsed.header.turnover.value).toBe(1);
  });
});
