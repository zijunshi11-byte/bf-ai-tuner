/**
 * Evidence sufficiency: does this log actually contain what a rule needs?
 *
 * Replaces the old "log must be >= 30 s" idea (HANDOFF §6.1). Duration is a
 * poor proxy: 60 s of hovering has no stick steps, and 15 s of hard racing can
 * hold everything. Instead each analysis domain declares the evidence it needs
 * (clean steps per axis, throttle chops, raw-gyro spectrum, high-throttle
 * time ...) and a rule whose domain is short of evidence stands down for this
 * round. The operator is told exactly what to fly to fill the gap.
 *
 * Pure functions only; computeMetrics() attaches `assessEvidence(report)` to
 * every report and proposeTune() gates on it.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Minimum evidence per domain. Exported so tests and the UI quote the same numbers. */
export const EVIDENCE_NEEDS = Object.freeze({
  /** Clean setpoint->gyro steps per axis (estimateStepResponse samples). */
  stepsPerAxis: Object.freeze({ roll: 5, pitch: 5, yaw: 3 }),
  /** Mean 5-100 Hz setpoint->gyro coherence for a tracking / transfer fit. */
  trackingCoherence: 0.5,
  /** Usable throttle-chop segments for propwash / iterm_relax evidence. */
  propwashChops: 3,
  /** Welch segments (512 samples) of raw gyro behind the noise spectrum. */
  noiseSegments: 16,
  /** Logging rate below which the noise band (200 Hz+) is barely visible. */
  minSampleRateHz: 1000,
  /** Seconds at or above `highThrottleLevel` before a filter may be OPENED. */
  highThrottleS: 2,
  highThrottleLevel: 0.7,
});

const AXES = ['roll', 'pitch', 'yaw'];

/**
 * Guided test flights. Each card fills one or more evidence domains; the UI
 * shows only the cards whose domains are short, so the operator flies what is
 * missing instead of a fixed timer. Card C (chirp) is optional: it needs a
 * firmware built with USE_CHIRP and is never demanded.
 */
export const FLIGHT_CARDS = Object.freeze([
  Object.freeze({
    id: 'A',
    title: '科目 A · 噪声与油门扫描',
    goal: '采到原始陀螺噪声谱，并覆盖高油门段（放宽滤波前必须有）',
    steps: [
      '起飞后悬停约 10 秒',
      '直线平飞中把油门由低到满匀速推上去再收回，重复 3–4 次',
      `至少累计 ${EVIDENCE_NEEDS.highThrottleS} 秒在 ${Math.round(EVIDENCE_NEEDS.highThrottleLevel * 100)}% 以上油门（直道冲刺即可）`,
    ],
    domains: ['noise', 'noiseOpen', 'rpm'],
    optional: false,
  }),
  Object.freeze({
    id: 'B',
    title: '科目 B · 打杆阶跃',
    goal: '采到干净的 setpoint→gyro 阶跃，用于超调/跟手/前馈/传递函数',
    steps: [
      '必须在 ACRO（自稳关闭）模式下飞，ANGLE/HORIZON 的数据不用于横滚/俯仰',
      `横滚、俯仰各打 ≥ ${EVIDENCE_NEEDS.stepsPerAxis.roll} 次快速满舵并回中，每次之间停顿约 1 秒`,
      `偏航打 ≥ ${EVIDENCE_NEEDS.stepsPerAxis.yaw} 次`,
      '中等油门进行，避免同时大幅改变油门',
    ],
    domains: ['steps', 'tracking'],
    optional: false,
  }),
  Object.freeze({
    id: 'C',
    title: '科目 C · 洗桨（收油门下坠）',
    goal: '采到收油门穿过自身尾流的片段，用于洗桨与 iterm_relax 判断',
    steps: [
      `至少 ${EVIDENCE_NEEDS.propwashChops} 次：爬升后把油门急收到底，下坠 1–2 秒再接油门`,
      '收油门期间尽量不动方向杆，让抖动只来自尾流',
    ],
    domains: ['propwash'],
    optional: false,
  }),
  Object.freeze({
    id: 'D',
    title: '科目 D · 扫频（可选）',
    goal: '固件带 USE_CHIRP 时，用扫频得到更可靠的闭环频响；只影响 P/I/FF，从不据此改滤波',
    steps: [
      'aux 开关切到 CHIRP 模式，debug_mode = CHIRP，每次只扫一个轴',
      '保持 ACRO 与中等油门，扫频期间不打杆',
    ],
    domains: ['tracking'],
    optional: true,
  }),
]);

const DOMAIN_LABEL = Object.freeze({
  logging: '记录设置',
  steps: '打杆阶跃',
  tracking: '跟踪/传递函数',
  propwash: '洗桨片段',
  noise: '噪声频谱',
  noiseOpen: '高油门覆盖（放宽滤波前提）',
  rpm: '电机转速（eRPM）',
});

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * Throttle as a 0..1 fraction. The decoder's `throttle` channel falls back to
 * rcCommand[3] (1000..2000 us) or setpoint[3] (0..1000), so the scale is
 * detected from the data. Returns null when the scale is not recognisable -
 * an unknown scale must read as "no high-throttle evidence", never as plenty.
 */
export function normaliseThrottle(values) {
  if (!values || !values.length) return null;
  const sorted = Array.from(values, Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 8) return null;
  const lo = percentile(sorted, 0.02);
  const hi = percentile(sorted, 0.98);
  let toUnit;
  if (lo >= 900 && hi <= 2100) toUnit = (v) => (v - 1000) / 1000;
  else if (lo >= -1 && hi <= 1001) toUnit = (v) => v / 1000;
  else return null;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = toUnit(Number(values[i]));
    out[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  }
  return out;
}

/**
 * Time spent per throttle quarter, plus seconds above the high-throttle level.
 * @returns {{available:boolean, bandsS:number[], bandsPct:number[], highS:number, maxPct:number}}
 */
export function throttleProfile(values, sampleRateHz, { highLevel = EVIDENCE_NEEDS.highThrottleLevel } = {}) {
  const empty = { available: false, bandsS: [0, 0, 0, 0], bandsPct: [0, 0, 0, 0], highS: 0, maxPct: 0 };
  const unit = normaliseThrottle(values);
  if (!unit || !(sampleRateHz > 0)) return empty;
  const counts = [0, 0, 0, 0];
  let high = 0;
  let max = 0;
  for (const v of unit) {
    counts[Math.min(3, Math.floor(v * 4))]++;
    if (v >= highLevel) high++;
    if (v > max) max = v;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    available: true,
    bandsS: counts.map((c) => r1(c / sampleRateHz)),
    bandsPct: counts.map((c) => r1((c / unit.length) * 100)),
    highS: r1(high / sampleRateHz),
    maxPct: Math.round(max * 100),
  };
}

/**
 * Stick-input evidence on one axis: isolated steps, or accepted
 * deconvolution windows (one per half second of real stick input), whichever
 * the log holds more of.
 */
function axisSteps(metrics, axis) {
  const a = metrics?.axes?.[axis];
  return Math.max(num(a?.step?.samples) ?? 0, num(a?.stepDeconv?.samples) ?? 0);
}

function axisCoherence(metrics, axis) {
  const a = metrics?.axes?.[axis];
  return num(a?.transfer?.metrics?.meanCoherence) ?? num(a?.trackingCoherence) ?? 0;
}

/**
 * Assess every evidence domain of one metrics report.
 *
 * @returns {{
 *   domains: Record<string, {ok:boolean, label:string, have:any, need:any, axes?:object, advice:string}>,
 *   missing: string[],
 *   flights: object[],
 * }}
 */
export function assessEvidence(metrics) {
  const N = EVIDENCE_NEEDS;
  const domains = {};
  const rate = num(metrics?.sampleRateHz) ?? 0;

  /* logging: a precondition for the noise domain, fixed on the FC not in the air */
  const hasRaw = AXES.some((a) => metrics?.axes?.[a]?.gyroUnfiltSpectrum?.psd?.length);
  const loggingOk = hasRaw && rate >= N.minSampleRateHz;
  domains.logging = {
    ok: loggingOk,
    label: DOMAIN_LABEL.logging,
    have: { gyroUnfilt: hasRaw, sampleRateHz: rate },
    need: { gyroUnfilt: true, sampleRateHz: N.minSampleRateHz },
    advice: loggingOk
      ? ''
      : [
          !hasRaw ? '黑盒字段需包含 gyroUnfilt（BF 4.4+ 默认带；4.3 用 debug_mode = GYRO_SCALED）' : '',
          rate < N.minSampleRateHz ? `黑盒记录频率 ${rate || '未知'} Hz，至少需要 ${N.minSampleRateHz} Hz（推荐 2 kHz）` : '',
        ].filter(Boolean).join('；'),
  };

  /* steps: per axis */
  const stepAxes = {};
  for (const axis of AXES) {
    const have = axisSteps(metrics, axis);
    const need = N.stepsPerAxis[axis];
    stepAxes[axis] = { have, need, ok: have >= need };
  }
  const stepsOk = AXES.every((a) => stepAxes[a].ok);
  domains.steps = {
    ok: stepsOk,
    label: DOMAIN_LABEL.steps,
    axes: stepAxes,
    have: stepAxes,
    need: N.stepsPerAxis,
    advice: stepsOk
      ? ''
      : AXES.filter((a) => !stepAxes[a].ok)
          .map((a) => `${axisName(a)}还差 ${stepAxes[a].need - stepAxes[a].have} 次有效打杆（现有 ${stepAxes[a].have}）`)
          .join('；'),
  };

  /* tracking: coherence AND excitation on the same axis */
  const trackAxes = {};
  for (const axis of AXES) {
    const coherence = axisCoherence(metrics, axis);
    const ok = coherence >= N.trackingCoherence && stepAxes[axis].ok;
    trackAxes[axis] = { have: Math.round(coherence * 100) / 100, need: N.trackingCoherence, ok };
  }
  const trackingOk = AXES.every((a) => trackAxes[a].ok);
  domains.tracking = {
    ok: trackingOk,
    label: DOMAIN_LABEL.tracking,
    axes: trackAxes,
    have: trackAxes,
    need: N.trackingCoherence,
    advice: trackingOk
      ? ''
      : AXES.filter((a) => !trackAxes[a].ok)
          .map((a) => `${axisName(a)}相干度 ${trackAxes[a].have}（需 ≥ ${N.trackingCoherence} 且打杆足够）`)
          .join('；'),
  };

  /* propwash: throttle chops are shared by all axes - take the best axis count */
  const chops = Math.max(0, ...AXES.map((a) => num(metrics?.axes?.[a]?.propwashEvents) ?? 0));
  domains.propwash = {
    ok: chops >= N.propwashChops,
    label: DOMAIN_LABEL.propwash,
    have: chops,
    need: N.propwashChops,
    advice: chops >= N.propwashChops ? '' : `收油门下坠片段 ${chops} 个，至少需要 ${N.propwashChops} 个`,
  };

  /* noise: raw spectrum backed by enough averaging */
  const segments = Math.max(0, ...AXES.map((a) => num(metrics?.axes?.[a]?.gyroUnfiltSpectrum?.segments) ?? 0));
  const noiseOk = loggingOk && segments >= N.noiseSegments;
  domains.noise = {
    ok: noiseOk,
    label: DOMAIN_LABEL.noise,
    have: segments,
    need: N.noiseSegments,
    advice: noiseOk
      ? ''
      : !loggingOk
        ? domains.logging.advice
        : `原始陀螺频谱只有 ${segments} 段平均，至少需要 ${N.noiseSegments} 段（多飞几秒即可）`,
  };

  /* noiseOpen: opening a filter needs proof the high-throttle noise is known */
  const highS = num(metrics?.throttleProfile?.highS) ?? 0;
  const openOk = noiseOk && highS >= N.highThrottleS;
  domains.noiseOpen = {
    ok: openOk,
    label: DOMAIN_LABEL.noiseOpen,
    have: highS,
    need: N.highThrottleS,
    advice: openOk
      ? ''
      : !noiseOk
        ? domains.noise.advice
        : `${Math.round(N.highThrottleLevel * 100)}% 以上油门只有 ${highS} 秒，至少需要 ${N.highThrottleS} 秒才能判断放宽滤波是否安全`,
  };

  /* rpm: eRPM telemetry */
  const rpm = (num(metrics?.rpmAvailable) ?? 0) > 0;
  domains.rpm = {
    ok: rpm,
    label: DOMAIN_LABEL.rpm,
    have: rpm,
    need: true,
    advice: rpm ? '' : '日志里没有 eRPM：需开启双向 DShot 并在黑盒字段中记录电机转速',
  };

  const missing = Object.keys(domains).filter((k) => !domains[k].ok);
  const flights = FLIGHT_CARDS.filter((card) => !card.optional && card.domains.some((d) => missing.includes(d)));
  return { domains, missing, flights: flights.map((c) => c.id) };
}

function axisName(axis) {
  return { roll: '横滚', pitch: '俯仰', yaw: '偏航' }[axis] || axis;
}

/* ------------------------------------------------------------------ *
 * Proposal gating
 * ------------------------------------------------------------------ */

/**
 * Evidence domains a proposal depends on, from its rule id. `null` means the
 * proposal is configuration-driven or a hardware fault and is never gated
 * here (faults have their own blocking path).
 */
const DOMAIN_BY_ID = [
  [/^overshoot-/, ['steps']],
  [/^sluggish-/, ['steps']],
  [/^i-(high|low)-/, ['steps']],
  [/^feedforward-lag-/, ['tracking']],
  [/^tf-tune-/, ['tracking']],
  [/^propwash-/, ['propwash']],
  [/^filter-iterm-relax-evidence$/, ['propwash']],
  [/^filter-rpm-health$/, ['rpm', 'noise']],
  [/^filter-(assessment|residual-peak|dterm-lpf1|gyro-lpf1-tight|gyro-lpf1-open|dterm-latency)$/, ['noise']],
];

export function domainsForProposal(p) {
  const id = String(p?.id || '');
  for (const [re, domains] of DOMAIN_BY_ID) {
    if (re.test(id)) return opensFilter(p?.diff) ? [...domains, 'noiseOpen'] : domains;
  }
  // Unknown rule: if it opens a filter it still needs the high-throttle proof.
  return opensFilter(p?.diff) ? ['noise', 'noiseOpen'] : null;
}

/**
 * True when a diff loosens noise filtering: a low-pass cutoff raised, or fewer
 * dynamic notches / RPM harmonics. That is the direction that crashed a quad
 * (btfl_003.bbl) and so the direction that needs high-throttle evidence.
 */
export function opensFilter(diff) {
  if (!Array.isArray(diff)) return false;
  return diff.some((d) => {
    const from = num(d?.from);
    const to = num(d?.to);
    if (from === null || to === null) return false;
    const param = String(d?.param || '');
    if (/lpf\d?(_static|_dyn_min|_dyn_max)?_hz$/.test(param)) return to > from;
    if (param === 'dyn_notch_count' || param === 'rpm_filter_harmonics') return to < from;
    return false;
  });
}

const AXIS_SUFFIX = /_(roll|pitch|yaw)$/;

/** Axes named by a proposal's diff; empty when the diff is not per-axis. */
function diffAxes(p) {
  const set = new Set();
  for (const d of p?.diff || []) {
    const m = AXIS_SUFFIX.exec(String(d?.param || ''));
    if (m) set.add(m[1]);
  }
  return [...set];
}

function domainOk(evidence, domain, axes) {
  const d = evidence?.domains?.[domain];
  if (!d) return true;
  if (d.axes && axes.length) return axes.every((a) => d.axes[a]?.ok !== false);
  return d.ok;
}

/**
 * Split proposals into those backed by enough evidence and those withheld.
 * A per-axis domain is checked only on the axes the proposal actually changes,
 * so a roll fix is not blocked by missing yaw steps. A proposal with several
 * domains needs all of them.
 *
 * @returns {{kept: object[], withheld: {id:string, domains:string[]}[]}}
 */
export function gateProposals(proposals, evidence) {
  if (!evidence?.domains) return { kept: proposals, withheld: [] };
  const kept = [];
  const withheld = [];
  for (const p of proposals) {
    const domains = domainsForProposal(p);
    if (!domains) {
      kept.push(p);
      continue;
    }
    const axes = diffAxes(p);
    const short = domains.filter((d) => !domainOk(evidence, d, axes));
    if (short.length) withheld.push({ id: p.id, domains: short });
    else kept.push(p);
  }
  return { kept, withheld };
}

/**
 * One advisory proposal in the mandated six-part order that says what was
 * held back and what to fly to unlock it. Never carries a diff.
 */
export function evidenceGapProposal(evidence, withheld) {
  const shortDomains = [...new Set(withheld.flatMap((w) => w.domains))];
  if (!shortDomains.length) return null;
  const lines = shortDomains.map((d) => `${evidence.domains[d]?.label || d}：${evidence.domains[d]?.advice || '证据不足'}`);
  const cards = FLIGHT_CARDS.filter((c) => !c.optional && c.domains.some((d) => shortDomains.includes(d)));
  return {
    id: 'evidence-gap',
    problem: `证据不足：${withheld.length} 条建议本轮暂不给出`,
    evidence: lines.join('。') + '。',
    cli: [],
    why: '这些建议所依赖的数据在本日志里不够充分，在不充分的数据上改参数等于猜测；宁可少给一条建议，也不改错一个参数。',
    verification: cards.length
      ? `补飞：${cards.map((c) => c.title).join('、')}，然后重新分析。`
      : '补充记录后重新分析。',
    ifNotApplied: '对应方面继续沿用当前参数，不会有任何参数被修改。',
    confidence: 1,
    category: 'evidence',
    safeToApply: false,
    blockedBy: ['证据不足'],
    diff: [],
    withheld,
    flightCards: cards.map((c) => c.id),
  };
}

export default {
  EVIDENCE_NEEDS,
  FLIGHT_CARDS,
  assessEvidence,
  gateProposals,
  evidenceGapProposal,
  throttleProfile,
  normaliseThrottle,
  opensFilter,
  domainsForProposal,
};
