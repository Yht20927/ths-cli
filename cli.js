#!/usr/bin/env node
// cli.js — 同花顺 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js / scripts/bridge.sh start) 运行中，
// 且浏览器已安装油猴脚本 scripts/tonghuashun.user.js 并打开任一 10jqka.com.cn 页面。

const fs = require('fs');
const path = require('path');
const { AuditLogger } = require('./lib/audit');
const { BridgeClient } = require('./lib/client/bridge-client');
const { KlineCache } = require('./lib/cache');
const { safeSerialize } = require('./lib/shared/serialize');
const commands = require('./lib/commands');
const { SITE } = require('./lib/commands/helpers');
const { detectCapabilities } = require('./lib/render/capabilities');
const { resolveTheme, normalizeThemeName } = require('./lib/render/theme');
const {
  configureRender, getRenderOptions,
  configureOutput, getOutputOptions,
} = require('./lib/render/output');

// ── 配置 ──
let config = {};
try { config = require('./config.json'); } catch (e) { /* use defaults */ }

// ── Bridge 客户端 ──
const bridge = new BridgeClient({
  host: config.bridge?.host || '127.0.0.1',
  port: config.bridge?.port || 19429,
  token: config.bridge?.token || '',
});

// ── 审计日志 ──
const audit = new AuditLogger();

// ── 本地缓存（K线 + 自选股，data/cache/ths.json）──
const cache = new KlineCache();

// ═══════════════════════════════════════════════════════════
// Bridge 通信（通过 BridgeClient）
// ═══════════════════════════════════════════════════════════

async function bridgeCall(expression, awaitPromise = true) {
  const resp = await bridge.call({ site: SITE, expression, awaitPromise });
  if (resp.ok) return resp.value;
  throw new Error(resp.error || 'Bridge Server 返回未知错误');
}

async function loggedCall(endpoint, params, expression) {
  const t0 = Date.now();
  try {
    const result = await bridgeCall(expression);
    audit.logApiCall(endpoint, params, Date.now() - t0, 'success', {});
    return result;
  } catch (e) {
    audit.logApiCall(endpoint, params, Date.now() - t0, 'error', { error: e.message });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// 命令上下文（注入到各命令模块）
// ═══════════════════════════════════════════════════════════

const ctx = { bridge, audit, config, cache, bridgeCall, loggedCall };

// ═══════════════════════════════════════════════════════════
// 全局渲染/输出参数（从 argv 中剥离，命令看不到）
// ═══════════════════════════════════════════════════════════

const RENDER_FLAGS = new Set([
  '--width', '--height', '--theme', '--format', '--out',
  '--no-color', '--ascii', '--emoji',
]);

function positiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 解析全局参数，返回剥离后的命令参数。
 * 支持 --flag value 与 --flag=value。
 */
function parseGlobalArgs(argv) {
  const rest = [];
  const g = {
    width: null, height: null, theme: 'cn', format: null, out: null,
    noColor: false, ascii: false, emoji: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(0, eq) : a;
    const inline = eq >= 0 ? a.slice(eq + 1) : null;
    const needValue = () => {
      if (inline != null) return inline;
      const v = argv[i + 1];
      if (v !== undefined && !String(v).startsWith('--')) { i++; return v; }
      return null;
    };
    switch (name) {
      case '--width': g.width = positiveInt(needValue()); break;
      case '--height': g.height = positiveInt(needValue()); break;
      case '--theme': g.theme = normalizeThemeName(needValue() || 'cn'); break;
      case '--format': g.format = String(needValue() || '').toLowerCase(); break;
      case '--out': g.out = needValue(); break;
      case '--no-color': g.noColor = true; break;
      case '--ascii': g.ascii = true; break;
      case '--emoji': g.emoji = true; break;
      default: rest.push(a);
    }
  }

  // --format json/csv 对旧命令做兼容注入（旧命令只认 --json/--csv）
  const format = g.format || (rest.includes('--json') ? 'json' : rest.includes('--csv') ? 'csv' : 'text');
  if (format === 'json' && !rest.includes('--json')) rest.push('--json');
  if (format === 'csv' && !rest.includes('--csv')) rest.push('--csv');
  return { globals: { ...g, format }, args: rest };
}

function configureRendering(globals) {
  const caps = detectCapabilities({
    width: globals.width || undefined,
    height: globals.height || undefined,
    ascii: globals.ascii,
    emoji: globals.emoji,
    color: globals.noColor ? false : undefined,
  });
  const theme = resolveTheme(globals.theme, caps);
  const color = caps.colorDepth !== 'none' &&
    globals.format !== 'json' && globals.format !== 'csv';
  // Batch 1 只接受显式 --width；等命令补上列 priority 后再开启 TTY 自动约束，
  // 避免旧命令在窄终端被无差别压到 3 列宽。
  const width = globals.width || null;

  configureRender({
    width,
    border: caps.unicode === 'full' && caps.isTTY ? 'round' : 'ascii',
    color,
    theme,
    unicode: caps.unicode,
    emoji: caps.emoji,
    themeName: theme.name,
  });
  configureOutput({ format: globals.format, out: globals.out, color });
  ctx.render = { caps, options: getRenderOptions() };
  ctx.output = getOutputOptions();
  return caps;
}

// ═══════════════════════════════════════════════════════════
// 帮助
// ═══════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
同花顺 CLI（Bridge Framework）

  ths search <keyword> [--json]               搜索股票（代码/名称/拼音）
  ths quote <code> [--market N] [--json]      实时行情快照（含换手/量比/PE/市值/涨跌停）
  ths quotes [--pool watchlist|--codes a,b] [--json]   批量行情（一次多只）
  ths kline <code> [--period day|week|month|quarter|60min|120min]
       [--count N] [--adjust forward|backward|none] [--market N]
       [--json|--csv]                         获取 K 线
  ths trend <code> [--count N] [--market N] [--json|--csv]   分时数据
  ths turnover [--period minute|day] [--count N] [--json]    大盘成交额
  ths analyze <code> [--period day|week|...] [--count 250] [--market N] [--json] [--compact] [--chart] [--refresh]
                                                 K线分析：均线/MACD/KDJ/RSI/BOLL/ATR/ADX/CCI/WR/
                                                 MFI/OBV/SAR + 形态 + 支撑压力 + 评分 + 估值
                                                 --chart 追加终端 K 线图
  ths chart <code> [--period day|week|60min|...] [--count N(120)] [--market N] [--json]
                                                 终端 K 线图（MA5/MA20 + 成交量）
  ths compare [--codes a,b,c | --pool watchlist] [--period day] [--count 250] [--json]
                                                 跨股横向对比（紧凑摘要）
  ths scan --criterion ma-bull,macd-golden [--pool watchlist|--codes a,b|--universe 关键词]
       [--min-score N] [--lookback N] [--oversold N] [--overbought N] [--delay MS] [--refresh] [--json] [--only-hot]
                                                 选股扫描（11 种条件；--only-hot 大盘普跌时抑制做多）
  ths watchlist add|remove|list|prices|clear <code> [--name X] [--json]
                                                 自选股管理 + 实时价格总览
  ths backtest <code> --strategy ma-cross|rsi|macd|score|resonance|buy-hold
       [--fast N] [--slow N] [--score-buy 60] [--score-sell 40] [--score-min 60] [--adx 25]
       [--period day] [--count 500] [--fee 0.0005]
       [--stop-loss N] [--slippage X] [--limit-check] [--json]
                                                 策略回测（含实战打分/共振策略：回测自己的打法）
  ths position <code> --risk N [--stop X] [--target X] [--atr-mult 2] [--capital N]
       [--price X] [--period day] [--count 250] [--json]
                                                 仓位计算（止损额→仓位 + 盈亏比，SKILL 铁律落地）
  ths market [--json]                           大盘情绪（三大指数 + 涨跌家数 + 市场温度）
  ths index [1A0001|399001|399006] [--json]      大盘指数趋势（上证/深成/创业板 MA20/支撑压力，
                                                 Node 直连）——"不逆大盘"第一关
  ths fundflow [--top 10] [--codes a,b] [--json] 资金流排行（主力净流入方向）
  ths sectors [--type industry|concept] [--top N] [--sort pct|netIn|amount] [--json]
                                                 板块强弱排名（行业/概念，代码可 analyze 深挖）
  ths rank [--kind zdfph|cxg|cxd|lxsz|lxxd|cxfl|cxsl|xstp|xxtp|ljqs|ljqd] [--top N] [--json]
                                                 涨跌幅排行 + 技术形态选股族
  ths lhb [--top N] [--json]                    龙虎榜（营业部席位/机构游资）
  ths fundamental <code> [--json]               F10 财务概况（毛利率/ROE/增速/负债率）
  ths portfolio add|sell|list|risk|history|remove|clear
       add <code> --qty N --price X [--name X] [--fee X] [--note X]
       sell <code> --qty N --price X [--fee X]
       list [--capital N] [--risk] [--json]
       risk <code> [--stop X] [--target X] [--json]   # 止损/目标/盈亏比
                                                 持仓台账（记录买卖→盈亏/止损/复盘）
  ths daily run [--codes a,b] [--refresh] [--min-n N] [--since N] [--candidates a,b,c] [--json]
                                                 每日监控+快照+复盘+池建议（学习回路）
  ths daily review [--since N] [--code X] [--min-n N] [--json]   复盘命中率统计（纯本地）
  ths daily lessons [--json]                      经验教训 + 待确认池建议
  ths daily lesson-add "复盘文字" [--category X] [--code X]       手动记一条经验
  ths daily lesson-remove <id>                    删除一条经验
  ths daily snapshot [--date YYYY-MM-DD] [--code X] [--json]     查看历史快照
  ths daily apply <Sid> [--yes]                   执行池建议（剔除/加入/减仓）
                                                 每日复盘闭环：分析落盘→3/5日回填命中→经验积累
  ths report daily|review|backtest|risk|portfolio [选项]
       [--format md|html|json] [--out FILE]      静态研究报告（快照/回测/风控/持仓）
                                                 详细用法: ths report --help
  ths watch [--pool watchlist|--codes a,b] [--interval N(30s)] [--once]
       [--chase 7] [--drop -5] [--vol 3] [--cooldown 300] [--until HH:MM] [--quiet] [--json] [--tui] [--no-journal]
                                                 盘中实时追踪：轮询自选池，对照固化止损/
                                                 支撑压力/涨跌停/量比/涨幅阈值告警（Ctrl+C 退出）
                                                 --tui 交互式面板（总览/告警/详情/帮助，需 TTY）
                                                 --no-journal 不写 data/realtime 状态/告警/tick
  ths watch --once                              单次体检（脚本可用）[--json 输出结构化结果]
  ths replay [YYYY-MM-DD] [--ticks] [--json]     盘中回放：告警时间线 + tick 摘要（本地 JSONL）
  ths data verify [--json]                       本地数据校验（缓存/快照/经验/实时 JSONL）
  ths data backup [--dest DIR]                   递归备份 data/ 到 backups/
  ths risk [--pool watchlist|--codes a,b] [--count N(120)] [--weights A=0.5,B=0.3] [--json]
                                                组合风控画像：相关矩阵/有效独立标的/
                                                集中度(HHI)/组合波动/单票ATR%/超重&高相关提示

通用选项:
  --json / --format json    输出原始 JSON（machine-readable）
  --csv  / --format csv     表格类命令输出 CSV（--json 优先）
  --no-log                  不写审计日志
  --no-color                关闭 ANSI 颜色
  --ascii                   使用 ASCII 边框/符号
  --emoji                   使用 emoji 状态图标（默认几何符号）
  --width N                 覆盖终端宽度（60/80/100/120/160）
  --theme NAME              cn(默认红涨绿跌)|intl|mono|high-contrast
  --out FILE                把本次 stdout 写入文件（诊断仍走 stderr）

市场码自动推断: 6 开头→沪(17)，0/3 开头→深(33)，88 开头→板块指数(48)
  （4/8 开头北交所等需手动 --market）

前置条件:
  1. 运行 Bridge Server:  node server.js  或  ./scripts/bridge.sh start
  2. 浏览器安装油猴脚本 scripts/tonghuashun.user.js
  3. 浏览器打开任一 10jqka.com.cn 页面（如 https://stockpage.10jqka.com.cn/600519/）

示例:
  ths search 茅台
  ths quote 600519
  ths kline 600519 --period day --count 20
  ths kline 600519 --period week --count 52 --json
  ths kline 000001 --period 60min --count 100 --csv
  ths kline 886100 --count 20                  # 同花顺板块指数（自动推断 48）
  ths trend 600519 --count 30
  ths turnover --period day --count 5
  ths analyze 600519 --period day --count 250
`);
}

// ═══════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════

async function dispatch(cmd, args) {
  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令 "${cmd}"。运行 "ths help" 查看用法。`);
    process.exit(2);
  }
  const result = await handler(ctx, args);
  // 命令已自行打印表格/CSV 时返回 undefined；--json 时返回数据对象，由这里打印
  if (result !== undefined) {
    console.log(JSON.stringify(safeSerialize(result), null, 2));
  }
}

/**
 * --out：捕获本次命令写到 stdout 的内容，结束后一次性写文件。
 * 诊断信息走 stderr，不会被捕获。
 */
async function withOutputFile(out, fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (typeof encoding === 'function') encoding();
    else if (typeof cb === 'function') cb();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.concat(chunks));
  }
}

async function main() {
  const raw = process.argv.slice(2);
  const { globals, args } = parseGlobalArgs(raw);
  const cmd = args[0];

  if (args.includes('--no-log')) audit.setNoLog(true);
  configureRendering(globals);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (['md', 'html', 'ndjson'].includes(globals.format) && cmd !== 'report') {
    process.stderr.write(`⚠ 输出格式 ${globals.format} 仅 report 支持，本次按 text 输出\n`);
    configureOutput({ format: 'text' });
  }

  if (globals.format === 'csv' && !['kline', 'trend'].includes(cmd)) {
    process.stderr.write('⚠ 该命令暂未接入 CSV，本次按 text 输出\n');
  }

  try {
    if (globals.out) await withOutputFile(globals.out, () => dispatch(cmd, args.slice(1)));
    else await dispatch(cmd, args.slice(1));
    audit.close();
  } catch (e) {
    audit.close();
    const msg = e.message || String(e);
    // 友好错误提示
    if (/ECONNREFUSED|Bridge Server 未启动|connect ECONNREFUSED/.test(msg)) {
      console.error('[ths] Bridge Server 未运行 — 请先执行: node server.js 或 ./scripts/bridge.sh start');
    } else if (/Unauthorized|无效的 access token/i.test(msg)) {
      console.error('[ths] Bridge token 不匹配 — 请同步 config.json 与油猴脚本 scripts/tonghuashun.user.js 里的 bridge.token');
    } else if (/polling client/.test(msg)) {
      console.error('[ths] 没有浏览器连接 — 请确认油猴脚本已安装且浏览器打开了 10jqka.com.cn 页面');
    } else {
      console.error(`[ths] ${msg}`);
    }
    process.exit(1);
  }
}

main();
