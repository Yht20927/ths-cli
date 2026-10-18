# ths-cli 渲染与 TUI 设计稿

> 状态：定稿 v1  
> 日期：2026-10-18  
> 范围：终端渲染层、TUI 交互、静态报告、输出协议  
> 前置决策：安全整改本轮不做；交互形态选 TUI；渲染方案由本稿定稿

---

## 0. 背景与决策

### 0.1 本轮用户排序

1. 安全先不改；
2. 实时交互选 TUI；
3. 渲染方案由开发侧决定，越详细越好。

### 0.2 本轮定稿

| 项 | 决定 |
|---|---|
| 主战场 | 终端：静态文本 + TUI |
| HTML | 只作为导出/归档格式，不做 Web 应用 |
| 核心抽象 | ViewModel + Renderer；命令不直接拼输出 |
| 绘图底座 | Canvas（字符单元格缓冲） |
| 图表实现 | Unicode 块字符 + Braille 点阵；零新增依赖 |
| 颜色 | 默认 A 股习惯：红涨绿跌；另提供 intl/mono/high-contrast |
| 状态符号 | 默认几何符号（●▲◆✓▸），不默认 emoji |
| 响应式 | 60/80/100/120/160 列五档，按列优先级隐藏 |
| 机器输出 | text / json / csv / ndjson / md / html；诊断走 stderr |
| 依赖 | 保持零新增运行依赖 |
| 安全 | 本轮不动；渲染层不新增监听端口、不发起外部请求 |

### 0.3 与现有克制清单的关系

`ITERATION_PLAN.md` §四原有一条“❌ 不做可视化图表/Web 界面”。本设计将其修订为：

- ✅ 做终端图表、静态 HTML 报告、只读 TUI/本地面板；
- ❌ 不做托管 Web 服务、多用户系统、自动下单；
- ✅ 继续零新增依赖，不引入图表库/UI 框架。

### 0.4 非目标

- 不做 Web Dashboard、不做 Electron；
- 不做自动交易/委托；
- 不引入 Ink、Blessed、Chalk、D3、ECharts、React 等依赖；
- 不做逐笔/Level2/秒级行情；
- 本轮不处理 Bridge token/WS 鉴权等安全整改（按用户决定延后）。

---

## 1. 目标与成功标准

### 1.1 目标

1. 所有含中文的表格在 60/80/100/120/160 列下正确对齐。
2. 每条命令都有稳定的 text/json 输出契约，诊断不污染 stdout。
3. 高价值命令具备图表表达：K 线、权益曲线、回撤、相关热力图、命中率分布。
4. `ths watch --tui` 成为盘中主界面：状态、告警、详情、过滤、排序一体化。
5. 同一份数据可导出 Markdown/HTML 报告，离线可读。
6. 迁移过程中现有 321 个测试保持全绿。

### 1.2 验收指标

| 指标 | 目标 |
|---|---|
| 输出宽度 | 任意 renderer 不产生超过目标宽度的行 |
| 颜色关闭 | `stripAnsi(color) === noColor` |
| TUI 渲染 | 120×40 Canvas < 5ms；行级 diff < 2ms |
| 表格渲染 | 1000 行 < 10ms |
| JSON 纯净 | `--format json` stdout 只有一段合法 JSON |
| TUI 稳定性 | 80×24 / 120×35 可用；2 小时 soak 无泄漏/无重复告警风暴 |
| 报告 | 离线打开，无外部请求；2 秒内生成 |
| 依赖 | 运行依赖仍只有 `ws` |

---

## 2. 设计原则

1. **数据先于装饰**：先保证数字、单位、样本量正确，再谈颜色和图表。
2. **一套 ViewModel，多种 Renderer**：text / json / csv / md / html / tui 消费同一份数据。
3. **宽度是硬约束**：中文、emoji、ANSI 统一按显示宽度计算；任何行不得超宽。
4. **颜色不是唯一信息通道**：涨跌/告警同时用符号和文字表达；无色模式信息不丢失。
5. **响应式而非缩水**：窄屏隐藏低优先级列，保留关键字段；极窄切堆叠模式。
6. **图表服务于判断**：表格放 sparkline，详情放 K 线/权益/回撤/热力图；不做装饰图形。
7. **渐进迁移**：先修表格与输出契约，再逐命令接 ViewModel，最后上 TUI。
8. **可测试**：宽度、ANSI、表格、图表、TUI reducer 全部有确定性测试。
9. **零依赖**：图表用字符/盲文，报告用内联 SVG，TUI 用 readline/ANSI。
10. **数据与展示分离**：命令只产出数据/视图模型；格式化只在渲染层发生。

---

## 3. 总体架构

### 3.1 分层

```text
命令层 lib/commands/*.js
   │  参数 → 取数 → 调用服务 → 返回数据 / 调用 emit()
   ▼
视图层 lib/view/*.js
   │  纯函数：data → ViewModel（sections/columns/charts）
   ▼
渲染层 lib/render/*
   │  capabilities / width / ansi / theme / format / canvas / layout / widgets / output
   ├──────────────► text（静态终端）
   ├──────────────► json / csv / ndjson（机器）
   ├──────────────► md / html（导出）
   └──────────────► tui（Canvas + 增量重绘）
```

### 3.2 数据流

```text
Bridge/HTTP → 领域数据 → ViewModel → Renderer → stdout / TUI canvas / report file
                              │
                              └─ json 契约直接输出来源数据（保持兼容）
```

### 3.3 目录规划

```text
lib/render/
  capabilities.js   # TTY/宽高/色深/Unicode 检测
  width.js          # displayWidth / pad / truncate / wrap / slice
  ansi.js           # SGR 构造、strip、可见宽度
  theme.js          # token → SGR；cn/intl/mono/hc
  format.js         # 价格/百分比/金额/量/日期/时长
  canvas.js         # 字符单元格缓冲、绘制、diff
  layout.js         # hstack/vstack/panel/grid
  table.js          # 响应式表格
  kv.js
  widgets/
    tiles.js        # 指标卡
    alerts.js       # 告警流
    sparkline.js
    bars.js         # 横向条/分布
    line.js         # Braille 线图/权益/回撤
    candles.js      # K 线 + 成交量 + MA
    heatmap.js      # 相关矩阵
    timeline.js     # 复盘逐条时间线
  output.js         # emit(viewModel, opts) / info/warn/error → stderr
lib/view/
  quote.js  quotes.js  analyze.js  compare.js  scan.js
  daily.js  review.js  risk.js  backtest.js  portfolio.js
lib/tui/
  terminal.js       # alt screen / cursor / resize / cleanup
  input.js          # keypress / raw mode
  state.js          # UI state + reducer
  app.js            # 事件循环 + 渲染调度 + diff
  screens/
    dashboard.js  detail.js  alerts.js  help.js
lib/realtime/
  watch-session.js  # 取数循环/阶段/告警事件（与 UI 解耦）
```

---

## 4. 视觉语言

### 4.1 色彩 token

| token | 用途 | ANSI16 回退 | 256/truecolor |
|---|---|---|---|
| `text` | 正文 | 默认 | 默认 |
| `muted` | 时间、单位、次要说明 | 90 | `#8b949e` |
| `dim` | 更弱的辅助信息 | SGR 2 | SGR 2 |
| `accent` | 标题、当前 tab、选中强调 | 36 | `#39c5cf` |
| `up` | 上涨/正收益 | 31 | `#f85149` |
| `down` | 下跌/负收益 | 32 | `#3fb950` |
| `flat` | 平盘 | 37 | `#c9d1d9` |
| `critical` | 破止损/破支撑 | 1;31 | `#ff6b6b` |
| `warn` | 追高/触压力/急跌 | 33 | `#d29922` |
| `info` | 提示/放量/涨停 | 34 | `#58a6ff` |
| `success` | 正常/达标/守支撑 | 32 | `#3fb950` |
| `border` | 面板边框 | 90 | `#30363d` |
| `header` | 表头 | 1 | bold |
| `selection` | 选中行 | 7（反显） | bg `#1f6feb` |

热力图使用独立发散色阶，并在图例中标注，避免与涨跌色混淆：

```text
-1.0        -0.5         0        +0.5        +1.0
 蓝 ████████ 蓝 ▓▓▓▓ 灰 ░░░░ 红 ▓▓▓▓ 红 ████████
```

### 4.2 符号

| 语义 | 默认 | ASCII 回退 |
|---|---|---|
| 上涨/下跌/平盘 | `▲` / `▼` / `■` | `^` / `v` / `-` |
| 严重告警 | `●`（红） | `[X]` |
| 警告 | `▲`（黄） | `[!]` |
| 提示 | `◆`（蓝） | `[i]` |
| 正常/达标 | `✓` | `[ok]` |
| 选中行 | `▸` | `>` |
| 缺失值 | `—` | `-` |
| 省略 | `…` | `...` |
| Sparkline | `▁▂▃▄▅▆▇█` | `_.-\|/` |
| 横向条 | `█░` + 分数块 `▏▎▍▌▋▊▉` | `#` / `=` |
| Braille 线图 | `⠁⠂⠄⡀…` | `.` + `*` |

默认**不使用 emoji 作为表格/图表符号**，因为不同终端的 emoji 宽度不一致。`--emoji` 可恢复 🔴/🟠/🟡 状态图标。

### 4.3 数字、单位、日期

- 价格：2 位小数。
- 百分比：盯盘 1 位，统计 2 位；总是带符号。
- 金额：基本单位“元”传入，渲染为 `万/亿`，2 位小数。
- 成交量：基本单位“股”传入，渲染为 `万股/亿股`。
- 比率/相关系数：2 位小数。
- 缺失：`—`；不要用 0 代替。
- 日期：`YYYY-MM-DD`；时间：`HH:MM:SS`；分钟 bar：`MM-DD HH:MM`。
- 数据年龄：`3s前` / `1.2m前`；超过阈值用 `warn` 色。
- 所有交易日期/时间统一使用北京时间，禁止本地 `getHours` / `toISOString().slice(0,10)`。

### 4.4 排版与布局

- 静态文本最大宽度 120；TUI 跟随终端宽度。
- 表头加粗；分区标题用 `▌` 或 `──` 前缀；分区之间空 1 行。
- 数字右对齐，文本左对齐；列间固定 2 空格。
- 不使用背景色（热力图/选中除外），保证任意终端主题可读。
- 长文本按显示宽度换行，续行缩进 2 格。
- 1 个面板内边距 1 格；面板边框默认 `round`。

### 4.5 主题

```bash
--theme cn            # 默认：红涨绿跌
--theme intl          # 绿涨红跌
--theme mono          # 无色，用粗体/暗色/符号区分
--theme high-contrast # 高对比，粗体+强符号
--no-color            # 强制无色
--ascii               # ASCII 边框/符号
--emoji               # 恢复 emoji 状态图标
```

自动检测：

- `NO_COLOR` 非空、`TERM=dumb`、非 TTY → 无色；
- `LANG/LC_ALL` 不含 UTF-8 → ASCII；
- `COLORTERM=truecolor` → truecolor；`TERM=*-256color` → ansi256；否则 ansi16。

---

## 5. ViewModel 规范

### 5.1 Schema

```js
{
  schemaVersion: 1,
  kind: 'analyze',
  generatedAt: '2026-10-18T10:23:45+08:00',
  title: '贵州茅台 600519',
  subtitle: '日K · 前复权 · 250 根',
  quality: {
    lastBarDate: '2026-10-17',
    quoteTime: '2026-10-18 10:23:41',
    stale: false,
    adjusted: 'forward',
    priceDeltaPct: 0.12,
    warnings: []
  },
  sections: [
    { type: 'tiles', id: 'headline', items: [] },
    { type: 'kv', id: 'detail', items: [] },
    { type: 'chart', id: 'trend', chart: 'sparkline', values: [], tone: 'up' },
    { type: 'table', id: 'levels', columns: [], rows: [] },
    { type: 'chart', id: 'candles', chart: 'candles', bars: [], overlays: [] },
    { type: 'text', id: 'note', text: '' }
  ]
}
```

### 5.2 Section 类型

| type | 字段 | 用途 |
|---|---|---|
| `tiles` | `items[{label,value,delta,tone,spark}]` | 顶部指标卡 |
| `kv` | `items[{label,value,fmt,tone}]` | 键值明细 |
| `table` | `columns[], rows[], footer` | 表格 |
| `chart` | `chart, ...data` | sparkline/bars/line/candles/heatmap |
| `alerts` | `items[{ts,level,code,name,message}]` | 告警流 |
| `text` | `text` | 说明/提示 |
| `timeline` | `rows[]` | 复盘逐条时间线 |

### 5.3 与 JSON/CSV 的关系

- `--format json` 返回命令的**来源数据契约**（保持现有字段，必要时加 `schemaVersion`），不返回渲染用 ViewModel。
- `--format csv` 选取 ViewModel 中标记 `csv: true` 的 table section；命令可指定默认 section。
- 文本/TUI/HTML 只消费 ViewModel；renderer 可按宽度丢弃 section。
- 数字保留原始类型；格式化只在 renderer/`fmt` 函数中发生。

---

## 6. 基础层 API

### 6.1 capabilities.js

```js
detectCapabilities(env, stdout) => {
  isTTY,
  width,        // --width > COLUMNS > stdout.columns > 80；夹在 [40, 200]
  height,       // --height > LINES > stdout.rows > 24
  colorDepth,   // 'none' | 'ansi16' | 'ansi256' | 'truecolor'
  unicode,      // 'full' | 'basic' | 'ascii'
  emoji,        // boolean
  theme         // 'cn' | 'intl' | 'mono' | 'high-contrast'
}
```

### 6.2 width.js（关键）

```js
displayWidth(s)        // ANSI=0；组合字符=0；CJK/emoji=2
stripAnsi(s)
padEndW(s, w)
padStartW(s, w)
truncateW(s, w, ellipsis = '…')
wrapW(s, w)
sliceW(s, start, end)
```

实现要点：

- 按 code point 遍历（`for...of`），不用 `charCodeAt`。
- 组合字符（U+0300–U+036F 等）宽度 0。
- 全角/宽字符（CJK、Hangul、全角标点）宽度 2。
- 常见 emoji（U+1F300–U+1FAFF 等）宽度 2；ZWJ 序列整体宽度 2。
- 制表符展开为 4 空格；控制字符宽度 0。
- 歧义宽度默认 1；提供 `--width-policy ambiguous=2` 覆盖。
- 所有测量前先 `stripAnsi`；样式绝不混进字符串内容。

### 6.3 ansi.js

```js
SGR.reset / bold / dim / underline / inverse / fg(n) / bg(n)
style(text, codes) -> '\x1b[...m' + text + '\x1b[0m'
```

- 颜色只通过 theme 解析，不在命令里写 `\x1b`。
- 禁止嵌套未闭合样式；Canvas 每格存样式，输出时统一 reset。
- 文本进入 Canvas 前拒绝/替换控制字符，防止注入和宽度错乱。

### 6.4 theme.js

```js
resolveTheme(name, caps) => {
  name,
  colors: { text, muted, dim, accent, up, down, flat, critical, warn, info, success, border, header, selection },
  symbols: { up, down, flat, critical, warn, info, success, selected, missing, ellipsis }
}
```

- `colorDepth === 'none'` 时颜色为空，符号回退到 ASCII/几何符号。
- `intl` 主题交换 up/down。
- `mono` 主题只使用 bold/dim/inverse。

### 6.5 format.js

```js
fmtPrice(v)        // 1482.00 / —
fmtPct(v, d = 1)   // +5.2% / -0.8% / —
fmtMoney(v)        // 1.23亿 / -4,560万 / —
fmtVolume(v)       // 1.2亿股 / 340万股
fmtRatio(v)        // 0.75
fmtDate(v)         // 2026-10-18
fmtDateTime(v)     // 2026-10-18 10:23:45（北京时间）
fmtAge(ms)         // 3s / 1.2m
toneOf(v)          // up | down | flat | null
```

- 所有函数接受 `null/undefined/NaN` 并返回 `—`。
- 金额/成交量统一按基本单位（元/股）传入，渲染层决定万/亿。
- 日期时间统一走 `trading-hours.js` 的北京时间。

### 6.6 canvas.js

```js
class Canvas {
  constructor(width, height)
  set(x, y, ch, style)       // 宽字符占两格，第二格 continuation
  text(x, y, str, style)     // 自动裁剪/宽度推进
  fillRect / hline / vline / box
  blit(src, x, y)
  toString(colorDepth)       // → string[]
  diff(prev, colorDepth)     // → 带光标定位的增量输出
}
```

- 单元格 `{ch, style}`；越界写入静默裁剪。
- `diff`：逐行比较渲染后的字符串；变化行用 `\x1b[{row};1H` + 内容 + `\x1b[K`；尺寸变化/首帧全量 `\x1b[2J`。
- 渲染后每行补齐到宽度，避免残影。
- 禁止在 cell 内容中出现换行/控制字符。

### 6.7 layout.js

```js
hstack([{ flex: 2 }, { flex: 1 }], { width, gap: 1 })
vstack([{ height: 2 }, { flex: 1 }], { height })
panel({ x, y, w, h, title, border: 'round' | 'square' | 'none' })
```

- 边框：`╭─╮│╰╯`；ASCII 用 `+-|`。
- 标题超宽用 `…` 截断；内容区自动扣边框/内边距。
- 布局函数返回矩形区域，widget 往 Canvas 画。

### 6.8 output.js

```js
emit(viewModel, { format, width, color, theme, out })
info(msg) / warn(msg) / error(msg)   // → stderr
```

| format | 行为 |
|---|---|
| `text` | 按 width 渲染 ViewModel |
| `json` | 输出命令原始数据；stdout 只有一段 JSON |
| `csv` | 选默认 table section，应用列 fmt，RFC4180 转义 |
| `ndjson` | watch tick/alert 一行一条 |
| `md` / `html` | 报告 renderer |

任何诊断/进度/警告都不许写 stdout。

---

## 7. 组件库

### 7.1 响应式表格

列定义：

```js
{
  key, header,
  align: 'l' | 'r' | 'c',
  width: 'auto' | 8 | { flex: 1, min: 6, max: 20 },
  priority: 0 | 1 | 2,          // 0 永不隐藏
  fmt: (v, row) => string,
  tone: (v, row) => 'up' | 'down' | 'critical' | 'warn' | 'muted' | null,
  truncate: true,
  wrap: false,
  csv: false
}
```

宽度算法：

1. 自然宽度 = max(表头, 所有行格式化后的 `displayWidth`)。
2. 总宽 + 列间距 > 可用宽度 → 先隐藏 priority 2，再隐藏 priority 1。
3. 仍超 → flex 列按剩余空间分配，min/max 夹取。
4. 仍超 → 对最低优先级列 `truncateW`。
5. 可用宽度 < 60 → 切“堆叠模式”：每条记录两行。

三种样式：

- `box`：圆角边框，静态命令输出；
- `compact`：表头 + 一条 `─` 分隔线，TUI/scan；
- `none`：仅对齐列，watch 高密度面板。

选中行：反显 + `▸`；无颜色模式用 `>`。页脚显示 `共 N 行 · 显示 M 行 · 已隐藏 距压力/量比`。

示例（80 列，中文对齐后）：

```text
┌────────┬──────────┬────────┬───────┬────────┬──────────┐
│ 代码   │ 名称     │  现价  │ 涨跌% │  量比  │ 状态     │
├────────┼──────────┼────────┼───────┼────────┼──────────┤
│ 000725 │ 京东方A  │   5.79 │ +0.52 │   2.63 │          │
│ 002185 │ 华天科技 │  16.05 │ +1.00 │   3.62 │ ● 放量   │
│ 881129 │ 通信设备 │ 9509.80│ +0.70 │   5.79 │ 板块风向 │
└────────┴──────────┴────────┴───────┴────────┴──────────┘
```

### 7.2 KV 面板

```text
  现价       1482.00        +0.12%
  支撑       1450 / 1420 / 1398
  压力       1520 / 1568
  盈亏比     2.4（达标）
```

- 标签宽度按 `displayWidth` 对齐；数组用 ` / ` 连接。
- 数值带 tone；标签 muted。

### 7.3 指标卡（tiles）

```text
┌ 总收益 ─────────┐  ┌ 最大回撤 ───────┐  ┌ 胜率 ───────────┐  ┌ 盈亏比 ─────────┐
│ +63.9%          │  │ -18.2%          │  │ 57.1%           │  │ 2.31            │
│ ▁▂▃▅▆▇█▇▆▅▃▂▃▄▅ │  │ █▇▆▅▄▃▂▁▂▃▄▅▆▇█ │  │ 14 笔           │  │ 8 胜 / 6 负     │
└─────────────────┘  └─────────────────┘  └─────────────────┘  └─────────────────┘
```

- 120 列 4 个/行；80 列 2 个/行；60 列 1 个/行。
- 卡片高度 3-5；数值 tone；副标题 muted。

### 7.4 告警流

```text
● 10:21:03 002185 华天科技  跌破固化止损 15.80（现价 15.76）—— 破位必走
▲ 10:22:11 000100 TCL科技   盘中涨幅 +7.2% ≥ 7% —— 追高红线，等回踩
◆ 10:24:05 000975 山金国际  量比 6.02 ≥ 3 —— 放量异动
```

- 时间 dim；代码加粗；消息按剩余宽度换行，续行缩进 6 格。
- 新告警在 TUI 中加粗/反显一次；已确认告警变 dim + `✓`。
- 默认最多显示 5 条，页脚 `还有 N 条 · [2] 告警页`。

### 7.5 Sparkline

- 8 级块字符；`null` 用空格或 `·`；全平序列取中间级。
- 表格内宽度 8-20；整条按最新涨跌 tone 着色。
- 详情中可按斜率分段着色（涨段红、跌段绿）。
- 示例：`▁▂▃▅▆▇█▇▆▅▃▂▃▄▅▆▇█ +6.8%`

### 7.6 横向条 / 分布

用于评分、命中率桶、板块净流入：

```text
信号: 看多    ██████████████░░░░░░  68%  n=25 (方向 19)
      看空    ██████░░░░░░░░░░░░░░  27%  n=22 (方向 18)
      观望    ░░░░░░░░░░░░░░░░░░░░   —   n=11
```

- 条宽按可用空间；分数块提升精度；右侧同时给率、总样本、方向样本。
- 样本不足用 `样本不足(n=3)`，不要画误导性的短条。

### 7.7 Braille 线图

用于权益曲线、回撤、NAV、指数走势：

```text
 1.64 ┤                                    ⢀⣠⠞⠋
 1.42 ┤                          ⢀⡠⠞⠋⠁
 1.20 ┤              ⣀⡠⠴⠚⠉
 0.98 ┤      ⢀⡠⠔⠒⠉
 0.76 ┤⣀⡠⠔⠒⠉
      └────────────────────────────────────
       08-01      09-01      10-01
```

- 2×4 子像素 Braille；Bresenham 连线。
- 左侧 4-6 个 Y 轴刻度；底部 3-4 个 X 轴日期。
- 零轴 dim；回撤图用 `░` 填充负值区域。
- ASCII 模式用 `.` / `*` 降级。

### 7.8 K 线图

```text
 1520 ┤                    │
 1500 ┤      █             █│█
 1480 ┤  █   █   │   █    █│█│
 1460 ┤  █   █   █   █    █│█│
 1440 ┤  │   █   █   █     ││
 1420 ┤      │   │   │
      └────────────────────────────
       09-26  10-08  10-14  10-18
 量   ▁▂▃▅▆▇█▇▆▅▃▂▃▄▅▆▇█
 MACD ▁▂▃▅▆▇█▇▆▅▃▂▁▂▃▄▅▆
```

- 输入 OHLCV；bar 数 > 绘图列数时按桶聚合：open=首、close=尾、high=max、low=min、volume=sum。
- 每列：影线 `│`，实体 `█`；涨红跌绿；实体为 0 行时用 `─`。
- MA5/10/20 叠加用 `·`，优先级：实体 > MA > 影线；图例在下方。
- 成交量面板高度 3；MACD 面板高度 4-6。
- 左侧价格轴 5 个刻度；右侧可放当前价标签。
- ASCII：影线 `|`、实体 `#`、MA `+`、量 `=`。

### 7.9 热力图（相关矩阵）

```text
         000725  000100  002185  000975  603881
000725   1.00    0.75    0.42    0.18    0.31
000100   0.75    1.00    0.39    0.22    0.28
002185   0.42    0.39    1.00    0.11    0.35
...
图例:  -1.0 蓝 █████  0 灰 ░░░░  +1.0 红 █████
```

- 单元格宽 6（含空格），背景色按 5 档；文字颜色自动黑/白或反显。
- 宽 < 80 时退化为 1 字符热图 + 单独数值表。
- 高相关对在下方列出：`ρ≥0.7: 000725×000100 0.75 —— 同向风险重复`。

### 7.10 时间线

用于 `daily review --verbose`：

```text
10-14  1482.00  看多   3日 +1.8% ✓   守支撑   5日 +3.1% ✓
10-15  1501.00  看多   3日 +0.4% ✓   触压力   5日  …
10-16  1478.00  看空   3日 -1.2% ✓   破支撑   5日 -2.4% ✓
```

- 日期/价格/信号/结果分列；`✓/✗/…` 用符号 + 颜色；结果列右对齐。
- 底部汇总：`3日命中 62% (n=13/17) · 5日 58% (n=9/15)`。

### 7.11 空/错/加载状态

- 空：`（暂无数据）` + 下一步命令提示。
- 错：`✖ 数据获取失败: ...` + 分类（网络/桥接/数据质量）+ 建议。
- 加载：TUI 显示 `⏳ 正在获取...`；静态命令不显示转圈。
- 数据陈旧：顶部黄色横幅 `⚠ 行情 12:03:11 后未更新（当前 12:05:40）`。

---

## 8. 命令渲染映射

| 命令 | 主布局 | 图表 | 窄屏策略 |
|---|---|---|---|
| `quote` | tiles + KV | 20 日 sparkline | 单列 KV |
| `quotes` / `watchlist prices` | 表格 | sparkline 列 | 隐藏换手/PE，保留价/涨跌/状态 |
| `analyze` | tiles + KV + 支撑压力表 | sparkline；`--chart` 加 K 线 | 隐藏明细指标，保留评分/信号 |
| `compare` | 表格 | 评分条 + spark | 隐藏 ADX/ATR |
| `scan` | 表格 | 评分条 + spark | 隐藏条件详情，保留命中原因 |
| `risk` | tiles + 热力图 + 表 | 相关矩阵/波动条 | 窄屏退化为数值表 |
| `backtest` | tiles + 权益图 + 交易表 | 权益/回撤线图 | 隐藏逐笔交易 |
| `daily run` | 环境 tiles + 自选表 + 告警 + 桶表 | 指数 spark / 桶条形图 | 单列顺序输出 |
| `daily review` | 桶条形图 + 分股票表 | 命中率条（带 n/CI） | 只显示 tier1 桶 |
| `portfolio` | tiles + 持仓表 | NAV/浮盈 spark | 隐藏成本明细 |
| `market` | 指数 tiles + 涨跌条 | 成交额 spark | 单列 |
| `sectors` | 表格 | 净流入条 | 隐藏领涨股 |
| `rank` | 表格 | spark | 隐藏部分形态列 |
| `lhb` | 表格 | 净额条 | 隐藏席位明细 |
| `fundamental` | KV | 增速条 | 单列 |
| `indices` | tiles | 指数 spark | 单列 |
| `watch` | 高密度表 / TUI | 详情 K 线 | TUI 自适应 |

### 8.1 `analyze` 示例（120 列）

```text
贵州茅台 600519 · 日K · 前复权 · 250 根                    2026-10-18 10:23:45
┌ 评分 ────┐ ┌ 信号 ─────────┐ ┌ 均线 ────┐ ┌ ADX ────┐ ┌ ATR% ──┐
│ 65       │ │ 看多(存疑)    │ │ 多头排列 │ │ 28.1    │ │ 3.2%   │
│ ▲ 强于昨 │ │ 2 项矛盾      │ │ 5>10>20  │ │ 趋势强  │ │ 中等   │
└──────────┘ └───────────────┘ └──────────┘ └─────────┘ └────────┘

现价 1482.00  +0.12%     支撑 1450 / 1420 / 1398     压力 1520 / 1568
MACD 空头   KDJ 72/68   RSI6 64   MFI 58   OBV 上升   盈亏比 2.4

近 60 日  ▁▂▃▅▆▇█▇▆▅▃▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█  +6.8%

因子     趋势 78  ████████████████░░░░
         动量 55  ███████████░░░░░░░░░
         量能 62  ████████████░░░░░░░░
         摆动 48  █████████░░░░░░░░░░░
         风险 60  ████████████░░░░░░░░
         形态 58  ███████████░░░░░░░░░

矛盾: MACD 空头 × 均线多头；KDJ 偏高位 × 距压力 2.6%
```

### 8.2 `backtest` 示例（120 列）

```text
600519 回测 · 综合评分（买入上穿60 / 卖出跌破40）· 日K · 500 根
┌ 总收益 ────────┐ ┌ 年化 ──────────┐ ┌ 最大回撤 ──────┐ ┌ 胜率 ──────────┐
│ +63.9%         │ │ +28.4%         │ │ -18.2%         │ │ 57.1% (14笔)   │
│ ▁▂▃▅▆▇█▇▆▅▃▂▃▄ │ │ 买入持有 +21%  │ │ █▇▆▅▄▃▂▁▂▃▄▅▆▇ │ │ 盈亏比 2.31    │
└────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘

权益曲线
 1.64 ┤                                    ⢀⣠⠞⠋
 1.42 ┤                          ⢀⡠⠞⠋⠁
 1.20 ┤              ⣀⡠⠴⠚⠉
 0.98 ┤      ⢀⡠⠔⠒⠉
 0.76 ┤⣀⡠⠔⠒⠉
      └────────────────────────────────────
       2025-01   2025-06   2025-12   2026-06

最近交易
  #3  2026-08-12 → 2026-09-03   买入 1450.00 → 卖出 1522.00   +4.96%
  #2  2026-05-06 → 2026-06-18   买入 1388.00 → 卖出 1440.00   +3.75%
  #1  2026-02-10 → 2026-03-21   买入 1320.00 → 卖出 1298.00   -1.67%
```

### 8.3 `risk` 示例（120 列）

```text
组合风险 · 7 标的 · 等权纸面组合 · 2026-04-18 ~ 2026-10-17（120 个共同交易日）
┌ 平均相关 ──┐ ┌ 有效独立标的 ┐ ┌ 年化波动 ──┐ ┌ 集中度 HHI ┐
│ 0.42      │ │ 3.1 / 7      │ │ 24.8%      │ │ 0.143      │
└───────────┘ └──────────────┘ └────────────┘ └────────────┘

相关矩阵（蓝=负，红=正）
         000725  000100  002185  000975  603881
000725   1.00    0.75    0.42    0.18    0.31
000100   0.75    1.00    0.39    0.22    0.28
002185   0.42    0.39    1.00    0.11    0.35

风险提示
  ▲ 000725 京东方A × 000100 TCL科技 ρ=0.75 —— 同向风险重复，最好只留一只
  ● 000975 山金国际 权重 14.3% —— 未超 20% 铁律
```

---

## 9. TUI 设计

### 9.1 结构

- **WatchSession**（`lib/realtime/watch-session.js`）：轮询、阶段、告警引擎、错误/退避；事件 `tick` / `alert` / `error` / `phase`。
- **TuiApp**（`lib/tui/app.js`）：终端、输入、状态、布局、渲染调度。
- **Screens**：dashboard / detail / alerts / help。
- **State**：不可变快照；reducer 处理按键和 tick；UI 不直接调用网络。

### 9.2 事件循环

```text
setInterval(tick, interval) ──► WatchSession.fetch() ──► emit('tick', payload)
                                                    └──► emit('alert', alerts)
keypress ──► reducer(state, action) ──► requestRender()
resize ──► re-layout ──► full repaint
render scheduler: 50ms 合并，最多 10fps；无变化不输出
```

- 渲染与取数解耦；网络等待不阻塞按键。
- 暂停 `p` 时停止取数，但仍可导航/看详情。
- 退出：停止 session、恢复光标/主屏、打印一行摘要。

### 9.3 终端控制

```text
进入:  \x1b[?1049h（备用屏） \x1b[?25l（隐藏光标）
重绘:  行级 diff + \x1b[K
退出:  \x1b[?25h \x1b[?1049l
```

- 使用 `readline.emitKeypressEvents` + `setRawMode(true)`。
- 监听 `SIGWINCH`、`SIGINT`、`SIGTERM`、`uncaughtException`，确保恢复终端。
- 非 TTY / `--format json` 时拒绝 `--tui`，提示改用 line 模式。
- 最小可用尺寸 60×16；小于时显示居中提示。

### 9.4 键位

| 键 | 行为 |
|---|---|
| `q` / `Ctrl+C` | 退出（恢复终端） |
| `p` | 暂停/恢复轮询 |
| `r` | 立即刷新一次 |
| `1` `2` `3` `4` | 总览 / 告警 / 详情 / 帮助 |
| `↑`/`k`、`↓`/`j` | 移动选中 |
| `g` / `G` | 首行 / 末行 |
| `Enter` | 打开选中详情 |
| `Esc` | 返回 / 取消输入 |
| `s` | 循环排序（代码/涨跌/距支撑/距压力/量比/状态） |
| `/` | 过滤（代码/名称/状态） |
| `a` | 确认选中告警（仅告警页） |
| `?` | 帮助 |
| `Ctrl+L` | 强制重绘 |

### 9.5 响应式断点

| 宽度 | 布局 |
|---|---|
| < 60 | 提示终端过窄，要求 ≥60 列 |
| 60-79 | 紧凑：隐藏距支撑/距压力/量比；详情作为 tab |
| 80-99 | 标准：代码/名称/价格/涨跌/状态；详情作为 tab |
| 100-129 | 增加距支撑/距压力；右侧详情面板 |
| ≥130 | 全列 + sparkline 列 + 更宽详情 |

高度 < 20 时隐藏告警面板，仅在头部显示告警数。

### 9.6 总览（120×35）

```text
┌ ths watch ──────────────────────────────────────────── 10:23:45 上午盘中 ─────────────┐
│ 连接 ● 正常  最近 tick 1.2s  间隔 15s  池 7  告警 2  暂停 否        [q]退出 [p]暂停 [r]刷新 │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 代码   名称      现价     涨跌%   距支撑   距压力   止损     量比   状态                    │
│▸000725 京东方A    5.79    +0.52   +1.4%   -5.1%   -        2.63                         │
│ 002185 华天科技   16.05   +1.00   +0.3%   -8.0%   -        3.62   ● 放量                 │
│ 000100 TCL科技    4.89    +0.82   +1.9%   -3.4%   -        4.90   ● 放量                 │
│ 881129 通信设备   9509.80 +0.70   -       -       -        5.79   板块风向                │
├─ 告警 ──────────────────────────────────────────────────────────────────────────────────┤
│ ● 10:21:03 002185 华天科技  跌破固化止损 15.80（现价 15.76）—— 破位必走                   │
│ ▲ 10:22:11 000100 TCL科技   盘中涨幅 +7.2% ≥ 7% —— 追高红线，等回踩                      │
├─ 详情 000725 京东方A ───────────────────────────────────────────────────────────────────┤
│ 评分 65 看多(存疑)   MA 多头   MACD 空头   KDJ 72/68   RSI6 64   ADX 28   ATR 3.2%      │
│ 支撑 5.62 / 5.48 / 5.31    压力 6.10 / 6.35    盈利比 2.4                                │
│ 近 60 日  ▁▂▃▅▆▇█▇▆▅▃▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█  +6.8%                                    │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ [1]总览 [2]告警 [3]详情 [4]帮助    / 过滤   s 排序   Enter 详情   r 刷新   p 暂停   q 退出 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 9.7 总览（80×24，紧凑）

```text
┌ ths watch ──────────── 10:23:45 盘中 ─────────────┐
│ 连接 ●  1.2s  15s  池7  告警2                 [q] │
├───────────────────────────────────────────────────┤
│ 代码   名称      现价    涨跌%   状态             │
│▸000725 京东方A    5.79   +0.52                    │
│ 002185 华天科技  16.05   +1.00   ● 放量           │
│ 000100 TCL科技    4.89   +0.82   ● 放量           │
│ 881129 通信设备  9509.80 +0.70   板块             │
├─ 告警 ─────────────────────────────────────────────┤
│ ● 002185 华天科技  跌破止损 15.80（15.76）         │
│ ▲ 000100 TCL科技   涨幅 +7.2% ≥ 7%                 │
├───────────────────────────────────────────────────┤
│ 选中 000725  评分65 看多(存疑)  支撑5.62 压力6.10  │
│ [1]总览 [2]告警 [3]详情  /过滤 s排序 Enter r p q  │
└───────────────────────────────────────────────────┘
```

### 9.8 详情页

```text
┌ 000725 京东方A · 日K · 前复权 ─────────────────────────────── 5.79 +0.52% ─┐
│ 1520 ┤                                    │                              │
│ 1500 ┤      █             █              █│█                             │
│ 1480 ┤  █   █   │   █    █│█│   MA5 ───  │                              │
│ 1460 ┤  █   █   █   █    █│█│   MA20 ──  │                              │
│ 1440 ┤  │   █   █   █     ││                                            │
│ 1420 ┤      │   │   │                                                    │
│      └──────────────────────────────────────────────────────────────────│
│ 量   ▁▂▃▅▆▇█▇▆▅▃▂▃▄▅▆▇█                                              │
│ MACD ▁▂▃▅▆▇█▇▆▅▃▂▁▂▃▄▅▆                                              │
├──────────────────────────────────────────────────────────────────────────┤
│ 评分 65 看多(存疑) | MA 多头 | MACD 空头 | KDJ 72/68 | RSI6 64 | ADX 28    │
│ 支撑 5.62/5.48/5.31 | 压力 6.10/6.35 | 盈亏比 2.4 | 固化止损 -             │
│ 矛盾: MACD 空头 × 均线多头；KDJ 高位 × 距压力 2.6%                        │
│ [Esc]返回  [1]总览  [2]告警  [s]排序  [/]过滤                             │
└──────────────────────────────────────────────────────────────────────────┘
```

### 9.9 告警页 / 帮助页

- 告警页：按时间倒序，支持 severity 过滤；列：时间 / 代码 / 名称 / 类型 / 消息 / 状态；`a` 确认。
- 帮助页：键位表、颜色图例、数据质量说明、版本号、连接状态。
- 过滤输入：底部单行 `/ 输入代码或名称`；实时过滤；`Esc` 取消。

### 9.10 错误/陈旧/空状态

- 网络错误：状态栏显示错误 + 下次重试倒计时；不清屏。
- 数据陈旧 > 2×interval：顶部黄色横幅 + 状态图标变化。
- 连续失败：指数退避（15s→30s→60s，上限 5min），不直接退出。
- 空池/无行情：表格显示 `—` 和 `⏳ 无行情`；状态栏提示检查 Bridge/浏览器。

### 9.11 性能与稳定性

- Canvas 120×40 渲染目标 < 5ms；行级 diff < 2ms；10fps 无压力。
- 行级 diff + 50ms 合并；无变化不写 stdout。
- 2 小时 soak：内存稳定、无重复告警风暴、无光标残留。
- 退出/崩溃统一 cleanup：显示光标、退出备用屏、移除监听器。

---

## 10. 静态报告（Markdown / HTML）

定位：导出/归档，不是 Web UI。

```bash
ths report daily --format html --out reports/daily-2026-10-18.html
ths report backtest 600519 --strategy score --format html --out bt.html
ths report review --since 90 --format md --out review.md
```

### 10.1 HTML 结构

- 顶部：标题、日期、数据源、生成时间、质量徽标（final/preliminary/stale）。
- 指标卡：收益/回撤/胜率/命中率/风险指标。
- 表格：自选池/持仓/交易/桶统计；数字右对齐，涨跌色。
- SVG 图表：权益曲线、回撤、K 线、相关热力图、桶命中率条形图。
- 底部：数据口径、样本量、免责声明。

### 10.2 样式

- 内联 CSS，系统字体栈（含中文），`max-width: 1100px`。
- `prefers-color-scheme: dark` 自动暗色。
- `@media print` 分页、隐藏交互元素。
- 无外部字体/图片/JS；所有 SVG 内联；可离线打开。
- 所有文本 `escapeHtml`；禁止把行情字符串直接拼进 HTML。

### 10.3 Markdown

- 表格 + 指标卡 + ASCII sparkline/条形图。
- 图表的完整版链接到同目录 HTML。
- 适合 git 归档/PR/复盘记录。

---

## 11. 输出协议

| 模式 | 用途 | 约束 |
|---|---|---|
| `text` | 人看 | 不超过终端宽度；诊断走 stderr |
| `json` | 脚本/Agent | stdout 只有一段合法 JSON；保持现有字段，加 `schemaVersion` |
| `csv` | Excel/分析 | RFC4180；应用列 `fmt`；可选 BOM |
| `ndjson` | 流式 | watch tick/alert 一行一条 |
| `md` | 归档/PR | 表格 + ASCII 图 |
| `html` | 分享/打印 | 内联 CSS/SVG，无外部请求 |

全局参数：

```bash
--format text|json|csv|ndjson|md|html
--out FILE             # 写文件；默认 stdout
--width N              # 覆盖终端宽度（测试/截图）
--no-color / --ascii / --emoji
--theme cn|intl|mono|high-contrast
--tui                  # watch 专用；要求 TTY
```

退出码（建议）：

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行时错误 |
| 2 | 用法/参数错误 |
| 3 | 数据质量不足（样本不足/数据陈旧） |
| 4 | Bridge/网络不可用 |
| 5 | 配置错误 |

---

## 12. 迁移计划

### Batch 1：渲染地基（1-2 天）

- 新增 `capabilities/width/ansi/theme/format/canvas/layout/table/kv/output`。
- 现有 `renderTable/renderKV` 改为委托新实现（外观基本不变，只修中文对齐）。
- `cli.js` 加全局 `--format/--no-color/--ascii/--width/--theme`。
- JSON 诊断改 stderr；先修 `scan`。
- 测试：宽度、CJK/emoji、表格 80/120 快照、颜色开关不变性。

**验收**

```bash
NO_COLOR=1 node cli.js quotes --codes 600519,000001,300750
node cli.js scan --pool watchlist --json | jq .
COLUMNS=80 node cli.js compare --codes 600519,000001
node cli.js analyze 600519 --chart
```

### Batch 2：高价值命令（2-3 天）

- ViewModel：quote/quotes/analyze/compare/scan/risk/backtest。
- widgets：tiles/sparkline/bars/line/candles/heatmap。
- `analyze --chart`、`backtest` 权益曲线、`risk` 热力图、表格 spark 列。
- `--format csv/json` 契约补齐。
- 测试：各命令 80/120 快照、JSON 纯净化。

### Batch 3：每日/组合/报告（2 天）

- daily run/review、portfolio、market/sectors/rank。
- 复盘桶条形图（n/nDir/CI）；方向桶全部显示。
- `ths report --format md|html`。
- 测试：HTML 转义、报告结构、离线资源扫描。

### Batch 4：TUI（3-4 天）

- `lib/realtime/watch-session.js` + `lib/tui/*`。
- 总览/详情/告警/帮助、键位、resize、diff、alt screen。
- 复用 widgets；line 模式保留。
- 测试：reducer、布局边界、键位映射；手工 2 小时 soak。

### Batch 5：打磨（1-2 天）

- ASCII/高对比主题；宽度策略；长文本换行；窄屏堆叠。
- 帮助/补全/README 从命令元数据生成（顺带治理漂移）。
- 性能与视觉回归。

---

## 13. 测试策略

1. **宽度不变式**：任意 renderer、任意 60/80/100/120/160 宽度，所有行 `displayWidth <= width`。
2. **颜色不变式**：`stripAnsi(colorOutput) === noColorOutput`。
3. **Unicode/ASCII**：文本内容一致，仅符号/边框不同。
4. **表格 golden**：中文名、emoji、负数、缺失值、超长名称。
5. **Canvas**：宽字符占位、越界裁剪、diff 正确、控制字符转义。
6. **TUI reducer**：每个键位、过滤/排序/暂停/选择的状态迁移。
7. **布局边界**：60×16、80×24、120×35、160×50；不越界、不超宽。
8. **HTML**：`<script>` 转义、无外部 URL、SVG 存在、打印样式存在。
9. **性能**：1000 行表格 <10ms；120×40 Canvas <5ms；TUI render <5ms。
10. **回归**：现有 321 个测试保持全绿。

建议新增：

```text
tests/render-width.test.js
tests/render-table.test.js
tests/render-canvas.test.js
tests/render-output.test.js
tests/render-charts.test.js
tests/tui-state.test.js
tests/tui-layout.test.js
tests/report-html.test.js
```

---

## 14. 风险与边界

| 风险 | 处理 |
|---|---|
| emoji 宽度因终端而异 | 默认不用 emoji；`--emoji` 显式开启；表格优先几何符号 |
| CJK 歧义宽度 | 默认宽 1；`--width-policy ambiguous=2`；golden 测试锁定 |
| ANSI 混入内容导致截断错误 | 样式与文本分离；进入 Canvas 前 strip/拒绝控制字符 |
| Windows/macOS 终端差异 | 先支持 Linux/macOS 现代终端；Windows 文档标注；`--ascii` 兜底 |
| 极窄终端 | <60 列切堆叠模式；<40 列提示调整宽度 |
| 超长表格 | 静态分页/行数上限；TUI 滚动 |
| 图表过密 | OHLC 聚合 + 线图降采样；原始数据保留在 JSON |
| 数据缺失 | 显式 `—` + 质量横幅，不画假线/假柱 |
| TUI 崩溃残留终端状态 | `SIGINT/SIGTERM/uncaughtException` 全部走 cleanup |
| 安全（本轮不改） | 渲染层不新增端口/外部请求；TUI 只在本地 TTY 运行 |

---

## 15. 开放问题

以下不阻塞 Batch 1，可在后续迭代决定：

1. 静态文本默认是否在 `analyze` 中直接嵌入 K 线，还是只在 `--chart` 时显示？
2. `watch` line 模式是否保留完整表格，还是默认更紧凑的“只显示异常/告警”？
3. HTML 报告是否需要 PDF 导出（依赖外部工具，默认不做）？
4. TUI 告警确认是否需要落盘（与后续实时状态持久化一起做）？
5. 是否需要 `--width-policy` 之外的字体宽度配置（例如 Nerd Font 图标）？

---

## 附录 A：TUI 键位速查

```text
q / Ctrl+C   退出
p            暂停/恢复
r            立即刷新
1 2 3 4      总览 / 告警 / 详情 / 帮助
↑ k / ↓ j    移动
g / G        首行 / 末行
Enter        详情
Esc          返回/取消
s            循环排序
/            过滤
a            确认告警（告警页）
?            帮助
Ctrl+L       强制重绘
```

## 附录 B：宽度算法伪代码

```js
function displayWidth(str) {
  let w = 0;
  for (const cp of Array.from(stripAnsi(str))) {
    const code = cp.codePointAt(0);
    if (isControl(code)) continue;          // 0
    if (isCombining(code)) continue;        // 0
    if (code === 0x09) { w += 4; continue; } // tab
    if (isWide(code) || isEmoji(code)) w += 2;
    else w += 1;
  }
  return w;
}
```

表格布局：

```text
1. 计算每列自然宽度
2. 若总宽 > 可用：按 priority 2 → 1 隐藏列
3. 若仍 > 可用：flex 列均分剩余空间（min/max 夹取）
4. 若仍 > 可用：对最低优先级列 truncateW
5. 若可用 < 60：切堆叠模式
```

## 附录 C：Batch 1 文件清单

新增：

- `lib/render/width.js`
- `lib/render/ansi.js`
- `lib/render/capabilities.js`
- `lib/render/theme.js`
- `lib/render/format.js`
- `lib/render/canvas.js`
- `lib/render/layout.js`
- `lib/render/table.js`
- `lib/render/kv.js`
- `lib/render/output.js`

修改：

- `lib/commands/helpers.js`：`renderTable/renderKV` 委托新实现，保留旧导出。
- `cli.js`：全局 flags；`--format/--no-color/--ascii/--width/--theme`。
- `lib/commands/scan.js`：诊断改 stderr。

新增测试：

- `tests/render-width.test.js`
- `tests/render-table.test.js`
- `tests/render-canvas.test.js`
- `tests/render-output.test.js`

---

## 16. 实施进度

### Batch 1 ✅ 2026-10-18

- `lib/render/width.js`：CJK/emoji/ANSI/组合字符宽度、pad/truncate/wrap。
- `ansi.js` / `capabilities.js` / `theme.js` / `format.js`。
- `canvas.js`：宽字符单元格、边框、颜色、行级 diff。
- `table.js` / `kv.js`：CJK 对齐、响应式列隐藏/收缩、颜色/无色一致性。
- `output.js`：`configureRender/getRenderOptions`、`emit`、诊断走 stderr。
- `helpers.js` 的 `renderTable/renderKV` 委托新实现；旧 API 保持兼容。
- `cli.js` 全局 `--format/--no-color/--ascii/--emoji/--width/--theme/--out`；
  未知命令退出码 2；`--out` 捕获 stdout。
- `scan` 的 `--only-hot` 诊断改走 stderr。
- 测试：`render-width/table/canvas/output`，全量 **398 用例通过**。

**落地差异**：TTY 自动宽度约束暂缓，当前只接受显式 `--width`；
等各命令补齐列 `priority` 后再开启自动约束，避免旧宽表被压到 3 列。

### Batch 2 🟡 部分完成 2026-10-18

- widgets：`sparkline` / `bars` / `line`（Braille + ASCII）/ `candles` / `heatmap` / `tiles`。
- `ths chart <code>`：K 线 + MA5/MA20 + 成交量 + 日期轴。
- `analyze --chart`：在文本分析后追加 K 线。
- `backtest`：`res.equity` + 权益曲线 + 回撤图。
- `risk`：相关系数热力图 + 指标卡。
- `scan` / `compare`：30 日 sparkline 列 + 列 priority。
- `daily review`：改为遍历 `BUCKETS`（方向桶/信号分级全部显示）+ 3 日命中率条形图。
- 测试：`render-charts`、`chart` 命令接入，共 **398 用例通过**。

**待补**：统一 ViewModel 层、quotes 历史 spark、CSV 全命令覆盖、
daily run 的指标卡/指数 spark、HTML/Markdown 报告。

### Batch 4 🟡 TUI 首版 2026-10-18

- `lib/tui/state.js`：不可变状态机、排序/过滤/暂停/页面切换/告警确认。
- `lib/tui/render.js`：总览/告警/详情/帮助四页；响应式列、选中行、告警流、详情 K 线。
- `lib/tui/screen.js`：alt screen、隐藏光标、行级 diff、resize 全量重绘。
- `ths watch --tui`：复用 line 模式的取数/告警引擎；错误退避、暂停、即时刷新、退出清理。
- 详情页复用日 K + MA5/MA20 + 成交量；`--tui` 与 `--json/--once` 互斥。
- 测试：`tui-state` / `tui-render`，全量 **418 用例通过**。

**已完成补充（2026-10-18）**：

- `lib/realtime/watch-journal.js`：当日状态原子写 + 告警/tick append-only JSONL + ack 事件。
- watch line/TUI 默认恢复当日 `prevState`，跨重启不重复触发；首次运行对已破位标的补“启动告警”。
- `ths replay [date] [--ticks] [--json]`：告警时间线 + tick 摘要。
- `--no-journal` 可关闭落盘。

**已完成补充**：告警冷却 `--cooldown N`（同 code+kind 默认 300s 内只留一条）。

**待补**：每日告警上限、告警确认后的跨进程 UI 同步。

### Batch 3 🟡 部分完成 2026-10-18

- `lib/report/svg.js`：折线/条形/热力图/K线内联 SVG。
- `lib/report/html.js`：自包含 HTML 报告（inline CSS/SVG，明暗主题，打印样式）。
- `lib/report/markdown.js`：Markdown 报告（复用终端 ASCII 图表）。
- `ths report daily|review --format md|html|json [--out FILE]`。
- 测试：`report` / `watch-journal` / `replay`，全量 **433 用例通过**。

**已完成补充**：`report backtest`（权益/回撤/交易/成本）、`report risk`（热力图/单票画像/风险提示）、`report portfolio`（市值/浮盈亏/止损状态）。

**待补**：报告内基准调整/置信区间。

### 数据正确性/审计补充 2026-10-18

- RSI/MFI 完全平盘返回中性 50（避免误判超买）。
- 持仓无行情/显式 null 现价回退成本价（避免 -100%）。
- 两市成交额只汇总上证+深成，创业板不再重复计入。
- turnover 日线日期改用北京时间；daily 违规天数同日重跑不再重复 +1。
- 审计：每进程独立 session、`close()` 落盘、超大文件自动轮转、只存轻量摘要；
  移除 kline 嵌套 `startOperation` 对外层操作的覆盖。
- 测试全量 **440 用例通过**。

### Batch 5 ⬜

- ASCII/高对比打磨、帮助/补全自动生成。

---

## 版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1 | 2026-10-18 | 初稿：终端优先 + TUI + Canvas + ViewModel；安全整改延后 |
| v1.1 | 2026-10-18 | 实施 Batch 1 + Batch 2 核心：宽度/表格/Canvas/图表/命令接入；398 测试通过 |
| v1.2 | 2026-10-18 | TUI 首版：状态机/屏幕 diff/总览/告警/详情/帮助；418 测试通过 |
| v1.3 | 2026-10-18 | 实时 journal + replay + 跨重启恢复；`ths report daily/review` HTML/MD/JSON；433 测试通过 |
| v1.4 | 2026-10-18 | 数据正确性补充（RSI/MFI/空价/成交额/时区/违规天数）+ 审计轮转与轻量摘要；440 测试通过 |
| v1.5 | 2026-10-18 | `report backtest/risk`；组合代码排序稳定；445 测试通过 |
| v1.6 | 2026-10-18 | `report portfolio`；报告四件套（daily/review/backtest/risk/portfolio）；448 测试通过 |
| v1.7 | 2026-10-18 | 告警冷却 `--cooldown`；452 测试通过 |
