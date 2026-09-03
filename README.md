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
- **策略回测**:ma-cross / rsi / macd / **score(综合评分) / resonance(共振)** / buy-hold,输出收益/回撤/胜率/盈亏比/夏普,支持 ATR 止损/滑点/一字板约束/buy-hold 自动对比——可**回测自己的实战打分/共振打法**,不只测简单均线策略
- **仓位计算**:`ths position` 按"目标止损额 ÷ 止损距离%"反推仓位(SKILL 仓位铁律落地),自动取支撑位与 ATR×N 止损中更远者防扫损,并输出**盈亏比**(目标空间 ÷ 止损空间,压力位自动取,`--target` 可手动指定)
- **大盘情绪**:`ths market` 三大指数快照 + 涨跌家数 + 市场温度(需油猴 v1.2.0)
- **资金流**:`ths fundflow` 主力净流入排行(需油猴 v1.2.0)
- **板块强弱**:`ths sectors` 行业/概念板块涨跌幅+净流入+领涨股排名,板块代码可直接 `ths analyze` 深挖(Node 直连)
- **行情排行**:`ths rank` 涨跌幅排行(当日/三日/五日)+ 10 种技术形态选股(创新高/连续上涨/持续放量/突破…) (Node 直连)
- **龙虎榜**:`ths lhb` 营业部席位/机构游资,净额排序(Node 直连)
- **F10 财务**:`ths fundamental <code>` 毛利率/ROE/营收净利增速/负债率 + 去年同期对比与点评(Node 直连)
- **持仓台账**:`ths portfolio` 记录建仓/加仓/减仓 → 摊薄成本/浮动与已实现盈亏/**建仓即固化止损**/盈亏比;`daily run` 每日查破位并记连续违规天数(本地 JSON)
- **盘中实时追踪**:`ths watch` 轮询自选池,对照**固化止损/支撑压力/涨跌停/量比/涨幅阈值**做**边沿触发**告警(🔴 破位/🟠 追高急跌/🟡 涨跌停放量),把"破止损必走"纪律从收盘后提前到盘中破位瞬间;`scripts/watch.sh` 后台常驻(前台 `node cli.js watch`,Ctrl+C 退出)
- **组合/风控画像**:`ths risk` 把自选池/指定标的当**纸面组合**算:相关矩阵+**有效独立标的数**、集中度(HHI)、组合波动(日/年化)、单票 ATR% 波动预算,并标出 **≥0.7 高相关对**与**超 ≤20% 仓位铁律**的标的(纯本地离线)
- **大盘趋势判定**:`ths index` 看 上证/深成/创业板 是否站上 MA20、均线排列、支撑压力、近5日涨跌(Node 直连同花顺指数日K)——"不逆大盘"第一关;`daily run` 报告与快照并入指数趋势
- **选股方向门控**:`ths scan --only-hot` 大盘**普跌弱势**时抑制做多类命中(不逆大盘落到选股)
- **本地缓存**:K 线数据落到 `data/cache/ths.json`,重复分析不重复打接口(避免 WAF 风控)
- **股票名称**:quote/analyze/compare/scan 自动显示股票名(本地缓存,search 解析)

```
┌──────────┐    /api/call    ┌──────────────┐   WebSocket/poll   ┌────────────────────┐
│   ths CLI │ ─────────────▶ │ Bridge Server│ ◀───────────────  │ 油猴脚本 (页面上下文) │
└──────────┘  eval 表达式     │  127.0.0.1:  │                   └────────────────────┘
                             │  19429       │      fetch + 静态JWT + cookie
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
       [--min-score N] [--oversold N] [--overbought N] [--delay MS] [--refresh] [--json] [--only-hot]
                                                                                       选股扫描(--only-hot 大盘普跌抑制做多)
ths index [1A0001|399001|399006] [--json]    大盘指数趋势(MA20/支撑压力/近5日)   [Node直连]
ths watchlist add|remove|list|prices|clear <code> [--name X] [--json]   自选股(含价格总览)
ths backtest <code> --strategy ma-cross|rsi|macd|score|resonance|buy-hold
       [--fast N] [--slow N] [--score-buy 60] [--score-sell 40] [--score-min 60] [--adx 25]
       [--count 500] [--fee 0.0005]
       [--stop-loss N] [--slippage X] [--limit-check] [--json]   策略回测(含实战打分/共振)
ths position <code> --risk N [--stop X] [--target X] [--atr-mult 2] [--capital N]
       [--price X] [--period day] [--count 250] [--json]   仓位计算(止损额→仓位+盈亏比)
ths market [--json]    大盘情绪(三大指数+涨跌家数+市场温度)   [油猴 v1.2.0]
ths fundflow [--top 10] [--codes a,b] [--json]   资金流排行(主力净流入)   [油猴 v1.2.0]
ths sectors [--type industry|concept] [--top N] [--sort pct|netIn|amount] [--json]   板块强弱排名   [Node 直连]
ths rank [--kind zdfph|cxg|cxd|lxsz|lxxd|cxfl|cxsl|xstp|xxtp|ljqs|ljqd] [--top N] [--json]   涨跌幅/技术形态排行   [Node 直连]
ths lhb [--top N] [--json]   龙虎榜(营业部席位)   [Node 直连]
ths fundamental <code> [--json]   F10 财务概况   [Node 直连]
ths portfolio add|sell|list|risk|history|remove|clear <code> [--qty N] [--price X] [--stop X] [--capital N] [--risk] [--json]   持仓台账(建仓固化止损)   [本地]
ths portfolio risk <code> [--stop X --save]   固化止损/目标/盈亏比(--save 上移止损)   [本地+行情]
ths daily run [--codes a,b] [--refresh] [--min-n N] [--since N] [--candidates a,b,c] [--json]
      每日监控+快照+复盘+池建议(学习回路)+方向环境(板块/资金/龙虎榜)+信号分级+破位追踪   [本地+行情]
ths daily review [--since N] [--code X] [--min-n N] [--json]   复盘命中率统计   [本地]
ths daily lessons [--json]    经验教训+待确认池建议   [本地]
ths daily lesson-add "复盘文字" [--category X] [--code X]    手动记一条经验   [本地]
ths daily snapshot [--date D] [--code X] [--json]   查看历史快照   [本地]
ths daily apply <Sid> [--yes]   执行池建议(剔除/加入/减仓)   [本地]
ths watch [--pool watchlist|--codes a,b] [--interval N(30s)] [--once]
       [--chase 7] [--drop -5] [--vol 3] [--until HH:MM] [--quiet] [--json]
                              盘中实时追踪(固化止损/支撑/阈值边沿告警)   [Bridge+本地]
ths watch --once              单次体检(脚本可用)   [Bridge+本地]
ths risk [--pool watchlist|--codes a,b] [--count N(120)] [--weights A=0.5,B=0.3] [--json]
                              组合风控画像(相关/独立标的/集中度/波动)   [本地+行情]
ths help                         帮助
```

> **油猴脚本升级**:`ths quote` 的换手率/量比/PE/PB/市值字段依赖 `scripts/tonghuashun.user.js` v1.1.0;
> `ths market` / `ths fundflow` 依赖 v1.2.0。
> 请在浏览器 Tampermonkey 里更新该脚本(或重新拖入安装),并刷新 10jqka 页面。升级前这些功能显示 `-` 或报"油猴脚本需 v1.2.0",其余功能不受影响。

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
ths backtest 600519 --strategy ma-cross --stop-loss 2 --slippage 0.001 --limit-check
                                                     # 带 ATR 止损/滑点/一字板约束
ths position 000001 --risk 3000 --capital 100000     # 仓位计算(止损额→仓位+盈亏比)
ths position 600519 --risk 10000 --stop 1300         # 手动止损价
ths position 600519 --risk 10000 --stop 1300 --target 1500   # 手动止损价+目标价(算盈亏比)
ths market                                          # 大盘情绪(指数+涨跌家数+温度)
ths fundflow --top 10                               # 主力净流入 Top10
ths fundflow --codes 600519,000001                  # 指定票在资金流榜中的位置
ths sectors --top 10 --sort netIn                   # 行业板块净流入排名
ths sectors --type concept --top 5                  # 概念热点(题材事件日历)
ths rank --kind zdfph --top 10                      # 涨跌幅排行(当日/三日/五日)
ths rank --kind ljqs --top 10                       # 量价齐升选股
ths lhb --top 10                                    # 龙虎榜 Top10(净额)
ths lhb --json                                      # 龙虎榜完整席位明细
ths fundamental 600519                              # F10 财务概况(茅台)
ths portfolio add 600519 --qty 100 --price 1300 --name 贵州茅台   # 建仓
ths portfolio sell 600519 --qty 40 --price 1420 --fee 5          # 减仓(记已实现盈亏)
ths portfolio list --capital 100000 --risk          # 持仓总览(现价/浮盈亏/止损/盈亏比/仓位占比)
ths portfolio risk 600519                           # 单只止损/目标/盈亏比
ths portfolio history                               # 交易流水
ths daily run                                       # 每日监控+复盘+建议(自选池)
ths daily run --codes 600519,000001                 # 指定池
ths daily run --candidates 000049,688508            # 候选参与"加入"评估
ths daily review --since 90                         # 复盘命中率统计
ths daily lesson-add "完整共振才是买点" --category 策略 --code 000049
ths daily snapshot --date 2026-08-17 --code 000049  # 查看某日某股快照
ths daily apply S01 --yes                           # 执行池建议
ths watch --once                                    # 盘中单次体检(自选池)
ths watch --interval 30                             # 前台盯盘,盘中破止损/触阈值即 🔴/🟠 提醒
scripts/watch.sh start 15                           # 后台常驻盯盘(日志 logs/watch.log)
ths risk --codes 000725,000100                       # 组合相关性/集中度画像(纸面组合)
ths index                                            # 上证/深成/创业板 MA20 趋势(不逆大盘)
ths backtest 000725 --strategy resonance --count 300 # 用共振回测自己的打法
ths scan --pool watchlist --only-hot --criterion ma-bull   # 大盘普跌时抑制做多
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
- **半截 K 线卫生**:盘中(<15:05)拉到的日 K 末根是"在途未收盘 bar",`backtest` 默认剔除它(close-to-close 只用已定型 bar,`--include-forming` 显式包含,应对 15:00–15:05 缓冲窗),`watch` 算支撑压力也剔除;`analyze`/`scan`/`daily` 保留它(盘中实时信号即期望语义)

## 每日学习回路(`ths daily`)

把「每日监控 → 复盘 → 经验积累」闭环化:`daily run` 一次取数,把每只监控股的分析快照按交易日落盘
到 `data/daily/snapshots/YYYY-MM-DD.json`,3/5 个交易日后再自动回填该快照的 outcome(看对/看错、
支撑是否守住、是否触压力),按特征桶累计命中率,并给出池建议(剔除/减仓/加入)。经验与建议存
`data/daily/lessons.json`,可长期复用。

- 复盘窗口按「快照序列定位」,无交易日历依赖;缺跑的日子自动顺延,周末同日重跑幂等
- 命中率桶:信号/评分/均线/市场情绪(MACD/KDJ/RSI/ADX/ATR/形态/共振),`n≥--min-n`(默认5)才显示
- 池建议只出建议不执行,`ths daily apply <Sid> --yes` 确认后才改自选池
- `review / lessons / snapshot / apply` 纯本地离线可用;`run` 各网络步失败打 ⚠ 不中断
- 每日一键:`npm run daily`(scripts/daily.sh 已改为跑 `ths daily run` + `review`)

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
    "port": 19429,
    "token": "",            // 留空则 server 自动生成并写回
    "requestTimeout": 30000
  },
  "cache": {                // K线缓存 TTL(分钟),可覆盖
    "ttlMinutes": { "day": 10, "week": 30, "month": 60, "quarter": 60, "60min": 1, "120min": 1 }
  },
  "scan": { "delayMs": 500 },   // 扫描节流,防 WAF(可被 --delay 覆盖)
  "score": {                    // 综合评分六因子权重(可覆盖部分,自动归一化)
    "weights": { "trend": 0.25, "momentum": 0.20, "volume": 0.15, "swing": 0.15, "risk": 0.10, "pattern": 0.15 }
  },
  "position": { "risk": 5000 }  // ths position 默认单笔风险额(可被 --risk 覆盖)
}
```

token 需与油猴脚本 `scripts/tonghuashun.user.js` 里的 `CONFIG.token` 保持一致。

### 已知限制

- **涨停梯队 / 板块成分**:同花顺 `q.10jqka.com.cn` 与 `data.10jqka.com.cn` 的涨停池、板块成分接口被 CORS/WAF 拦截(实测 `fetch` 全部 NetworkError 或空响应),故未提供 `ths limitup` / `ths board` 命令。替代路径:
  - 大盘温度 → `ths market`(涨跌家数)
  - 资金进攻方向 → `ths fundflow`(主力净流入)
  - 圈板块 → `ths scan --universe 关键词`(search 联想建池)
  - 筛强势股 → `ths scan --criterion volume-break,ma-bull`
- **涨跌家数口径**:`ths market` 的涨/跌/平家数为各市场证券合计(含基金/债券等),以同花顺 realhead 接口为准,用于情绪判断足够,不用于精确统计。

### 开发

```bash
npm test            # vitest(159 用例,含真实 HAR fixture 的 K 线解析断言)
./scripts/bridge.sh status    # 查看 server 状态
./scripts/bridge.sh stop      # 停止 server
```

### 帮助脚本

`scripts/` 下除 `bridge.sh`（Server 生命周期）与 `tonghuashun.user.js`（油猴脚本）外，还有：

| 脚本 | 用途 | 用法 |
|---|---|---|
| `scripts/doctor.sh` | 一键排障:node/config/依赖/Server/油猴版本与 token 一致性/目录可写,输出 ✓/✗ 清单与修复指引 | `./scripts/doctor.sh`（`-q` 静默可脚本化判断,`-v` 详情,`--fix` 自动修） |
| `scripts/demo.sh` | 全链路冒烟测试:搜索→行情→K线→分时→成交额→分析→对比→扫描→回测,11 步任一步失败即退出非 0 | `./scripts/demo.sh`（`--quick` 6 步,`--codes a,b` 换池） |
| `scripts/daily.sh` | 大师日报:①大盘成交额 → ②代码池估值 → ③条件扫描 → ④技术深挖 → ⑤横向对比,开盘前一次跑完 | `./scripts/daily.sh`（`--codes` 换池,`--compact`/`--all`,`--scan-criteria` 换条件） |
| `scripts/cache.sh` | 缓存管理:统计 / 按周期清理 / 自选股+名称导出导入（迁移备份） | `stats` `clean [--period day]` `export --file f` `import --file f` |
| `scripts/completion.bash` | `ths` 命令/周期/选股条件/回测策略 bash 补全 | `echo "source $(pwd)/scripts/completion.bash" >> ~/.bashrc` |

对应的 npm scripts:`npm run doctor` / `npm run daily` / `npm run demo` / `npm run cache`。

## 免责声明

本项目仅用于**个人学习与研究**,行情数据来自同花顺公开接口。请勿用于商业用途或高频请求;对数据准确性不作任何保证。使用前请知悉同花顺相关服务条款。
