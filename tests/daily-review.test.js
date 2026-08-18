// tests/daily-review.test.js — 复盘纯函数（窗口算法 / 命中率统计 / 池建议）

import { describe, it, expect } from 'vitest';
import { computeOutcomes, computeStats, generateSuggestions } from '../lib/daily-review.js';

/** 构造快照：date 必须, close 默认 10；可覆盖任意字段 */
const S = (date, extra = {}) => ({
  code: 'X', name: 'X', date, close: 10, signal: '看多', score: 70,
  maAlignment: '多头排列', macdStatus: '多头', kdj: { k: 60, d: 55 }, rsi6: 60,
  adx: 25, atrPct: 3, support: 9, resistance: 11, patterns: [], dayLow: 9.8, dayHigh: 10.2,
  pe: 20, turnoverRate: 2, volumeRatio: 1.2, ...extra,
});

const closes = dates => dates.map((d, i) => S(d, { close: 10 + i }));

describe('computeOutcomes 窗口算法', () => {
  it('3日 ret 数学正确 + 命中判定', () => {
    const snaps = [
      S('2026-08-03', { close: 10, signal: '看多' }),
      S('2026-08-04', { close: 11 }),
      S('2026-08-05', { close: 12 }),
      S('2026-08-06', { close: 12.5 }),
      S('2026-08-07', { close: 13 }),
      S('2026-08-10', { close: 13.5 }),
      S('2026-08-11', { close: 14 }),
      S('2026-08-12', { close: 14.5 }),
      S('2026-08-13', { close: 15 }),
    ];
    const out = computeOutcomes(snaps);
    // 第一条 08-03 的 3日窗口终点=第4条(08-06): 12.5/10-1 = 0.25
    expect(out[0].outcome[3].ret).toBeCloseTo(0.25, 4);
    expect(out[0].outcome[3].hit).toBe(true);   // 看多 + 正收益 → 命中
    // 5日窗口终点=第6条(08-10): 13.5/10-1 = 0.35
    expect(out[0].outcome[5].ret).toBeCloseTo(0.35, 4);
    expect(out[0].outcome[3].closeAt).toBe(12.5);
  });

  it('看空 + 负收益 → hit；观望 → hit null', () => {
    const snaps = [
      S('2026-08-03', { close: 10, signal: '看空' }),
      S('2026-08-04', { close: 9.5 }),
      S('2026-08-05', { close: 9 }),
      S('2026-08-06', { close: 9.2 }),
      S('2026-08-07', { close: 9.5 }),
      S('2026-08-10', { close: 10 }),
      S('2026-08-11', { close: 10 }),
      S('2026-08-12', { close: 10 }),
      S('2026-08-13', { close: 10 }),
    ];
    const o1 = computeOutcomes(snaps)[0];
    expect(o1.outcome[3].hit).toBe(true);   // 看空 + 下跌 → 命中

    const snaps2 = [
      S('2026-08-03', { close: 10, signal: '观望' }),
      S('2026-08-04', { close: 9.5 }),
      S('2026-08-05', { close: 9 }),
      S('2026-08-06', { close: 9.2 }),
      S('2026-08-07', { close: 9.5 }),
      S('2026-08-10', { close: 10 }),
      S('2026-08-11', { close: 10 }),
      S('2026-08-12', { close: 10 }),
      S('2026-08-13', { close: 10 }),
    ];
    expect(computeOutcomes(snaps2)[0].outcome[3].hit).toBeNull();
  });

  it('缺跑日子自然顺延（非连续日期）', () => {
    const snaps = closes(['2026-08-03', '2026-08-04', '2026-08-07', '2026-08-10', '2026-08-13']);
    // 08-03 的 3 日窗口 = 第4条（08-10），因为中间只跑了 3 条更晚的快照
    const out = computeOutcomes(snaps);
    expect(out[0].outcome[3].closeAt).toBe(13); // 08-10 close=13
  });

  it('周末同日去重后窗口不漂移', () => {
    // 同日期重复快照只保留最后一次
    const snaps = [
      S('2026-08-03', { close: 10 }),
      S('2026-08-03', { close: 999 }), // 同日重跑，取最后
      S('2026-08-04', { close: 11 }),
      S('2026-08-05', { close: 12 }),
      S('2026-08-06', { close: 13 }),
      S('2026-08-07', { close: 14 }),
    ];
    const out = computeOutcomes(snaps);
    expect(out).toHaveLength(5); // 去重后 5 条
    expect(out[0].close).toBe(999);
    expect(out[0].outcome[3].ret).toBeCloseTo(13 / 999 - 1, 4);
  });

  it('窗口未闭合（不足 3/5 个更晚快照）→ outcome 缺席', () => {
    const snaps = closes(['2026-08-03', '2026-08-04', '2026-08-05']);
    const out = computeOutcomes(snaps);
    // 共 3 条，任何 i+3 / i+5 都 >= 3 → 全部未闭合
    expect(out[0].outcome).toBeNull();
    expect(out[1].outcome).toBeNull();
    expect(out[2].outcome).toBeNull();
  });

  it('supportHeld / hitResistance 判定', () => {
    // 支撑 9：窗口 dayLow 全 > 9 → held true
    const held = [
      S('2026-08-03', { support: 9, dayLow: 9.5, dayHigh: 10.5 }),
      S('2026-08-04', { dayLow: 9.4, dayHigh: 10.4 }),
      S('2026-08-05', { dayLow: 9.6, dayHigh: 10.6 }),
      S('2026-08-06', { dayLow: 9.8, dayHigh: 10.8 }),
      S('2026-08-07', { dayLow: 9.9, dayHigh: 10.9 }),
    ];
    expect(computeOutcomes(held)[0].outcome[3].supportHeld).toBe(true);

    // 任一日跌破支撑 → false
    const broken = [
      S('2026-08-03', { support: 9, dayLow: 9.5, dayHigh: 10.5 }),
      S('2026-08-04', { dayLow: 8.8, dayHigh: 10.4 }),
      S('2026-08-05', { dayLow: 9.6, dayHigh: 10.6 }),
      S('2026-08-06', { dayLow: 9.8, dayHigh: 10.8 }),
      S('2026-08-07', { dayLow: 9.9, dayHigh: 10.9 }),
    ];
    expect(computeOutcomes(broken)[0].outcome[3].supportHeld).toBe(false);

    // 任一窗口日触及压力 → hitResistance true
    const hit = [
      S('2026-08-03', { resistance: 11, dayHigh: 10.5 }),
      S('2026-08-04', { dayHigh: 11.2, dayLow: 9 }),
      S('2026-08-05', { dayHigh: 10.6, dayLow: 9 }),
      S('2026-08-06', { dayHigh: 10.8, dayLow: 9 }),
      S('2026-08-07', { dayHigh: 10.9, dayLow: 9 }),
    ];
    expect(computeOutcomes(hit)[0].outcome[3].hitResistance).toBe(true);
  });

  it('3 与 5 窗口切片不同', () => {
    const snaps = closes(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10']);
    const out = computeOutcomes(snaps);
    expect(out[0].outcome[3].ret).toBeCloseTo(13 / 10 - 1, 4); // 08-06
    expect(out[0].outcome[5].ret).toBeCloseTo(15 / 10 - 1, 4); // 08-10
  });
});

describe('computeStats 命中率统计', () => {
  it('overall 聚合正确（n/nDir/hits/rate）', () => {
    // 6 条连续 closes 10,11,12,11,12,13；看多、看多、看空、观望、看多、看多
    // 3 日窗口闭合 i∈{0,1,2}：
    //   i0 看多 c10→c3=11 ret=+0.1 hit
    //   i1 看多 c11→c4=12 ret≈+.09 hit
    //   i2 看空 c12→c5=13 ret≈+.08 hit=false（看空需下跌）
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看多' }),
      S('2026-08-04', { code: 'A', close: 11, signal: '看多' }),
      S('2026-08-05', { code: 'A', close: 12, signal: '看空' }),
      S('2026-08-06', { code: 'A', close: 11, signal: '观望' }),
      S('2026-08-07', { code: 'A', close: 12, signal: '看多' }),
      S('2026-08-10', { code: 'A', close: 13, signal: '看多' }),
    ];
    const st = computeStats(snaps, { minN: 1 });
    const o = st.overall;
    expect(o.n3).toBe(3);
    expect(o.nDir3).toBe(3);
    expect(o.hits3).toBe(2);
    expect(o.hitRate3).toBeCloseTo(2 / 3, 6);
    // minN=5 时 rate 为 null
    const st2 = computeStats(snaps, { minN: 5 });
    expect(st2.overall.hitRate3).toBeNull();
  });

  it('观望计入 n/avgRet 但不进命中率', () => {
    // closes 10,20,20,20,30；3 日窗口闭合 i∈{0,1}
    //   i0 观望 c10→c3=20 ret=+1.0  hit=null（不计命中率）
    //   i1 看多 c20→c4=30 ret=+0.5  hit=true
    const snaps = [
      S('2026-08-03', { close: 10, signal: '观望' }),
      S('2026-08-04', { close: 20, signal: '看多' }),
      S('2026-08-05', { close: 20, signal: '看多' }),
      S('2026-08-06', { close: 20, signal: '看多' }),
      S('2026-08-07', { close: 30, signal: '看多' }),
    ];
    const st = computeStats(snaps, { minN: 2 });
    const o = st.overall;
    expect(o.n3).toBe(2);
    expect(o.nDir3).toBe(1); // 只有一条看多参与命中率
    expect(o.hits3).toBe(1);
    expect(o.hitRate3).toBe(1);
    expect(o.avgRet3).toBeCloseTo((1.0 + 0.5) / 2, 4); // 两条 avg
  });

  it('特征桶（marketMood / signal / scoreBand）', () => {
    // 9 条：普涨强势段先涨，分化震荡段后跌。3 日窗口闭合 i∈{0..5}
    //   i0 看多 c10→c3=13 ret=+.3 hit | i1 看多 c11→c4=12 ret≈+.09 hit
    //   i2 看多 c12→c5=11 ret≈-.08 miss | i3 看多 c13→c6=10 ret≈-.23 miss
    //   i4 看空 c12→c7=9 ret=-.25 hit | i5 看空 c11→c8=8 ret≈-.27 hit
    const mk = (date, mood, signal, score, close) => S(date, {
      marketEnv: { mood }, signal, score, close,
    });
    const snaps = [
      mk('2026-08-03', '普涨强势', '看多', 75, 10),
      mk('2026-08-04', '普涨强势', '看多', 72, 11),
      mk('2026-08-05', '普涨强势', '看多', 70, 12),
      mk('2026-08-06', '普涨强势', '看多', 72, 13),
      mk('2026-08-07', '分化震荡', '看空', 35, 12),
      mk('2026-08-10', '分化震荡', '看空', 30, 11),
      mk('2026-08-11', '分化震荡', '看空', 25, 10),
      mk('2026-08-12', '分化震荡', '看空', 20, 9),
      mk('2026-08-13', '分化震荡', '看空', 15, 8),
    ];
    const st = computeStats(snaps, { minN: 1 });
    // marketMood 桶
    expect(st.buckets.marketMood['普涨强势'].n3).toBe(4);
    expect(st.buckets.marketMood['普涨强势'].hitRate3).toBe(0.5); // i0,i1 hit / i2,i3 miss
    expect(st.buckets.marketMood['分化震荡'].hitRate3).toBe(1);   // i4,i5 hit
    // signal 桶
    expect(st.buckets.signal['看多'].nDir3).toBe(4);
    expect(st.buckets.signal['看空'].nDir3).toBe(2);
    // scoreBand 桶
    expect(st.buckets.scoreBand['≥70'].n3).toBe(4);
    expect(st.buckets.scoreBand['≤40'].n3).toBe(2);
  });

  it('perCode 单独统计 + pending 计数', () => {
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10 }),
      S('2026-08-04', { code: 'A', close: 11 }),
      S('2026-08-05', { code: 'A', close: 12 }),
      S('2026-08-06', { code: 'A', close: 13 }),
      S('2026-08-03', { code: 'B', close: 20 }),
      S('2026-08-04', { code: 'B', close: 21 }),
      S('2026-08-05', { code: 'B', close: 22 }),
    ];
    const st = computeStats(snaps, { minN: 1 });
    // A 4 条：只有 i0 有 3 日窗口（i+3<4 → i<1）
    // B 3 条：i0+3=3 不 < 3 → 3 日窗口也不闭合
    expect(st.perCode.A.stat3.n3).toBe(1);
    expect(st.perCode.B.stat3.n3).toBe(0);
    expect(st.perCode.B.last.close).toBe(22);
    // pending.n3：A 的 i1,i2,i3（3 条）+ B 的 i0,i1,i2（3 条）= 6
    expect(st.pending.n3).toBe(6);
    // 5 日窗口全未闭合（A 4 条 / B 3 条 都 < 6 条）→ pending.n5 = 7
    expect(st.pending.n5).toBe(7);
  });

  it('resonance 桶', () => {
    const mk = (date, score, ma, macd, adx) => S(date, { score, maAlignment: ma, macdStatus: macd, adx });
    const snaps = [
      mk('2026-08-03', 70, '多头排列', '多头', 30),
      mk('2026-08-04', 70, '多头排列', '多头', 28),
      mk('2026-08-05', 70, '多头排列', '多头', 26),
      mk('2026-08-06', 70, '多头排列', '多头', 24), // ADX<25 → 非共振
      mk('2026-08-07', 70, '多头排列', '多头', 26),
      mk('2026-08-10', 70, '多头排列', '多头', 26),
      mk('2026-08-11', 70, '多头排列', '多头', 26),
      mk('2026-08-12', 70, '多头排列', '多头', 26),
    ];
    const st = computeStats(snaps, { minN: 1 });
    // 3 日窗口闭合 i∈{0..4}：0,1,2 是共振(adx≥25)，3 非共振，4 是
    expect(st.buckets.resonance['是'].n3).toBe(4);
    expect(st.buckets.resonance['否'].n3).toBe(1);
  });
});

describe('方向特征桶（M2-1）', () => {
  it('boardMood/fundDir/lhbJoin 按 direction 聚合；缺 direction/dir 跳过', () => {
    const mk = (date, close, direction, dir) => S(date, { close, direction, dir });
    const snaps = [
      mk('2026-08-03', 10, { boardMood: { label: '强' }, fundDir: { label: '进攻' }, lhbJoin: { label: '强' } }, { boardLeader: '通信设备', fundTop: true, lhb: 100, dirCount: 3 }),
      mk('2026-08-04', 11, { boardMood: { label: '强' }, fundDir: { label: '进攻' }, lhbJoin: { label: '强' } }, { boardLeader: null, fundTop: false, lhb: null, dirCount: 0 }),
      mk('2026-08-05', 12, { boardMood: { label: '弱' }, fundDir: { label: '流出' }, lhbJoin: { label: '弱' } }, { boardLeader: null, fundTop: true, lhb: null, dirCount: 1 }),
      mk('2026-08-06', 13, { boardMood: { label: '弱' }, fundDir: { label: '流出' }, lhbJoin: { label: '弱' } }, null), // 有方向但无个股 dir
      mk('2026-08-07', 14, null, null), // 无方向数据
      mk('2026-08-10', 15, null, null),
    ];
    const st = computeStats(snaps, { minN: 1 });
    // 3 日窗口闭合 i∈{0..2}
    expect(st.buckets.boardMood['强'].n3).toBe(2);
    expect(st.buckets.boardMood['弱'].n3).toBe(1);
    expect(st.buckets.fundDir['进攻'].n3).toBe(2);
    expect(st.buckets.fundDir['流出'].n3).toBe(1);
    expect(st.buckets.lhbJoin['强'].n3).toBe(2);
    expect(st.buckets.lhbJoin['弱'].n3).toBe(1);
    // dirResonance：i0 三重 / i1 无 / i2 一重
    expect(st.buckets.dirResonance['2重+'].n3).toBe(1);
    expect(st.buckets.dirResonance['无'].n3).toBe(1);
    expect(st.buckets.dirResonance['1重'].n3).toBe(1);
    // boardLeader：i0 龙头 / i1,i2 非龙头
    expect(st.buckets.boardLeader['龙头'].n3).toBe(1);
    expect(st.buckets.boardLeader['非龙头'].n3).toBe(2);
  });

  it('signalGrade 桶（M1-3）：signalLabel 聚合、缺字段跳过', () => {
    const snaps = [
      S('2026-08-03', { close: 10, signalLabel: '强看多' }),
      S('2026-08-04', { close: 11, signalLabel: '强看多' }),
      S('2026-08-05', { close: 12, signalLabel: '看多(存疑)' }),
      S('2026-08-06', { close: 13 }),
      S('2026-08-07', { close: 14 }),
      S('2026-08-10', { close: 15 }),
    ];
    const st = computeStats(snaps, { minN: 1 });
    // 3 日窗口闭合 i∈{0..2}：两条强看多 + 一条看多(存疑)
    expect(st.buckets.signalGrade['强看多'].n3).toBe(2);
    expect(st.buckets.signalGrade['看多(存疑)'].n3).toBe(1);
  });
});

describe('generateSuggestions 池建议', () => {
  it('R1: 连续≥3日看空且 code 3日命中率<40% → 剔除', () => {
    // 8 条全看空但股票一路上涨 → hitRate3 = 0（<40%），且 n3=5 ≥ minN(5)
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看空' }),
      S('2026-08-04', { code: 'A', close: 11, signal: '看空' }),
      S('2026-08-05', { code: 'A', close: 12, signal: '看空' }),
      S('2026-08-06', { code: 'A', close: 13, signal: '看空' }),
      S('2026-08-07', { code: 'A', close: 14, signal: '看空' }),
      S('2026-08-10', { code: 'A', close: 15, signal: '看空' }),
      S('2026-08-11', { code: 'A', close: 16, signal: '看空' }),
      S('2026-08-12', { code: 'A', close: 17, signal: '看空' }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.type === 'remove' && s.code === 'A' && s.strength === 'strong')).toBe(true);
  });

  it('R1 边界：命中率不低则不触发', () => {
    // 看空 4 次全对（股票跌了）→ hitRate3 = 1
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看空' }),
      S('2026-08-04', { code: 'A', close: 9, signal: '看空' }),
      S('2026-08-05', { code: 'A', close: 8, signal: '看空' }),
      S('2026-08-06', { code: 'A', close: 7, signal: '看空' }),
      S('2026-08-07', { code: 'A', close: 6, signal: '看空' }),
      S('2026-08-10', { code: 'A', close: 5, signal: '看空' }),
      S('2026-08-11', { code: 'A', close: 4, signal: '看空' }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.type === 'remove' && s.code === 'A')).toBe(false);
    // 但会有 reduce（最新看空，W1）
    expect(sugs.some(s => s.type === 'reduce' && s.code === 'A')).toBe(true);
  });

  it('R2: 最近5条 3日均收益≤-3% 且最新看空 → 强剔除', () => {
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看空' }),
      S('2026-08-04', { code: 'A', close: 9.5, signal: '看空' }),
      S('2026-08-05', { code: 'A', close: 9, signal: '看空' }),
      S('2026-08-06', { code: 'A', close: 8.5, signal: '看空' }),
      S('2026-08-07', { code: 'A', close: 8, signal: '看空' }),
      S('2026-08-10', { code: 'A', close: 7.5, signal: '看空' }),
      S('2026-08-11', { code: 'A', close: 7, signal: '看空' }),
      S('2026-08-12', { code: 'A', close: 6.5, signal: '看空' }),
    ];
    const sugs = generateSuggestions({ snaps });
    // R2 要求最近5条 avgRet3 ≤ -3%：快照持续下跌，3日窗口 ret 恒负 → 命中
    expect(sugs.some(s => s.type === 'remove' && s.code === 'A' && s.reason.includes('3日均收益'))).toBe(true);
  });

  it('W2a: 最新看多但当日涨幅≥7% → 减仓（不追高红线）', () => {
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10 }),
      S('2026-08-04', { code: 'A', close: 11 }),
      S('2026-08-05', { code: 'A', close: 12 }),
      S('2026-08-06', { code: 'A', close: 13 }),
      S('2026-08-07', { code: 'A', close: 14, pct: 8.5 }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.type === 'reduce' && s.code === 'A' && s.reason.includes('不追高'))).toBe(true);
  });

  it('W2b: 超买且接近压力位(<3%) → 减仓；单纯超买不触发（避免噪音）', () => {
    // 接近压力：close 10, resistance 10.2（距2%），KDJ 超买 → 触发
    const near = [
      S('2026-08-03', { code: 'A', close: 10, resistance: 10.2 }),
      S('2026-08-04', { code: 'A', close: 10, resistance: 10.2 }),
      S('2026-08-05', { code: 'A', close: 10, resistance: 10.2 }),
      S('2026-08-06', { code: 'A', close: 10, resistance: 10.2 }),
      S('2026-08-07', { code: 'A', close: 10, resistance: 10.2, kdj: { k: 85, d: 80 }, rsi6: 75 }),
    ];
    expect(generateSuggestions({ snaps: near }).some(s => s.type === 'reduce' && s.code === 'A')).toBe(true);

    // 仅超买但距压力远（10→10.5，5%）→ 不触发（普涨日不刷屏）
    const far = [
      S('2026-08-03', { code: 'A', close: 10, resistance: 10.5 }),
      S('2026-08-04', { code: 'A', close: 10, resistance: 10.5 }),
      S('2026-08-05', { code: 'A', close: 10, resistance: 10.5 }),
      S('2026-08-06', { code: 'A', close: 10, resistance: 10.5 }),
      S('2026-08-07', { code: 'A', close: 10, resistance: 10.5, kdj: { k: 85, d: 80 }, rsi6: 75 }),
    ];
    expect(generateSuggestions({ snaps: far }).some(s => s.type === 'reduce' && s.code === 'A')).toBe(false);
  });

  it('W3: 连续≥3日评分≤40 → 剔除候选', () => {
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, score: 35 }),
      S('2026-08-04', { code: 'A', close: 10, score: 30 }),
      S('2026-08-05', { code: 'A', close: 10, score: 28 }),
      S('2026-08-06', { code: 'A', close: 10, score: 25 }),
      S('2026-08-07', { code: 'A', close: 10, score: 22 }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.type === 'remove' && s.code === 'A' && s.reason.includes('评分≤40'))).toBe(true);
  });

  it('A1: 提供 candidates → 加入建议（weak，无特征兜底）', () => {
    const sugs = generateSuggestions({ snaps: [], candidates: [{ code: '000049', name: '德赛电池' }] });
    expect(sugs.some(s => s.type === 'add' && s.code === '000049' && s.strength === 'weak')).toBe(true);
  });

  it('A1: 候选命中历史高分特征（共振/评分段）→ strong 且带命中率证据', () => {
    // 历史快照：共振桶 3日命中率 100%（共振全对，8 条 → 5 个闭合窗口 n3=5）
    const snaps = [
      S('2026-08-03', { code: 'B', close: 10, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-04', { code: 'B', close: 11, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
      S('2026-08-05', { code: 'B', close: 12, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 26 }),
      S('2026-08-06', { code: 'B', close: 13, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-07', { code: 'B', close: 14, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
      S('2026-08-10', { code: 'B', close: 15, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 26 }),
      S('2026-08-11', { code: 'B', close: 16, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-12', { code: 'B', close: 17, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
    ];
    const sugs = generateSuggestions({
      snaps,
      candidates: [{ code: '600519', name: '茅台', score: 75, signal: '看多', maAlignment: '多头排列', macdStatus: '多头', adx: 30, resistance: 2000, close: 1700 }],
    });
    const add = sugs.find(s => s.type === 'add' && s.code === '600519');
    expect(add.strength).toBe('strong');
    expect(add.reason).toContain('3日命中');
  });

  it('A1: 候选特征历史表现差 → 仅 weak（不夸大）', () => {
    // 历史快照：共振桶命中率 0%（共振全错，8 条 → 5 个闭合窗口）
    const snaps = [
      S('2026-08-03', { code: 'B', close: 10, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-04', { code: 'B', close: 9, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
      S('2026-08-05', { code: 'B', close: 8, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 26 }),
      S('2026-08-06', { code: 'B', close: 7, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-07', { code: 'B', close: 6, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
      S('2026-08-10', { code: 'B', close: 5, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 26 }),
      S('2026-08-11', { code: 'B', close: 4, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 30 }),
      S('2026-08-12', { code: 'B', close: 3, score: 70, maAlignment: '多头排列', macdStatus: '多头', adx: 28 }),
    ];
    const sugs = generateSuggestions({
      snaps,
      candidates: [{ code: '600519', name: '茅台', score: 75, signal: '看多', maAlignment: '多头排列', macdStatus: '多头', adx: 30 }],
    });
    const add = sugs.find(s => s.type === 'add' && s.code === '600519');
    expect(add.strength).toBe('weak'); // 命中率 0% < 55%，即便评分高也仅 weak
    expect(add.reason).toContain('偏弱谨慎');
  });

  it('每只股票最多一条主建议（R1 remove 与 W3 remove 只留一条）', () => {
    // 既满足 R1（连续看空+看空命中率低）又满足 W3（评分≤40连续）→ 只出一条 remove
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看空', score: 30 }),
      S('2026-08-04', { code: 'A', close: 11, signal: '看空', score: 30 }),
      S('2026-08-05', { code: 'A', close: 12, signal: '看空', score: 28 }),
      S('2026-08-06', { code: 'A', close: 13, signal: '看空', score: 25 }),
      S('2026-08-07', { code: 'A', close: 14, signal: '看空', score: 22 }),
      S('2026-08-10', { code: 'A', close: 15, signal: '看空', score: 20 }),
      S('2026-08-11', { code: 'A', close: 16, signal: '看空', score: 18 }),
      S('2026-08-12', { code: 'A', close: 17, signal: '看空', score: 15 }),
    ];
    const sugs = generateSuggestions({ snaps });
    const removes = sugs.filter(s => s.type === 'remove' && s.code === 'A');
    expect(removes.length).toBe(1);
  });

  it('M2: 已移除股票（末条 removedAt）不再出建议', () => {
    const snaps = [
      S('2026-08-03', { code: 'A', close: 10, signal: '看空' }),
      S('2026-08-04', { code: 'A', close: 9, signal: '看空' }),
      S('2026-08-05', { code: 'A', close: 8, signal: '看空' }),
      S('2026-08-06', { code: 'A', close: 7, signal: '看空' }),
      S('2026-08-07', { code: 'A', close: 6, signal: '看空', removedAt: '2026-08-07' }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.code === 'A')).toBe(false);
  });

  it('M3: 候选已在监控池（有快照）→ 不再建议加入', () => {
    const snaps = [
      S('2026-08-03', { code: '600519', close: 10 }),
      S('2026-08-04', { code: '600519', close: 11 }),
      S('2026-08-05', { code: '600519', close: 12 }),
      S('2026-08-06', { code: '600519', close: 13 }),
    ];
    const sugs = generateSuggestions({ snaps, candidates: [{ code: '600519', name: '茅台' }] });
    expect(sugs.some(s => s.type === 'add' && s.code === '600519')).toBe(false);
  });

  it('M5: 板块指数（isBoard）快照不产生买卖建议（M1-2）', () => {
    // 板块指数连续看空且命中率差 → 本会触发 R1 remove；但 isBoard 应被跳过
    const snaps = [
      S('2026-08-03', { code: '881129', close: 10, signal: '看空', isBoard: true }),
      S('2026-08-04', { code: '881129', close: 11, signal: '看空', isBoard: true }),
      S('2026-08-05', { code: '881129', close: 12, signal: '看空', isBoard: true }),
      S('2026-08-06', { code: '881129', close: 13, signal: '看空', isBoard: true }),
      S('2026-08-07', { code: '881129', close: 14, signal: '看空', isBoard: true }),
      S('2026-08-10', { code: '881129', close: 15, signal: '看空', isBoard: true }),
      S('2026-08-11', { code: '881129', close: 16, signal: '看空', isBoard: true }),
      S('2026-08-12', { code: '881129', close: 17, signal: '看空', isBoard: true }),
    ];
    const sugs = generateSuggestions({ snaps });
    expect(sugs.some(s => s.code === '881129')).toBe(false);
  });

  it('M4: 缺失 score 不落入"≤40"桶', () => {
    const snaps = [
      S('2026-08-03', { score: undefined }),
      S('2026-08-04', { score: undefined }),
      S('2026-08-05', { score: undefined }),
      S('2026-08-06', { score: undefined }),
      S('2026-08-07', { score: undefined }),
      S('2026-08-10', { score: undefined }),
    ];
    const stats = computeStats(snaps, { minN: 1 });
    expect(stats.buckets.scoreBand).toBeUndefined(); // 无 score → 不进任何评分桶
  });
});
