// lib/daily-review.js — 每日复盘的纯函数（可单测）
//
// 三个能力：
//   computeOutcomes       给某只股票的历史快照补 3/5 日窗口的 outcome（命中/支撑/压力）
//   computeStats          按特征桶聚合命中率（signal/评分/均线/市场情绪…）
//   generateSuggestions   基于统计生成池建议（剔除/减仓/加入）
//
// 窗口定位（无交易日历）：对某 code 按 date 去重升序的快照序列 snaps[]，
//   snaps[i] 的 3 日窗口闭合 ⇔ i+3 < len，终点 = snaps[i+3]，窗口 = snaps[i+1..i+3]。
//   缺跑的日子自然顺延；周末同日重跑被去重 → 幂等。
// 命中判定：hit = (看多 ∧ ret>0) || (看空 ∧ ret<0)；观望不参与命中率但计入 n/avgRet。

const MIN_N = 5;
const WINDOWS = [3, 5];

const round4 = v => (v == null || !isFinite(v) ? null : Number(v.toFixed(4)));

// ── 分组 / 去重 ──

function groupByCode(snaps) {
  const m = new Map();
  for (const s of snaps) {
    if (!s || !s.code) continue;
    if (!m.has(s.code)) m.set(s.code, []);
    m.get(s.code).push(s);
  }
  return m;
}

/** 同一交易日期只留最后一次（重跑幂等） */
function dedupByDate(snaps) {
  const m = new Map();
  for (const s of snaps) if (s && s.date) m.set(s.date, s);
  return [...m.values()];
}

/** 升序排序 */
function sortByDate(snaps) {
  return snaps.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ── 窗口 outcome ──

/**
 * 为某只股票的历史快照补 3/5 日窗口 outcome。
 * @param {Array<object>} codeSnaps 该 code 的（可能未排序/含重复日期的）快照
 * @returns {Array<object>} 同长度，每项附 outcome: {3:{ret,hit,supportHeld,hitResistance,closeAt},5:{…}} | null
 */
function computeOutcomes(codeSnaps) {
  const sorted = sortByDate(dedupByDate(codeSnaps));
  return sorted.map((s, i) => {
    const outcome = {};
    for (const N of WINDOWS) {
      const endIdx = i + N;
      if (endIdx >= sorted.length) continue; // 窗口未闭合
      const end = sorted[endIdx];
      if (s.close == null || end.close == null) continue;
      const ret = end.close / s.close - 1;
      const hit = s.signal === '看多' ? ret > 0
        : s.signal === '看空' ? ret < 0
        : null; // 观望不判定
      const win = sorted.slice(i + 1, endIdx + 1);
      let supportHeld = null;
      if (s.support != null) {
        const lows = win.map(x => x.dayLow).filter(v => v != null);
        if (lows.length === win.length) supportHeld = lows.every(v => v > s.support);
      }
      let hitResistance = null;
      if (s.resistance != null) {
        const highs = win.map(x => x.dayHigh).filter(v => v != null);
        if (highs.length === win.length) hitResistance = highs.some(v => v > s.resistance);
      }
      outcome[N] = { ret: round4(ret), hit, supportHeld, hitResistance, closeAt: end.close };
    }
    return { ...s, outcome: Object.keys(outcome).length ? outcome : null };
  });
}

// ── 统计聚合 ──

const emptyAgg = () => ({
  n3: 0, nDir3: 0, hits3: 0, retSum3: 0, hitRate3: null, avgRet3: null,
  n5: 0, nDir5: 0, hits5: 0, retSum5: 0, hitRate5: null, avgRet5: null,
});

function addToAgg(agg, s, win) {
  const o = s.outcome && s.outcome[win];
  if (!o || o.ret == null) return;
  const f = win === 3 ? '3' : '5';
  agg[`n${f}`]++;
  agg[`retSum${f}`] += o.ret;
  if (o.hit != null) {
    agg[`nDir${f}`]++;
    if (o.hit) agg[`hits${f}`]++;
  }
}

function finalize(agg, minN) {
  agg.hitRate3 = agg.n3 >= minN && agg.nDir3 ? agg.hits3 / agg.nDir3 : null;
  agg.avgRet3 = agg.n3 ? agg.retSum3 / agg.n3 : null;
  agg.hitRate5 = agg.n5 >= minN && agg.nDir5 ? agg.hits5 / agg.nDir5 : null;
  agg.avgRet5 = agg.n5 ? agg.retSum5 / agg.n5 : null;
}

// ── 特征桶 ──
// Tier 1（始终显示）：signal / scoreBand / ma / marketMood
// Tier 2（n≥MIN_N 才显示）：macdDir / kdjRegime / rsiRegime / adxRegime / atrRegime / patternDir / resonance

const scoreBandOf = s => (s.score == null ? null : s.score >= 70 ? '≥70' : s.score >= 60 ? '60-69' : s.score >= 41 ? '41-59' : '≤40');
const macdDirOf = s => (s.macdStatus === '金叉' || s.macdStatus === '多头') ? '偏多'
  : (s.macdStatus === '死叉' || s.macdStatus === '空头') ? '偏空' : '中性';
const patternDirOf = s => {
  if (!Array.isArray(s.patterns) || !s.patterns.length) return '无';
  const bull = s.patterns.some(p => p.direction === 'bull');
  const bear = s.patterns.some(p => p.direction === 'bear');
  return bull ? '看多' : bear ? '看空' : '中性';
};
const resonanceOf = s => (s.score >= 60 && s.maAlignment === '多头排列' && s.macdStatus !== '空头' && s.adx != null && s.adx >= 25) ? '是' : '否';

const BUCKETS = [
  { key: 'signal', label: '信号', tier: 1, valueOf: s => s.signal },
  { key: 'scoreBand', label: '评分', tier: 1, valueOf: scoreBandOf },
  { key: 'ma', label: '均线', tier: 1, valueOf: s => s.maAlignment },
  { key: 'marketMood', label: '市场', tier: 1, valueOf: s => (s.marketEnv && s.marketEnv.mood) || null },
  { key: 'boardMood', label: '板块', tier: 1, valueOf: s => (s.direction && s.direction.boardMood && s.direction.boardMood.label) || null },
  { key: 'fundDir', label: '资金', tier: 1, valueOf: s => (s.direction && s.direction.fundDir && s.direction.fundDir.label) || null },
  { key: 'lhbJoin', label: '龙虎榜', tier: 1, valueOf: s => (s.direction && s.direction.lhbJoin && s.direction.lhbJoin.label) || null },
  { key: 'macdDir', label: 'MACD', tier: 2, valueOf: macdDirOf },
  { key: 'kdjRegime', label: 'KDJ', tier: 2, valueOf: s => (s.kdj && s.kdj.k != null) ? (s.kdj.k >= 80 ? '超买' : s.kdj.k <= 20 ? '超卖' : '中性') : null },
  { key: 'rsiRegime', label: 'RSI6', tier: 2, valueOf: s => (s.rsi6 != null) ? (s.rsi6 > 70 ? '超买' : s.rsi6 < 30 ? '超卖' : '中性') : null },
  { key: 'adxRegime', label: 'ADX', tier: 2, valueOf: s => (s.adx != null) ? (s.adx >= 25 ? '趋势强' : s.adx < 20 ? '无趋势' : '中等') : null },
  { key: 'atrRegime', label: 'ATR%', tier: 2, valueOf: s => (s.atrPct != null) ? (s.atrPct >= 5 ? '高波动' : s.atrPct <= 2 ? '低波动' : '中等') : null },
  { key: 'patternDir', label: '形态', tier: 2, valueOf: patternDirOf },
  { key: 'resonance', label: '共振', tier: 2, valueOf: resonanceOf },
  { key: 'signalGrade', label: '信号分级', tier: 2, valueOf: s => s.signalLabel || null },
  { key: 'boardLeader', label: '龙头', tier: 2, valueOf: s => (s.dir && s.dir.boardLeader) ? '龙头' : (s.dir ? '非龙头' : null) },
  { key: 'dirResonance', label: '方向共振', tier: 2, valueOf: s => (s.dir && s.dir.dirCount >= 2) ? '2重+' : (s.dir && s.dir.dirCount === 1) ? '1重' : (s.dir ? '无' : null) },
];

/**
 * 统计快照集合的命中率。
 * @param {Array<object>} snaps 扁平快照（每项含 marketEnv）
 * @param {object} [opts] { minN }
 * @returns {object} { overall, buckets, perCode, pending, minN }
 */
function computeStats(snaps, opts = {}) {
  const minN = opts.minN != null ? opts.minN : MIN_N;
  const overall = emptyAgg();
  const buckets = {};
  const perCode = {};
  const pending = { n3: 0, n5: 0 };

  for (const [code, codeSnaps] of groupByCode(snaps)) {
    const withOut = computeOutcomes(codeSnaps);
    // 排除「已移除且未闭合」的记录（窗口永远不会闭合，避免稀释样本）
    const active = withOut.filter(s => !(s.removedAt && !s.outcome));
    perCode[code] = {
      last: active[active.length - 1] || null,
      stat3: emptyAgg(),
      stat5: emptyAgg(),
      bySignal: { 看多: emptyAgg(), 看空: emptyAgg(), 观望: emptyAgg() },
    };
    for (const s of active) {
      addToAgg(perCode[code].stat3, s, 3);
      addToAgg(perCode[code].stat5, s, 5);
      const bs = perCode[code].bySignal[s.signal];
      if (bs) { addToAgg(bs, s, 3); addToAgg(bs, s, 5); }

      addToAgg(overall, s, 3);
      addToAgg(overall, s, 5);

      for (const b of BUCKETS) {
        const v = b.valueOf(s);
        if (v == null) continue;
        if (!buckets[b.key]) buckets[b.key] = {};
        if (!buckets[b.key][v]) buckets[b.key][v] = emptyAgg();
        addToAgg(buckets[b.key][v], s, 3);
        addToAgg(buckets[b.key][v], s, 5);
      }

      if (!s.outcome || s.outcome[3] == null) pending.n3++;
      if (!s.outcome || s.outcome[5] == null) pending.n5++;
    }
    finalize(perCode[code].stat3, minN);
    finalize(perCode[code].stat5, minN);
    for (const sig of Object.keys(perCode[code].bySignal)) {
      finalize(perCode[code].bySignal[sig], minN);
    }
  }

  finalize(overall, minN);
  for (const k of Object.keys(buckets)) {
    for (const v of Object.keys(buckets[k])) finalize(buckets[k][v], minN);
  }

  return { overall, buckets, perCode, pending, minN };
}

// ── 池建议 ──

/**
 * 基于统计生成池建议（只出建议，不执行）。
 * @param {object} p { snaps, watchlist, candidates }
 *   snaps 扁平快照；watchlist 自选池；candidates 候选代码（触发 add 建议）
 * @returns {Array<{type, code, name, reason, strength}>}
 */
function generateSuggestions(p = {}, opts = {}) {
  const { snaps = [], candidates = [] } = p;
  const minN = opts.minN != null ? opts.minN : MIN_N;
  const out = [];
  const stats = computeStats(snaps, { minN });
  const byCode = groupByCode(snaps);

  for (const [code, codeSnaps] of byCode) {
    const withOut = computeOutcomes(codeSnaps);
    const last = withOut[withOut.length - 1];
    if (!last || last.removedAt) continue; // 已移除的股票不再给建议
    if (last.isBoard) continue;            // 板块指数仅供观察，不产生买卖建议（M1-2）
    const tail3 = withOut.slice(-3);
    const pc = stats.perCode[code];
    const st3 = pc ? pc.stat3 : emptyAgg();

    // 每只股票最多给一条主建议（remove 优先于 reduce）
    let removeReason = null, removeStrength = null;
    let reduceReason = null;

    // R1: 最近≥3条连续看空 且 该股"看空"信号3日命中率<40%（看空样本≥minN）
    const allBearish = tail3.length >= 3 && tail3.every(s => s.signal === '看空');
    const bearSig = pc && pc.bySignal['看空'];
    if (allBearish && bearSig && bearSig.nDir3 >= minN && bearSig.hitRate3 != null && bearSig.hitRate3 < 0.4) {
      removeReason = `连续≥3日看空，看空3日命中率 ${Math.round(bearSig.hitRate3 * 100)}%`;
      removeStrength = 'strong';
    }

    // R2: 处于下跌趋势（最近5条已闭合3日预测 avgRet3 ≤ -3%）且最新看空 → 剔除（下跌趋势股不值得监控）
    const closed3 = withOut.filter(o => o.outcome && o.outcome[3] && o.outcome[3].ret != null);
    const last5 = closed3.slice(-5);
    if (!removeReason && last.signal === '看空' && last5.length >= 5) {
      const avg = last5.reduce((s, o) => s + o.outcome[3].ret, 0) / last5.length;
      if (avg <= -0.03) {
        removeReason = `下跌趋势（最近5次3日均收益 ${(avg * 100).toFixed(1)}%）且仍看空`;
        removeStrength = 'strong';
      } else {
        reduceReason = '最新看空'; // W1
      }
    } else if (!removeReason && last.signal === '看空') {
      reduceReason = '最新看空'; // W1
    }

    // W2: 追高风险——当日涨幅≥7%（SKILL"不追高"红线），或超买且接近压力位（上行空间<3%）
    if (!removeReason && last.signal === '看多') {
      const pct = last.pct != null ? last.pct : 0;
      const kHot = last.kdj && last.kdj.k != null && last.kdj.k >= 80;
      const rHot = last.rsi6 != null && last.rsi6 > 70;
      const nearRes = last.resistance != null && last.close != null
        && last.resistance > last.close && (last.resistance - last.close) / last.close < 0.03;
      if (pct >= 7) {
        reduceReason = `当日涨 ${pct.toFixed(1)}%，不追高（SKILL 红线）`;
      } else if ((kHot || rHot) && nearRes) {
        reduceReason = `看多但超买且距压力位<3%，追高风险`;
      }
    }

    // W3: 评分≤40 连续≥3天 → 剔除候选
    if (tail3.length >= 3 && tail3.every(s => s.score != null && s.score <= 40)) {
      if (!removeReason) {
        removeReason = '连续≥3日评分≤40';
        removeStrength = 'weak';
      }
    }

    if (removeReason) {
      out.push({ type: 'remove', code, name: last.name, reason: removeReason, strength: removeStrength });
    } else if (reduceReason) {
      out.push({ type: 'reduce', code, name: last.name, reason: reduceReason, strength: 'normal' });
    }
  }

  // A1: candidates → 加入建议。有特征时比对历史高分组合给强弱；无特征（分析失败）给弱建议兜底
  for (const cand of candidates) {
    const code = cand.code || cand;
    // 已有快照=已被监控（含曾监控/已移除）→ 不再建议加入；已出 remove/reduce → 跳过，避免矛盾
    if (byCode.has(code)) continue;
    if (out.some(s => s.code === code && s.type !== 'add')) continue;

    let best = null; // { rate, label } 历史命中率最高的匹配特征
    const band = cand.score != null ? scoreBandOf(cand) : null;
    if (band && stats.buckets.scoreBand && stats.buckets.scoreBand[band]) {
      const agg = stats.buckets.scoreBand[band];
      if (agg.hitRate3 != null && agg.n3 >= minN) best = { rate: agg.hitRate3, label: `评分${band}` };
    }
    if (resonanceOf(cand) === '是' && stats.buckets.resonance && stats.buckets.resonance['是']) {
      const agg = stats.buckets.resonance['是'];
      if (agg.hitRate3 != null && agg.n3 >= minN && (!best || agg.hitRate3 > best.rate)) {
        best = { rate: agg.hitRate3, label: '共振' };
      }
    }
    if (cand.signal && stats.buckets.signal && stats.buckets.signal[cand.signal]) {
      const agg = stats.buckets.signal[cand.signal];
      if (agg.hitRate3 != null && agg.n3 >= minN && (!best || agg.hitRate3 > best.rate)) {
        best = { rate: agg.hitRate3, label: `信号${cand.signal}` };
      }
    }

    let strength;
    if (best && best.rate >= 0.55) strength = 'strong';
    else if (best) strength = 'weak'; // 有历史证据但命中率差 → 谨慎
    else strength = (cand.score != null && cand.score >= 60) ? 'normal' : 'weak'; // 无证据按评分兜底
    const reason = best
      ? `候选${cand.score != null ? `评分${cand.score}${cand.signal ? ' ' + cand.signal : ''}` : ''}，历史${best.label}3日命中 ${Math.round(best.rate * 100)}%${best.rate < 0.55 ? '，偏弱谨慎' : ''}`
      : '候选加入（建议 analyze 确认共振）';
    out.push({ type: 'add', code, name: cand.name || null, reason, strength });
  }

  // 去重：同 code 同 type 只留一条
  const seen = new Set();
  return out.filter(s => {
    const k = `${s.code}:${s.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = { MIN_N, WINDOWS, BUCKETS, groupByCode, computeOutcomes, computeStats, generateSuggestions };
