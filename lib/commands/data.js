// lib/commands/data.js — 本地数据校验与备份
//
// 用法:
//   ths data verify [--cache FILE] [--state FILE] [--ledger FILE] [--daily DIR] [--realtime DIR] [--json]
//   ths data backup [--data DIR] [--dest DIR] [--json]
//
// verify 只读检查：JSON 是否可解析、快照/经验结构、JSONL 坏行。
// backup 用 fs.cpSync 递归复制 data/，默认输出 backups/data-YYYYMMDD-HHMMSS。
// 注意：全局 --out 用于捕获 stdout，因此备份目录参数用 --dest，避免冲突。

const fs = require('fs');
const path = require('path');
const { getFlag, renderTable } = require('./helpers');
const { readJson } = require('../store/atomic');
const {
  DEFAULT_FILE: CACHE_FILE, DEFAULT_STATE_FILE, DEFAULT_LEDGER_FILE,
  deriveStateFile, deriveLedgerFile,
} = require('../cache');
const { DailyStore } = require('../daily-store');
const { WatchJournal, DEFAULT_DIR: REALTIME_DIR_RUNTIME } = require('../realtime/watch-journal');
const { toBeijingClock } = require('../trading-hours');

const ROOT = path.join(__dirname, '..', '..');
const REALTIME_DIR = REALTIME_DIR_RUNTIME;

async function cmdData(ctx, args) {
  const sub = (args[0] || 'verify').toLowerCase();
  if (sub === 'verify') return verify(args.slice(1));
  if (sub === 'backup') return backup(args.slice(1));
  if (sub === 'help' || sub === '-h' || sub === '--help') {
    console.log(`ths data 用法:
  data verify [--cache FILE] [--state FILE] [--ledger FILE] [--daily DIR] [--realtime DIR] [--json]
  data backup [--data DIR] [--dest DIR] [--json]

  示例:
    ths data verify
    ths data verify --json
    ths data backup
    ths data backup --dest backups/before-upgrade`);
    return undefined;
  }
  throw new Error(`未知子命令 "${sub}"，可用: verify / backup / help`);
}

function verify(args) {
  const cacheFile = getFlag(args, '--cache', null) || CACHE_FILE;
  const dailyDir = getFlag(args, '--daily', null) || path.join(ROOT, 'data', 'daily');
  const realtimeDir = getFlag(args, '--realtime', null) || REALTIME_DIR;

  const checks = [];
  const add = (item, status, detail) => checks.push({ item, status, detail });

  // 1. K线缓存
  const cache = readJson(cacheFile);
  if (cache.ok) {
    const d = cache.data || {};
    const n = d.kline ? Object.keys(d.kline).length : 0;
    add('K线缓存', 'ok', `${n} 个K线条目`);
  } else if (cache.missing) {
    add('K线缓存', 'warn', `文件不存在: ${cacheFile}`);
  } else {
    add('K线缓存', 'error', `无法解析: ${cacheFile}`);
  }

  // 1b. 用户状态（自选/名称/持仓）
  const stateFile = getFlag(args, '--state', null) ||
    (cacheFile === CACHE_FILE ? DEFAULT_STATE_FILE : deriveStateFile(cacheFile));
  const state = readJson(stateFile);
  if (state.ok) {
    const d = state.data || {};
    const w = Array.isArray(d.watchlist) ? d.watchlist.length : 0;
    const p = Array.isArray(d.positions) ? d.positions.length : 0;
    const nm = d.names && typeof d.names === 'object' ? Object.keys(d.names).length : 0;
    add('用户状态', 'ok', `${w} 自选 / ${p} 持仓 / ${nm} 名称`);
    if (!Array.isArray(d.positions)) add('持仓结构', 'warn', 'positions 不是数组，读取时会被重置');
    if (!Array.isArray(d.watchlist)) add('自选结构', 'warn', 'watchlist 不是数组，读取时会被重置');
  } else if (state.missing && cache.ok) {
    // 旧版 ths.json 回退
    const d = cache.data || {};
    const w = Array.isArray(d.watchlist) ? d.watchlist.length : 0;
    const p = Array.isArray(d.positions) ? d.positions.length : 0;
    add('用户状态', 'warn', `state 文件不存在（旧版缓存中 ${w} 自选 / ${p} 持仓，将在下次启动迁移）`);
  } else if (state.missing) {
    add('用户状态', 'warn', `文件不存在: ${stateFile}`);
  } else {
    add('用户状态', 'error', `无法解析: ${stateFile}`);
  }

  // 1c. 交易流水（append-only JSONL）
  const ledgerFile = getFlag(args, '--ledger', null) ||
    (cacheFile === CACHE_FILE ? DEFAULT_LEDGER_FILE : deriveLedgerFile(cacheFile));
  if (fs.existsSync(ledgerFile)) {
    const l = checkJsonl(ledgerFile);
    add('交易流水', l.bad ? 'warn' : 'ok', `${l.lines} 笔${l.bad ? `，${l.bad} 行损坏` : ''}`);
  } else {
    add('交易流水', 'warn', '文件不存在（尚未记录交易）');
  }

  // 2. 每日快照
  const store = new DailyStore({
    snapDir: path.join(dailyDir, 'snapshots'),
    lessonsFile: path.join(dailyDir, 'lessons.json'),
  });
  const dates = store.listDates();
  let snapErrors = 0;
  for (const date of dates) {
    const f = store.loadSnapshotFile(date);
    if (!f) snapErrors++;
  }
  add('每日快照', snapErrors ? 'error' : 'ok',
    `${dates.length} 个日期${snapErrors ? `，${snapErrors} 个损坏` : ''}`);

  // 3. 经验/建议
  const lessonsFile = path.join(dailyDir, 'lessons.json');
  const lessons = readJson(lessonsFile);
  if (lessons.ok) {
    add('经验/建议', 'ok', `${(lessons.data.lessons || []).length} 条经验 / ${(lessons.data.poolSuggestions || []).length} 条建议`);
  } else if (lessons.missing) {
    add('经验/建议', 'warn', '文件不存在');
  } else {
    add('经验/建议', 'error', '无法解析');
  }

  // 4. 实时 JSONL
  const journal = new WatchJournal({ dir: realtimeDir });
  const rDates = journal.listDates();
  let jsonlBad = 0;
  let jsonlLines = 0;
  for (const date of rDates) {
    for (const sub2 of ['alerts', 'ticks']) {
      const file = path.join(realtimeDir, sub2, `${date}.jsonl`);
      const r = checkJsonl(file);
      jsonlLines += r.lines;
      jsonlBad += r.bad;
    }
  }
  add('实时 JSONL', jsonlBad ? 'warn' : 'ok',
    `${rDates.length} 个日期 / ${jsonlLines} 行${jsonlBad ? `，${jsonlBad} 行损坏` : ''}`);

  const errors = checks.filter(c => c.status === 'error').length;
  const warnings = checks.filter(c => c.status === 'warn').length;

  if (args.includes('--json')) {
    return { ok: errors === 0, errors, warnings, checks };
  }

  console.log('════ 本地数据校验 ════');
  console.log(renderTable(checks.map(c => ({
    item: c.item,
    status: c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗',
    detail: c.detail,
  })), [
    { header: '项', key: 'item' },
    { header: '状态', key: 'status' },
    { header: '详情', key: 'detail' },
  ]));
  console.log(errors ? `\n✗ ${errors} 个错误 / ${warnings} 个警告` : `\n✓ 校验通过${warnings ? `（${warnings} 个警告）` : ''}`);
  if (errors) process.exitCode = 1;
  return undefined;
}

function checkJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { lines: 0, bad: 0 }; }
  let lines = 0;
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
    try { JSON.parse(line); } catch (e) { bad++; }
  }
  return { lines, bad };
}

function backup(args) {
  const src = getFlag(args, '--data', null) || path.join(ROOT, 'data');
  const c = toBeijingClock();
  const pad = n => String(n).padStart(2, '0');
  const stamp = c.dateStr.replace(/-/g, '') + `-${pad(c.hour)}${pad(c.min)}${pad(c.sec)}`;
  let out = getFlag(args, '--dest', null) || path.join(ROOT, 'backups', `data-${stamp}`);

  if (!fs.existsSync(src)) throw new Error(`数据目录不存在: ${src}`);
  const rel = path.relative(src, out);
  if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('备份目录不能位于数据目录内部，请用 --out 指定外部目录');
  }
  if (fs.existsSync(out)) out = `${out}-${Date.now()}`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.cpSync(src, out, { recursive: true });

  let files = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files++;
    }
  };
  walk(out);

  if (args.includes('--json')) return { src, out, files };
  console.log(`✓ 已备份 ${src} → ${out}（${files} 个文件）`);
  return undefined;
}

module.exports = cmdData;
