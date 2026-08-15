#!/usr/bin/env node
// cli.js — 同花顺 CLI（Bridge Framework 版）
//
// 依赖 Bridge Server (server.js / scripts/bridge.sh start) 运行中，
// 且浏览器已安装油猴脚本 scripts/tonghuashun.user.js 并打开任一 10jqka.com.cn 页面。

const { AuditLogger } = require('./lib/audit');
const { BridgeClient } = require('./lib/client/bridge-client');
const { KlineCache } = require('./lib/cache');
const { safeSerialize } = require('./lib/shared/serialize');
const commands = require('./lib/commands');
const { SITE } = require('./lib/commands/helpers');

// ── 配置 ──
let config = {};
try { config = require('./config.json'); } catch (e) { /* use defaults */ }

// ── Bridge 客户端 ──
const bridge = new BridgeClient({
  host: config.bridge?.host || '127.0.0.1',
  port: config.bridge?.port || 19422,
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
  ths analyze <code> [--period day|week|...] [--count 250] [--market N] [--json] [--compact] [--refresh]
                                                 K线分析：均线/MACD/KDJ/RSI/BOLL/ATR/ADX/CCI/WR/
                                                 MFI/OBV/SAR + 形态 + 支撑压力 + 评分 + 估值
  ths compare [--codes a,b,c | --pool watchlist] [--period day] [--count 250] [--json]
                                                 跨股横向对比（紧凑摘要）
  ths scan --criterion ma-bull,macd-golden [--pool watchlist|--codes a,b|--universe 关键词]
       [--min-score N] [--lookback N] [--oversold N] [--overbought N] [--delay MS] [--refresh] [--json]
                                                 选股扫描（11 种条件）
  ths watchlist add|remove|list|prices|clear <code> [--name X] [--json]
                                                 自选股管理 + 实时价格总览
  ths backtest <code> --strategy ma-cross|rsi|macd|buy-hold
       [--fast N] [--slow N] [--period day] [--count 500] [--fee 0.0005]
       [--stop-loss N] [--slippage X] [--limit-check] [--json]
                                                 策略回测（收益/回撤/胜率/夏普/基准对比）
  ths position <code> --risk N [--stop X] [--atr-mult 2] [--capital N]
       [--price X] [--period day] [--count 250] [--json]
                                                 仓位计算（止损额→仓位，SKILL 铁律落地）
  ths market [--json]                           大盘情绪（三大指数 + 涨跌家数 + 市场温度）
  ths fundflow [--top 10] [--codes a,b] [--json] 资金流排行（主力净流入方向）

通用选项:
  --json    输出原始 JSON（machine-readable）
  --csv     表格类命令输出 CSV（--json 优先）
  --no-log  不写审计日志

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

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (args.includes('--no-log')) audit.setNoLog(true);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  const handler = commands[cmd];
  if (!handler) {
    console.error(`未知命令 "${cmd}"。运行 "ths help" 查看用法。`);
    process.exit(1);
  }

  try {
    const result = await handler(ctx, args.slice(1));
    // 命令已自行打印表格/CSV 时返回 undefined；--json 时返回数据对象，由这里打印
    if (result !== undefined) {
      console.log(JSON.stringify(safeSerialize(result), null, 2));
    }
  } catch (e) {
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
