// lib/portfolio-risk.js — 组合/风控层量化（纯函数，可单测）
//
// 输入：一组标的的日 K（含 date/high/low/close），输出组合层面的风险画像：
//   - 收益相关性矩阵 / 平均两两相关 / 有效独立标的数
//   - 集中度（HHI / 单票权重 / 超 ≤20% 铁律 flag）
//   - 组合波动（等权或给定权重，日/年化）与单票波动预算（ATR%）
//
// 语义：
//   - 收益在"全部标的存在行情"的**共同交易日**上对齐（缺一方的日期剔除），避免停牌日
//     把相关算成 0。
//   - 有效独立标的数 ≈ N/(1+(N-1)·ρ̄)：ρ̄=0 → N；ρ̄=1 → 1（两两完全同涨跌=只有 1 个方向）。
//   - 权重默认等权；调用方（实盘持仓时）可传市值权重。
//   - 波动用样本标准差（n-1），年化 ×√252；ATR% 取最近一期 ATR14 / 收盘。

const { atr } = require('./indicators');

const TRADING_DAYS = 252;

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sampleStd = xs => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

function corr(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  if (vx === 0 || vy === 0) return null; // 任一平线（停牌/一字）→ 相关无定义
  return cov / Math.sqrt(vx * vy);
}

// bars 尾部 n 根 → { date: ret }
function tailDailyReturns(bars, n) {
  const slice = bars.slice(-n);
  const out = {};
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    if (prev > 0) out[slice[i].date] = (slice[i].close - prev) / prev;
  }
  return out;
}

/**
 * 组合风险画像。
 * @param {object} opts
 * @param {Array<{code:string, name?:string, bars:Array<{date,high,low,close}>}>} opts.stocks 升序日 K
 * @param {object} [opts.weights] { code: weight } 缺省等权
 * @param {number} [opts.n=120] 收益窗口（尾部根数）
 * @param {number} [opts.corrThreshold=0.7] 高相关对阈值
 * @param {number} [opts.maxWeight=0.2] 单票权重铁律
 * @returns {object} 见下方示例
 */
function computeRisk({ stocks, weights, n = 120, corrThreshold = 0.7, maxWeight = 0.2 }) {
  const retsMap = {};
  const meta = {};
  for (const s of stocks) {
    const r = tailDailyReturns(s.bars, n);
    if (Object.keys(r).length > 0) {
      retsMap[s.code] = r;
      meta[s.code] = { name: s.name || s.code, atrPct: atrPctOf(s.bars) };
    }
  }
  const codes = Object.keys(retsMap);
  if (codes.length === 0) {
    return { codes: [], errors: ['无可用日K'], metrics: {}, corr: {}, perCode: {}, highCorrPairs: [] };
  }
  if (codes.length === 1) {
    const code = codes[0];
    const aligned = Object.keys(retsMap[code]).sort();
    return single(code, meta, retsMap, aligned, weights, maxWeight);
  }

  // 对齐共同交易日
  let common = null;
  for (const c of codes) {
    const ds = Object.keys(retsMap[c]);
    common = common == null ? new Set(ds) : new Set([...common].filter(d => retsMap[c][d] != null));
  }
  const dates = [...common].sort();
  const window = { dates, n: dates.length, startDate: dates[0], endDate: dates[dates.length - 1] };

  const returnsByCode = {};
  const retPctByCode = {};
  for (const c of codes) {
    const rs = dates.map(d => retsMap[c][d]);
    returnsByCode[c] = rs;
    retPctByCode[c] = (rs.reduce((p, r) => p * (1 + r), 1) - 1) * 100;
  }

  // 相关矩阵
  const corrMat = {};
  for (const a of codes) {
    corrMat[a] = {};
    for (const b of codes) corrMat[a][b] = a === b ? 1 : corr(returnsByCode[a], returnsByCode[b]);
  }

  // 权重（市值权重或等权）
  const given = weights || {};
  let wsum = codes.reduce((s, c) => s + (given[c] || 0), 0);
  let weightsFinal = {};
  if (wsum > 0) {
    for (const c of codes) weightsFinal[c] = (given[c] || 0) / wsum; // 归一化
  } else {
    const w = 1 / codes.length;
    for (const c of codes) weightsFinal[c] = w;
  }

  // 平均两两相关（上三角）
  let sum = 0, cnt = 0;
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
    const r = corrMat[codes[i]][codes[j]];
    if (r != null) { sum += r; cnt++; }
  }
  const avgCorr = cnt ? sum / cnt : null;
  const effectiveBets = avgCorr == null ? codes.length : codes.length / (1 + (codes.length - 1) * avgCorr);

  // 波动
  const dailySigma = {};
  const annSigma = {};
  const atrPctMap = {};
  for (const c of codes) {
    const sd = sampleStd(returnsByCode[c]);
    dailySigma[c] = sd;
    annSigma[c] = sd * Math.sqrt(TRADING_DAYS);
    atrPctMap[c] = meta[c].atrPct;
  }
  // 组合方差 = ΣiΣj wi·wj·σi·σj·ρij
  let varP = 0;
  for (const a of codes) for (const b of codes) {
    varP += weightsFinal[a] * weightsFinal[b] * dailySigma[a] * dailySigma[b] * (corrMat[a][b] || 0);
  }
  const portVolDailyPct = Math.sqrt(Math.max(varP, 0)) * 100;
  const portVolAnnPct = portVolDailyPct * Math.sqrt(TRADING_DAYS);

  // 集中度
  const herfindahl = codes.reduce((s, c) => s + weightsFinal[c] ** 2, 0);
  const overweight = codes.filter(c => weightsFinal[c] > maxWeight);

  // 高相关对（上三角，按 ρ 降序）
  const pairs = [];
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
    const r = corrMat[codes[i]][codes[j]];
    if (r != null && r >= corrThreshold) pairs.push({ a: codes[i], b: codes[j], r });
  }
  pairs.sort((x, y) => y.r - x.r);
  const highCorrPairs = pairs.slice(0, 10);

  const perCode = {};
  for (const c of codes) {
    let sumC = 0, cntC = 0;
    for (const b of codes) if (b !== c && corrMat[c][b] != null) { sumC += corrMat[c][b]; cntC++; }
    perCode[c] = {
      name: meta[c].name,
      weight: weightsFinal[c],
      retPct: retPctByCode[c],
      volAnnPct: annSigma[c] * 100, // 百分数（与 retPct/atrPct/metrics 一致）
      atrPct: atrPctMap[c],
      avgCorrToOthers: cntC ? sumC / cntC : null,
    };
  }

  return {
    codes,
    window,
    weights: weightsFinal,
    corr: corrMat,
    metrics: {
      avgCorr, effectiveBets, herfindahl, maxWeight,
      overweight,
      portVolDailyPct, portVolAnnPct,
    },
    perCode,
    highCorrPairs,
  };
}

// 单标的：无组合维度，只给单票指标
function single(code, meta, retsMap, dates, weights, maxWeight) {
  const rs = dates.map(d => retsMap[code][d]);
  const retPct = (rs.reduce((p, r) => p * (1 + r), 1) - 1) * 100;
  const sd = sampleStd(rs);
  const perCode = {
    [code]: {
      name: meta[code].name,
      weight: 1,
      retPct,
      volAnnPct: sd * Math.sqrt(TRADING_DAYS) * 100, // 百分数
      atrPct: meta[code].atrPct,
      avgCorrToOthers: null,
    },
  };
  return {
    codes: [code],
    window: { dates, n: dates.length, startDate: dates[0], endDate: dates[dates.length - 1] },
    weights: { [code]: 1 },
    corr: { [code]: { [code]: 1 } },
    metrics: {
      avgCorr: null, effectiveBets: 1, herfindahl: 1, maxWeight,
      overweight: maxWeight < 1 ? [code] : [],
      portVolDailyPct: perCode[code].volAnnPct / Math.sqrt(TRADING_DAYS),
      portVolAnnPct: perCode[code].volAnnPct,
    },
    perCode,
    highCorrPairs: [],
  };
}

// 最近一期 ATR14 / 收盘 → %
function atrPctOf(bars) {
  if (!Array.isArray(bars) || bars.length < 20) return null;
  const a = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14);
  let last = null;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] != null && Number.isFinite(a[i])) { last = a[i]; break; }
  }
  const lastClose = bars[bars.length - 1].close;
  if (last == null || !lastClose) return null;
  return (last / lastClose) * 100;
}

module.exports = { computeRisk, tailDailyReturns, corr };
