// tests/trading-hours.test.js — 交易时段判定（注入 nowMs，与时区无关）

import { describe, it, expect } from 'vitest';
import { toBeijingClock, marketPhase, shouldPoll } from '../lib/trading-hours.js';

// 把某北京日期 + 钟面时刻转成真实毫秒（UTC+8 反推），测试据此注入
function bj(day, hm) {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 8 * 3600 * 1000;
}

// 已知星期：2026-09-03 周四 / 09-04 周五 / 09-05 周六 / 09-06 周日 / 09-07 周一
describe('toBeijingClock', () => {
  it('输出北京日期与累计分钟', () => {
    const c = toBeijingClock(bj('2026-09-03', '09:30'));
    expect(c.dateStr).toBe('2026-09-03');
    expect(c.minutes).toBe(9 * 60 + 30);
    expect(c.wd).toBe(4); // 周四
  });

  it('深夜北京 00:00 对应 UTC 前一日 16:00，但 dateStr 仍是北京当天', () => {
    const c = toBeijingClock(bj('2026-09-03', '00:00'));
    expect(c.dateStr).toBe('2026-09-03');
    expect(c.minutes).toBe(0);
  });
});

describe('marketPhase 边界（工作日 09-03 周四）', () => {
  const cases = [
    ['00:00', 'pre'],
    ['09:14', 'pre'],
    ['09:15', 'auction'],
    ['09:25', 'auction'],
    ['09:26', 'auction'],   // 竞价结束~开盘间隙仍属 auction（记状态不告警）
    ['09:29', 'auction'],
    ['09:30', 'am'],
    ['11:29', 'am'],
    ['11:30', 'lunch'],
    ['11:31', 'lunch'],
    ['12:59', 'lunch'],
    ['13:00', 'pm'],
    ['14:57', 'pm'],
    ['14:59', 'pm'],
    ['15:00', 'post'],
    ['15:05', 'post'],
    ['23:59', 'post'],
  ];
  for (const [hm, expected] of cases) {
    it(`${hm} → ${expected}`, () => {
      expect(marketPhase(bj('2026-09-03', hm)).phase).toBe(expected);
    });
  }

  it('inSession 仅 am/pm', () => {
    expect(marketPhase(bj('2026-09-03', '10:00')).inSession).toBe(true);
    expect(marketPhase(bj('2026-09-03', '14:00')).inSession).toBe(true);
    expect(marketPhase(bj('2026-09-03', '09:20')).inSession).toBe(false); // auction
    expect(marketPhase(bj('2026-09-03', '12:00')).inSession).toBe(false); // lunch
    expect(marketPhase(bj('2026-09-03', '15:30')).inSession).toBe(false); // post
    expect(marketPhase(bj('2026-09-03', '08:00')).inSession).toBe(false); // pre
  });

  it('label 为中文且 phase 映射一致', () => {
    const p = marketPhase(bj('2026-09-03', '10:30'));
    expect(p.label).toBe('上午盘中');
    expect(p.inSession).toBe(true);
  });
});

describe('marketPhase 周末', () => {
  it('周六整天 weekend（含 10:00）', () => {
    expect(marketPhase(bj('2026-09-05', '10:00')).phase).toBe('weekend');
  });
  it('周日整天 weekend', () => {
    expect(marketPhase(bj('2026-09-06', '09:30')).phase).toBe('weekend');
  });
  it('周一回到盘中', () => {
    expect(marketPhase(bj('2026-09-07', '10:00')).phase).toBe('am');
  });
});

describe('shouldPoll', () => {
  it('auction/am/pm 需轮询；其余不轮询', () => {
    expect(shouldPoll('auction')).toBe(true);
    expect(shouldPoll('am')).toBe(true);
    expect(shouldPoll('pm')).toBe(true);
    expect(shouldPoll('pre')).toBe(false);
    expect(shouldPoll('lunch')).toBe(false);
    expect(shouldPoll('post')).toBe(false);
    expect(shouldPoll('weekend')).toBe(false);
  });
});
