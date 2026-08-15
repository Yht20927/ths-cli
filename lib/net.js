// lib/net.js — 轻量 HTTP GET（Node 内置模块，零第三方依赖）
//
// 用途: 拉取同花顺数据中心/行情中心的 GBK HTML 页面（板块/排行/龙虎榜/F10）。
// 这些页面实测裸 HTTP 即可访问（无 CORS，无需浏览器上下文），
// 因此不走 Bridge/油猴，直接用 Node http/https 拉取，比页面 fetch 更稳。
//
// 设计:
// - httpGet: GET + 3xx 跟随重定向 + 超时 + 非 200 抛错
// - decodeText: 按 charset 嗅探解码（GBK 为主，UTF-8 兜底）
// - fetchHtml: 一步拉取并解码成字符串

const http = require('http');
const https = require('https');
const { TextDecoder } = require('util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * HTTP GET 到 Buffer。
 * @param {string} url
 * @param {object} [opts] - { timeoutMs=15000, redirects=3 }
 * @returns {Promise<Buffer>}
 */
function httpGet(url, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 15000;
  const redirects = opts.redirects != null ? opts.redirects : 3;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    }, res => {
      // 3xx 跟随重定向（最多 redirects 次）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(httpGet(next, { ...opts, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`请求超时 ${url}`)); });
  });
}

/**
 * Buffer → 字符串，按页面 charset 嗅探。
 * GBK 页面用 TextDecoder('gbk')（Node 全 ICU）；UTF-8 页面直接 utf8。
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeText(buf) {
  const head = buf.slice(0, 512).toString('latin1').toLowerCase();
  const isUtf8 = /charset=["']?utf-?8/i.test(head)
    || (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
  if (isUtf8) return buf.toString('utf8');
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

/**
 * 拉取页面并解码为字符串。
 * @param {string} url
 * @param {object} [opts] - 透传 httpGet
 * @returns {Promise<string>}
 */
async function fetchHtml(url, opts = {}) {
  const buf = await httpGet(url, opts);
  return decodeText(buf);
}

module.exports = { httpGet, decodeText, fetchHtml, UA };
