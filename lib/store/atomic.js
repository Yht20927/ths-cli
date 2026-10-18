// lib/store/atomic.js — 原子写 + 进程锁 + 损坏隔离（零依赖）
//
// 目标：解决 JSON 文件“读-改-写”并发丢更新、固定 .tmp 竞争、坏文件静默覆盖。
// 协议：lock → 重新读盘 → 合并 → 唯一 tmp → fsync → rename → fsync(dir) → unlock
//
// 锁是同步的（与现有同步存储 API 匹配）；竞争时短暂阻塞等待，超时抛 ELOCKED。
// 崩溃遗留的锁超过 staleMs 会被回收。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LOCK_TIMEOUT = 3000;
const DEFAULT_LOCK_STALE = 15000;

function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch (e) {
    // 极老 Node/受限环境：退化为忙等（不应发生）
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function uniqueTmp(file) {
  return `${file}.${process.pid}.${Date.now().toString(36)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
}

/**
 * 原子写 JSON。
 * @param {string} file
 * @param {*} obj
 * @param {object} [opts] { fsync=true, fsyncDir=true }
 */
function atomicWriteJson(file, obj, opts = {}) {
  ensureDir(file);
  const tmp = uniqueTmp(file);
  const text = JSON.stringify(obj);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    if (opts.fsync !== false) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  if (opts.fsyncDir !== false) {
    try {
      const dfd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e) { /* 某些平台/文件系统不支持目录 fsync */ }
  }
}

/**
 * 获取文件锁。
 * @param {string} file 目标文件（锁文件为 file + '.lock'）
 * @param {object} [opts] { timeoutMs, staleMs, lockFile }
 * @returns {Function} release()
 */
function acquireLock(file, opts = {}) {
  const lockFile = opts.lockFile || `${file}.lock`;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_LOCK_TIMEOUT;
  const staleMs = opts.staleMs != null ? opts.staleMs : DEFAULT_LOCK_STALE;
  const start = Date.now();

  for (;;) {
    try {
      ensureDir(lockFile);
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(lockFile); } catch (e) { /* ignore */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁回收
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockFile); } catch (e2) { /* ignore */ }
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
        throw e2;
      }
      if (Date.now() - start >= timeoutMs) {
        const err = new Error(`文件被其他进程锁定: ${lockFile}`);
        err.code = 'ELOCKED';
        throw err;
      }
      sleepSync(25);
    }
  }
}

/** 同步 withLock */
function withLock(file, fn, opts = {}) {
  const release = acquireLock(file, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

/**
 * 读 JSON。
 * @returns {{ok:true,data:any}|{ok:false,missing?:boolean,corrupt?:boolean,error:Error}}
 */
function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, missing: true, error: e };
    return { ok: false, corrupt: true, error: e };
  }
}

/** 把损坏文件重命名为 .corrupt-<ts>，返回归档路径 */
function quarantineFile(file, opts = {}) {
  try {
    const archived = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, archived);
    if (opts.warn !== false) {
      process.stderr.write(`⚠ 文件损坏，已隔离: ${file} → ${archived}\n`);
    }
    return archived;
  } catch (e) {
    return null;
  }
}

module.exports = {
  atomicWriteJson,
  acquireLock,
  withLock,
  readJson,
  quarantineFile,
  sleepSync,
};
