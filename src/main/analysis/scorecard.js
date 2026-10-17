/**
 * Racing scorecard: the handful of numbers a 5-inch racing tune is judged by,
 * pulled from one metrics report so successive flights can be compared.
 *
 * Every KPI is a measurement already in the report (or, for filter delay, a
 * first-order estimate from the configured cutoffs, labelled as such). The
 * grade bands are references for a 5-inch racing quad, not pass/fail gates;
 * nothing here drives a parameter change.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const AXES_RP = ['roll', 'pitch'];

function num(v) {
  // null / undefined / '' are "not measured"; Number(null) === 0 would turn a
  // missing KPI into a perfect score.
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, d = 1) {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function maxOf(metrics, axes, pick) {
  let best = null;
  for (const a of axes) {
    const v = num(pick(metrics?.axes?.[a] || {}));
    if (v !== null && (best === null || v > best)) best = v;
  }
  return best;
}

/** First-order (PT1) group delay of a low-pass at `hz`: 1 / (2 pi fc), in ms. */
export function pt1DelayMs(hz) {
  const f = num(hz);
  return f && f > 0 ? 1000 / (2 * Math.PI * f) : 0;
}

/**
 * KPI definitions. `bands` = [good, ok] upper bounds when lower is better
 * (value <= good -> 'ok', <= ok -> 'warn', else 'crit').
 */
export const KPIS = Object.freeze([
  {
    key: 'delayMs',
    label: '跟杆延迟（50%）',
    unit: 'ms',
    bands: [8, 14],
    source: '反卷积阶跃 50% 时间，横滚/俯仰取大',
    pick: (m) => maxOf(m, AXES_RP, (a) => (a.stepDeconv?.samples ? a.stepDeconv.delay50Ms : null)),
  },
  {
    key: 'overshootPct',
    label: '阶跃超调',
    unit: '%',
    bands: [15, 30],
    source: '反卷积阶跃（含前馈），横滚/俯仰取大',
    pick: (m) => maxOf(m, AXES_RP, (a) => (a.stepDeconv?.samples ? a.stepDeconv.overshootPct : null)),
  },
  {
    key: 'propwash',
    label: '洗桨指数',
    unit: '',
    bands: [0.3, 0.6],
    source: '收油门片段振荡能量，三轴取大',
    pick: (m) => maxOf(m, ['roll', 'pitch', 'yaw'], (a) => (a.propwashEvents ? a.propwashIndex : null)),
  },
  {
    key: 'dTermRatio',
    label: 'D 项/陀螺能量（电机热代理）',
    unit: '',
    bands: [0.25, 0.33],
    source: 'D 项 RMS ÷ 陀螺 RMS，三轴取大',
    pick: (m) => maxOf(m, ['roll', 'pitch', 'yaw'], (a) => a.dTermToGyroRatio),
  },
  {
    key: 'noiseAttenuationDb',
    label: '噪声带衰减',
    unit: 'dB',
    bands: [-18, -12],
    higherIsBetter: true,
    source: '原始→滤波后 200 Hz 以上能量差，三轴取最差',
    pick: (m) => {
      let worst = null;
      for (const a of ['roll', 'pitch', 'yaw']) {
        const v = num(m?.axes?.[a]?.filterAttenuationDb);
        if (v !== null && (worst === null || v < worst)) worst = v;
      }
      return worst;
    },
  },
  {
    key: 'filterDelayMs',
    label: '滤波延迟（估算）',
    unit: 'ms',
    bands: [1.2, 2.0],
    source: '陀螺 LPF1 + D 项 LPF1 的一阶近似 1/(2πfc)，取较大者',
    pick: (m) => {
      const f = m?.craftSettings?.filter || {};
      const gyro = pt1DelayMs(f.gyroLpf1DynMinHz || f.gyroLpf1Hz) + pt1DelayMs(f.gyroLpf2Hz);
      const dterm = pt1DelayMs(f.dtermLpf1DynMinHz || f.dtermLpf1Hz) + pt1DelayMs(f.dtermLpf2Hz);
      const v = Math.max(gyro, dterm);
      return v > 0 ? v : null;
    },
  },
  {
    key: 'saturationPct',
    label: '电机饱和',
    unit: '%',
    bands: [5, 20],
    source: '半数以上电机 ≥ 97% 输出的样本占比',
    pick: (m) => num(m?.motorSaturationPct),
  },
]);

function grade(kpi, value) {
  if (value === null) return 'na';
  const [good, ok] = kpi.bands;
  // higherIsBetter bands are given as negated bounds, e.g. attenuation
  // >= 18 dB is good: compare -value against [-18, -12].
  const v = kpi.higherIsBetter ? -value : value;
  if (v <= good) return 'ok';
  if (v <= ok) return 'warn';
  return 'crit';
}

/**
 * @returns {{kpis: {key:string,label:string,unit:string,value:number|null,grade:'ok'|'warn'|'crit'|'na',source:string}[]}}
 */
export function buildScorecard(metrics) {
  return {
    kpis: KPIS.map((k) => {
      const value = round(k.pick(metrics), k.unit === '' ? 3 : 1);
      return { key: k.key, label: k.label, unit: k.unit, value, grade: grade(k, value), source: k.source };
    }),
  };
}

/**
 * Per-KPI change between two scorecards: direction is "better"/"worse" in
 * the KPI's own sense, null when either side is missing.
 */
export function compareScorecards(before, after) {
  const prev = Object.fromEntries((before?.kpis || []).map((k) => [k.key, k]));
  return (after?.kpis || []).map((k) => {
    const b = prev[k.key];
    if (!b || b.value === null || k.value === null) return { key: k.key, label: k.label, before: b?.value ?? null, after: k.value, direction: null };
    const def = KPIS.find((x) => x.key === k.key);
    const delta = k.value - b.value;
    const better = def?.higherIsBetter ? delta > 0 : delta < 0;
    const same = Math.abs(delta) <= Math.max(1e-9, Math.abs(b.value) * 0.05);
    return { key: k.key, label: k.label, before: b.value, after: k.value, direction: same ? 'same' : better ? 'better' : 'worse' };
  });
}

export default { KPIS, buildScorecard, compareScorecards, pt1DelayMs };
