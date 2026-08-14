# 同花顺 CLI (`ths`)

同花顺(10jqka)行情命令行工具,基于 **Bridge Framework**(油猴脚本 + 本地 Bridge Server + CLI),与 [douyin-cli](https://github.com/Yht20927/douyin-cli) / boss-cli 同一套架构。

- **搜索股票**:中文名 / 代码 / 拼音缩写联想
- **实时行情**:最新价/涨跌/开高低收/量额快照
- **K 线**:日 / 周 / 月 / 季 / 60分 / 120分,支持前/后复权、CSV/JSON 导出
- **分时**:每分钟价格/成交量/成交额
- **大盘成交额**:分时 / 日K 两个粒度
- **技术分析**:区间统计 + MA/MACD/KDJ/RSI/BOLL(纯本地计算,`--json` 可导出完整指标序列)

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
ths quote <code> [--market N] [--json]     实时行情快照
ths kline <code> [--period day|week|month|quarter|60min|120min]
       [--count N] [--adjust forward|backward|none] [--market N]
       [--json|--csv]           获取 K 线
ths trend <code> [--count N] [--market N] [--json|--csv]   分时数据
ths turnover [--period minute|day] [--count N] [--json]    大盘成交额
ths analyze <code> [--period ...] [--count 250] [--market N] [--json]
                                                           K线技术分析
ths help                         帮助
```

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
  }
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
