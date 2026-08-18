// tests/daily-store.test.js — 每日监控/复盘/经验的本地持久层

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DailyStore } from '../lib/daily-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `ths-daily-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

const mk = () => new DailyStore({ snapDir: path.join(tmpDir, 'snapshots'), lessonsFile: path.join(tmpDir, 'lessons.json') });

const SNAP = (code, date, extra = {}) => ({
  code, name: code, date, close: 10, score: 70, signal: '看多',
  maAlignment: '多头排列', macdStatus: '多头', kdj: { k: 60, d: 55 }, rsi6: 60,
  adx: 25, atrPct: 3, support: 9, resistance: 11, patterns: [], dayLow: 9.8, dayHigh: 10.2,
  pe: 20, turnoverRate: 2, volumeRatio: 1.2, ...extra,
});

describe('快照 upsert/读取', () => {
  it('写入后可读回（date/marketEnv/stocks）', () => {
    const s = mk();
    s.setMarketEnv('2026-08-17', { mood: '普涨强势', totalUp: 3500, totalDown: 1500 });
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    const f = s.loadSnapshotFile('2026-08-17');
    expect(f.date).toBe('2026-08-17');
    expect(f.marketEnv.mood).toBe('普涨强势');
    expect(f.stocks['600519'].signal).toBe('看多');
    expect(f.stocks['600519'].code).toBe('600519');
  });

  it('同日同 code 重跑幂等：不重复、note 保留、outcome 保留', () => {
    const s = mk();
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.setNote('2026-08-17', '600519', '看错原因：大盘转冷');
    s.setOutcome('2026-08-17', '600519', { 3: { ret: 0.01, hit: true } });
    s.upsertSnapshot('2026-08-17', { ...SNAP('600519', '2026-08-17'), close: 10.5, score: 72 });
    const f = s.loadSnapshotFile('2026-08-17');
    expect(Object.keys(f.stocks)).toHaveLength(1);          // 不重复
    expect(f.stocks['600519'].note).toBe('看错原因：大盘转冷'); // note 保留
    expect(f.stocks['600519'].outcome['3'].hit).toBe(true);   // 已闭合 outcome 保留
    expect(f.stocks['600519'].close).toBe(10.5);              // 技术字段被覆盖
    expect(f.stocks['600519'].score).toBe(72);
  });

  it('不同 code 同文件共存', () => {
    const s = mk();
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.upsertSnapshot('2026-08-17', SNAP('000001', '2026-08-17', { code: '000001', name: '平安银行' }));
    expect(Object.keys(s.loadSnapshotFile('2026-08-17').stocks).sort()).toEqual(['000001', '600519']);
  });

  it('setOutcome 只写目标股，其余不动', () => {
    const s = mk();
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.upsertSnapshot('2026-08-17', SNAP('000001', '2026-08-17', { code: '000001' }));
    s.setOutcome('2026-08-17', '600519', { 3: { ret: 0.02, hit: true } });
    const f = s.loadSnapshotFile('2026-08-17');
    expect(f.stocks['600519'].outcome['3'].hit).toBe(true);
    expect(f.stocks['000001'].outcome).toBeNull();
  });

  it('setRemovedAt 打标记', () => {
    const s = mk();
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.setRemovedAt('2026-08-17', '600519', '2026-08-20');
    expect(s.loadSnapshotFile('2026-08-17').stocks['600519'].removedAt).toBe('2026-08-20');
  });

  it('backfillOutcomes 批量按日期合并写入、只写有变化的目标股', () => {
    const s = mk();
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.upsertSnapshot('2026-08-17', SNAP('000001', '2026-08-17', { code: '000001' }));
    s.upsertSnapshot('2026-08-18', SNAP('600519', '2026-08-18', { close: 11 }));

    // 只给 08-17 的 600519 一个已闭合 outcome；000001 与 08-18 不动
    s.backfillOutcomes({ '2026-08-17': { '600519': { 3: { ret: 0.05, hit: true } } } });

    const f = s.loadSnapshotFile('2026-08-17');
    expect(f.stocks['600519'].outcome['3'].hit).toBe(true);
    expect(f.stocks['000001'].outcome).toBeNull();

    const f2 = s.loadSnapshotFile('2026-08-18');
    expect(f2.stocks['600519'].outcome).toBeNull();

    // 幂等：同样内容再回填，文件不因无变化而出问题（仅内部写一次，行为一致）
    s.backfillOutcomes({ '2026-08-17': { '600519': { 3: { ret: 0.05, hit: true } } } });
    expect(s.loadSnapshotFile('2026-08-17').stocks['600519'].outcome['3'].ret).toBeCloseTo(0.05, 6);
  });
});

describe('listDates / loadSnapshots', () => {
  it('listDates 升序、跳过非日期文件', () => {
    const s = mk();
    fs.mkdirSync(path.join(tmpDir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'snapshots', '2026-08-17.json'), '{"stocks":{}}');
    fs.writeFileSync(path.join(tmpDir, 'snapshots', '2026-08-14.json'), '{"stocks":{}}');
    fs.writeFileSync(path.join(tmpDir, 'snapshots', 'readme.txt'), 'x');
    expect(s.listDates()).toEqual(['2026-08-14', '2026-08-17']);
  });

  it('loadSnapshots 扁平化并按日期升序、并入 marketEnv、code 过滤', () => {
    const s = mk();
    s.setMarketEnv('2026-08-14', { mood: '分化震荡' });
    s.upsertSnapshot('2026-08-14', SNAP('600519', '2026-08-14'));
    s.setMarketEnv('2026-08-17', { mood: '普涨强势' });
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    s.upsertSnapshot('2026-08-17', SNAP('000001', '2026-08-17', { code: '000001' }));

    const all = s.loadSnapshots();
    expect(all).toHaveLength(3);
    expect(all[0].date).toBe('2026-08-14');
    expect(all[0].marketEnv.mood).toBe('分化震荡');
    expect(all[2].date).toBe('2026-08-17');

    const only519 = s.loadSnapshots({ code: '600519' });
    expect(only519).toHaveLength(2);
    expect(only519.every(x => x.code === '600519')).toBe(true);

    const since = s.loadSnapshots({ since: '2026-08-17' });
    expect(since).toHaveLength(2);
    expect(since.every(x => x.date >= '2026-08-17')).toBe(true);
  });

  it('损坏 JSON → loadSnapshotFile 返回 null，不 throw', () => {
    const s = mk();
    fs.mkdirSync(path.join(tmpDir, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'snapshots', '2026-08-17.json'), '{broken');
    expect(s.loadSnapshotFile('2026-08-17')).toBeNull();
    expect(() => s.loadSnapshots()).not.toThrow();
  });

  it('非日期文件名的读取被拒绝', () => {
    const s = mk();
    expect(s.loadSnapshotFile('not-a-date')).toBeNull();
  });
});

describe('经验 lessons', () => {
  it('add / list / category+code 过滤 / 持久化', () => {
    const s = mk();
    s.addLesson({ text: '看多后 3 日命中率高', category: '策略', code: '600519' });
    s.addLesson({ text: '超买不追', category: '纪律', code: '000001' });
    expect(s.listLessons()).toHaveLength(2);
    expect(s.listLessons({ category: '纪律' })).toHaveLength(1);
    expect(s.listLessons({ code: '600519' })[0].category).toBe('策略');

    // 重载后仍在
    const s2 = mk();
    expect(s2.listLessons()).toHaveLength(2);
    expect(s2.listLessons()[0].id).toMatch(/^L\d+$/);
  });

  it('addLesson 空文本抛错；removeLesson 可删', () => {
    const s = mk();
    expect(() => s.addLesson({ text: '   ' })).toThrow('经验内容不能为空');
    const l = s.addLesson({ text: '要删的' });
    expect(s.removeLesson(l.id)).toBe(true);
    expect(s.removeLesson('L999')).toBe(false);
    expect(s.listLessons()).toHaveLength(0);
  });
});

describe('方向环境 direction（M2-1）', () => {
  it('setDirection 写入并可读回；与 marketEnv 并列不互踩', () => {
    const s = mk();
    s.setMarketEnv('2026-08-17', { mood: '普涨强势' });
    s.setDirection('2026-08-17', {
      boardMood: { label: '强', topSector: '通信设备', topPct: 3.2 },
      fundDir: { label: '进攻', positiveRatio: 0.7 },
      lhbJoin: { label: '中性', count: 12, netSum: -1000 },
    });
    const f = s.loadSnapshotFile('2026-08-17');
    expect(f.marketEnv.mood).toBe('普涨强势');
    expect(f.direction.boardMood.label).toBe('强');
    expect(f.direction.fundDir.label).toBe('进攻');
  });

  it('upsertSnapshot 保留已写入的 direction', () => {
    const s = mk();
    s.setDirection('2026-08-17', { boardMood: { label: '强' } });
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17'));
    expect(s.loadSnapshotFile('2026-08-17').direction.boardMood.label).toBe('强');
  });

  it('loadSnapshots 把 direction 并入每只股票（缺失时为空对象）', () => {
    const s = mk();
    s.setDirection('2026-08-17', { boardMood: { label: '强' } });
    s.upsertSnapshot('2026-08-17', SNAP('600519', '2026-08-17', { dir: { boardLeader: '通信设备', dirCount: 1 } }));
    s.upsertSnapshot('2026-08-14', SNAP('600519', '2026-08-14')); // 无 direction
    const all = s.loadSnapshots();
    const d17 = all.find(x => x.date === '2026-08-17');
    expect(d17.direction.boardMood.label).toBe('强');
    expect(d17.dir.boardLeader).toBe('通信设备');
    const d14 = all.find(x => x.date === '2026-08-14');
    expect(d14.direction).toEqual({});
  });
});

describe('池建议 poolSuggestions', () => {
  it('add 自动编号、open 去重、markSuggestion 状态流转', () => {
    const s = mk();
    const a = s.addSuggestion({ type: 'remove', code: '000001', name: '平安银行', reason: '连续看空', strength: 'strong' });
    expect(a.id).toMatch(/^S\d+$/);
    expect(a.status).toBe('open');
    // 同 code 同 type open 去重
    expect(s.addSuggestion({ type: 'remove', code: '000001' })).toBeNull();
    // 不同类型不冲突
    expect(s.addSuggestion({ type: 'reduce', code: '000001' })).not.toBeNull();

    expect(s.listSuggestions({ status: 'open' })).toHaveLength(2);
    expect(s.markSuggestion(a.id, 'applied')).toBe(true);
    expect(s.listSuggestions({ status: 'open' })).toHaveLength(1);
    expect(s.markSuggestion('S999', 'applied')).toBe(false);

    // 持久化
    const s2 = mk();
    expect(s2.listSuggestions({ status: 'applied' })[0].id).toBe(a.id);
  });
});
