// lib/report/html.js — 自包含 HTML 报告（内联 CSS/SVG，零依赖）

const { lineSVG, barsSVG, heatmapSVG, candlesSVG, esc } = require('./svg');

/**
 * @param {object} report { title, subtitle, generatedAt, quality, sections }
 * @returns {string}
 */
function renderHtml(report) {
  const title = esc(report.title || 'ths 报告');
  const sections = (report.sections || []).map(renderSection).join('\n');
  const quality = report.quality
    ? `<div class="quality ${esc(report.quality.tone || '')}">${esc(report.quality.label || '')}${
      report.quality.warnings && report.quality.warnings.length
        ? '<ul>' + report.quality.warnings.map(w => `<li>${esc(w)}</li>`).join('') + '</ul>'
        : ''
    }</div>`
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>${title}</h1>
  ${report.subtitle ? `<p class="subtitle">${esc(report.subtitle)}</p>` : ''}
  <p class="meta">生成时间：${esc(report.generatedAt || '')} · 数据来源：同花顺 Bridge / 本地快照</p>
  ${quality}
</header>
${sections}
<footer>
  <p>本报告仅用于个人研究，不构成投资建议。指标与命中率是历史统计，不代表未来收益。</p>
</footer>
</main>
</body>
</html>`;
}

function renderSection(s) {
  if (!s) return '';
  switch (s.type) {
    case 'tiles': return renderTiles(s);
    case 'kv': return renderKV(s);
    case 'table': return renderTable(s);
    case 'chart': return renderChart(s);
    case 'text': return renderText(s);
    case 'alerts': return renderAlerts(s);
    default: return '';
  }
}

function renderTiles(s) {
  const items = (s.items || []).map(it => `
    <div class="tile">
      <div class="label">${esc(it.label)}</div>
      <div class="value ${esc(it.tone || '')}">${esc(it.value)}</div>
      ${it.delta ? `<div class="delta ${esc(it.tone || '')}">${esc(it.delta)}</div>` : ''}
    </div>`).join('');
  return `<section><h2>${esc(s.title || '')}</h2><div class="tiles">${items}</div></section>`;
}

function renderKV(s) {
  const rows = (s.items || []).map(it =>
    `<tr><th>${esc(it.label)}</th><td>${esc(it.value)}</td></tr>`).join('');
  return `<section><h2>${esc(s.title || '')}</h2><table class="kv"><tbody>${rows}</tbody></table></section>`;
}

function renderTable(s) {
  const cols = s.columns || [];
  const head = cols.map(c => `<th class="${c.align === 'r' ? 'r' : ''}">${esc(c.header)}</th>`).join('');
  const rows = (s.rows || []).map(row => {
    const cells = cols.map(c => {
      const raw = typeof c.fmt === 'function' ? c.fmt(row[c.key], row) : row[c.key];
      const tone = typeof c.tone === 'function' ? c.tone(row[c.key], row) : '';
      const cls = [c.align === 'r' ? 'r' : '', tone || ''].filter(Boolean).join(' ');
      return `<td class="${cls}">${esc(raw == null ? '' : raw)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  const note = s.note ? `<p class="note">${esc(s.note)}</p>` : '';
  return `<section><h2>${esc(s.title || '')}</h2><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>${note}</section>`;
}

function renderChart(s) {
  let svg = '';
  if (s.chart === 'line') {
    svg = lineSVG(s.values || [], {
      width: 820, height: s.height || 240, color: s.color || 'var(--up)',
      fill: s.fill, fmt: s.fmt, yMin: s.yMin, yMax: s.yMax, xLabels: s.xLabels,
    });
  } else if (s.chart === 'bars') {
    svg = barsSVG(s.items || [], { width: 820, max: s.max });
  } else if (s.chart === 'heatmap') {
    svg = heatmapSVG(s.labels || [], s.matrix || []);
  } else if (s.chart === 'candles') {
    svg = candlesSVG(s.bars || [], { width: 820, height: s.height || 340 });
  }
  return `<section><h2>${esc(s.title || '')}</h2>${svg}</section>`;
}

function renderText(s) {
  const paras = String(s.text || '').split('\n').filter(Boolean)
    .map(p => `<p>${esc(p)}</p>`).join('');
  return `<section><h2>${esc(s.title || '')}</h2>${paras}</section>`;
}

function renderAlerts(s) {
  const items = (s.items || []).map(a =>
    `<li class="${esc(a.level || '')}"><span class="time">${esc(a.time || '')}</span> <b>${esc(a.code || '')}</b> ${esc(a.name || '')} — ${esc(a.message || '')}</li>`
  ).join('');
  return `<section><h2>${esc(s.title || '告警')}</h2><ul class="alerts">${items}</ul></section>`;
}

const CSS = `
:root{
  --bg:#ffffff; --fg:#1f2328; --muted:#656d76; --grid:#d8dee4; --border:#d0d7de;
  --up:#d1242f; --down:#1a7f37; --accent:#0969da; --card:#f6f8fa;
}
@media (prefers-color-scheme: dark){
  :root{ --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --grid:#30363d; --border:#30363d;
         --up:#ff7b72; --down:#3fb950; --accent:#58a6ff; --card:#161b22; }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
  font-family:system-ui,-apple-system,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  line-height:1.55}
main{max-width:1100px;margin:0 auto;padding:32px 20px 64px}
header{margin-bottom:24px;border-bottom:1px solid var(--border);padding-bottom:16px}
h1{font-size:24px;margin:0 0 6px}
h2{font-size:16px;margin:28px 0 10px;color:var(--fg)}
.subtitle{margin:0;color:var(--muted)}
.meta{font-size:12px;color:var(--muted);margin:8px 0 0}
.quality{font-size:13px;margin-top:10px;padding:8px 10px;border-radius:6px;background:var(--card)}
.quality.critical{color:var(--up)} .quality.warn{color:#9a6700}
.quality ul{margin:6px 0 0 18px;padding:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.tile{border:1px solid var(--border);border-radius:8px;padding:12px 14px;background:var(--card)}
.tile .label{font-size:12px;color:var(--muted)}
.tile .value{font-size:22px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
.tile .delta{font-size:12px;color:var(--muted);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);background:var(--card)}
th.r,td.r{text-align:right;font-variant-numeric:tabular-nums}
.kv th{width:160px;background:transparent;color:var(--muted);font-weight:500}
.up{color:var(--up)} .down{color:var(--down)} .flat{color:var(--muted)}
.critical{color:var(--up)} .warn{color:#9a6700} .info{color:var(--accent)}
.muted,.note{color:var(--muted);font-size:12px}
.chart{width:100%;height:auto;display:block;margin:6px 0}
.alerts{list-style:none;padding:0;margin:0;font-size:13px}
.alerts li{padding:6px 0;border-bottom:1px solid var(--border)}
.alerts .time{color:var(--muted);font-variant-numeric:tabular-nums}
.alerts li.critical{color:var(--up)} .alerts li.warn{color:#9a6700} .alerts li.info{color:var(--accent)}
footer{margin-top:40px;border-top:1px solid var(--border);padding-top:12px;color:var(--muted);font-size:12px}
@media print{
  body{background:#fff;color:#111}
  main{max-width:none;padding:0}
  section{break-inside:avoid}
  .tile{background:#fff}
}
`;

module.exports = { renderHtml };
