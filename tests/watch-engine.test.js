// tests/watch-engine.test.js — 盘中告警引擎（纯函数，注入 phase/prevState，确定性）

import { describe, it, expect } from 'vitest';
import { evaluateTick } from '../lib/watch-engine.js';

// 参照位构造器：默认全关，只开被测条件，避免多条件同时命中干扰断言
const L = (over = {}) => ({
  code: '000725', name: '京东方A', isBoard: false,
  stop: null, support: null, resistance: null, limitUp: null, limitDown: null,
  ...over,
});

function q(code, over = {}) {
  return { code, price: 10, pct: 0, volume: 1000, prevClose: 10, volumeRatio: 0.5, limitUp: null, limitDown: null, ...over };
}

// 跑一步 tick；prevState 累进。level 为单个标的定义，内部按 code 包装成 levels 字典
function makeRunner(level) {
  const levels = { [level.code]: level };
  let prev = {};
  return (phase, quote) => {
    const res = evaluateTick({ quotes: [quote], levels, prevState: prev, phase });
    prev = res.state;
    return res;
  };
}
const kindsOf = alerts => alerts.map(a => a.kind);

describe('边沿触发语义', () => {
  it('首次进入为基线：启动时已破位不误报，但状态被记录', () => {
    const run = makeRunner(L({ stop: 9 }));
    const { alerts, state } = run('am', q('000725', { price: 8.8 }));
    expect(alerts).toHaveLength(0); // 基线
    expect(state['000725'].cond.stop).toBe(true);
  });

  it('穿越才报、保持不重复、复位后再次穿越才再报', () => {
    const run = makeRunner(L({ stop: 9 }));
    expect(run('am', q('000725', { price: 10 })).alerts).toHaveLength(0);   // t1 基线(above)
    let a = run('am', q('000725', { price: 8.8 })).alerts;                   // t2 破止损
    expect(kindsOf(a)).toEqual(['stop']);
    expect(a[0].level).toBe('critical');
    expect(a[0].icon).toBe('🔴');
    a = run('am', q('000725', { price: 9.01 })).alerts;                       // t3 回抽但 < 9*1.005 迟滞保持
    expect(a).toHaveLength(0);
    a = run('am', q('000725', { price: 9.2 })).alerts;                        // t4 明显收回 → 复位
    expect(a).toHaveLength(0);
    expect(run('am', q('000725', { price: 8.8 })).alerts).toHaveLength(1);    // t5 再破 → 再报
  });

  it('不在 am/pm（lunch）不告警，仅记录；午后破位按边沿触发', () => {
    const run = makeRunner(L({ support: 9.5 }));
    const { alerts } = run('lunch', q('000725', { price: 9.9 }));
    expect(alerts).toHaveLength(0);
    const a = run('pm', q('000725', { price: 9.3 })).alerts;
    expect(kindsOf(a)).toEqual(['support']);
  });
});

describe('开盘传感补发（防跳空漏报）', () => {
  it('auction 记录(站上止损) → am 跳空跌破 → 补发 🔴', () => {
    const run = makeRunner(L({ stop: 9 }));
    const au = run('auction', q('000725', { price: 9.3 }));
    expect(au.alerts).toHaveLength(0);
    expect(au.state['000725'].sensor).toBe(true);
    const am = run('am', q('000725', { price: 8.8 }));
    expect(kindsOf(am.alerts)).toEqual(['stop']);
  });

  it('auction 就已跌破 → am 首 tick 仍补发一次（传感突发）', () => {
    const run = makeRunner(L({ stop: 9 }));
    run('auction', q('000725', { price: 8.8 }));
    const am = run('am', q('000725', { price: 8.8 }));
    expect(kindsOf(am.alerts)).toEqual(['stop']);
    expect(run('am', q('000725', { price: 8.7 })).alerts).toHaveLength(0); // 之后保持不重复
  });
});

describe('迟滞 hysteresis', () => {
  it('跌破后小幅回抽(未越 ~0.5%)仍算破位；越过后才复位', () => {
    const run = makeRunner(L({ support: 9.5 }));
    run('am', q('000725', { price: 10 }));                                            // 基线 above
    expect(kindsOf(run('am', q('000725', { price: 9.4 })).alerts)).toEqual(['support']);
    expect(run('am', q('000725', { price: 9.52 })).alerts).toHaveLength(0);            // 回抽仍破(<9.5*1.005)
    expect(run('am', q('000725', { price: 9.6 })).alerts).toHaveLength(0);             // 越过 → 复位
    expect(kindsOf(run('am', q('000725', { price: 9.3 })).alerts)).toEqual(['support']);
  });
});

describe('冻结/无成交抑制（停牌/节假日）', () => {
  it('price==prevClose && pct==0 && volume==0 → 不告警、标记 frozen、条件沿用', () => {
    const run = makeRunner(L({ stop: 9 }));
    run('am', q('000725', { price: 10 }));                                             // 基线 above
    const fr = run('am', q('000725', { price: 10, prevClose: 10, pct: 0, volume: 0 }));
    expect(fr.alerts).toHaveLength(0);
    expect(fr.state['000725'].frozen).toBe(true);
    expect(fr.state['000725'].cond.stop).toBe(false);                                  // 不被假穿越改写成 true
    expect(kindsOf(run('am', q('000725', { price: 8.8 })).alerts)).toEqual(['stop']);  // 恢复真实破位仍触发
  });
});

describe('阈值告警（追高/急跌/放量/涨跌停）', () => {
  it('涨幅≥7% → 🟠 追高；跌幅≤-5% → 🟠 急跌', () => {
    const run = makeRunner(L({}));
    run('am', q('000725', { price: 10 }));
    let a = run('am', q('000725', { price: 10.8, pct: 8 })).alerts;
    expect(a.some(x => x.kind === 'chase' && x.level === 'warn')).toBe(true);
    a = run('am', q('000725', { price: 9.4, pct: -6 })).alerts;
    expect(a.some(x => x.kind === 'drop' && x.level === 'warn')).toBe(true);
  });

  it('量比≥3 → 🟡 放量；触及涨停价 → 🟡 封涨停', () => {
    const run = makeRunner(L({}));
    run('am', q('000725', { price: 10 }));
    let a = run('am', q('000725', { price: 10.2, volumeRatio: 4 })).alerts;
    expect(a.some(x => x.kind === 'vol' && x.level === 'info')).toBe(true);
    a = run('am', q('000725', { price: 11, pct: 10, limitUp: 11 })).alerts;
    expect(a.some(x => x.kind === 'limitUp' && x.level === 'info')).toBe(true);
  });
});

describe('数值强转 / 板块指数', () => {
  it('字符串字段照常比较（price/pct/volumeRatio 为 string）', () => {
    const run = makeRunner(L({ stop: 9 }));
    run('am', q('000725', { price: '10' }));
    expect(kindsOf(run('am', q('000725', { price: '8.8' })).alerts)).toEqual(['stop']);
    const b = run('am', q('000725', { price: '10.8', pct: '8', volumeRatio: '4' })).alerts;
    expect(b.some(x => x.kind === 'chase')).toBe(true);
    expect(b.some(x => x.kind === 'vol')).toBe(true);
  });

  it('板块指数不触发任何告警', () => {
    const board = { code: '881129', name: '通信设备', isBoard: true, stop: 999, support: 999, resistance: null, limitUp: null, limitDown: null };
    const run = makeRunner(board);
    const { alerts, state } = run('am', q('881129', { price: 888, pct: 9 }));
    expect(alerts).toHaveLength(0);
    expect(state['881129'].board).toBe(true);
  });
});
