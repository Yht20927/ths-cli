// tests/data-command.test.js — ths data verify / backup

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cmdData from '../lib/commands/data.js';

let dir;
let backupDir;
let cacheFile;
let dailyDir;
let realtimeDir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-data-'));
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-backup-'));
  cacheFile = path.join(dir, 'cache.json');
  dailyDir = path.join(dir, 'daily');
  realtimeDir = path.join(dir, 'realtime');
  fs.mkdirSync(path.join(dailyDir, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(realtimeDir, 'alerts'), { recursive: true });
  fs.mkdirSync(path.join(realtimeDir, 'ticks'), { recursive: true });
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

function seedValid() {
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: 3, kline: { k: { bars: [] } },
  }));
  fs.writeFileSync(cacheFile.replace(/\.json$/, '.state.json'), JSON.stringify({
    version: 1, watchlist: [{ code: '000725' }], names: {}, positions: [],
  }));
  fs.writeFileSync(path.join(dailyDir, 'snapshots', '2026-10-18.json'), JSON.stringify({
    date: '2026-10-18', marketEnv: {}, direction: {}, stocks: { '000725': { code: '000725' } },
  }));
  fs.writeFileSync(path.join(dailyDir, 'lessons.json'), JSON.stringify({
    version: 1, lessons: [{ id: 'L01', text: 'x' }], poolSuggestions: [],
  }));
  fs.writeFileSync(path.join(realtimeDir, 'alerts', '2026-10-18.jsonl'),
    '{"type":"alert","id":"a1","code":"000725","ts":1}\n');
  fs.writeFileSync(path.join(realtimeDir, 'ticks', '2026-10-18.jsonl'),
    '{"type":"tick","ts":1,"quotes":{}}\n');
}

function verify(json = true) {
  const args = ['verify', '--cache', cacheFile, '--daily', dailyDir, '--realtime', realtimeDir];
  if (json) args.push('--json');
  return cmdData({}, args);
}

describe('ths data verify', () => {
  it('健康数据 → ok', async () => {
    seedValid();
    const res = await verify();
    expect(res.ok).toBe(true);
    expect(res.errors).toBe(0);
    expect(res.checks.some(c => c.item === 'K线缓存' && c.status === 'ok')).toBe(true);
    expect(res.checks.some(c => c.item === '用户状态' && c.status === 'ok')).toBe(true);
    expect(res.checks.some(c => c.item === '每日快照' && c.status === 'ok')).toBe(true);
    expect(res.checks.some(c => c.item === '实时 JSONL' && c.status === 'ok')).toBe(true);
  });

  it('损坏缓存 → error', async () => {
    seedValid();
    fs.writeFileSync(cacheFile, '{bad');
    const res = await verify();
    expect(res.ok).toBe(false);
    expect(res.checks.some(c => c.item === 'K线缓存' && c.status === 'error')).toBe(true);
  });

  it('损坏快照 → error', async () => {
    seedValid();
    fs.writeFileSync(path.join(dailyDir, 'snapshots', '2026-10-19.json'), '{bad');
    const res = await verify();
    expect(res.ok).toBe(false);
    expect(res.checks.some(c => c.item === '每日快照' && c.status === 'error')).toBe(true);
  });

  it('JSONL 坏行 → warn', async () => {
    seedValid();
    fs.appendFileSync(path.join(realtimeDir, 'alerts', '2026-10-18.jsonl'), 'not-json\n');
    const res = await verify();
    expect(res.checks.some(c => c.item === '实时 JSONL' && c.status === 'warn')).toBe(true);
  });
});

describe('ths data backup', () => {
  it('递归复制 data 目录', async () => {
    seedValid();
    const out = path.join(backupDir, 'backup');
    const res = await cmdData({}, ['backup', '--data', dir, '--dest', out, '--json']);
    expect(res.src).toBe(dir);
    expect(res.out).toBe(out);
    expect(res.files).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(out, 'cache.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'daily', 'lessons.json'))).toBe(true);
  });

  it('目标已存在时自动加后缀', async () => {
    seedValid();
    const out = path.join(backupDir, 'exists');
    fs.mkdirSync(out);
    const res = await cmdData({}, ['backup', '--data', dir, '--dest', out, '--json']);
    expect(res.out).not.toBe(out);
    expect(res.out.startsWith(out)).toBe(true);
  });
});
