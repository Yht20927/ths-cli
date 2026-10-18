// tests/store-atomic.test.js — 原子写 / 文件锁 / 损坏隔离

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  atomicWriteJson, acquireLock, withLock, readJson, quarantineFile,
} from '../lib/store/atomic.js';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ths-atomic-'));
  file = path.join(dir, 'data.json');
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

describe('atomicWriteJson', () => {
  it('写入后可读，且不残留 tmp', () => {
    atomicWriteJson(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(fs.readdirSync(dir).filter(n => n.endsWith('.tmp'))).toHaveLength(0);
  });

  it('覆盖写', () => {
    atomicWriteJson(file, { a: 1 });
    atomicWriteJson(file, { a: 2 });
    expect(readJson(file).data.a).toBe(2);
  });
});

describe('acquireLock / withLock', () => {
  it('同一时刻只能持有一个锁；超时抛 ELOCKED', () => {
    const release = acquireLock(file, { timeoutMs: 100 });
    try {
      expect(() => acquireLock(file, { timeoutMs: 30 })).toThrow(/锁定|ELOCKED/);
    } finally {
      release();
    }
    const release2 = acquireLock(file, { timeoutMs: 100 });
    release2();
  });

  it('陈旧锁会被回收', () => {
    const lockFile = `${file}.lock`;
    fs.writeFileSync(lockFile, '{}');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, old, old);
    const release = acquireLock(file, { timeoutMs: 100, staleMs: 1000 });
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('withLock 返回值并释放锁', () => {
    const v = withLock(file, () => 42);
    expect(v).toBe(42);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });
});

describe('readJson / quarantine', () => {
  it('缺失文件标记 missing', () => {
    const r = readJson(file);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
  });

  it('损坏 JSON 标记 corrupt 并可隔离', () => {
    fs.writeFileSync(file, '{bad');
    const r = readJson(file);
    expect(r.ok).toBe(false);
    expect(r.corrupt).toBe(true);
    const archived = quarantineFile(file, { warn: false });
    expect(archived).toContain('.corrupt-');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(archived)).toBe(true);
  });
});
