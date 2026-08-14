# 同花顺 CLI (`ths`)

同花顺(10jqka)行情命令行工具,基于 **Bridge Framework**(油猴脚本 + 本地 Bridge Server + CLI),与 [douyin-cli](https://github.com/Yht20927/douyin-cli) / boss-cli 同一套架构。

- **搜索股票**:中文名 / 代码 / 拼音缩写联想
- **实时行情**:最新价/涨跌/开高低收/量额 + **换手率/量比/市盈率/市净率/总市值/涨跌停价**(需油猴 v1.1.0)
- **批量行情**:一次接口请求多只股票(`ths quotes` / `ths watchlist prices`)
- **K 线**:日 / 周 / 月 / 季 / 60分 / 120分,支持前/后复权、CSV/JSON 导出
- **分时**:每分钟价格/成交量/成交额
- **大盘成交额**:分时 / 日K 两个粒度
- **技术分析**:区间统计 + MA/MACD/KDJ/RSI/BOLL/ATR/ADX/CCI/WR/MFI/OBV/SAR/ROC/VWAP,
  叠加 **K线形态识别**(锤子/吞没/早晨之星/红三兵…)、**支撑压力位**、**多因子综合评分**(0-100 看多/观望/看空)
- **跨股对比**:`ths compare` 一次横向对比多只的评分/信号/形态/支撑压力
- **选股扫描**:11 种条件(金叉/放量突破/均线多头/超卖…),池来源支持自选股/代码/`--universe 关键词`
- **自选股**:本地管理,无需登录,`prices` 实时总览
- **策略回测**:ma-cross / rsi / macd / buy-hold,输出收益/回撤/胜率/盈亏比/夏普
- **本地缓存**:K 线数据落到 `data/cache/ths.json`,重复分析不重复打接口(避免 WAF 风控)
- **股票名称**:quote/analyze/compare/scan 自动显示股票名(本地缓存,search 解析)

```
┌──────────┐    /api/call    ┌──────────────┐   WebSocket/poll   ┌────────────────────┐
│   ths CLI │ ─────────────▶ │ Bridge Server│ ◀───────────────  │ 油猴脚本 (页面上下文) │
└──────────┘  eval 表达式     │  127.0.0.1:  │                   └────────────────────┘
                             │  19422       │      fetch + 静态JWT + cookie
                             └──────────────┘          ↕
              quota-h.10jqka.com.cn / news.10jqka.com.cn / dq.10jqka.com.cn
```

## 快速上手

```bash
# 1. 安装依赖
npm install

# 2. 启动 Bridge Server(幂等,可重复执行)
./scripts/bridge.sh start          # 或 node server.js

# 3. 浏览器装油猴脚本 scripts/tonghuashun.user.js,
#    并打开任一 10jqka.com.cn 页面(如个股页 https://stockpage.10jqka.com.cn/600519/)

# 4. 使用
node cli.js search 茅台
node cli.js kline 600519 --period day --count 20
```

## 命令

```
ths search <keyword> [--json]   搜索股票(代码/名称/拼音)
ths quote <code> [--market N] [--json]     实时行情快照(含换手/量比/PE/市值/涨跌停)
ths quotes [--pool watchlist|--codes a,b] [--json]   批量行情(一次多只)
ths kline <code> [--period day|week|month|quarter|60min|120min]
       [--count N] [--adjust forward|backward|none] [--market N]
       [--json|--csv]           获取 K 线
ths trend <code> [--count N] [--market N] [--json|--csv]   分时数据
ths turnover [--period minute|day] [--count N] [--json]    大盘成交额
ths analyze <code> [--period ...] [--count 250] [--market N] [--json] [--compact] [--refresh]
                                                     K线技术分析(全指标+形态+支撑压力+评分+估值)
ths compare [--codes a,b,c|--pool watchlist] [--json]   跨股横向对比
ths scan --criterion macd-golden [--pool watchlist|--codes a,b|--universe 关键词]
       [--min-score N] [--oversold N] [--overbought N] [--delay MS] [--refresh] [--json]   选股扫描
ths watchlist add|remove|list|prices|clear <code> [--name X] [--json]   自选股(含价格总览)
ths backtest <code> --strategy ma-cross|rsi|macd|buy-hold
       [--fast N] [--slow N] [--count 500] [--fee 0.0005] [--json]   策略回测
ths help                         帮助
```

> **油猴脚本升级**:`ths quote` 的换手率/量比/PE/PB/市值字段依赖 `scripts/tonghuashun.user.js` v1.1.0。
> 请在浏览器 Tampermonkey 里更新该脚本(或重新拖入安装),并刷新 10jqka 页面。升级前这些字段显示 `-`,其余功能不受影响。

示例:

```bash
ths search 茅台
ths quote 600519                                     # 实时行情
ths kline 600519 --period day --count 20             # 贵州茅台 日K
ths kline 000001 --period week --count 52 --json     # 平安银行 周K(JSON)
ths kline 600519 --period 60min --count 100 --csv    # 60分钟K(CSV)
ths kline 886100 --count 20                          # 同花顺板块指数(自动推断 48)
ths trend 600519 --count 30                          # 分时
ths turnover --period day --count 5                  # 大盘成交额(日)
ths analyze 600519 --period day --count 250          # 技术分析
ths analyze 600519 --json                            # 完整指标序列(JSON)
ths analyze 600519 --refresh                         # 强制刷新本地缓存
ths watchlist add 600519 --name 贵州茅台             # 加入自选股
ths watchlist add 000001                             # 加入自选股(平安银行)
ths watchlist prices                                # 自选股实时价格总览(换手/量比/PE/市值)
ths quote 600519                                    # 实时行情(含名称+估值)
ths quotes --codes 600519,000001                    # 批量行情
ths compare --codes 600519,000100,601668            # 跨股横向对比
ths analyze 600519 --compact                        # 单行紧凑摘要
ths scan --pool watchlist --criterion macd-golden    # 自选股里筛 MACD 金叉
ths scan --universe 银行 --criterion ma-bull --min-score 60   # 关键词建池扫描
ths scan --codes 600519,000001 --criterion ma-bull,volume-break --min-score 60
                                                     # 多条件 + 最低评分
ths scan --pool watchlist --criterion rsi-oversold --oversold 25 --delay 500 --json
                                                     # 超卖票(自定义阈值,JSON,节流500ms/只)
ths backtest 600519 --strategy ma-cross --fast 5 --slow 20
ths backtest 000001 --strategy rsi --count 500 --json
```

## 参数说明

| 参数 | 说明 |
|---|---|
| `--period` | 周期,默认 `day` |
| `--count` | 回看条数(映射接口 `begin_time:-N`),默认 250 |
| `--adjust` | 复权 `forward`(前复权,默认)/ `backward`(后复权)/ `none` |
| `--market` | 市场码:`17`=沪 `33`=深 `48`=同花顺板块指数。6 开头自动→17,0/3 开头自动→33,88 开头自动→48;4/8 开头(北交所等)必须手动指定 |
| `--json` | 输出原始 JSON |
| `--csv` | 输出 CSV(`--json` 优先) |

## 选股条件一览

`ths scan --criterion a,b,c` 支持的条件:

| 条件 | 含义 | 可调参数 |
|---|---|---|
| `ma-bull` | 均线多头排列(MA5>MA10>MA20>MA60) | |
| `ma-cross-up` | MA5 上穿 MA20 | `--lookback N` |
| `macd-golden` | MACD 柱由负转正(金叉) | `--lookback N` |
| `macd-bull` | DIF>0 且柱>0 | |
| `rsi-oversold` / `rsi-overbought` | RSI6 超卖/超买 | `--oversold N` / `--overbought N` |
| `kdj-golden` | KDJ 金叉 | `--lookback N` |
| `volume-break` | 放量突破 N 日新高 | `--break-n N` `--vol-ratio X` |
| `atr-range` | 波动率区间(默认 1-6%) | `--atr-min X` `--atr-max X` |
| `pattern` | 最近 5 根出现看多形态 | `--lookback N` |
| `score-gt` | 综合评分 ≥ N | `--score N` |

## 本地缓存

K 线数据缓存于 `data/cache/ths.json`(gitignore),避免重复打同花顺接口触发风控。

- TTL:日/周/月/季 10 分钟,60/120 分钟 1 分钟,可在 `config.json` 的 `cache.ttlMinutes` 覆盖
- `analyze` / `scan` / `backtest` 默认走缓存,`--refresh` 强制刷新
- 自选股存于同一文件;`watchlist clear` 清空自选与 K 线缓存

## 架构

Bridge Server(`lib/server/*`)提供 `/api/health` `/api/status` `/api/call` `/api/connect` `/api/poll` `/api/result`,支持 WebSocket 与 HTTP 长轮询两种传输。油猴脚本 `scripts/tonghuashun.user.js` 注入 `window.__ths`,在页面上下文用浏览器的 fetch/cookie 请求同花顺行情接口,天然绕开反爬与签名问题。

### 认证说明

- `X-Fuyao-Auth` 是**固定静态 JWT**(非登录态,所有客户端共享),已内置在油猴脚本常量中,无需手动获取。
- 浏览器内请求必须带完整认证头(`X-Fuyao-Auth` + `X-Auth-*` + `sw8`),最小头会被 CORS/WAF 拦;这是与裸 curl 行为的重要区别。
- 搜索接口需要浏览器上下文(CORS/反爬),不走纯 HTTP。

### 配置

`config.json`(已被 `.gitignore` 忽略,从 `config.example.json` 复制):

```json
{
  "bridge": {
    "host": "127.0.0.1",
    "port": 19422,
    "token": "",            // 留空则 server 自动生成并写回
    "requestTimeout": 30000
  },
  "cache": {                // K线缓存 TTL(分钟),可覆盖
    "ttlMinutes": { "day": 10, "week": 30, "month": 60, "quarter": 60, "60min": 1, "120min": 1 }
  },
  "scan": { "delayMs": 500 }   // 扫描节流,防 WAF(可被 --delay 覆盖)
}
```

token 需与油猴脚本 `scripts/tonghuashun.user.js` 里的 `CONFIG.token` 保持一致。

### 开发

```bash
npm test            # vitest(32 用例,含真实 HAR fixture 的 K 线解析断言)
./scripts/bridge.sh status    # 查看 server 状态
./scripts/bridge.sh stop      # 停止 server
```

## 免责声明

本项目仅用于**个人学习与研究**,行情数据来自同花顺公开接口。请勿用于商业用途或高频请求;对数据准确性不作任何保证。使用前请知悉同花顺相关服务条款。
