// lib/report/markdown.js — Markdown 报告（终端图表复用 ASCII 版本）

const { sparkline } = require('../render/widgets/sparkline');
const { renderBars } = require('../render/widgets/bars');
const { heatmap } = require('../render/widgets/heatmap');
const { candlestickChart } = require('../render/widgets/candles');

/**
 * @param {object} report
 * @returns {string}
 */
function renderMarkdown(report) {
  const out = [];
  out.push(`# ${report.title || 'ths 报告'}`);
  if (report.subtitle) out.push('', `> ${report.subtitle}`);
  out.push('', `生成时间：${report.generatedAt || ''} · 数据来源：同花顺 Bridge / 本地快照`);
  if (report.quality) {
    out.push('', `**${report.quality.label || ''}**`);
    for (const w of report.quality.warnings || []) out.push(`- ⚠ ${w}`);
  }
  for (const s of report.sections || []) out.push('', ...renderSection(s));
  out.push('', '---', '', '本报告仅用于个人研究，不构成投资建议。指标与命中率是历史统计，不代表未来收益。');
  return out.join('\n') + '\n';
}

function renderSection(s) {
  if (!s) return [];
  const title = s.title ? `## ${s.title}` : '';
  switch (s.type) {
    case 'tiles': return [title, '', renderTiles(s)].filter(Boolean);
    case 'kv': return [title, '', renderKV(s)].filter(Boolean);
    case 'table': return [title, '', renderTable(s), s.note ? `\n_${s.note}_` : ''].filter(Boolean);
    case 'chart': return [title, '', renderChart(s)].filter(Boolean);
    case 'text': return [title, '', String(s.text || '')].filter(Boolean);
    case 'alerts': return [title, '', ...(s.items || []).map(a =>
      `- ${a.time || ''} **${a.code || ''}** ${a.name || ''} — ${a.message || ''}${a.acked ? ' ✓' : ''}`)].filter(Boolean);
    default: return [];
  }
}

function renderTiles(s) {
  const rows = (s.items || []).map(it => `| ${esc(it.label)} | ${esc(it.value)} |`);
  return ['| 指标 | 值 |', '|---|---|', ...rows].join('\n');
}

function renderKV(s) {
  const rows = (s.items || []).map(it => `| ${esc(it.label)} | ${esc(it.value)} |`);
  return ['| 项 | 值 |', '|---|---|', ...rows].join('\n');
}

function renderTable(s) {
  const cols = s.columns || [];
  const head = `| ${cols.map(c => esc(c.header)).join(' | ')} |`;
  const sep = `| ${cols.map(c => (c.align === 'r' ? '---:' : '---')).join(' | ')} |`;
  const rows = (s.rows || []).map(row => `| ${cols.map(c => {
    const raw = typeof c.fmt === 'function' ? c.fmt(row[c.key], row) : row[c.key];
    return esc(raw == null ? '' : raw);
  }).join(' | ')} |`);
  return [head, sep, ...rows].join('\n');
}

function renderChart(s) {
  if (s.chart === 'line') {
    const values = s.values || [];
    return [
      '```text',
      sparkline(values, { width: Math.min(100, Math.max(20, values.length || 40)) }),
      '```',
    ].join('\n');
  }
  if (s.chart === 'bars') {
    return ['```text', renderBars(s.items || [], { width: 88, fmt: v => String(Math.round(Number(v) * 10) / 10) }), '```'].join('\n');
  }
  if (s.chart === 'heatmap') {
    return ['```text', heatmap(s.labels || [], s.matrix || [], { width: 88, color: false }), '```'].join('\n');
  }
  if (s.chart === 'candles') {
    return ['```text', candlestickChart(s.bars || [], { width: 88, height: 14, volumeHeight: 3, ascii: true }), '```'].join('\n');
  }
  return '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = { renderMarkdown };
