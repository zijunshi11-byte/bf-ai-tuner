/**
 * Tuning proposal engine.
 *
 * Turns a MetricsReport into a small number of *evidence-backed* proposals,
 * each formatted as:
 *
 *     problem -> evidence -> CLI suggestion -> re-fly verification
 *
 * Design rules this module enforces:
 *
 *  - Every claim carries the numbers that produced it. A rule that cannot
 *    quote real evidence returns nothing.
 *  - Steps are conservative: P/I move 5-10% (we target 7%), D moves 2-3 units,
 *    filters move at most 10%.
 *  - Hardware faults stop the process. When metrics.blocksTuning is set, no
 *    PID or filter proposal is produced at all - only the fault report.
 *  - The engine never writes. It returns diffs; the caller applies them behind
 *    an explicit confirmation.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { STEP_LIMITS, FORBIDDEN_PARAMS } from '../../shared/contracts.js';
import { noiseFloorDbfs } from './bbl-fft.js';

/** Axis index -> name. Blackbox axes are roll, pitch, yaw in that order. */
export const AXES = ['roll', 'pitch', 'yaw'];

/**
 * Absolute sanity ranges for a 5-inch racing quad on Betaflight 4.x.
 * A proposal that would push a value outside its range is emitted but marked
 * unsafe, so the operator sees *why* the engine held back.
 */
export const SANE_RANGES = {
  p: { min: 20, max: 120, typical: [45, 55] },
  i: { min: 30, max: 160, typical: [80, 95] },
  // 5-inch racers run lower D than freestyle builds; the ceiling stays well
  // under what starts cooking motors.
  d: { min: 15, max: 80, typical: [30, 40] },
  f: { min: 0, max: 200, typical: [100, 130] },
  // Floors are the "do not go below" line, not targets: the advice never
  // proposes cutting a low-pass below these, and never proposes 0.
  gyroLpf: { min: 150, max: 500, typical: [150, 250] },
  dtermLpf: { min: 80, max: 250, typical: [100, 150] },
};

/**
 * 5-inch racing reference points, quoted in the advice so the operator can see
 * what the recommendation is anchored to.
 *
 * Latency is the priority: prefer the RPM filter with 3 harmonics and the
 * dynamic notch over a heavy global low-pass, keep the low-passes "just enough"
 * rather than aggressive, and never disable them outright.
 */
export const RACING_REFERENCE = {
  gyroLpfHz: [150, 170],
  dtermLpfHz: [100, 150],
  dRollPitch: [30, 40],
  itermRelaxCutoffHz: [25, 35],
  motorHeatRedLine: '着陆摸电机不能「烫到握不住 3 秒」；达到这个程度就先降 D / D_min，并检查滤波与桨。',
  lowLatencyPreference: '能用 RPM 滤波（harmonics=3）与动态陷波解决的，不靠全局重低通。',
};

/** Thresholds. Every one of these is quoted in the evidence text when it fires. */
export const THRESHOLDS = {
  overshootPct: 18,
  overshootHighPct: 30,
  settlingMs: 110,
  riseTimeSlowMs: 62,
  propwashIndex: 0.32,
  dTermToGyroRatio: 0.33,
  iTermWindup: 0.55,
  lowFreqOscHz: [4, 16],
  motorHarmonicHz: [80, 400],
  noiseFloorDbfs: -28,
};

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * @param {object} args
 * @param {import('../../shared/contracts.js').MetricsReport} args.metrics
 * @param {import('../../shared/contracts.js').PidProfile} args.currentPid
 * @param {import('../../shared/contracts.js').FilterConfig} args.currentFilter
 * @param {object} [args.capabilities]
 * @returns {import('../../shared/contracts.js').TuneProposal[]}
 */
export function proposeTune(
  { metrics, currentPid = null, currentFilter = null, capabilities = null, dynamics = null } = {},
) {
  if (!metrics) return [];

  const blocking = (metrics.faults || []).filter((f) => f.blocksTuning);
  if (blocking.length) {
    // Hard stop: report the faults, propose nothing that changes flight behaviour.
    return blocking.map((fault, i) => hardwareProposal(fault, i, metrics));
  }

  const proposals = [];
  const pid = normalisePid(currentPid);
  const filter = normaliseFilter(currentFilter);

  proposals.push(...rulePropwash(metrics, pid, dynamics));
  proposals.push(...ruleOvershoot(metrics, pid));
  proposals.push(...ruleSluggish(metrics, pid));
  proposals.push(...ruleITerm(metrics, pid));
  // Spectrum-driven filter shaping comes first: it is the half of the advice
  // the operator cannot read off the PID screen.
  // One filter authority. D-term and gyro LPF findings are produced by
  // ruleFilterShaping so the same symptom cannot yield two competing diffs.
  const filterFindings = ruleFilterShaping(metrics, pid, filter, capabilities);
  proposals.push(...filterFindings);
  // If the filter analysis produced no actionable change, report that fact with
  // its numbers. Silence is the worst answer here: the operator cannot tell
  // whether the filter analysis ran and found nothing wrong, or never ran.
  if (!filterFindings.some((p) => (p.diff || []).length > 0)) {
    proposals.push(...ruleFilterSummary(metrics, filter));
  }

  // Soft hardware warnings (non-blocking) are surfaced but never auto-applied.
  for (const fault of (metrics.faults || []).filter((f) => !f.blocksTuning && f.severity === 'warn')) {
    proposals.push(advisoryProposal(fault, metrics));
  }

  // Highest confidence first, and never more than three actions at once - the
  // operator must be able to attribute the result of a change to that change.
  const ranked = proposals
    .filter(Boolean)
    .sort((a, b) => Number(b.safeToApply) - Number(a.safeToApply) || b.confidence - a.confidence);
  const top = ranked.slice(0, 3);

  // Reserve a slot for filter advice: ranking by confidence alone lets three
  // PID findings hide the filter work entirely, which is exactly the complaint
  // this is here to fix.
  if (!top.some((x) => x.category === 'filter')) {
    const bestFilter = ranked.find((x) => x.category === 'filter' && x.safeToApply) || ranked.find((x) => x.category === 'filter');
    if (bestFilter && top.length >= 3) top[top.length - 1] = bestFilter;
    else if (bestFilter) top.push(bestFilter);
  }

  return top;
}

/**
 * Renders a proposal in the mandated four-part format.
 * @param {import('../../shared/contracts.js').TuneProposal} p
 */
export function formatProposal(p) {
  const lines = [
    `问题: ${p.problem}`,
    `证据: ${p.evidence}`,
  ];
  if (p.cli?.length) {
    lines.push('CLI 建议:');
    for (const c of p.cli) lines.push(`  ${c}`);
  } else {
    lines.push('CLI 建议: (无 - 本条不含参数写入)');
  }
  lines.push(`复飞验证: ${p.verification}`);
  lines.push(`置信度: ${(p.confidence * 100).toFixed(0)}%`);
  if (p.blockedBy?.length) lines.push(`阻塞项: ${p.blockedBy.join(', ')}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Rules
 * ------------------------------------------------------------------ */

/** Propwash: raise D, which is the damping term that fights the oscillation. */
function rulePropwash(metrics, pid, dynamics = null) {
  const hits = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m) continue;
    const index = m.propwashIndex ?? 0;
    if (index < THRESHOLDS.propwashIndex) continue;

    // Only meaningful if the motors had headroom; D cannot help a saturated quad.
    if ((metrics.motorSaturationPct ?? 0) > 25) continue;

    const current = axisValue(pid, axis, 'D');
    if (current === null) continue;
    const next = clampStepD(current, +2);
    if (next === current) continue;

    hits.push({ axis, index, current, next, events: m.propwashEvents ?? 0, peak: m.motorNoisePeakHz ?? 0 });
  }
  if (!hits.length) return [];

  const axes = hits.map((h) => h.axis);
  const grouped = groupRollPitch(axes);
  const worst = hits.reduce((a, b) => (b.index > a.index ? b : a));
  const step = grouped.axes.length > 1 ? +2 : +3;

  // Raising D_min is the preferred fix: it adds damping exactly where propwash
  // lives (low throttle / descending) without the steady-state D energy that
  // heats motors. Static D is only raised when there is no D_min to work with.
  const dMin = dynamics?.dMin ?? null;

  /**
   * D_min target for one axis.
   *
   * D_min is meant to sit close to the cruise D, so when it is unset (0) or far
   * below D the fix is to move it up to a meaningful fraction of D in one go -
   * nudging a disabled floor from 0 to 2 changes nothing. When it is already in
   * the right region, a normal conservative step is used.
   */
  const dMinTarget = (axis) => {
    const cruiseD = axisValue(pid, axis, 'D');
    const floor = Number(dMin?.[axis]);
    if (!Number.isFinite(cruiseD) || cruiseD <= 0) return null;
    if (!Number.isFinite(floor)) return null;
    if (floor <= 0 || floor < cruiseD * 0.6) {
      const raised = Math.round(cruiseD * 0.8);
      return raised > floor && raised <= cruiseD ? raised : null;
    }
    const stepped = Math.min(clampStepD(floor, step), cruiseD);
    return stepped > floor ? stepped : null;
  };

  // Decided per axis: yaw legitimately runs D = 0 on a racer, and that must not
  // force every other axis back onto the static-D path.
  const diff = grouped.axes.map((axis) => {
    const target = dMin ? dMinTarget(axis) : null;
    if (target !== null) {
      return { param: `d_min_${axis}`, from: Number(dMin[axis]), to: target, deltaPct: null };
    }
    const current = axisValue(pid, axis, 'D');
    return { param: `d_${axis}`, from: current, to: clampStepD(current, step), deltaPct: null };
  });
  const useDMin = diff.some((d) => d.param.startsWith('d_min_'));

  return [
    {
      id: `propwash-${grouped.key}`,
      problem: `螺旋桨洗流振荡 (propwash) - ${grouped.label} 轴在收油门时出现低频抖动`,
      evidence:
        `${grouped.label} 轴 propwash 指数 ${worst.index.toFixed(2)} (阈值 ${THRESHOLDS.propwashIndex}), ` +
        `共 ${worst.events} 段收油门事件; 电机未饱和 (${(metrics.motorSaturationPct ?? 0).toFixed(0)}%), ` +
        `说明有阻尼余量而不是动力不足。` +
        (useDMin
          ? `优先抬 D_min（低油门段加阻尼）而不是抬静态 D：5 寸竞速静态 D 参考 ${RACING_REFERENCE.dRollPitch[0]}–${RACING_REFERENCE.dRollPitch[1]}，D 越高电机越热。`
          : ''),
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      why: useDMin
        ? 'D_min 只在低油门/下落段提供阻尼，正好覆盖洗桨发生的工况，同时避免巡航段 D 能量升高导致电机发热。'
        : `${RACING_REFERENCE.lowLatencyPreference}`,
      ifNotApplied:
        `收油门下落时 ${grouped.label} 轴仍会抖；比赛里表现为出弯和下降穿尾流时姿态不稳，` +
        `但不会恶化其他轴，属于可延后处理的项。`,
      verification:
        `复飞时重点做快速收油门下落再接油门。` +
        `预期 ${grouped.label} 轴下落抖动明显减弱; 若抖动转移到高频或出现电机发热, 立即回退到 ${diff.map((d) => `${d.param}=${d.from}`).join(', ')}。` +
        ` ${RACING_REFERENCE.motorHeatRedLine}`,
      confidence: confidenceFrom([worst.index / THRESHOLDS.propwashIndex, (metrics.sampleQuality ?? 0.5)]),
      category: 'pid',
      safeToApply: grouped.axes.length <= 2,
      blockedBy: grouped.axes.length > 2 ? ['D 建议同时涉及三个轴, 请分轴单独验证'] : [],
      diff,
    },
  ];
}

/** Overshoot: P is too aggressive for the current filtering. */
function ruleOvershoot(metrics, pid) {
  const hits = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    const step = m?.step;
    if (!step || !step.samples) continue;
    if ((step.overshootPct ?? 0) < THRESHOLDS.overshootPct) continue;
    if ((step.settlingTimeMs ?? 0) < THRESHOLDS.settlingMs) continue;

    const current = axisValue(pid, axis, 'P');
    if (current === null) continue;
    hits.push({ axis, overshoot: step.overshootPct, settling: step.settlingTimeMs, samples: step.samples, current });
  }
  if (!hits.length) return [];

  const grouped = groupRollPitch(hits.map((h) => h.axis));
  const worst = hits.reduce((a, b) => (b.overshoot > a.overshoot ? b : a));
  const pct = STEP_LIMITS.P_PCT;

  const diff = grouped.axes.map((axis) => {
    const current = axisValue(pid, axis, 'P');
    const to = clampStepPercent(current, -pct, 1);
    return { param: `p_${axis}`, from: current, to, deltaPct: Number((((to - current) / current) * -100).toFixed(1)) };
  });

  const unsafe = diff.some((d) => d.to < SANE_RANGES.p.min);

  return [
    {
      id: `overshoot-${grouped.key}`,
      problem: `P 值偏高 - ${grouped.label} 轴阶跃响应超调过大且安定时间偏长`,
      evidence:
        `${grouped.label} 轴超调 ${worst.overshoot.toFixed(1)}% (阈值 ${THRESHOLDS.overshootPct}%), ` +
        `安定时间 ${worst.settling.toFixed(0)} ms (阈值 ${THRESHOLDS.settlingMs} ms), ` +
        `基于 ${worst.samples} 次干净的 setpoint->gyro 阶跃。`,
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      verification:
        `复飞同样的急打杆动作。预期超调下降、安定更快; ` +
        `若手感发木或出现缓慢漂移, 说明降过头了, 回退到 ${diff.map((d) => `${d.param}=${d.from}`).join(', ')}。`,
      confidence: confidenceFrom([worst.overshoot / THRESHOLDS.overshootHighPct, Math.min(worst.samples / 8, 1)]),
      category: 'pid',
      safeToApply: !unsafe,
      blockedBy: unsafe ? ['P 将低于安全下限, 更可能是滤波或机械问题'] : [],
      diff,
    },
  ];
}

/** Sluggish: not enough P, the quad lags the stick. */
function ruleSluggish(metrics, pid) {
  const hits = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    const step = m?.step;
    if (!step || !step.samples) continue;
    if ((step.riseTimeMs ?? 0) < THRESHOLDS.riseTimeSlowMs) continue;
    if ((step.overshootPct ?? 0) > THRESHOLDS.overshootPct) continue; // overshoot rule owns that case
    const current = axisValue(pid, axis, 'P');
    if (current === null) continue;
    hits.push({ axis, rise: step.riseTimeMs, gain: m.trackingGainDb ?? 0, samples: step.samples, current });
  }
  if (!hits.length) return [];

  const grouped = groupRollPitch(hits.map((h) => h.axis));
  const worst = hits.reduce((a, b) => (b.rise > a.rise ? b : a));

  const diff = grouped.axes.map((axis) => {
    const current = axisValue(pid, axis, 'P');
    return { param: `p_${axis}`, from: current, to: clampStepPercent(current, +STEP_LIMITS.P_PCT, 1) };
  });
  const unsafe = diff.some((d) => d.to > SANE_RANGES.p.max);

  return [
    {
      id: `sluggish-${grouped.key}`,
      problem: `P 值偏低 - ${grouped.label} 轴响应迟钝, 跟杆不到位`,
      evidence:
        `${grouped.label} 轴上升时间 ${worst.rise.toFixed(0)} ms (阈值 ${THRESHOLDS.riseTimeSlowMs} ms) ` +
        `且无明显超调, 跟踪增益 ${worst.gain.toFixed(1)} dB。`,
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      verification:
        '复飞同样的急打杆动作, 预期跟手性提升、上升时间缩短; 若开始出现超调或高频抖动, 回退。',
      confidence: confidenceFrom([worst.rise / (THRESHOLDS.riseTimeSlowMs * 1.8), Math.min(worst.samples / 8, 1)]),
      category: 'pid',
      safeToApply: !unsafe,
      blockedBy: unsafe ? ['P 将超出安全上限'] : [],
      diff,
    },
  ];
}

/** I-term: too much causes slow oscillation, too little causes steady-state error. */
function ruleITerm(metrics, pid) {
  const proposals = [];

  const windup = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m) continue;
    const score = m.iTermWindupScore ?? 0;
    const lowFreqPeak = (m.peaks || []).find(
      (p) => p.hz >= THRESHOLDS.lowFreqOscHz[0] && p.hz <= THRESHOLDS.lowFreqOscHz[1],
    );
    if (score < THRESHOLDS.iTermWindup) continue;
    const current = axisValue(pid, axis, 'I');
    if (current === null) continue;
    windup.push({ axis, score, peakHz: lowFreqPeak?.hz ?? null, current });
  }
  if (windup.length) {
    const grouped = groupRollPitch(windup.map((w) => w.axis));
    const worst = windup.reduce((a, b) => (b.score > a.score ? b : a));
    const diff = grouped.axes.map((axis) => {
      const current = axisValue(pid, axis, 'I');
      return { param: `i_${axis}`, from: current, to: clampStepPercent(current, -STEP_LIMITS.I_PCT, 1) };
    });
    proposals.push({
      id: `i-high-${grouped.key}`,
      problem: `I 值偏高 - ${grouped.label} 轴积分饱和, 收油门后缓慢摆动`,
      evidence:
        `${grouped.label} 轴积分饱和评分 ${worst.score.toFixed(2)} (阈值 ${THRESHOLDS.iTermWindup}%)`.replace('%', '') +
        (worst.peakHz ? `, 并在 ${worst.peakHz.toFixed(1)} Hz 出现低频峰` : '') +
        '。',
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      verification:
        '复飞时做几次快速收油门再稳住悬停。预期收油门后的缓慢摆动减少; 若出现定高漂移或转弯掉高, 回退。',
      confidence: confidenceFrom([worst.score, metrics.sampleQuality ?? 0.5]),
      category: 'pid',
      safeToApply: true,
      blockedBy: [],
      diff,
    });
  }

  const lag = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    const step = m?.step;
    if (!step || !step.samples) continue;
    if ((step.steadyStateErrorPct ?? 0) < 12) continue;
    const current = axisValue(pid, axis, 'I');
    if (current === null) continue;
    lag.push({ axis, err: step.steadyStateErrorPct, current });
  }
  if (lag.length) {
    const grouped = groupRollPitch(lag.map((l) => l.axis));
    const worst = lag.reduce((a, b) => (b.err > a.err ? b : a));
    const diff = grouped.axes.map((axis) => {
      const current = axisValue(pid, axis, 'I');
      return { param: `i_${axis}`, from: current, to: clampStepPercent(current, +STEP_LIMITS.I_PCT, 1) };
    });
    proposals.push({
      id: `i-low-${grouped.key}`,
      problem: `I 值偏低 - ${grouped.label} 轴存在稳态误差`,
      evidence: `${grouped.label} 轴稳态误差 ${worst.err.toFixed(1)}% (阈值 12%), 阶跃后无法回到目标值。`,
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      verification: '复飞中做长时间定角/定高动作。预期稳态误差收敛; 若开始出现低频摆动, 回退。',
      confidence: confidenceFrom([worst.err / 25, metrics.sampleQuality ?? 0.5]),
      category: 'pid',
      safeToApply: true,
      blockedBy: [],
      diff,
    });
  }

  return proposals;
}

/** D-term noise: filtering is not keeping up with the D term. */
/* ------------------------------------------------------------------ *
 * Spectrum-driven filter advisor
 * ------------------------------------------------------------------ */

/** Snap a frequency to a 5 Hz grid - a value a human would actually type. */
function snapHz(hz, step = 5) {
  return Math.max(step, Math.round(hz / step) * step);
}

/**
 * Minimum attenuation (dB) the filter chain should provide across the noise
 * band before the gyro low-pass is considered "open".
 */
const MIN_NOISE_BAND_ATTENUATION_DB = 12;

/**
 * States the filter verdict when no change is warranted, with the measurements
 * that led to it. Every filter field the user asked about is covered, so the
 * page always shows a filter conclusion rather than silence.
 */
function ruleFilterSummary(metrics, filter) {
  const f = filter || {};
  const rows = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m) continue;
    rows.push({
      axis,
      atten: Number.isFinite(m.filterAttenuationDb) ? m.filterAttenuationDb : null,
      topRaw: (m.rawPeaks || [])[0] || null,
    });
  }
  if (!rows.length) return [];

  const withAtten = rows.filter((r) => r.atten !== null);
  const attens = withAtten.map((r) => r.atten);
  const minAtten = attens.length ? Math.min(...attens) : null;
  const maxAtten = attens.length ? Math.max(...attens) : null;
  const peaks = rows
    .filter((r) => r.topRaw)
    .map((r) => `${r.axis} ${r.topRaw.hz.toFixed(0)} Hz/${r.topRaw.prominenceDb.toFixed(0)} dB`);
  const lpf1 = Number.isFinite(f.gyroLpf1Hz) ? f.gyroLpf1Hz : 0;
  const dtermLpf1 = Number.isFinite(f.dtermLpf1Hz) ? f.dtermLpf1Hz : 0;
  const notch = Number.isFinite(f.gyroNotch1Hz) ? f.gyroNotch1Hz : 0;

  const parts = [];
  if (minAtten !== null) {
    parts.push(`200 Hz 以上（噪声带）滤波链衰减 ${minAtten.toFixed(1)}–${maxAtten.toFixed(1)} dB，目标 ≥ ${MIN_NOISE_BAND_ATTENUATION_DB} dB`);
  }
  parts.push(peaks.length ? `原始频谱主要峰值：${peaks.join('；')}` : '原始频谱未发现显著峰值');
  parts.push(`当前 gyro_lpf1 = ${lpf1} Hz、dterm_lpf1 = ${dtermLpf1} Hz、gyro 静态陷波 ${notch > 0 ? `${notch} Hz` : '未设置'}`);

  const adequate = minAtten === null || minAtten >= MIN_NOISE_BAND_ATTENUATION_DB;

  return [
    {
      id: 'filter-assessment',
      problem: adequate
        ? '滤波配置合理 — 本次日志未发现需要改动的滤波项'
        : '滤波评估完成 — 噪声带衰减不足，请参考上方滤波建议',
      evidence: `${parts.join('；')}。`,
      cli: [],
      verification: adequate
        ? '无需执行任何滤波改动。这是分析结论而非待执行项；若之后出现高频抖动或电机发热，再采集日志复评。'
        : '请按其它滤波建议项执行，并单独复飞验证。',
      confidence: confidenceFrom([0.6, metrics.sampleQuality ?? 0.5]),
      category: 'filter',
      safeToApply: false,
      blockedBy: [],
      diff: [],
    },
  ];
}

/**
 * The filter half of the advice, read off the log the way Blackbox Explorer's
 * spectrum view is read by eye:
 *
 *   1. attenuation across the noise band (200 Hz+) - is the chain working?
 *   2. peaks surviving into gyroADC            - discrete tones -> notch
 *   3. D-term noisier than the gyro            - D-term low-pass
 *   4. clean noise band but a very low LPF1    - buy latency back
 *
 * Note on why this is NOT "find where noise rises above the floor": on real
 * logs the raw gyro spectrum simply decays with frequency (aircraft motion
 * dominates the low end), so an onset detector reports whatever frequency it
 * starts scanning from. That produced advice like "250 Hz -> 100 Hz" on a
 * perfectly healthy log. Attenuation and discrete peaks are the honest signals.
 *
 * RPM filtering is deliberately NOT required: it is mentioned as an option in
 * the verification text, and its absence never suppresses a finding.
 */
function ruleFilterShaping(metrics, pid, filter) {
  const proposals = [];
  const f = filter || {};
  const quality = metrics.sampleQuality ?? 0.5;
  const lpf1 = Number.isFinite(f.gyroLpf1Hz) ? f.gyroLpf1Hz : 0;
  const dtermLpf1 = Number.isFinite(f.dtermLpf1Hz) ? f.dtermLpf1Hz : 0;

  /* --- 1. is the chain actually attenuating the noise band? --- */
  const attenValues = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m?.gyroUnfiltSpectrum?.psd?.length) continue;
    if (Number.isFinite(m.filterAttenuationDb)) attenValues.push({ axis, atten: m.filterAttenuationDb });
  }

  if (attenValues.length && lpf1 > 0) {
    const worst = attenValues.reduce((a, b) => (b.atten < a.atten ? b : a));
    if (worst.atten < MIN_NOISE_BAND_ATTENUATION_DB) {
      // One conservative step per round; a bigger move needs another flight.
      const floor = Math.max(SANE_RANGES.gyroLpf.min, 150);
      const to = Math.max(floor, snapHz(lpf1 * 0.8));
      if (to < lpf1) {
        proposals.push({
          id: 'filter-gyro-lpf1-open',
          problem: `陀螺低通未压住噪声带 - 滤波链在 200 Hz 以上只衰减了 ${worst.atten.toFixed(1)} dB`,
          evidence:
            `对比原始与滤波后的频谱，200 Hz 以上（噪声带）整体只衰减 ${worst.atten.toFixed(1)} dB` +
            `（目标 ≥ ${MIN_NOISE_BAND_ATTENUATION_DB} dB），最差轴为 ${worst.axis}。` +
            `当前 gyro_lpf1 = ${lpf1} Hz。`,
          cli: [`set gyro_lpf1_static_hz = ${to}`],
          verification:
            `复飞采集一段日志，确认 200 Hz 以上的原始/滤波差值变大，且手感不发糊。` +
            `若一次不到位，下一次分析可继续小幅收紧；不要一次降到与电机噪声峰值持平的过低值。`,
          confidence: confidenceFrom([1 - worst.atten / MIN_NOISE_BAND_ATTENUATION_DB, quality]),
          category: 'filter',
          safeToApply: to < lpf1,
          blockedBy: [],
          diff: [{ param: 'gyro_lpf1_static_hz', from: lpf1, to }],
        });
      }
    }
  }

  /* --- 2. peaks that survive into the FILTERED gyro --- */
  const residual = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    for (const pk of m?.peaks || []) {
      if (pk.hz < 100 || pk.prominenceDb < 12) continue;
      residual.push({ axis, hz: pk.hz, db: pk.prominenceDb, harmonic: (m.rpmHarmonicMatch ?? 0) >= 0.5 });
    }
  }

  if (residual.length) {
    const worst = residual.reduce((a, b) => (b.db > a.db ? b : a));
    const rpmOn = (Number.isFinite(f.rpmFilterHarmonics) ? f.rpmFilterHarmonics : 0) > 0;
    const notchHz = Number.isFinite(f.gyroNotch1Hz) ? f.gyroNotch1Hz : 0;
    const to = snapHz(worst.hz);
    const cutoff = Math.max(20, snapHz(worst.hz * 0.6));

    proposals.push({
      id: 'filter-residual-peak',
      problem: `滤波后仍有残留峰 - ${worst.axis} 轴 ${worst.hz.toFixed(0)} Hz 处仍有 ${worst.db.toFixed(1)} dB 峰值`,
      evidence:
        `滤波后的 gyroADC 频谱在 ${worst.hz.toFixed(0)} Hz 仍有 ${worst.db.toFixed(1)} dB 峰值（阈值 12 dB），` +
        `当前滤波链没有压住它。RPM 滤波当前${rpmOn ? '已开启' : '未开启'}，` +
        `静态陷波当前 ${notchHz > 0 ? `${notchHz} Hz` : '未设置'}。` +
        (worst.harmonic ? '该峰与电机转速谐波吻合。' : '该峰与电机转速谐波不吻合，更像固定频率干扰。'),
      cli:
        notchHz > 0 && Math.abs(notchHz - to) <= 10
          ? [`set gyro_notch_cutoff = ${cutoff}`]
          : [`set gyro_notch_hz = ${to}`, `set gyro_notch_cutoff = ${cutoff}`],
      verification:
        `复飞后该峰应明显下降。若峰值随油门移动，改用动态陷波（dyn_notch_min_hz/max_hz）而不是静态陷波；` +
        `若固定不动则静态陷波合适。` +
        (worst.harmonic && !rpmOn ? '若想从根因解决，可选启用双向 DShot + RPM 滤波（本工具不强制，也不会自动写入）。' : ''),
      confidence: confidenceFrom([worst.db / 24, quality]),
      category: 'filter',
      safeToApply: true,
      blockedBy: [],
      diff:
        notchHz > 0 && Math.abs(notchHz - to) <= 10
          ? [{ param: 'gyro_notch_cutoff', from: Number.isFinite(f.gyroNotch1CutoffHz) ? f.gyroNotch1CutoffHz : 0, to: cutoff }]
          : [
              { param: 'gyro_notch_hz', from: notchHz, to },
              { param: 'gyro_notch_cutoff', from: Number.isFinite(f.gyroNotch1CutoffHz) ? f.gyroNotch1CutoffHz : 0, to: cutoff },
            ],
    });
  }

  /* --- 3. D-term low-pass --- */
  const noisyD = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    const ratio = m?.dTermToGyroRatio ?? 0;
    if (ratio >= THRESHOLDS.dTermToGyroRatio) noisyD.push({ axis, ratio });
  }
  if (noisyD.length && dtermLpf1 > 0) {
    const to = Math.max(SANE_RANGES.dtermLpf.min, snapHz(dtermLpf1 * 0.85));
    if (to < dtermLpf1) {
      const worst = noisyD.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      proposals.push({
        id: 'filter-dterm-lpf1',
        problem: `D 项低通需要收紧 - ${worst.axis} 轴 D 项噪声高于陀螺`,
        evidence:
          `${worst.axis} 轴 D/陀螺能量比 ${worst.ratio.toFixed(2)}（阈值 ${THRESHOLDS.dTermToGyroRatio}），` +
          `当前 dterm_lpf1 = ${dtermLpf1} Hz。`,
        cli: [`set dterm_lpf1_static_hz = ${to}`],
        verification:
          `复飞后 D 项噪声与电机温度应下降。若手感发糊或出现洗流，回退到 ${dtermLpf1} Hz。` +
          `这项与 P/D 分开改，便于归因。`,
        confidence: confidenceFrom([worst.ratio / 0.6, quality]),
        category: 'filter',
        safeToApply: to < dtermLpf1,
        blockedBy: [],
        diff: [{ param: 'dterm_lpf1_static_hz', from: dtermLpf1, to }],
      });
    }
  }

  /* --- 4. over-filtering: far more attenuation than the band needs --- */
  if (attenValues.length && lpf1 > 0 && lpf1 < 200) {
    const best = attenValues.reduce((a, b) => (b.atten > a.atten ? b : a));
    const to = Math.min(snapHz(lpf1 * 1.3), 250);
    if (best.atten > 30 && to > lpf1) {
      proposals.push({
        id: 'filter-gyro-lpf1-tight',
        problem: `陀螺低通过度收紧 - ${lpf1} Hz 的低通在噪声带上多衰减了 ${(best.atten - MIN_NOISE_BAND_ATTENUATION_DB).toFixed(0)} dB，主要是在增加延迟`,
        evidence:
          `滤波链在 200 Hz 以上衰减 ${best.atten.toFixed(1)} dB，远超所需的 ${MIN_NOISE_BAND_ATTENUATION_DB} dB` +
          `（最佳轴 ${best.axis}），而 gyro_lpf1 仍设为 ${lpf1} Hz。`,
        cli: [`set gyro_lpf1_static_hz = ${to}`],
        verification:
          `复飞后手感应更跟手（延迟下降）。若出现高频抖动传入 PID，回退到 ${lpf1} Hz。`,
        confidence: confidenceFrom([0.5, quality]),
        category: 'filter',
        safeToApply: to > lpf1,
        blockedBy: [],
        diff: [{ param: 'gyro_lpf1_static_hz', from: lpf1, to }],
      });
    }
  }

  return proposals;
}

/* ------------------------------------------------------------------ *
 * Non-actionable proposals (hardware / advisories)
 * ------------------------------------------------------------------ */

function hardwareProposal(fault, index, metrics) {
  const guidance = HARDWARE_GUIDANCE[fault.code] || {
    cli: [],
    verification: '排除硬件问题后再重新采集日志。',
  };
  return {
    id: `fault-${fault.code}-${index}`,
    problem: `${HARDWARE_TITLES[fault.code] || fault.code} - 已停止自动调参`,
    evidence: fault.evidence,
    cli: guidance.cli,
    verification: guidance.verification,
    confidence: 0.95,
    category: 'hardware',
    safeToApply: false,
    blockedBy: [`${fault.code} (${fault.severity})`, '安全边界: 检测到硬件故障时不允许修改 PID/滤波'],
    diff: [],
  };
}

function advisoryProposal(fault, metrics) {
  return {
    id: `warn-${fault.code}`,
    problem: `${HARDWARE_TITLES[fault.code] || fault.code} - 提示`,
    evidence: fault.evidence,
    cli: [],
    verification: '确认该项后再决定是否继续调参。',
    confidence: 0.6,
    category: 'hardware',
    safeToApply: false,
    blockedBy: [],
    diff: [],
  };
}

const HARDWARE_TITLES = {
  GYRO_CLIPPING: '陀螺仪削顶',
  MOTOR_DESYNC: '电机失步 (desync)',
  SEVERE_VIBRATION: '严重振动',
  MOTOR_SATURATION: '电机饱和',
  FRAME_DROP_HIGH: '日志丢帧过多',
  SAMPLE_RATE_MISMATCH: '实际采样率与预期不符',
  SAMPLE_TOO_SHORT: '采集时长不足',
  NO_RPM_DATA: '缺少 RPM 数据',
  GYRO_ABSENT: '日志中没有陀螺数据',
  LOG_TRUNCATED: '日志损坏或被截断',
};

const HARDWARE_GUIDANCE = {
  MOTOR_DESYNC: {
    cli: [],
    verification:
      '检查电机螺丝是否顶到线圈、电调固件版本、以及 DShot 线与电源走线。' +
      '把 idle 百分比适当提高后复飞; 失步属于硬件/电调层问题, 不能靠改 PID 解决。',
  },
  SEVERE_VIBRATION: {
    cli: [],
    verification:
      '先做机械排查: 桨叶是否平衡、电机轴承是否松旷、飞控减震是否安装到位、螺丝是否松动。' +
      '机械问题解决前加滤波只会掩盖症状并增加延迟。',
  },
  GYRO_CLIPPING: {
    cli: [],
    verification: '陀螺量程被打满, 通常是剧烈振动或炸机造成。检查陀螺型号与量程设置, 排除机械问题。',
  },
  LOG_TRUNCATED: {
    cli: [],
    verification: '日志在传输或写入过程中损坏。降低 blackbox_sample_rate 或更换存储介质后重新采集。',
  },
  SAMPLE_TOO_SHORT: {
    cli: [],
    verification: '再飞一段并重新采集日志即可；频域分析在短日志上波动更大，但没有最短时长要求。',
  },
  MOTOR_SATURATION: {
    cli: [],
    verification: '电机长时间打满, 说明动力不足或桨负载过大; 这种情况下 PID 的任何改动都无法改善手感。',
  },
  FRAME_DROP_HIGH: {
    cli: ['set blackbox_sample_rate = 2'],
    verification: '把记录率降到 1/4 (约 2 kHz) 后复飞, 确认丢帧率回到 2% 以下再看数据。',
  },
  SAMPLE_RATE_MISMATCH: {
    cli: [],
    verification: '确认 blackbox_sample_rate 与实际循环频率匹配; 采样率不准会让频域结论整体偏移。',
  },
  GYRO_ABSENT: {
    cli: ['set blackbox_disable_gyro = OFF'],
    verification: '在黑匣子字段中启用 gyro 后重新采集。',
  },
  NO_RPM_DATA: {
    cli: [],
    verification: '启用双向 DShot 并打开 rpm 字段后重新采集。',
  },
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Normalises the several PidProfile shapes the app may hold into `{roll:{P,I,D}}`. */
export function normalisePid(pid) {
  const out = {};
  for (const axis of AXES) out[axis] = { P: null, I: null, D: null, F: null };
  if (!pid) return out;

  for (const axis of AXES) {
    const src = pid[axis] || (Array.isArray(pid.axes) ? pid.axes[AXES.indexOf(axis)] : null);
    if (!src) continue;
    out[axis] = {
      P: pick(src.P ?? src.p),
      I: pick(src.I ?? src.i),
      D: pick(src.D ?? src.d),
      F: pick(src.F ?? src.f ?? src.FF ?? src.ff),
    };
  }
  return out;
}

function normaliseFilter(filter) {
  return {
    gyroLpf1Hz: filter?.gyroLpf1Hz ?? 0,
    dtermLpf1Hz: filter?.dtermLpf1Hz ?? 0,
    rpmFilterHarmonics: filter?.rpmFilterHarmonics ?? 0,
    rpmFilterQ: filter?.rpmFilterQ ?? 0,
    rpmFilterMinHz: filter?.rpmFilterMinHz ?? 0,
  };
}

function axisValue(pid, axis, term) {
  const v = pid?.[axis]?.[term];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pick(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Move `current` by `pct` (signed), rounded and floored at `min`. */
export function clampStepPercent(current, pct, minDelta = 1, floor = 0) {
  if (current === null || current === undefined) return current;
  const raw = current * (1 + pct);
  const delta = Math.max(minDelta, Math.abs(Math.round(raw - current)));
  const next = pct >= 0 ? current + delta : current - delta;
  return Math.max(floor, next);
}

/** Move `current` by `delta` absolute units (signed), floored at 0. */
export function clampStepD(current, delta) {
  if (current === null || current === undefined) return current;
  return Math.max(0, current + delta);
}

/** Prefer editing roll+pitch together when both need the same change. */
export function groupRollPitch(axes) {
  const set = new Set(axes);
  const both = set.has('roll') && set.has('pitch');
  const ordered = AXES.filter((a) => set.has(a));
  if (both) {
    return { axes: ordered, key: ordered.includes('yaw') ? 'rp' : 'rp', label: ordered.includes('yaw') ? '横滚/俯仰' : '横滚与俯仰' };
  }
  return { axes: ordered, key: ordered.join('-'), label: ordered.map(axisLabel).join('/') };
}

function axisLabel(axis) {
  return { roll: '横滚', pitch: '俯仰', yaw: '偏航' }[axis] || axis;
}

/**
 * Confidence in 0..1 from a list of 0..1-ish sub-scores, averaged and softly
 * capped so a single strong signal never reads as certainty.
 */
export function confidenceFrom(scores) {
  const valid = scores.filter((s) => Number.isFinite(s)).map((s) => Math.max(0, Math.min(1, s)));
  if (!valid.length) return 0.3;
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
  return Number(Math.min(0.93, 0.25 + mean * 0.65).toFixed(2));
}

/**
 * Final gate before a diff is offered to the FC: strips anything on the
 * forbidden list and anything that is not a known tunable.
 *
 * @param {{param:string, from:any, to:any}[]} diff
 * @returns {{allowed:object[], blocked:object[]}}
 */
export function filterDiff(diff) {
  const allowed = [];
  const blocked = [];
  for (const item of diff || []) {
    const param = String(item?.param || '');
    const forbidden = FORBIDDEN_PARAMS.some((f) => param === f || param.startsWith(f));
    if (forbidden) {
      blocked.push({ ...item, reason: 'param is on the immutable safety list' });
      continue;
    }
    if (!isTunableParam(param)) {
      blocked.push({ ...item, reason: 'param is not a tunable PID/filter parameter' });
      continue;
    }
    allowed.push(item);
  }
  return { allowed, blocked };
}

/** Whitelist of parameter families this app is allowed to write. */
export function isTunableParam(param) {
  return (
    /^[pidf]_(roll|pitch|yaw)$/.test(param) ||
    /^d_max_(roll|pitch|yaw)$/.test(param) ||
    /^(gyro|dterm)_lpf[12]_(static|dyn_min|dyn_max)_hz$/.test(param) ||
    /^(gyro|dterm)_notch_(hz|cutoff)$/.test(param) ||
    /^(dyn_notch_(count|q|min_hz|max_hz)|rpm_filter_(harmonics|q|min_hz))$/.test(param) ||
    // Dynamic D: raising D_min is the preferred propwash fix because it adds
    // damping on the low-throttle part of the flight without the steady-state D
    // energy that heats motors.
    /^(d_min_(roll|pitch|yaw)|d_min_boost_gain|d_min_advance)$/.test(param) ||
    // I-term relax / anti-gravity: the other propwash lever that does not
    // require more static D.
    /^(iterm_relax|iterm_relax_type|iterm_relax_cutoff|anti_gravity_gain)$/.test(param) ||
    // TPA shapes D at high throttle, which is where heat shows up first.
    /^(tpa_rate|tpa_breakpoint|tpa_mode)$/.test(param) ||
    /^blackbox_(sample_rate|device)$/.test(param)
  );
}

export default { proposeTune, formatProposal, filterDiff, isTunableParam };
