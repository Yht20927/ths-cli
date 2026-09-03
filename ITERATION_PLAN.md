# ths-cli 迭代计划（炒股大师视角）

> 由"资深炒股大师"人设子代理基于真实代码 + 真实数据（2026-08-17 自选池 7 只快照 / lessons.json / ths.json 缓存）产出。
> 本文档是**活文档**：每完成一项就勾选 ✅，并更新日期。目标是让"大师纪律"从方法论文字变成强制执行的机制。

**核心判断**：技术分析闭环已完整，但**止损没固化、大盘没融入信号、复盘只统计技术信号（次变量）没统计方向（主变量）**——"不逆大盘、止损不犹豫、多重共振才动手"三条红线还靠人记得，不是靠工具亮灯。

---

## 一、现状摘要（已完成的能力）

- **行情**：search / quote / quotes / kline(6周期) / trend / turnover / market(大盘情绪)
- **技术分析**：analyze(全指标+形态+支撑压力+评分) / compare / scan(11条件) / backtest(4策略) / position(仓位/盈亏比)
- **选股**：rank(涨跌幅+技术形态族) / sectors(板块) / lhb(龙虎榜) / fundflow(资金流) / fundamental(F10)
- **台账**：portfolio(持仓/流水) / watchlist(自选池)
- **学习回路**：daily run/review/lessons/snapshot/apply（监控+快照落盘→3/5日命中回填→特征命中率→池建议）

---

## 二、差距分析（按对赚钱能力的价值排序）

### 🔴 1. 止损纪律没有闭环 —— 止损从没被"记下来"
- **实战缺口**：`ths position` 算的止损是一次性的；`portfolio add` 只存 `{code,name,qty,avgCost,openedAt,realizedPnl,trades}`（`lib/portfolio.js` applyTrade），**没有 `stopPrice` 字段**。`portfolio list --risk` / `portfolio risk` 每次用当天 K 线现算止损（`lib/commands/portfolio.js:103`）→ **止损位漂移**：跌破旧止损后工具会悄悄重算更低支撑当新止损，永远不告诉你"你当初定的止损破了、你还拿着"。`daily run` 持仓提醒用的是今日快照支撑，不是建仓时固化的止损。
- **严重度**：高。止损是唯一保命绳，连违规持仓都识别不了。
- **可复用**：`calcStopTarget`、`positions` 结构（加 stopPrice）、`daily.js` 持仓提醒框架。

### 🔴 2. "不逆大盘"是空头口号
- **实战缺口**：快照 `marketEnv` 只存当日涨跌家数/成交额/mood；`scoreBars`（`lib/score.js`）签名没有市场参数，大盘普跌日照样给个股打"看多"。工具**算不了大盘指数趋势**：`1A0001` 被解析成平安银行（names 缓存证实），需要手动 `--market 17`；`market` 命令只有指数快照，没有上证 MA20 位置/支撑压力。
- **严重度**：高。系统性风险是账户最大杀手，大盘破位时个股信号全是噪音。
- **可复用**：`market.js` moodLabel、`daily.js` fetchMarketEnv、`daily-review.js` marketMood 桶、`position.js` 仓位公式。

### 🔴 3. 复盘只停留在"技术信号"维度
- **实战缺口**：`daily run` 只取 market + quotes + kline；快照字段和 `daily-review.js` 的 BUCKETS 全是技术因子。板块（`sectors`）、资金（`fundflow`）、龙虎榜（`lhb`）是**临时查的命令，进不了每日学习回路**。复盘能回答"我的技术信号对不对"，回答不了"我选的方向（板块/资金/题材）对不对"。
- **严重度**：高。A 股赚钱主要靠方向，回路在优化错误的变量。
- **可复用**：`sectors.js` / `lhb.js` / `fundflow.js` 三个命令 + 三个纯函数 parser（`lib/parsers/`）、BUCKETS 结构可平铺扩展。

### 🟠 4. 信号自相矛盾但工具不报矛盾
- **实战缺口**：8/17 京东方A score 65→看多，但 MACD 空头 + 看跌吞没 + 乌云盖顶（pattern factor 33、risk 40）；华天科技 score 63→看多但 MACD 空头 + ATR 7% + 双看跌形态。六因子加权成一个数字，冲突被吞掉。数据港 KDJ 84/RSI 78.5 严重超买，因距压力 7% 而没触发 W2 追高告警。
- **严重度**：中高。信号是下单依据，一个吞掉矛盾的数值会直接误导买卖。
- **可复用**：`summary.js` 已带全原始因子，加一层"矛盾检测 + 共振分级"；`daily-review.js` 的 `resonanceOf` 有雏形。

### 🟠 5. 回测与实盘用的是两套方法论
- **实战缺口**：实盘打法=评分+共振+支撑压力+仓位铁律；`lib/backtest.js` 只有 `ma-cross/rsi/macd`+`buy-hold`，回测不了实战打分信号。全仓进出、不套仓位铁律/分批，涨跌停只近似处理。
- **严重度**：中高。回测结论不能反向优化实战打法，等于拿别人的策略论证自己的打法。
- **可复用**：`backtest.js` 撮合引擎骨架、`score.js` scoreBars（可改造）、`scanner.js` 11 个 CRITERIA。

### 🟡 6. 学习回路冷启动 + 输出统计报表而非可执行规则
- **实战缺口**：命中率桶要求 n≥5，冷启动期全部"样本不足"。回路产出是"命中率统计表 + 池建议"，不是"当 X 出现 → 该买/不该买"的可执行规则。
- **严重度**：中。决定回路是"数据收集器"还是"策略改进器"。
- **可复用**：`computeStats` / `generateSuggestions`、快照结构、BUCKETS；可用历史 K 线回放补样本。

### 🟡 7. 选股是扁平扫描，缺"板块龙头"思维
- **实战缺口**：`scan` 对池内每只独立跑条件，输出所有命中票，没有"同一板块内选最强（涨幅/量能/资金净流入最高者）"的龙头分级。`sectors` parser 的 leader 字段（`lib/parsers/sectors.js` leadName/leadCode/leadPct）只是显示字段，没接进选股管线。
- **严重度**：中。买中龙三和龙一盈亏差几个档次。
- **可复用**：`sectors` 领涨股字段、`scan.js` runScan、`compare` 横向表。

### 🟡 8. 数据真实性无护栏
- **实战缺口**：quotes "现价"可能返回昨收（`daily.js:271` 已注释过这个坑），但工具无"K线最后收盘 vs quotes 现价/涨跌幅"一致性校验或告警。快照 pct 来自 quotes、close 来自 K线，对不齐时 W2"追高≥7%"判定会误报/漏报。
- **严重度**：中。爆一次就是静默的错误信号。
- **可复用**：`formatQuote` 字段映射、daily.js "优先 K线 close"的经验。

### 🟢 9. 交易纪律不可量化
- **实战缺口**：SKILL 复盘三问"①按计划做吗 ②策略还是执行 ③策略还配不配用"，工具只量化了"策略"（命中率），"执行"部分靠主观。没有"违规记录"（追高还买/没设止损/超仓位铁律/破止损不执行）数据。
- **严重度**：低中。对稳定盈利重要，但优先级在止损固化/大盘之下。
- **可复用**：`lessons` 结构（可加 violation 类型）、portfolio trades 流水。

---

## 三、迭代计划

### 里程碑 M1 —— 近 1 周（保命环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M1-1** | **止损固化 + 破位追踪**（最高杠杆） | 补不足 1：止损从没被记下来是最大风控黑洞 | `lib/portfolio.js`（applyTrade 加 stop 字段）、`lib/commands/portfolio.js`（add 分支调 calcStopTarget，list/risk 用固化值，risk --stop --save 上移）、`lib/cache.js`（positions 结构）、`lib/commands/daily.js`（提醒改用 stopPrice，破位红字告警 + 连续违规天数写回） | ✅ 2026-08-18 |
| M1-2 | 板块指数（881xxx）打"不可直接买入"标记 | 陷阱1：快照里 881129 通信设备在出"看多"，会误导当个股买 | `lib/commands/helpers.js`（isBoardIndex）、`lib/commands/daily.js`（isBoard 快照 + ⚠指数标记 + 建议跳过）、`lib/commands/analyze.js`（横幅）、`lib/commands/portfolio.js`（add 拒绝）、`lib/scanner.js`（跳过） | ✅ 2026-08-18 |
| M1-3 | 信号矛盾检测 + 共振分级 | 补不足 4：信号升级"强看多/看多(存疑)/观望/看空" | `lib/signal.js`（新，classifySignal 纯函数）、`lib/summary.js`（buildSummary 加 signalGrade/conflicts）、`lib/commands/analyze.js`（评分区显示分级+矛盾）、`lib/commands/daily.js`（快照+报告）、`lib/daily-review.js`（signalGrade 桶） | ✅ 2026-08-18 |

### 里程碑 M2 —— 近 1 月（方向环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M2-1** | **方向维度入每日回路**（最高杠杆） | 补不足 3：daily run 加 sectors/fundflow/lhb 取数 → 快照新增 `boardMood/fundDir/lhbJoin`，命中率桶扩展，复盘能回答"我方向选对没" | `lib/commands/daily.js`（fetchDirectionEnv + 每股票 dir 标签 + 方向环境报告区）、`lib/daily-review.js`（BUCKETS：boardMood/fundDir/lhbJoin/boardLeader/dirResonance）、`lib/daily-store.js`（setDirection + loadSnapshots 合并 direction） | ✅ 2026-08-18 |
| M2-2 | 大盘趋势判定（不逆大盘落地） | 补不足 2：上证/创业板 K线，daily 存"上证是否站上 MA20、指数支撑/压力、涨跌家数 3 日趋势"；大盘破位标记"环境弱"，`position` 支持环境系数减半 | `lib/commands/helpers.js`（指数映射表）、`lib/commands/daily.js`、`lib/position.js` | ⬜ |
| M2-3 | 从统计报表到可执行规则 | 补不足 6：按桶命中率自动生成"当[特征]→买/不买，3日命中 XX%（n=N）"，可标记采用/弃用，采用后进 `scan` 条件库 | `lib/daily-review.js`（rule 生成纯函数）、`lib/daily-store.js`、`lib/scanner.js` | ⬜ |

### 里程碑 M3 —— 1-3 月（策略环）

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| M3-1 | 纸面交易/模拟盘 | daily 信号自动按 `position` 铁律开平模拟仓，跑资金曲线，与真实持仓对照 | `lib/portfolio.js`、`lib/backtest.js` | ⬜ |
| M3-2 | 回测对齐实盘打法 | score/共振信号做成可回测策略 + 涨跌停成交约束 + 分批建仓 + walk-forward | `lib/backtest.js`、`lib/score.js` | ⬜ |
| M3-3 | 纪律执行度量 | 记录"违规买入"（追高≥7%仍买/未设止损/超仓位铁律）与"止损是否执行"，输出月度纪律评分 | `lib/daily-store.js`（violations）、`lib/commands/daily.js`、`lib/commands/portfolio.js` | ⬜ |

### 里程碑 M4 —— 实时环（Slice 1，2026-09-03 ✅）

> 来源：2026-09-03 用户拍板加"量化 + 实时追踪"，推翻原克制清单第 4 条"不做分时级盯盘告警"（已改写为限定版，见下）。
> Slice 1 = 实时能力落地（M4-1/M4-2，✅）；**Slice 2 组合/风控层量化 `ths risk`**（M4-3，✅）；**Slice 3 因子/选股广度量化（打分/共振进回测 + 方向门控）** 为候选下一步。

| 项 | 功能 | 为什么 | 落在哪 | 状态 |
|---|---|---|---|---|
| **M4-1** | **盘中实时追踪 `ths watch`** | 保命环**执行时机缺口**：止损纪律目前只在**收盘后** daily run 亮灯，把"破止损必走"提前到**盘中破位瞬间**。只对固化阈值边沿提醒，不生成新信号 | `lib/trading-hours.js`（时段）、`lib/watch-engine.js`（告警引擎）、`lib/commands/watch.js`、`scripts/watch.sh`、`lib/commands/index.js`、`cli.js` | ✅ 2026-09-03 |
| **M4-2** | **半截 K 线数据卫生** | 盘中(<15:05)在途 bar 被当完整历史缓存会污染回测/参照位 | `lib/cache.js`（`isFormingBarNow`/`closedBars`/`excludeForming`）、`lib/commands/backtest.js`（默认剔除 + `--include-forming`） | ✅ 2026-09-03 |
| **M4-3** | **组合/风控层量化 `ths risk`**（Slice 2） | 用户拍板"组合/风控层量化"落地：把自选池当**纸面组合**算相关性/有效独立标的/集中度(HHI)/组合波动/单票 ATR% 波动预算，标出 ≥0.7 高相关对与超 ≤20% 仓位铁律的标的 | `lib/portfolio-risk.js`、`lib/commands/risk.js`、`lib/commands/index.js`、`cli.js` | ✅ 2026-09-03 |

---

## 四、克制清单（明确不做，防工具膨胀）

- ❌ **不做自动下单/委托** —— 工具只研究不碰资金，保住"研究助手"定位
- ❌ **不做可视化图表/Web 界面** —— CLI + ASCII 表已够用，加 UI 只增维护不增胜率
- ❌ **不接多数据源/付费数据** —— 同花顺 Bridge 单一可信源，少一个源少一类对不齐问题
- ✅ **盯盘告警收敛为"固化日线级阈值"**（2026-09-03 起，M4-1）—— 只对**建仓固化的止损 / 收盘支撑压力 / 涨跌停 / 量比 / 涨幅≥7%** 做**边沿触发**盘中提醒（`ths watch`）；**不生成新买卖信号、不落盘、不自动执行**。"分时级买卖信号 / 逐笔 / Level2 / 秒级"仍不做（盘中噪音反伤纪律的防线保留在"只提醒不决策"上）
- ❌ **不堆指标/策略数量** —— 回测只做与实战打法对齐的策略
- ❌ **池建议不自动执行** —— 保留 `daily apply --yes` 手动确认，这是纪律本身
- ❌ **不做大盘股/北交所特化** —— 自选池以主板/创业板为主

---

## 五、3 个月愿景

一套"**三环咬合的复利机器**"：

1. **保命环** —— 止损建仓时固化、每日自动查"破止损还在扛"
2. **方向环** —— 板块/资金/龙虎榜进每日回路，复盘能回答"我方向选对没"
3. **策略环** —— 用自己实战打分信号回测、命中率沉淀成可扫描的硬规则

**要解决的根本问题**：把"大师纪律"从方法论文字变成**强制执行的机制**——让"不逆大盘、止损不犹豫、多重共振才动手"三条红线在每次跑 `ths daily` 时自动亮灯，而不是靠人记得。

3 个月后打开它，看到的是"**今天该减哪些仓（因为破了固化的止损）、我的打法在哪个特征上胜率在下降、哪些规则值得坚持**"，而不是一堆指标数字。

---

*文档更新：2026-08-17 由炒股大师子代理分析产出；M1-1 与 M2-1 为最高杠杆项，建议优先。*
*2026-08-18 实现：M1-1（止损固化+破位追踪）、M1-2（板块指数标记）、M1-3（信号分级）、M2-1（方向入回路）已落地并单测覆盖。下一步候选：M2-2 大盘趋势判定。*
*2026-09-03 实现：M4-1 盘中实时追踪 `ths watch` + M4-2 半截 K 线数据卫生（Slice 1；测试全量 300 绿 + 盘中实盘验证）；克制清单第 4 条改写为限定版。*
*2026-09-03（续）实现：M4-3 组合/风控层量化 `ths risk`（Slice 2；相关性/独立标的/集中度/组合波动/ATR%，实弹验证 京东方×TCL ρ=0.749 高相关）。下一步候选：M2-2 大盘趋势 / Slice 3 因子/选股广度量化。*
