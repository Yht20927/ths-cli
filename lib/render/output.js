// lib/render/output.js — 输出上下文与统一出口（零依赖）
//
// 约定：
// - stdout 只放数据/渲染结果；info/warn/error 一律走 stderr
// - renderOptions 由 cli.js 在启动时配置一次，命令层通过 helpers 读取
// - emit() 供新命令/迁移中的命令使用；旧命令仍可直接 console.log

const fs = require('fs');
const { safeSerialize } = require('../shared/serialize');

const DEFAULT_RENDER = Object.freeze({
  width: null,          // null = 自然宽度；数字 = 终端宽度约束
  border: 'ascii',      // ascii | round | square | compact | none
  color: false,
  theme: null,          // resolveTheme() 结果
  unicode: 'basic',
  emoji: false,
  themeName: 'cn',
});

let renderOptions = { ...DEFAULT_RENDER };

const DEFAULT_OUTPUT = Object.freeze({
  format: 'text',
  out: null,
  quiet: false,
});

let outputOptions = { ...DEFAULT_OUTPUT };

/** 配置渲染默认值（cli.js 启动时调用） */
function configureRender(opts = {}) {
  renderOptions = { ...renderOptions, ...opts };
}

function getRenderOptions() {
  return { ...renderOptions };
}

function resetRenderOptions() {
  renderOptions = { ...DEFAULT_RENDER };
}

/** 配置输出模式（cli.js 启动时调用） */
function configureOutput(opts = {}) {
  outputOptions = { ...outputOptions, ...opts };
}

function getOutputOptions() {
  return { ...outputOptions };
}

function resetOutputOptions() {
  outputOptions = { ...DEFAULT_OUTPUT };
}

/**
 * 写数据到 stdout 或 --out 文件。
 * @param {string} text
 * @param {object} [opts] { out }
 */
function write(text, opts = {}) {
  const out = opts.out != null ? opts.out : outputOptions.out;
  const s = String(text == null ? '' : text);
  if (out) {
    fs.writeFileSync(out, s);
    return;
  }
  process.stdout.write(s);
}

/**
 * 统一出口。
 * - json: 一段合法 JSON
 * - csv:  字符串或数组
 * - text: 字符串或行数组
 * @param {*} data
 * @param {object} [opts] { format, out }
 */
function emit(data, opts = {}) {
  const format = opts.format || outputOptions.format || 'text';
  if (format === 'json') {
    const text = JSON.stringify(safeSerialize(data), null, 2) + '\n';
    write(text, opts);
    return;
  }
  if (format === 'csv' || format === 'text' || format === 'ndjson') {
    if (Array.isArray(data)) {
      write(data.join('\n') + (data.length ? '\n' : ''), opts);
      return;
    }
    if (typeof data === 'string') {
      write(data.endsWith('\n') ? data : data + '\n', opts);
      return;
    }
    // 对象在 text/csv 下没有通用渲染器；明确报错，避免静默输出 [object Object]
    throw new Error(`emit(${format}) 需要字符串或行数组，收到 ${typeof data}`);
  }
  throw new Error(`不支持的输出格式: ${format}`);
}

/** 诊断信息：stderr，不污染 stdout */
function info(msg) {
  process.stderr.write(String(msg == null ? '' : msg) + '\n');
}

function warn(msg) {
  process.stderr.write('⚠ ' + String(msg == null ? '' : msg) + '\n');
}

function error(msg) {
  process.stderr.write('✖ ' + String(msg == null ? '' : msg) + '\n');
}

module.exports = {
  DEFAULT_RENDER,
  configureRender,
  getRenderOptions,
  resetRenderOptions,
  configureOutput,
  getOutputOptions,
  resetOutputOptions,
  write,
  emit,
  info,
  warn,
  error,
};
