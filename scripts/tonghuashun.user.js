// ==UserScript==
// @name         Bridge: Tonghuashun
// @namespace    bridge-framework
// @match        *://*.10jqka.com.cn/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      127.0.0.1:*
// @connect      localhost
// @connect      localhost:*
// @version      1.2.0
// ==/UserScript==

// ═══════════════════════════════════════════════════════════
// Bridge Framework — 同花顺脚本
// 通过 GM_xmlhttpRequest 绕过 Chrome PNA loopback 限制
// unsafeWindow.eval 注入页面上下文 API，用页面的 fetch/cookie 请求
// 同花顺行情接口（quota-h.10jqka.com.cn / news.10jqka.com.cn）
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  // 只在顶层窗口运行：@match 会匹配到页内 iframe（如 My97DatePicker 的
  // data.10jqka.com.cn 子页面），每个 iframe 各自注册连接会互相清掉对方的
  // 连接（server removeStalePolling），导致频繁重连 + 命令卡死。
  if (window.top !== window.self) {
    console.log('[Bridge] iframe 中跳过（' + location.href.slice(0, 60) + '）');
    return;
  }

  const CONFIG = {
    server: 'http://127.0.0.1:19422',
    site: '10jqka.com.cn',
    token: 'fe494ef660d39ebfc5963feaec808fd30a5dcd76d4eb7df5', // 与 config.json 的 bridge.token 保持一致
    reconnectDelay: 2000,
  };

  let connected = false;
  let registered = false;
  let connId = null;           // 服务端返回的连接 ID，poll 时回传用于更新活跃时间
  let retryCount = 0;          // 连续重试次数（指数退避用）
  let pollFailCount = 0;       // 连续 poll 失败次数

  function gmFetch(url, opts) {
    // 自动注入 Authorization header
    const headers = Object.assign({}, opts && opts.headers);
    if (CONFIG.token) headers['Authorization'] = 'Bearer ' + CONFIG.token;
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest(Object.assign({ url: url, timeout: 35000 }, opts, {
        headers: headers,
        onload: function (r) { resolve(r); },
        onerror: function (e) { reject(new Error('GM_xmlhttpRequest failed')); },
        ontimeout: function () { reject(new Error('GM_xmlhttpRequest timeout')); },
      }));
    });
  }

  // 页面上下文专用：BigInt → 字符串
  function safeSerialize(value) {
    try {
      return JSON.parse(JSON.stringify(value === undefined ? null : value, (key, val) => {
        return typeof val === 'bigint' ? val.toString() : val;
      }));
    } catch (e) { return null; }
  }

  // ── HTTP 连接管理（通过 GM_xmlhttpRequest 绕过 PNA）──
  async function connect() {
    if (!registered) {
      try {
        console.log('[Bridge] Registering via GM_xmlhttpRequest...');
        const r = await gmFetch(CONFIG.server + '/api/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({
            site: CONFIG.site,
            url: location.href,
            title: document.title,
            userAgent: navigator.userAgent,
          }),
        });
        if (r.status === 200) {
          registered = true;
          connected = true;
          retryCount = 0; // 成功后重置
          const data = JSON.parse(r.responseText);
          connId = data.id || null; // 保存服务端返回的连接 ID
          console.log('[Bridge] ✓ Registered with Bridge Server, id=' + (connId || '').slice(0, 8));
        } else {
          throw new Error('status ' + r.status);
        }
      } catch (err) {
        retryCount++;
        // 指数退避: 2s, 4s, 8s, 16s, 最大 60s
        const delay = Math.min(CONFIG.reconnectDelay * Math.pow(2, retryCount - 1), 60000);
        console.warn('[Bridge] Registration failed, retry in ' + Math.round(delay / 1000) + 's:', err.message);
        setTimeout(connect, delay);
        return;
      }
    }
    poll();
  }

  async function poll() {
    if (!registered) return;
    try {
      // 注意：必须用 let（下面 += 追加 connId），用 const 会抛
      // "invalid assignment to const" 导致 poll 每次秒败 → 重连循环
      let pollUrl = CONFIG.server + '/api/poll?site=' + CONFIG.site;
      if (connId) pollUrl += '&id=' + connId;
      const r = await gmFetch(pollUrl, { method: 'GET' });
      if (r.status !== 200) throw new Error('status ' + r.status);
      const msg = JSON.parse(r.responseText);

      if (msg.type === 'eval') {
        connected = true;
        pollFailCount = 0;
        // 超时保护：单次 eval/取数最多等 EVAL_TIMEOUT_MS，超时返回错误并继续轮询，
        // 避免某次 fetch 挂起导致整个 poll 循环卡死（后续所有命令排队无客户端）。
        const EVAL_TIMEOUT_MS = 20000;
        let result, error;
        try {
          result = await Promise.race([
            (async () => {
              let r = (0, unsafeWindow.eval)(msg.expression);
              if (msg.awaitPromise !== false) r = await Promise.resolve(r);
              return r;
            })(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('eval 超时(' + EVAL_TIMEOUT_MS + 'ms)')), EVAL_TIMEOUT_MS)),
          ]);
        } catch (e) {
          error = e.message || String(e);
          console.error('[Bridge] eval error:', error);
        }
        try {
          await gmFetch(CONFIG.server + '/api/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id: msg.id, value: error ? undefined : safeSerialize(result), error }),
          });
        } catch (e) {
          console.error('[Bridge] result 提交失败:', e.message);
        }
        poll();
      } else {
        connected = true;
        pollFailCount = 0;
        poll();
      }
    } catch (err) {
      pollFailCount++;
      console.warn('[Bridge] poll fail #' + pollFailCount + ':', err.message);
      if (pollFailCount >= 3) {
        console.warn('[Bridge] Poll failed 3 times, reconnecting...');
        connected = false;
        registered = false;
        pollFailCount = 0;
        setTimeout(connect, CONFIG.reconnectDelay);
      } else {
        setTimeout(poll, 1000);
      }
    }
  }

  // ── SPA 导航检测 ──
  let lastUrl = location.href;
  function checkUrlChange() { if (location.href !== lastUrl) lastUrl = location.href; }
  const _pushState = unsafeWindow.history.pushState;
  const _replaceState = unsafeWindow.history.replaceState;
  unsafeWindow.history.pushState = function () { _pushState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.history.replaceState = function () { _replaceState.apply(this, arguments); checkUrlChange(); };
  unsafeWindow.addEventListener('popstate', checkUrlChange);
  unsafeWindow.addEventListener('hashchange', checkUrlChange);

  // ═══════════════════════════════════════════════════════════
  // 同花顺 __ths API — 注入页面上下文（用页面的 fetch/cookie）
  //
  // 实测要点：
  // - quota-h K线/快照接口在浏览器内必须带完整认证头（X-Fuyao-Auth 为静态 JWT
  //   + X-Auth-* 系列 + sw8），最小头会被 CORS/WAF 拦；裸 HTTP 反而能通。
  // - news 搜索接口带 Accept: application/json + Referer 即通（CORS/反爬依赖页面）。
  // ═══════════════════════════════════════════════════════════

  const BRIDGE_CODE = (function () {/*
(function () {
// ── 同花顺接口常量 ──
var THS = {
  // 静态应用级 JWT（非登录态，所有客户端共享，实测长期有效）
  FUYAO_AUTH: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhdXRob3JpemVyX25hbWVzcGFjZSI6ImNvbW1vbi1ocS1hZ2dyIiwibGljZW5zZWVfdHlwZSI6IkZST05UX0FQUCIsImxpY2Vuc2VlX25hbWVzcGFjZSI6Imh4a2xpbmUtTkVXU19hcHBOZXdzRmxvd0hvbWVfUGFnZSJ9.ldrvWTheNnGOa_rH_buA6OoUpLtW2bhcdr3fABrGHbk',
  SOURCE_ID: 'hxkline-NEWS_appNewsFlowHome_Page',
  PLATFORM: 'hxkline',
  QUOTA: 'https://quota-h.10jqka.com.cn/fuyao/common_hq_aggr/quote/v1',
  SEARCH: 'https://news.10jqka.com.cn/app/headline/mobi-stockdict/v1/search/',
};

// 生成 SkyWalking sw8 观测头（服务端不校验，动态值避免风控启发式）
function genSw8() {
  function rndHex(n) { var s = ''; for (var i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)]; return s; }
  function b64(str) { return btoa(unescape(encodeURIComponent(str))); }
  return '1-' + b64(rndHex(32)) + '-' + b64(rndHex(16)) + '-10-'
    + b64('news-p-fe-app-stock-page<browser>') + '-' + b64('ths-bridge') + '-' + b64(location.hostname);
}

// 统一 fetch + JSON 解析 + 业务错误判断
// 注意:必须用 var 函数表达式而非顶层 async function 声明 —— Firefox 的
// unsafeWindow.eval 对顶层 async function 声明会抛 "single-statement context" 错误。
var thsFetchJson = async function (label, url, init) {
  var resp = await fetch(url, init);
  if (!resp.ok) throw new Error(label + ' HTTP ' + resp.status);
  var text = await resp.text();
  var data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(label + ' 响应非 JSON: ' + text.slice(0, 80)); }
  if (data.status_code !== 0) throw new Error(label + ' 业务错误 status_code=' + data.status_code + ' ' + (data.status_msg || ''));
  return data;
};

// quota-h 完整认证头（浏览器内必须带，最小头会被 CORS/WAF 拦）
function THS_HEADERS() {
  return {
    'Content-Type': 'application/json',
    'X-Fuyao-Auth': THS.FUYAO_AUTH,
    'Source-Id': THS.SOURCE_ID,
    'Platform': THS.PLATFORM,
    'X-Auth-Type': 'ths',
    'X-Auth-Version': '1.0',
    'X-Auth-ProgId': '7047',
    'X-Auth-AppName': 'AINVEST',
    'sw8': genSw8(),
  };
}

window.__ths = {
  // 获取 K 线：code 证券代码 / market 市场码 '17'(沪) '33'(深) '48'(同花顺板块指数)
  // period 周期 day_1/week_1/month_1/quarter_1/min_60/min_120
  // begin 回看条数（负数），如 -250；-1 仅最新一根；adjust 复权 forward/backward/none
  kline: async function (code, market, period, begin, adjust) {
    var data = await thsFetchJson('kline', THS.QUOTA + '/single_kline', {
      method: 'POST',
      headers: THS_HEADERS(),
      body: JSON.stringify({
        code_list: [{ codes: [code], market: String(market) }],
        trade_class: 'intraday',
        time_period: period,
        trade_date: -1,
        begin_time: begin,
        end_time: 0,
        adjust_type: adjust || 'forward',
        gpid: 0,
      }),
    });
    return data.data.quote_data[0] || null;
  },

  // 搜索股票（联想）：kw 中文名/代码/拼音缩写
  searchStock: async function (kw) {
    var url = THS.SEARCH + '?isrealcode=1&associate=1&json=1&markettype=2&query=' + encodeURIComponent(kw);
    var data = await thsFetchJson('search', url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Referer': 'https://www.10jqka.com.cn/' },
    });
    return data.data || null;
  },

  // 实时行情快照字段：
  // 基础 6价/7开/8高/9低/10昨收/13量(股)/19额(元) | 69涨停/70跌停
  // 扩展 199112涨跌幅/264648涨跌额/3153PE/592920PB/3475914总市值/3541450流通市值/1968584换手率/1771976量比
  QUOTE_FIELDS: ['6', '7', '8', '9', '10', '13', '19', '69', '70', '199112', '264648', '3153', '592920', '3475914', '3541450', '1968584', '1771976'],

  // 批量实时行情：items = [{code, market}]，按 market 分组一次请求多只
  quotes: async function (items) {
    if (!items || !items.length) return [];
    var byMarket = {};
    items.forEach(function (it) { var m = String(it.market); (byMarket[m] = byMarket[m] || []).push(it.code); });
    var groups = Object.keys(byMarket).map(function (m) { return { codes: byMarket[m], market: m }; });
    var all = [];
    for (var i = 0; i < groups.length; i++) {
      var data = await thsFetchJson('quotes', THS.QUOTA + '/multi_last_snapshot', {
        method: 'POST',
        headers: THS_HEADERS(),
        body: JSON.stringify({
          code_list: [groups[i]],
          trade_class: 'intraday',
          data_fields: this.QUOTE_FIELDS,
          lang: 'zh_cn',
          gpid: 2,
        }),
      });
      all = all.concat(data.data.quote_data || []);
    }
    return all;
  },

  // 单只实时行情快照（兼容）
  quote: async function (code, market) {
    var arr = await this.quotes([{ code: code, market: market }]);
    return arr[0] || null;
  },

  // 分时：code / market / count 限制返回条数（0=全部）
  trend: async function (code, market, count) {
    var data = await thsFetchJson('trend', THS.QUOTA + '/single_trend', {
      method: 'POST',
      headers: THS_HEADERS(),
      body: JSON.stringify({
        code_list: [{ codes: [code], market: String(market) }],
        trade_class: 'intraday',
        trade_date: 0,
        begin_time: 0,
        end_time: 0,
      }),
    });
    var qd = data.data.quote_data[0] || null;
    if (qd && count > 0 && Array.isArray(qd.value) && qd.value.length > count) {
      qd.value = qd.value.slice(-count); // 只保留最近 count 根
    }
    return qd;
  },

  // 大盘成交额：period 'minute'|'day'
  turnover: async function (period) {
    var chartKey = period === 'day' ? 'turnover_day' : 'turnover_minute';
    var url = 'https://dq.10jqka.com.cn/fuyao/market_analysis_api/chart/v1/get_chart_data?chart_key=' + chartKey;
    var data = await thsFetchJson('turnover', url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Referer': 'https://www.10jqka.com.cn/' },
    });
    return data.data.charts || null;
  },

  // 大盘指数快照 + 涨跌家数（d.10jqka.com.cn realhead JSONP 接口）
  // 返回 [{ code, name, price, prevClose, open, high, amount, upCount, downCount, flatCount, updateTime }]
  // 字段都在 items 内: 7最新价 / 8今开 / 9昨收 / 10最高 / 19成交额 /
  //                   37上涨家数 / 38下跌家数 / 39平盘家数 / name / updateTime
  market: async function () {
    var codes = ['hs_1A0001', 'hs_399001', 'hs_399006']; // 上证指数/深证成指/创业板指
    var out = [];
    for (var i = 0; i < codes.length; i++) {
      var resp = await fetch('https://d.10jqka.com.cn/v2/realhead/' + codes[i] + '/last.js');
      var text = await resp.text();
      var m = text.match(/\((.+)\)\s*$/);
      var o = JSON.parse(m[1]);
      var it = o.items || {};
      out.push({
        code: codes[i].replace('hs_', ''),
        name: it.name,
        price: it['7'], prevClose: it['9'], open: it['8'], high: it['10'],
        amount: it['19'], upCount: it['37'], downCount: it['38'], flatCount: it['39'],
        updateTime: it.updateTime,
      });
    }
    return out;
  },

  // 资金流排行（data.10jqka.com.cn GBK 页面；code 参数为接口必需，返回全市场排行）
  // 返回 { headers, rows: [{rank, code, name, price, pct, turnoverRate, inflow, outflow, net, amount, bigIn, cells}] }
  fundflow: async function (code) {
    var url = 'https://data.10jqka.com.cn/funds/ggzjl/code/' + (code || '600519') + '/';
    var resp = await fetch(url);
    var buf = await resp.arrayBuffer();
    var html = new TextDecoder('gbk').decode(buf);
    var table = (html.match(/<table[^>]*>[\s\S]*?<\/table>/g) || [])[0] || '';
    var headers = (table.match(/<th[^>]*>[\s\S]*?<\/th>/g) || []).map(function (s) {
      return s.replace(/<[^>]+>/g, '').trim();
    });
    var rows = [];
    var trs = (table.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []).slice(1); // 跳过表头行
    var strip = function (s) { return s.replace(/<[^>]+>/g, ' ').replace(/-->/g, '').replace(/\s+/g, ' ').trim(); };
    for (var i = 0; i < trs.length; i++) {
      var cells = (trs[i].match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip);
      if (cells.length < 4) continue;
      rows.push({
        rank: cells[0], code: cells[1], name: cells[2], price: cells[3], pct: cells[4],
        turnoverRate: cells[5], inflow: cells[6], outflow: cells[7], net: cells[8],
        amount: cells[9], bigIn: cells[10], cells: cells,
      });
    }
    return { headers: headers, rows: rows };
  },
};

console.log('[Bridge:Tonghuashun] __ths API ready');
})();
*/}).toString().match(/\/\*([\s\S]*)\*\//)[1];

  // 注入到页面上下文。
  // 优先用 <script> 元素注入 —— Firefox 的 unsafeWindow.eval 对多语句/顶层
  // async 声明有限制（会抛 "single-statement context"），<script> 元素最稳。
  function injectBridgeCode() {
    try {
      const s = document.createElement('script');
      s.textContent = BRIDGE_CODE;
      (document.head || document.documentElement).appendChild(s);
      setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 0);
      return true;
    } catch (e) {
      console.error('[Bridge] <script> 注入失败，回退 unsafeWindow.eval:', e.message);
      try {
        unsafeWindow.eval(BRIDGE_CODE);
        return true;
      } catch (e2) {
        console.error('[Bridge] eval 回退也失败:', e2.message);
        return false;
      }
    }
  }
  const injected = injectBridgeCode();
  console.log('[Bridge] __ths injected =', injected, ', typeof =', typeof (unsafeWindow.__ths));

  // ── 启动 ──
  connect();
  console.log('[Bridge] Script loaded for ' + CONFIG.site);
})();
