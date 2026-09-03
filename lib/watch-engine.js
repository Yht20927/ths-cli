// lib/watch-engine.js — 盘中条件告警引擎（纯函数，可单测）
//
// 语义：
// - 方向告警只在 phase ∈ {am, pm}（连续竞价）评估；auction/pre/lunch/post/weekend
//   只**记录条件快照**（sensor），不产生告警。
// - 传感补发(sensor burst)：跨入 am 的首个 tick，若上一记录来自 auction/pre，则当前仍为
//   真的条件也补发——避免"9:25 竞价站上止损、9:30 跳空跌破"漏报；也避免 auction 就已跌破
//   的情形永不被提。午休(lunch)传感不补发，但照常按边沿处理 13:00 后的新穿越。
// - 冻结/无成交抑制：price==prevClose && pct==0 && volume==0 → 视为停牌/无成交/节假日，
//   条件保持上 tick 值、不产生穿越（免假穿越）。天然覆盖节假日，免自建交易日历。
// - 全等级统一 enter/exit 边沿触发 + 价格类迟滞（须反向越过 ~0.5% 才复位），防震荡刷屏。
// - 首次进入（prevState[code] 缺失）按基线处理不告警——重启/中途接入不误报。
// - 所有比较前 Number() 强转（quotes 字段可能为字符串）。
// - 板块指数(isBoard)不参与任何告警。

const DEFAULT_RULES = {
  chasePct: 7,      // 追高红线：盘中涨幅 >= 7%
  dropPct: -5,      // 急跌阈值：盘中跌幅 <= -5%
  volRatio: 3,      // 放量异动：量比 >= 3
  hystFrac: 0.005,  // 价格条件迟滞（相对比例，约 0.5%）
  armPct: 0.5,      // pct 类条件复位带（百分点）
  armVolFrac: 0.9,  // 量比复位系数
};

const LEVEL_META = {
  critical: { icon: '🔴', rank: 0 },
  warn: { icon: '🟠', rank: 1 },
  info: { icon: '🟡', rank: 2 },
};

const num = v => {
  if (v === null || v === undefined || v === '') return null; // Number(null)=0 是坑：缺失字段必须判空
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const f2 = v => (v == null ? '-' : String(Math.round(Number(v) * 100) / 100));

// 迟滞条件：now()=首次触发判定；hold()=已激活后的保持判定（须明显反向才复位）
const below = (price, lvl, hys) => ({ now: () => price <= lvl, hold: () => price <= lvl * (1 + hys) });
const above = (price, lvl, hys) => ({ now: () => price >= lvl, hold: () => price >= lvl * (1 - hys) });
const pctUp = (x, t, arm) => ({ now: () => x >= t, hold: () => x >= t - arm });
const pctDown = (x, t, arm) => ({ now: () => x <= t, hold: () => x <= t + arm });
const mulUp = (x, t, f) => ({ now: () => x >= t, hold: () => x >= t * f });

function emptyCond() {
  return { stop: false, support: false, resistance: false, chase: false, drop: false, vol: false, limitUp: false, limitDown: false };
}

const KIND_DEF = {
  stop: { level: 'critical', msg: (lvl, price) => `跌破固化止损 ${f2(lvl.stop)}（现价 ${f2(price)}）——破位必走` },
  support: { level: 'critical', msg: (lvl, price) => `跌破支撑 ${f2(lvl.support)}（现价 ${f2(price)}）` },
  resistance: { level: 'warn', msg: (lvl, price) => `触及压力 ${f2(lvl.resistance)}（现价 ${f2(price)}），上方空间收窄` },
  chase: { level: 'warn', msg: (lvl, price, q, R) => `盘中涨幅 ${num(q.pct)}% ≥ ${R.chasePct}% —— 追高红线，等回踩` },
  drop: { level: 'warn', msg: (lvl, price, q, R) => `盘中跌幅 ${num(q.pct)}% ≤ ${R.dropPct}% —— 急跌提醒` },
  vol: { level: 'info', msg: (lvl, price, q, R) => `量比 ${num(q.volumeRatio)} ≥ ${R.volRatio} —— 放量异动` },
  limitUp: { level: 'info', msg: (lvl, price) => `封涨停（现价 ${f2(price)} = 涨停价 ${f2(lvl.limitUp)}）` },
  limitDown: { level: 'info', msg: (lvl, price) => `封跌停（现价 ${f2(price)} = 跌停价 ${f2(lvl.limitDown)}）` },
};

/**
 * 评估一次 tick（见文件头语义）。
 * @param {object} args
 * @param {Array<object>} args.quotes formatQuotes 输出：{code,price,pct,volume,volumeRatio,prevClose,limitUp,limitDown,...}
 * @param {object} args.levels { [code]: {name, isBoard, support, resistance, stop, limitUp, limitDown} }（静态参照位）
 * @param {object} [args.rules] 覆盖 DEFAULT_RULES
 * @param {object} args.prevState 上 tick 的 state（首次 {}）
 * @param {string} args.phase marketPhase 的 phase
 * @returns {{alerts:Array, state:object}}
 */
function evaluateTick({ quotes, levels, rules, prevState, phase }) {
  const R = { ...DEFAULT_RULES, ...(rules || {}) };
  const inSession = phase === 'am' || phase === 'pm';
  const qByCode = new Map();
  for (const q of quotes || []) qByCode.set(String(q.code), q);

  const state = {};
  const alerts = [];

  for (const code of Object.keys(levels || {})) {
    const lvl = levels[code];
    if (!lvl) continue;
    const prev = (prevState && prevState[code]) || null;
    const q = qByCode.get(String(code));
    if (!q) { if (prev) state[code] = prev; continue; } // 无行情：沿用
    if (lvl.isBoard) { state[code] = { board: true, sensor: false, sensorPhase: null }; continue; }

    const prevC = (prev && prev.cond) ? prev.cond : emptyCond();
    const prevExists = !!prev;
    const sensorBurst = !!(prev && prev.sensor && (prev.sensorPhase === 'auction' || prev.sensorPhase === 'pre'));

    const price = num(q.price);
    const row = { frozen: false, cond: {}, fired: [], sensor: !inSession, sensorPhase: inSession ? null : phase };

    if (price == null) {
      row.cond = prevC;
      state[code] = row;
      continue;
    }

    const pct = num(q.pct);
    const vr = num(q.volumeRatio);
    const volume = num(q.volume);
    const prevClose = num(q.prevClose);

    // 冻结/停牌/节假日抑制：不更新条件、不产生穿越
    if (prevClose != null && pct != null && volume != null && price === prevClose && pct === 0 && volume === 0) {
      row.cond = { ...prevC };
      row.frozen = true;
      row.fired = [];
      state[code] = row;
      continue;
    }

    const limitUp = num(lvl.limitUp != null ? lvl.limitUp : q.limitUp);
    const limitDown = num(lvl.limitDown != null ? lvl.limitDown : q.limitDown);

    // 求值一个条件：更新 next 状态；按边沿/传感补发决定是否 fired
    const C = (key, d, prevVal) => {
      if (!d) { row.cond[key] = prevVal; return; } // 本 tick 不适用 → 沿用
      const active = prevVal ? d.hold() : d.now();
      row.cond[key] = active;
      const fire = inSession && prevExists && active && (!prevVal || sensorBurst);
      if (fire) row.fired.push(key);
    };

    C('stop', lvl.stop != null ? below(price, lvl.stop, R.hystFrac) : null, prevC.stop);
    C('support', lvl.support != null ? below(price, lvl.support, R.hystFrac) : null, prevC.support);
    C('resistance', lvl.resistance != null ? above(price, lvl.resistance, R.hystFrac) : null, prevC.resistance);
    C('chase', pct != null ? pctUp(pct, R.chasePct, R.armPct) : null, prevC.chase);
    C('drop', pct != null ? pctDown(pct, R.dropPct, R.armPct) : null, prevC.drop);
    C('vol', vr != null ? mulUp(vr, R.volRatio, R.armVolFrac) : null, prevC.vol);
    C('limitUp', limitUp != null ? above(price, limitUp, 0) : null, prevC.limitUp);
    C('limitDown', limitDown != null ? below(price, limitDown, 0) : null, prevC.limitDown);

    for (const kind of row.fired) {
      const def = KIND_DEF[kind];
      const lm = LEVEL_META[def.level];
      alerts.push({
        code, name: lvl.name || code, kind, level: def.level, icon: lm.icon,
        message: def.msg(lvl, price, q, R),
      });
    }
    state[code] = row;
  }

  alerts.sort((a, b) => LEVEL_META[a.level].rank - LEVEL_META[b.level].rank || String(a.code).localeCompare(String(b.code)));
  return { alerts, state };
}

module.exports = { evaluateTick, DEFAULT_RULES, LEVEL_META };
