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
import { recommendAxis, TF_TARGETS } from './transfer-tune.js';
import { evidenceGapProposal, gateProposals } from './evidence.js';

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
  // TPA (throttle PID attenuation) is the lever for the D-term heat that only
  // shows up at high throttle. In BF 4.3+ `tpa_mode = D` scales D above
  // `tpa_breakpoint` by (1 - tpa_rate/100) at full throttle, so MORE attenuation
  // means a HIGHER tpa_rate and a LOWER tpa_breakpoint. Stock is 65 / 1350;
  // a racing build that lands with hot motors has room in this band first.
  // With `tpa_mode = PD` the attenuation also hits P, so the band is a D-heat
  // reference only when the mode is D - ruleTpa says which one it read back.
  tpaRatePct: [70, 75],
  tpaBreakpoint: [1300, 1350],
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
  // High-throttle D-term stress: motors near full output for a meaningful share
  // of the log (same bar as the MOTOR_SATURATION fault) while D carries more
  // energy than the gyro it damps.
  tpaMotorSaturationPct: 20,
  tpaRateStepPct: 0.10,   // <= 10 % relative step, the same bar the filters use
  tpaBreakpointStep: 50,  // throttle units out of the 1000..2000 span
  // Feedforward: setpoint -> gyro delay is exactly what the F term exists for.
  // Phase lag is the coherence-weighted mean over 10-100 Hz (the estimator
  // PIDtoolbox reads in its step-response tool); latencyMs is the
  // step-to-10%-crossing delay from estimateStepResponse. Either one firing
  // marks the axis as lagging the stick rather than lacking P.
  trackingLagDeg: 25,
  trackingMinCoherence: 0.5,
  stepLatencyHighMs: 15,
  // RPM filter health: a motor-band peak that survives into the filtered gyro
  // while eRPM says it is a rotational harmonic means the RPM filter is on but
  // not covering it (harmonics, min_hz or Q mis-set).
  rpmResidualPeakDb: 12,
  rpmBandHz: [80, 500],
  // Standalone iterm_relax: throttle-chop hunt = I-term windup measured on
  // logs that actually contain descending-throttle segments.
  relaxMinChopEvents: 2,
  // PIDtoolbox "PID error x stick deflection": above this slope the error
  // grows with deflection, which confirms an authority (P) problem rather
  // than a latency problem.
  pidErrorSlopeRatio: 2,
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
  proposals.push(...ruleFeedforward(metrics, pid));
  proposals.push(...ruleTransferFunction(metrics, pid));
  proposals.push(...ruleITerm(metrics, pid));
  // High-throttle D-term heat first: when it is actionable it owns the D/gyro
  // symptom, and ruleFilterShaping stands its D-term branch down (see below).
  const tpaPlan = planTpa(metrics, dynamics);
  proposals.push(...ruleTpa(tpaPlan, metrics));
  // Spectrum-driven filter shaping comes first: it is the half of the advice
  // the operator cannot read off the PID screen.
  // One filter authority. D-term and gyro LPF findings are produced by
  // ruleFilterShaping so the same symptom cannot yield two competing diffs.
  // Evidence-driven findings are planned first so the configuration rules and
  // the static-notch branch can stand down when a measured cause owns the
  // symptom (throttle-chop hunt -> iterm_relax, RPM harmonic -> RPM filter).
  const relaxFindings = ruleItermRelaxEvidence(metrics, filter);
  const rpmHealthFindings = ruleRpmHealth(metrics, filter);
  const filterFindings = [
    // Configuration-based latency findings come first: they are read off the
    // craft's own settings (from the Blackbox header when offline) and so can
    // name a concrete `now -> target` even with no spectrum evidence.
    ...ruleFilterLatency(metrics, pid, filter, {
      itermRelaxOwnedByEvidence: relaxFindings.some((p) => (p.diff || []).length > 0),
    }),
    ...relaxFindings,
    ...rpmHealthFindings,
    ...ruleFilterShaping(metrics, pid, filter, {
      dtermHeatOwnedByTpa: Boolean(tpaPlan?.diff?.length),
      rpmResidualOwnedByHealth: rpmHealthFindings.some((p) => (p.diff || []).length > 0),
    }),
  ];
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

  // Evidence gate: a rule whose domain is short of data in this log stands
  // down, and one advisory says what to fly to unlock it. Reports built by
  // computeMetrics always carry `evidence`; hand-built metrics without it are
  // not gated (unit fixtures exercise rule logic in isolation).
  const { kept, withheld } = gateProposals(proposals.filter(Boolean), metrics.evidence);
  const gap = withheld.length ? evidenceGapProposal(metrics.evidence, withheld) : null;

  // Highest confidence first, and never more than three actions at once - the
  // operator must be able to attribute the result of a change to that change.
  const ranked = kept
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

  // The gap notice never takes an action slot: it changes nothing.
  if (gap) top.push(gap);
  return top;
}

/**
 * Renders a proposal in the mandated four-part format.
 * @param {import('../../shared/contracts.js').TuneProposal} p
 */
export function formatProposal(p) {
  const lines = [`问题: ${p.problem}`, `证据: ${p.evidence}`];
  // State the change as "param: now -> target" before the CLI form: a bare
  // `set` line makes the operator look up the current value to understand it.
  if (p.diff?.length) {
    lines.push('改什么 (参数: 现在 → 改成):');
    for (const d of p.diff) lines.push(`  ${d.param}: ${d.from ?? '—'} → ${d.to ?? '—'}`);
  }
  if (p.cli?.length) {
    lines.push('CLI 建议:');
    for (const c of p.cli) lines.push(`  ${c}`);
  } else {
    lines.push('CLI 建议: (无 - 本条不含参数写入)');
  }
  if (p.sliderHint) lines.push(`等效滑块: ${p.sliderHint}`);
  if (p.why) lines.push(`为什么: ${p.why}`);
  lines.push(`复飞验证: ${p.verification}`);
  if (p.ifNotApplied) lines.push(`不写会怎样: ${p.ifNotApplied}`);
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
   *
   * `null` is NOT the same as `0`. The Blackbox header does not carry the
   * `d_min_*` parameters, so offline analysis reads them as `null` ("unknown");
   * treating that as `0` ("disabled") used to propose `d_min_pitch: 0 -> 14`
   * against a craft that actually had `d_min_pitch = 17`. An unknown floor must
   * fall back to the static-D path, which the header *does* carry.
   */
  const dMinTarget = (axis) => {
    const cruiseD = axisValue(pid, axis, 'D');
    const floorRaw = dMin?.[axis];
    const floor = floorRaw === null || floorRaw === undefined ? null : Number(floorRaw);
    if (floor === null || !Number.isFinite(floor)) return null; // unknown -> static D
    if (!Number.isFinite(cruiseD) || cruiseD <= 0) return null;
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
      sliderHint: sliderHintFor(diff, 'pi'),
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
    hits.push({
      axis,
      rise: step.riseTimeMs,
      latency: step.latencyMs ?? 0,
      gain: m.trackingGainDb ?? 0,
      samples: step.samples,
      current,
      // PIDtoolbox "PID error x stick deflection": error that grows with
      // deflection is authority (P); flat error is latency, which P won't fix.
      errSlope: m.pidError?.slopeRatio ?? 0,
    });
  }
  if (!hits.length) return [];

  const grouped = groupRollPitch(hits.map((h) => h.axis));
  const worst = hits.reduce((a, b) => (b.rise > a.rise ? b : a));
  const authorityConfirmed = worst.errSlope >= THRESHOLDS.pidErrorSlopeRatio;

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
        (worst.latency > 0 ? `、阶跃延迟 ${worst.latency.toFixed(0)} ms ` : '') +
        `且无明显超调, 跟踪增益 ${worst.gain.toFixed(1)} dB。` +
        (worst.errSlope > 0
          ? `PID 误差随杆量增长 ×${worst.errSlope.toFixed(1)}（阈值 ${THRESHOLDS.pidErrorSlopeRatio}）` +
            (authorityConfirmed
              ? '——误差在大杆量端放大，支持「输出余量/P 不足」的判断。'
              : '——误差随杆量基本持平，迟钝更像延迟问题，F/滤波比 P 更对症。')
          : ''),
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      verification:
        '复飞同样的急打杆动作, 预期跟手性提升、上升时间缩短; 若开始出现超调或高频抖动, 回退。',
      sliderHint: sliderHintFor(diff, 'pi'),
      confidence: confidenceFrom([
        worst.rise / (THRESHOLDS.riseTimeSlowMs * 1.8),
        Math.min(worst.samples / 8, 1),
        ...(authorityConfirmed ? [0.8] : []),
      ]),
      category: 'pid',
      safeToApply: !unsafe,
      blockedBy: unsafe ? ['P 将超出安全上限'] : [],
      diff,
    },
  ];
}

/**
 * Feedforward: the craft lags the stick even though P is not the limiter.
 *
 * This is the rule PIDtoolbox's step-response tool drives by eye: delay from
 * stick to gyro is the F term's job, not P's. Two independent measurements are
 * accepted as evidence - the coherence-weighted setpoint->gyro phase lag over
 * 10-100 Hz, and the step-to-10%-crossing latency - because either alone can be
 * fooled (a noisy log kills coherence; a soft stick input inflates latency).
 *
 * Deliberately stands down on axes the overshoot rule owns: adding F to an
 * overshooting axis makes the overshoot worse, and two rules must not fight
 * over one axis.
 */
function ruleFeedforward(metrics, pid) {
  const hits = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    const step = m?.step;
    if (!step || !step.samples) continue;
    if ((step.overshootPct ?? 0) >= THRESHOLDS.overshootPct) continue; // overshoot rule owns that axis

    const coherence = m.trackingCoherence ?? 0;
    // phaseDeg is negative when the gyro lags the setpoint; only trust it when
    // the two signals actually move together.
    const phaseLagDeg = coherence >= THRESHOLDS.trackingMinCoherence
      ? Math.max(0, -(m.trackingPhaseDeg ?? 0))
      : 0;
    const latencyMs = step.latencyMs ?? 0;
    if (phaseLagDeg < THRESHOLDS.trackingLagDeg && latencyMs < THRESHOLDS.stepLatencyHighMs) continue;

    hits.push({ axis, phaseLagDeg, latencyMs, coherence, samples: step.samples, current: axisValue(pid, axis, 'F') });
  }
  if (!hits.length) return [];

  const grouped = groupRollPitch(hits.map((h) => h.axis));
  const worst = hits.reduce((a, b) => (Math.max(b.phaseLagDeg, b.latencyMs) > Math.max(a.phaseLagDeg, a.latencyMs) ? b : a));
  const known = grouped.axes.every((axis) => axisValue(pid, axis, 'F') !== null);

  // Without the current F there is no conservative step; report the
  // measurement and the racing reference, refuse the write.
  if (!known) {
    return [
      {
        id: `feedforward-lag-${grouped.key}`,
        problem: `杆到姿态的延迟偏高 - ${grouped.label} 轴陀螺滞后于打杆，属于前馈 (F) 的工作范围`,
        evidence:
          `${grouped.label} 轴 setpoint→gyro 相位滞后 ${worst.phaseLagDeg.toFixed(1)}°（阈值 ${THRESHOLDS.trackingLagDeg}°，` +
          `相干度 ${worst.coherence.toFixed(2)}），阶跃延迟 ${worst.latencyMs.toFixed(0)} ms（阈值 ${THRESHOLDS.stepLatencyHighMs} ms）。` +
          `未读到当前 f 值，无法给出保守步长；五寸竞速 F 常用区间 ${SANE_RANGES.f.typical[0]}–${SANE_RANGES.f.typical[1]}。`,
        cli: [],
        why: 'F 项按打杆速度直接前馈到电机，专门消除杆到姿态的延迟；用 P 去补延迟只会换来超调。',
        verification: '先用 `get f_roll` / `get f_pitch` 读回当前值再重新生成建议；本条不含写入。',
        confidence: confidenceFrom([worst.phaseLagDeg / 45, worst.latencyMs / 40, metrics.sampleQuality ?? 0.5]),
        category: 'pid',
        safeToApply: false,
        blockedBy: ['未读到当前 F 值，不能给出保守步长'],
        diff: [],
      },
    ];
  }

  const diff = grouped.axes.map((axis) => {
    const current = axisValue(pid, axis, 'F');
    // F = 0 means feedforward is off; nudging it by the 10 % step (0 -> 2)
    // changes nothing - the same trap D_min has. Enable it at the typical
    // floor in one go; otherwise move by the normal <= 10 % step.
    const to = current <= 0
      ? SANE_RANGES.f.typical[0]
      : clampStepPercent(current, +STEP_LIMITS.FF_PCT, 2);
    return {
      param: `f_${axis}`,
      from: current,
      to,
      deltaPct: current > 0 ? Number((((to - current) / current) * 100).toFixed(1)) : null,
    };
  }).filter((d) => d.to > d.from);
  if (!diff.length) return [];
  const unsafe = diff.some((d) => d.to > SANE_RANGES.f.max);

  return [
    {
      id: `feedforward-lag-${grouped.key}`,
      problem: `杆到姿态的延迟偏高 - ${grouped.label} 轴陀螺滞后于打杆，建议提高前馈 (F)`,
      evidence:
        `${grouped.label} 轴 setpoint→gyro 相位滞后 ${worst.phaseLagDeg.toFixed(1)}°（阈值 ${THRESHOLDS.trackingLagDeg}°，` +
        `相干度 ${worst.coherence.toFixed(2)}，10–100 Hz 相干加权），阶跃延迟 ${worst.latencyMs.toFixed(0)} ms` +
        `（阈值 ${THRESHOLDS.stepLatencyHighMs} ms），基于 ${worst.samples} 次干净阶跃。` +
        `五寸竞速 F 常用区间 ${SANE_RANGES.f.typical[0]}–${SANE_RANGES.f.typical[1]}，当前步进 ≤ ${(STEP_LIMITS.FF_PCT * 100).toFixed(0)}%。`,
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      sliderHint: sliderHintFor(diff, 'ff'),
      why:
        'F 项按打杆速度直接前馈输出，是消除「杆动了姿态晚半拍」的专用杠杆；' +
        '它不像 P 那样以超调为代价换响应速度，所以延迟类症状先动 F 而不是 P。',
      ifNotApplied: '快速打杆时姿态持续慢半拍，竞速里表现为入弯点判断要提前、跟手性差。',
      verification:
        `复飞做快速全行程打杆。预期姿态几乎与杆同步到达、且无新增超调；` +
        `若开始出现超调或回弹抖动，说明 F 加过头，回退到 ${diff.map((d) => `${d.param}=${d.from}`).join(', ')}。`,
      confidence: confidenceFrom([worst.phaseLagDeg / 45, worst.latencyMs / 40, Math.min(worst.samples / 8, 1)]),
      category: 'pid',
      safeToApply: !unsafe,
      blockedBy: unsafe ? ['F 将超出安全上限'] : [],
      diff,
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Transfer-function based PID recommendation
 * ------------------------------------------------------------------ */

/**
 * BetaflightAssistant-style systematic recommendation: fit the closed-loop
 * transfer function from setpoint to gyro, extract bandwidth/phase margin/
 * low-frequency tracking/noise floor, and derive conservative multiplicative
 * scales for P/I/D/FF. This is the strongest authority when the cross-spectrum
 * is coherent (mean coherence >= 0.5); it still only moves one conservative
 * step per round.
 */
function ruleTransferFunction(metrics, pid) {
  const axisData = [];
  for (const axis of AXES) {
    const t = metrics.axes?.[axis]?.transfer;
    if (!t?.coherent || !t.scales || (t.metrics?.meanCoherence ?? 0) < 0.5) continue;
    axisData.push({ axis, scales: t.scales, metrics: t.metrics });
  }
  if (!axisData.length) return [];

  const grouped = groupRollPitch(axisData.map((d) => d.axis));
  const leastCoherent = axisData.reduce((a, b) => (a.metrics.meanCoherence < b.metrics.meanCoherence ? a : b));

  const avgScale = (key) => {
    const vals = grouped.axes.map((axis) => axisData.find((d) => d.axis === axis).scales[key]);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };

  let piScale = avgScale('piScale');
  const iScale = avgScale('iScale');
  const dScale = avgScale('dScale');
  let ffScale = avgScale('ffScale');

  // Joint stability guard (betaflight-configurator#5258 item 2): each scale is
  // bounded on its own, but raising P/FF on a loop that is already short of
  // phase margin trades the remaining margin for bandwidth. Below the margin
  // target only damping (D) may go up; P/FF increases stand down this round.
  const worstMargin = Math.min(...axisData
    .filter((d) => grouped.axes.includes(d.axis))
    .map((d) => d.metrics.phaseMarginDeg ?? Infinity));
  const marginShort = Number.isFinite(worstMargin) && worstMargin < TF_TARGETS.phaseMarginDeg - 5;
  if (marginShort) {
    piScale = Math.min(piScale, 1);
    ffScale = Math.min(ffScale, 1);
  }

  const diff = [];
  const addScaled = (term, prefix, scale, minVal, maxVal) => {
    if (scale >= 0.97 && scale <= 1.03) return;
    for (const axis of grouped.axes) {
      const current = axisValue(pid, axis, term);
      if (current === null || current <= 0) continue;
      const raw = Math.round(current * scale);
      const to = Math.max(minVal, Math.min(maxVal, raw));
      if (to !== current) diff.push({ param: `${prefix}_${axis}`, from: current, to });
    }
  };

  addScaled('P', 'p', piScale, SANE_RANGES.p.min, SANE_RANGES.p.max);
  addScaled('I', 'i', iScale, SANE_RANGES.i.min, SANE_RANGES.i.max);
  addScaled('F', 'f', ffScale, SANE_RANGES.f.min, SANE_RANGES.f.max);

  // D is absolute-valued; use the same absolute clamp as the other D rules.
  if (dScale < 0.97 || dScale > 1.03) {
    for (const axis of grouped.axes) {
      const current = axisValue(pid, axis, 'D');
      if (current === null || current <= 0) continue;
      const delta = dScale > 1 ? +Math.min(3, Math.round(current * (dScale - 1))) : -Math.min(3, Math.round(current * (1 - dScale)));
      const to = Math.max(SANE_RANGES.d.min, Math.min(SANE_RANGES.d.max, current + delta));
      if (to !== current) diff.push({ param: `d_${axis}`, from: current, to });
    }
  }

  if (!diff.length) return [];

  const worst = leastCoherent.metrics;
  return [
    {
      id: `tf-tune-${grouped.key}`,
      problem: `闭环传递函数显示 ${grouped.label} 轴 PID 有优化空间`,
      evidence:
        `${grouped.label} 轴闭环 -3dB 带宽 ${worst.bandwidthHz} Hz（目标 ${TF_TARGETS.bandwidthHz} Hz），` +
        `增益交界频率 ${worst.gainCrossoverHz} Hz，相位裕度 ${worst.phaseMarginDeg}°（目标 ${TF_TARGETS.phaseMarginDeg}°），` +
        `2–10 Hz 低频误差 ${worst.lowFreqErrorDb} dB，谐振峰 ${worst.resonantPeakDb} dB` +
        (worst.resonantFreqHz > 0 ? ` @ ${worst.resonantFreqHz} Hz` : '') +
        `，5–100 Hz 平均相干度 ${worst.meanCoherence}。` +
        (marginShort ? `相位裕度 ${worstMargin}° 低于目标，本轮只允许加阻尼，不提高 P/FF。` : ''),
      cli: diff.map((d) => `set ${d.param} = ${d.to}`),
      why:
        '基于 setpoint→gyro 的 Welch 互谱估计闭环传递函数，从带宽、相位裕度、低频跟踪三方面同时确定 P/I/D/FF 的缩放方向；' +
        '比单一阶跃/频谱指标更系统，且只在相干度足够时才给出建议。',
      verification:
        '复飞同样的飞行科目。预期跟手性与阻尼同时改善；若出现新的超调或高频抖动，立即回退。',
      confidence: confidenceFrom([worst.meanCoherence, Math.min(worst.bandwidthHz / TF_TARGETS.bandwidthHz, 1)]),
      category: 'pid',
      safeToApply: true,
      blockedBy: [],
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

/* ------------------------------------------------------------------ *
 * High-throttle D-term heat -> TPA
 * ------------------------------------------------------------------ */

/**
 * The signature TPA exists for: the motors sat near full output for a
 * meaningful share of the log while the D term carried more energy than the
 * gyro it damps.
 *
 * `motorSaturationPct` is measured over the whole log, but it only counts
 * samples where at least half the motors are at 97 %+ of the throttle
 * reference, so it is a high-throttle/load measurement by construction.
 */
function highThrottleDtermStress(metrics) {
  const saturationPct = Number(metrics?.motorSaturationPct);
  if (!Number.isFinite(saturationPct) || saturationPct < THRESHOLDS.tpaMotorSaturationPct) return null;

  const noisy = [];
  for (const axis of AXES) {
    const ratio = Number(metrics?.axes?.[axis]?.dTermToGyroRatio);
    if (Number.isFinite(ratio) && ratio >= THRESHOLDS.dTermToGyroRatio) noisy.push({ axis, ratio });
  }
  if (!noisy.length) return null;

  const worst = noisy.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return { saturationPct, worst };
}

/**
 * One conservative step toward the racing TPA reference, or [] when the values
 * are already inside it. tpa_rate moves by the same <= 10 % relative step the
 * filter rules use; tpa_breakpoint moves by a bounded number of throttle units
 * so one flight changes one thing by a little.
 */
function tpaStepDiff(rate, breakpoint) {
  const [rateLo, rateHi] = RACING_REFERENCE.tpaRatePct;
  const [bpLo, bpHi] = RACING_REFERENCE.tpaBreakpoint;
  const diff = [];

  if (rate < rateLo) {
    // TPA off (0) or a token value changes nothing when nudged by one step -
    // the same trap D_min has. Enable it at the reference floor in one go;
    // otherwise move by the normal <= 10 % relative step.
    const step = Math.max(1, Math.round(rate * THRESHOLDS.tpaRateStepPct));
    const to = rate < rateLo / 2 ? rateLo : Math.min(rateHi, rate + step);
    if (to > rate) {
      diff.push({
        param: 'tpa_rate',
        from: rate,
        to,
        deltaPct: rate > 0 ? Number((((to - rate) / rate) * 100).toFixed(1)) : null,
      });
    }
  }
  if (breakpoint > bpHi) {
    const to = Math.max(bpLo, breakpoint - THRESHOLDS.tpaBreakpointStep);
    if (to < breakpoint) diff.push({ param: 'tpa_breakpoint', from: breakpoint, to });
  }
  return diff;
}

/**
 * Decides once whether the high-throttle heat finding is actionable, so the
 * filter advisor can stand down when it is.
 *
 * A step needs the current read-back: a diff built on a guessed tpa_rate can
 * move attenuation the wrong way, so without both values the finding is
 * reported (with its numbers and the reference) but no diff is offered.
 *
 * tpa_mode travels with it because it decides what the attenuation actually
 * touches: `D` (BF 4.3+ default) scales the D term only above the breakpoint,
 * while `PD` scales P and D together. The evidence text must not claim
 * D-only scaling on a PD build.
 */
function planTpa(metrics, dynamics) {
  const stress = highThrottleDtermStress(metrics);
  if (!stress) return null;
  const rate = pick(dynamics?.tpaRate);
  const breakpoint = pick(dynamics?.tpaBreakpoint);
  const mode = typeof dynamics?.tpaMode === 'string' ? dynamics.tpaMode.toUpperCase() : null;
  const known = rate !== null && breakpoint !== null;
  return { stress, rate, breakpoint, mode, known, diff: known ? tpaStepDiff(rate, breakpoint) : [] };
}

/**
 * What the attenuation actually scales, as read back from the FC. Unknown
 * mode falls back to the BF 4.3+ default and says so instead of asserting it.
 */
function tpaScope(mode) {
  if (mode === 'PD') {
    return {
      clause: '当前 tpa_mode = PD：breakpoint 以上按比例同时缩放 P 与 D 项（BF 4.3 之前的经典 TPA 行为），',
      caution: 'PD 模式下 P 项会跟着一起变软，高油门段可能更早出现发飘；',
    };
  }
  if (mode === 'D') {
    return {
      clause: 'BF 4.3+ 的 tpa_mode = D 只在 breakpoint 以上按 (1 - tpa_rate/100) 缩放 D 项，',
      caution: '',
    };
  }
  return {
    clause: '未读到 tpa_mode，按 BF 4.3+ 默认（tpa_mode = D，只缩放 D 项）参考，',
    caution: '',
  };
}

/**
 * TPA: when the D term is hot exactly where the throttle is high, attenuate D
 * above the breakpoint instead of filtering harder everywhere.
 */
function ruleTpa(plan, metrics) {
  if (!plan) return [];

  const { stress, rate, breakpoint, mode, known, diff } = plan;
  const [rateLo, rateHi] = RACING_REFERENCE.tpaRatePct;
  const [bpLo, bpHi] = RACING_REFERENCE.tpaBreakpoint;
  const scope = tpaScope(mode);
  const modeSuffix = mode ? `、tpa_mode = ${mode}` : '';

  const measured =
    `电机近满输出样本占 ${stress.saturationPct}%（判据 ≥ ${THRESHOLDS.tpaMotorSaturationPct}%，与 MOTOR_SATURATION 同源），` +
    `最差轴 ${stress.worst.axis} 的 D/陀螺能量比 ${stress.worst.ratio}（阈值 ${THRESHOLDS.dTermToGyroRatio}）。`;
  const reference =
    `竞速参考 tpa_rate ${rateLo}–${rateHi}、tpa_breakpoint ${bpLo}–${bpHi}（BF 默认 65 / 1350）：` +
    `${scope.clause}` +
    `所以 tpa_rate 越高、tpa_breakpoint 越低，高油门段的 D 能量（与电机发热）越少。`;
  const why =
    'D 项在高油门段的能量直接变成电机与电调的热；TPA 只在 breakpoint 以上按比例削减 D，' +
    '既压住这段发热，又保留巡航/低油门的阻尼，比继续收紧 D 项低通（对所有油门段都加延迟）更对症。' +
    scope.caution;
  const ifNotApplied =
    `高油门段继续按当前 D 能量工作，电机温度不会自己下来；${RACING_REFERENCE.motorHeatRedLine}`;
  const confidence = confidenceFrom([
    stress.saturationPct / (THRESHOLDS.tpaMotorSaturationPct * 2),
    stress.worst.ratio / 0.6,
    metrics?.sampleQuality ?? 0.5,
  ]);

  // No read-back: report the measurement and the reference, refuse a write.
  if (!known) {
    return [{
      id: 'tpa-high-throttle-d',
      problem: '高油门段 D 项能量偏高 - 未读到当前 TPA，建议按竞速参考复核',
      evidence: `${measured}${reference}本次分析没有拿到当前 tpa_rate / tpa_breakpoint，无法据此算保守步长。`,
      cli: [],
      why,
      ifNotApplied,
      verification: '先用 `get tpa_rate` / `get tpa_breakpoint` 读回当前值，再重新生成建议；本条不含写入。',
      confidence,
      category: 'filter',
      safeToApply: false,
      blockedBy: ['未读到当前 tpa_rate / tpa_breakpoint，不能给出保守步长'],
      diff: [],
    }];
  }

  // Already inside the reference band: say so rather than staying silent.
  if (!diff.length) {
    return [{
      id: 'tpa-high-throttle-d',
      problem: '高油门段 D 项能量偏高 - TPA 已在竞速参考区间，暂不建议改动',
      evidence:
        `${measured}${reference}` +
        `当前 tpa_rate = ${rate}、tpa_breakpoint = ${breakpoint}${modeSuffix} 已在参考区间内，继续加衰减会牺牲高油门段的阻尼。` +
        (mode === 'PD' ? '（PD 模式下还会一并牺牲 P 响应。）' : ''),
      cli: [],
      why,
      ifNotApplied: `TPA 已在参考区间时发热更可能来自 D 总量、滤波或机械（桨/轴承/螺丝）；${RACING_REFERENCE.motorHeatRedLine}`,
      verification: '不必改 TPA。先做机械与滤波复核，若高油门仍然烫手，再考虑整体降 D / D_min。',
      confidence,
      category: 'filter',
      safeToApply: false,
      blockedBy: [],
      diff: [],
    }];
  }

  return [{
    id: 'tpa-high-throttle-d',
    problem: `高油门段 D 项能量偏高 - ${stress.worst.axis} 轴 D/陀螺能量比 ${stress.worst.ratio}，建议提高 TPA 衰减`,
    evidence: `${measured}${reference}当前 tpa_rate = ${rate}、tpa_breakpoint = ${breakpoint}${modeSuffix}。`,
    cli: diff.map((d) => `set ${d.param} = ${d.to}`),
    why,
    ifNotApplied,
    verification:
      '复飞一段包含长时间高油门的日志，落地立即摸电机并与本次对比；同时确认高油门段没有出现新的洗流/发飘。' +
      (mode === 'PD' ? '若高油门段明显发飘或响应变软，先 `set tpa_mode = D` 把衰减限定在 D 项，再继续加衰减。' : '') +
      `若手感发糊或洗流增多，回退到 ${diff.map((d) => `${d.param}=${d.from}`).join(', ')}。`,
    confidence,
    category: 'filter',
    safeToApply: true,
    blockedBy: [],
    diff,
  }];
}

/* ------------------------------------------------------------------ *
 * Filter latency advisor (configuration-based)
 * ------------------------------------------------------------------ */

/**
 * Reference values for a 5-inch racer, taken from the craft's own configuration
 * rather than inferred from the spectrum.
 *
 * Rationale, from the published 5" tuning methodology (PIDToolbox-derived):
 * the goal is minimum latency, the working figure is ~1.5 ms of gyro delay, and
 * the process is explicitly one of REDUCING filtering while confirming that
 * motor temperature stays acceptable. An over-filtered D term arrives late and
 * so stops damping fast oscillations such as propwash - which is why "propwash"
 * and "lower the filters" belong together.
 *
 * Motor temperature is the guardrail: less filtering is only safe while the
 * motors stay merely warm.
 */
export const FILTER_REFERENCE = {
  dtermLpf1Hz: [100, 150],
  gyroLpf1Hz: [150, 250],
  itermRelaxCutoffHz: [25, 35],
  motorHeatGuardrail:
    '降滤波的代价是电机噪声与发热：每次只动一档，复飞后摸电机应「温热」；烫到握不住就说明滤波不足，需要回退。',
};

/** Snap to a 5 Hz grid - a value a human would actually type. */
function snapHz(hz, step = 5) {
  return Math.max(step, Math.round(hz / step) * step);
}

/**
 * One conservative filter step, bounded by STEP_LIMITS.FILTER_PCT (<= 10%).
 *
 * Every filter rule MUST go through these. An earlier version used ad-hoc
 * multipliers (`dtermLpf1 * 1.6`, `lpf1 * 0.8`, `lpf1 * 1.3`, ...) that broke
 * the "filters move at most 10%" invariant: the D-term over-filtering rule
 * jumped `dterm_lpf1_static_hz` from 82 -> 120 Hz (+46%) in one round, let
 * far more D-term noise reach the motors, and desynced/crashed a quad on the
 * next flight (btfl_003.bbl). One 10% step per round means the operator must
 * re-fly and re-analyse to advance further - exactly the intended loop.
 */
function filterOpenStep(hz) {
  return snapHz(hz * (1 + STEP_LIMITS.FILTER_PCT));
}

function filterTightenStep(hz) {
  return snapHz(hz * (1 - STEP_LIMITS.FILTER_PCT));
}

/**
 * Flags filtering heavier than a racing setup wants, plus an RPM filter sitting
 * configured-but-dead behind a disabled bidirectional link.
 *
 * Works purely from the configuration, so it names a concrete
 * `param: now -> target` even with no spectrum evidence available.
 *
 * @param {{itermRelaxOwnedByEvidence?:boolean}} [opts] when the measured
 *   throttle-chop hunt already produced an iterm_relax diff, this rule's
 *   configuration-only relax branch stands down so one symptom never yields
 *   two competing cutoffs.
 */
function ruleFilterLatency(metrics, pid, filter, opts = {}) {
  const proposals = [];
  const f = filter || {};

  /* --- D-term low-pass: the classic over-filtering trap --- */
  const dtermLpf1 = Number.isFinite(f.dtermLpf1Hz) ? f.dtermLpf1Hz : 0;
  const [dtermMin, dtermMax] = FILTER_REFERENCE.dtermLpf1Hz;
  if (dtermLpf1 > 0 && dtermLpf1 < dtermMin) {
    const to = filterOpenStep(dtermLpf1);
    if (to > dtermLpf1) {
      proposals.push({
        id: 'filter-dterm-latency',
        problem: `D 项低通过重 - dterm_lpf1 = ${dtermLpf1} Hz，D 项被延迟，压不住洗桨`,
        evidence:
          `当前 dterm_lpf1_static_hz = ${dtermLpf1} Hz` +
          (f.dtermLpf1DynMinHz
            ? `（动态 ${f.dtermLpf1DynMinHz}–${f.dtermLpf1DynMaxHz} Hz）`
            : '') +
          `，低于五寸竞速常用区间 ${dtermMin}–${dtermMax} Hz。` +
          'D 项低通越低，D 的阻尼到达越晚；洗桨是快速衰减振荡，靠的正是 D 及时出力。',
        cli: [`set dterm_lpf1_static_hz = ${to}`],
        why:
          '降低 D 项滤波延迟，让 D 更及时地抑制收油门后的振荡——这就是「洗桨 → 减少滤波」的机理，' +
          '代价是 D 项噪声上升，需要配合电机温度检查。',
        ifNotApplied:
          '收油门下落与穿尾流时抖动持续；D 项被延迟补偿，飞手往往只能继续加 D，反而更容易让电机发热。',
        verification: `复飞做快速收油门下落再接油门，对比抖动幅度。${FILTER_REFERENCE.motorHeatGuardrail}`,
        confidence: confidenceFrom([0.6, metrics?.sampleQuality ?? 0.5]),
        category: 'filter',
        safeToApply: to > dtermLpf1,
        blockedBy: [],
        diff: [{ param: 'dterm_lpf1_static_hz', from: dtermLpf1, to }],
      });
    }
  }

  /* --- RPM filter configured but doing nothing --- */
  const harmonics = Number.isFinite(f.rpmFilterHarmonics) ? f.rpmFilterHarmonics : 0;
  if (harmonics > 0 && f.bidirDshot !== true) {
    proposals.push({
      id: 'filter-rpm-inactive',
      problem: 'RPM 滤波已设置但不生效 - 双向 DShot 未开启',
      evidence:
        `rpm_filter_harmonics = ${harmonics}，但 dshot_bidir = 0。` +
        'RPM 滤波依赖电调回传的转速，双向 DShot 关闭时它完全不工作，' +
        '而动态陷波仍在为电机噪声工作并带来延迟。',
      cli: [],
      why:
        'RPM 滤波能精确滤掉电机谐波，从而允许整体滤波开得更少、延迟更低；' +
        '开启双向 DShot 后动态陷波负担与整体延迟都会下降，洗桨与手感同时受益。',
      ifNotApplied: '滤波器继续以延迟换噪声，RPM 滤波这份配置白占。',
      verification:
        '双向 DShot 属于电调/固件层设置，本工具不会自动改写。若要开启，请在电调协议处启用双向 DShot，再回读 rpm_filter 状态确认生效。',
      confidence: 0.9,
      category: 'filter',
      safeToApply: false,
      blockedBy: ['需要用户自行在电调/固件层启用双向 DShot'],
      diff: [],
    });
  }

  /* --- I-term relax: throttle-chop windup --- */
  const relax = opts.itermRelaxOwnedByEvidence ? 0 : (Number.isFinite(f.itermRelaxCutoff) ? f.itermRelaxCutoff : 0);
  const [relaxMin, relaxMax] = FILTER_REFERENCE.itermRelaxCutoffHz;
  if (relax > 0 && relax < relaxMin) {
    const to = Math.min(relaxMax, relaxMin + 5);
    proposals.push({
      id: 'filter-iterm-relax',
      problem: `I-term relax 截止偏低 - 收油门时 I 项积卷抑制不足（当前 ${relax} Hz）`,
      evidence:
        `iterm_relax_cutoff = ${relax} Hz，低于竞速常用 ${relaxMin}–${relaxMax} Hz。` +
        '收油门瞬间 I 项仍在累积，再加油门时会把积卷一次性释放成低频摆动。',
      cli: [`set iterm_relax_cutoff = ${to}`],
      why: '提高 relax 截止让 I 项在油门突变时更快被抑制，直接减少「收放油门后的低频晃」。',
      ifNotApplied: '急收急放油门后出现低频摆动，容易被误判成 D 不够而继续加 D。',
      verification: '复飞做连续急收急放油门，观察低频摆动是否减弱；若变迟钝或转向发飘则回退。',
      confidence: confidenceFrom([0.55, metrics?.sampleQuality ?? 0.5]),
      category: 'filter',
      safeToApply: to > relax,
      blockedBy: [],
      diff: [{ param: 'iterm_relax_cutoff', from: relax, to }],
    });
  }

  return proposals;
}

/* ------------------------------------------------------------------ *
 * Evidence-driven: standalone iterm_relax (throttle-chop hunt)
 * ------------------------------------------------------------------ */

/**
 * The standalone iterm_relax rule the configuration check cannot be: it fires
 * on the *measured* signature - I-term windup on logs that actually contain
 * descending-throttle segments (throttle chops) - and moves the cutoff one
 * conservative step toward the racing band.
 *
 * Without this, throttle-chop hunt was routed through the generic I-term and
 * D-term rules, which fix the symptom by detuning the loop instead of by
 * suppressing the integrator during the transient that causes it.
 *
 * One authority: when this rule produces a diff, ruleFilterLatency's
 * configuration-only relax branch stands down (see proposeTune).
 */
function ruleItermRelaxEvidence(metrics, filter) {
  const f = filter || {};
  const cutoff = Number.isFinite(f.itermRelaxCutoff) ? f.itermRelaxCutoff : null;
  if (cutoff === null) return []; // no read-back: cannot step conservatively
  const [relaxMin, relaxMax] = FILTER_REFERENCE.itermRelaxCutoffHz;
  if (cutoff >= relaxMax) return []; // already at the top of the reference band

  const hits = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m) continue;
    const windup = m.iTermWindupScore ?? 0;
    const chops = m.propwashEvents ?? 0;
    if (windup < THRESHOLDS.iTermWindup || chops < THRESHOLDS.relaxMinChopEvents) continue;
    const lowPeak = (m.peaks || []).find(
      (p) => p.hz >= THRESHOLDS.lowFreqOscHz[0] && p.hz <= THRESHOLDS.lowFreqOscHz[1],
    );
    hits.push({ axis, windup, chops, peakHz: lowPeak?.hz ?? null });
  }
  if (!hits.length) return [];

  const grouped = groupRollPitch(hits.map((h) => h.axis));
  const worst = hits.reduce((a, b) => (b.windup > a.windup ? b : a));
  // One step: from below the band jump to a working value (same trap as
  // D_min - nudging a 0 cutoff to 2 changes nothing); inside the band, +5 Hz.
  const to = cutoff < relaxMin ? Math.min(relaxMax, relaxMin + 5) : Math.min(relaxMax, cutoff + 5);
  if (to <= cutoff) return [];

  return [
    {
      id: 'filter-iterm-relax-evidence',
      problem: `收放油门后低频晃动（throttle-chop hunt）- ${grouped.label} 轴 I 项在油门突变时积卷，建议提高 iterm_relax 截止`,
      evidence:
        `${grouped.label} 轴积分饱和评分 ${worst.windup.toFixed(2)}（阈值 ${THRESHOLDS.iTermWindup}），` +
        `日志含 ${worst.chops} 段收油门事件（判据 ≥ ${THRESHOLDS.relaxMinChopEvents}）` +
        (worst.peakHz ? `，并在 ${worst.peakHz.toFixed(1)} Hz 出现低频峰（${THRESHOLDS.lowFreqOscHz[0]}–${THRESHOLDS.lowFreqOscHz[1]} Hz 窗口）` : '') +
        `。当前 iterm_relax_cutoff = ${cutoff} Hz，竞速参考 ${relaxMin}–${relaxMax} Hz。`,
      cli: [`set iterm_relax_cutoff = ${to}`],
      why:
        '收油门瞬间 I 项仍在累积，再加油门时把积卷一次性释放成低频晃动；' +
        'iterm_relax 在杆量/油门突变时暂时抑制积分，是对因处理——' +
        '比降 I（牺牲定高/定角保持）或加 D（增加电机热）更对症。',
      ifNotApplied:
        '急收急放油门后的低频晃动会继续被误判成「D 不够」或「I 太高」，' +
        '按通用 I/D 规则调会陷入来回拆补。',
      verification:
        '复飞做连续急收急放油门再稳住，预期低频晃动明显减弱；若定高漂移或转弯掉高（I 被抑制过度），回退到 ' +
        `iterm_relax_cutoff = ${cutoff}。`,
      confidence: confidenceFrom([worst.windup, Math.min(worst.chops / 6, 1), metrics.sampleQuality ?? 0.5]),
      category: 'filter',
      safeToApply: true,
      blockedBy: [],
      diff: [{ param: 'iterm_relax_cutoff', from: cutoff, to }],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Evidence-driven: RPM filter health
 * ------------------------------------------------------------------ */

/**
 * RPM filter on but not covering the motor harmonics.
 *
 * The configuration check (ruleFilterLatency) only catches "harmonics set but
 * bidirectional DShot off". This one catches the subtler failure the spectrum
 * shows: a motor-band peak survives into the FILTERED gyro, eRPM matching says
 * it is a rotational harmonic, yet the RPM filter that should track it leaves
 * it standing. Causes, in the order they are tried (one step per round):
 *
 *   1. harmonics < 3      -> the 2nd/3rd harmonic is unfiltered
 *   2. rpm_filter_min_hz above the peak -> the peak sits below the tracked range
 *   3. rpm_filter_q too high (too narrow) -> tracking lag lets the peak through
 *
 * When this rule has an actionable diff, ruleFilterShaping's static-notch
 * branch stands down on RPM-matched peaks: notching a tracked harmonic with a
 * static filter adds latency for what the RPM filter should do for free.
 */
function ruleRpmHealth(metrics, filter) {
  const f = filter || {};
  const harmonics = Number.isFinite(f.rpmFilterHarmonics) ? f.rpmFilterHarmonics : 0;
  const q = Number.isFinite(f.rpmFilterQ) ? f.rpmFilterQ : 0;
  const minHz = Number.isFinite(f.rpmFilterMinHz) ? f.rpmFilterMinHz : 0;
  if (f.bidirDshot !== true || harmonics <= 0) return [];
  if (!(metrics.rpmAvailable > 0)) return [];

  const residual = [];
  for (const axis of AXES) {
    const m = metrics.axes?.[axis];
    if (!m || (m.rpmHarmonicMatch ?? 0) < 0.5) continue;
    for (const pk of m.peaks || []) {
      if (pk.hz < THRESHOLDS.rpmBandHz[0] || pk.hz > THRESHOLDS.rpmBandHz[1]) continue;
      if (pk.prominenceDb < THRESHOLDS.rpmResidualPeakDb) continue;
      residual.push({ axis, hz: pk.hz, db: pk.prominenceDb, match: m.rpmHarmonicMatch });
    }
  }
  if (!residual.length) return [];

  const worst = residual.reduce((a, b) => (b.db > a.db ? b : a));

  // One step per round, in root-cause order.
  let diff = null;
  let cause = '';
  if (harmonics < 3) {
    diff = { param: 'rpm_filter_harmonics', from: harmonics, to: 3 };
    cause = `谐波数 ${harmonics} < 3，二/三次谐波没有被跟踪滤除`;
  } else if (minHz > 0 && worst.hz < minHz) {
    const to = Math.max(80, filterTightenStep(worst.hz));
    if (to < minHz) {
      diff = { param: 'rpm_filter_min_hz', from: minHz, to };
      cause = `残留峰 ${worst.hz.toFixed(0)} Hz 低于 rpm_filter_min_hz = ${minHz}，落在跟踪范围之外`;
    }
  }
  if (!diff && q > 300) {
    const to = Math.max(300, Math.round((q * (1 - STEP_LIMITS.FILTER_PCT)) / 10) * 10);
    if (to < q) {
      diff = { param: 'rpm_filter_q', from: q, to };
      cause = `rpm_filter_q = ${q} 的陷波偏窄，转速快速变化时峰值从陷波边缘漏过`;
    }
  }

  const measured =
    `滤波后的 gyroADC 频谱在 ${worst.axis} 轴 ${worst.hz.toFixed(0)} Hz 仍有 ${worst.db.toFixed(1)} dB 峰值` +
    `（阈值 ${THRESHOLDS.rpmResidualPeakDb} dB，电机谐波带 ${THRESHOLDS.rpmBandHz[0]}–${THRESHOLDS.rpmBandHz[1]} Hz），` +
    `且该轴滤波后峰值与 eRPM 谐波的吻合度 ${(worst.match * 100).toFixed(0)}%（判据 ≥ 50%）。` +
    `双向 DShot 与 RPM 滤波均已开启（harmonics = ${harmonics}${minHz ? `、min_hz = ${minHz}` : ''}${q ? `、Q = ${q}` : ''}）。`;

  if (!diff) {
    return [
      {
        id: 'filter-rpm-health',
        problem: 'RPM 滤波未盖住电机谐波 - 配置看似完整，建议人工复核',
        evidence: `${measured}谐波数、下限频率与 Q 均在常规范围内，残留峰可能来自电调回传延迟或电机差异，无法给出保守步长。`,
        cli: [],
        why: 'RPM 滤波是延迟最低的电机噪声手段；它失效时整体滤波只能以延迟换噪声。',
        verification: '核对电调双向 DShot 回传质量（debug 的 rpm 数据），再复飞对比该峰。',
        confidence: confidenceFrom([worst.db / 24, worst.match, metrics.sampleQuality ?? 0.5]),
        category: 'filter',
        safeToApply: false,
        blockedBy: ['配置在常规范围内，需要人工复核回传数据'],
        diff: [],
      },
    ];
  }

  return [
    {
      id: 'filter-rpm-health',
      problem: `RPM 滤波未盖住电机谐波 - ${cause}`,
      evidence: `${measured}${cause}。`,
      cli: [`set ${diff.param} = ${diff.to}`],
      why:
        'RPM 滤波按电调回传的转速实时跟踪电机谐波，是延迟最低的电机噪声手段；' +
        '把它修好比加静态陷波/收紧低通更省延迟——后两者对所有频率都加延迟。',
      ifNotApplied:
        '该谐波持续进入 PID（尤其 D 项），电机温度偏高；继续用静态陷波压它会白白增加延迟。',
      verification:
        `复飞后 ${worst.hz.toFixed(0)} Hz 峰应明显下降。若峰值仍在且随油门移动，` +
        '检查电调 rpm 回传质量；若峰消失但出现更高次谐波，下一轮再评估谐波数。',
      confidence: confidenceFrom([worst.db / 24, worst.match, metrics.sampleQuality ?? 0.5]),
      category: 'filter',
      safeToApply: true,
      blockedBy: [],
      diff: [diff],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Spectrum-driven filter advisor
 * ------------------------------------------------------------------ */

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
 *
 * @param {{dtermHeatOwnedByTpa?:boolean, rpmResidualOwnedByHealth?:boolean}} [opts]
 */
function ruleFilterShaping(metrics, pid, filter, opts = {}) {
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
      const to = Math.max(floor, filterTightenStep(lpf1));
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
    const rpmMatched = (m?.rpmHarmonicMatch ?? 0) >= 0.5;
    for (const pk of m?.peaks || []) {
      if (pk.hz < 100 || pk.prominenceDb < 12) continue;
      // One authority: when the RPM-health rule already offered a tracked-
      // filter fix, a static notch on the same RPM-matched peak would be a
      // competing diff for one symptom, so this branch only keeps the
      // non-harmonic peaks.
      if (opts.rpmResidualOwnedByHealth && rpmMatched) continue;
      residual.push({ axis, hz: pk.hz, db: pk.prominenceDb, harmonic: rpmMatched });
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
          ? [`set gyro_notch1_cutoff = ${cutoff}`]
          : [`set gyro_notch1_hz = ${to}`, `set gyro_notch1_cutoff = ${cutoff}`],
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
          ? [{ param: 'gyro_notch1_cutoff', from: Number.isFinite(f.gyroNotch1CutoffHz) ? f.gyroNotch1CutoffHz : 0, to: cutoff }]
          : [
              { param: 'gyro_notch1_hz', from: notchHz, to },
              { param: 'gyro_notch1_cutoff', from: Number.isFinite(f.gyroNotch1CutoffHz) ? f.gyroNotch1CutoffHz : 0, to: cutoff },
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
  // Both this branch and the TPA rule read the same D/gyro ratio. When the
  // high-throttle heat rule has an actionable diff it owns the symptom -
  // emitting two competing diffs for one measurement is what this module
  // refuses to do. Without a TPA read-back the TPA rule is advisory only, so
  // the D-term low-pass keeps its voice.
  if (noisyD.length && dtermLpf1 > 0 && !opts.dtermHeatOwnedByTpa) {
    const to = Math.max(SANE_RANGES.dtermLpf.min, filterTightenStep(dtermLpf1));
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
    const to = Math.min(filterOpenStep(lpf1), 250);
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

/**
 * Normalises the filter config the rules see.
 *
 * Every field a rule reads must survive this function. It used to keep only the
 * five original LPF/RPM values, which silently made the notch, dynamic-range,
 * I-term-relax and bidirectional-DShot findings inert: the rules ran, read
 * `undefined`, and concluded there was nothing to say.
 */
function normaliseFilter(filter) {
  const f = filter || {};
  const numOr = (v, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  return {
    gyroLpf1Hz: numOr(f.gyroLpf1Hz),
    gyroLpf2Hz: numOr(f.gyroLpf2Hz),
    gyroLpf1DynMinHz: numOr(f.gyroLpf1DynMinHz),
    gyroLpf1DynMaxHz: numOr(f.gyroLpf1DynMaxHz),
    dtermLpf1Hz: numOr(f.dtermLpf1Hz),
    dtermLpf2Hz: numOr(f.dtermLpf2Hz),
    dtermLpf1DynMinHz: numOr(f.dtermLpf1DynMinHz),
    dtermLpf1DynMaxHz: numOr(f.dtermLpf1DynMaxHz),
    dtermNotchHz: numOr(f.dtermNotchHz),
    gyroNotch1Hz: numOr(f.gyroNotch1Hz),
    gyroNotch1CutoffHz: numOr(f.gyroNotch1CutoffHz),
    dynamicNotchEnabled: Boolean(f.dynamicNotchEnabled),
    dynamicNotchCount: numOr(f.dynamicNotchCount),
    dynamicNotchQ: numOr(f.dynamicNotchQ),
    dynamicNotchMinHz: numOr(f.dynamicNotchMinHz),
    dynamicNotchMaxHz: numOr(f.dynamicNotchMaxHz),
    rpmFilterHarmonics: numOr(f.rpmFilterHarmonics),
    rpmFilterQ: numOr(f.rpmFilterQ),
    rpmFilterMinHz: numOr(f.rpmFilterMinHz),
    // Whether the bidirectional link the RPM filter depends on is actually up.
    bidirDshot: f.bidirDshot === true,
    itermRelaxCutoff: numOr(f.itermRelaxCutoff),
    antiGravityGain: numOr(f.antiGravityGain),
    tpaRate: numOr(f.tpaRate),
    tpaBreakpoint: numOr(f.tpaBreakpoint),
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

/**
 * Betaflight slider-mode equivalent of a PID diff, computed with the upstream
 * constants from the configurator's tuning sliders (simplified_tuning port):
 * P and I scale with `slider_pi_gain` * `slider_master_multiplier`, F with
 * `slider_feedforward_gain`, and the non-expert UI bounds every slider to
 * 0.70-1.40 (NON_EXPERT_SLIDER_MIN/MAX). The hint is advisory text only -
 * this tool still writes plain parameters, never the slider MSP path.
 *
 * @param {{param:string, from:number, to:number}[]} diff
 * @param {'pi'|'ff'} kind
 */
export function sliderHintFor(diff, kind) {
  const factors = (diff || []).filter((d) => d.from > 0 && d.to > 0).map((d) => d.to / d.from);
  if (!factors.length) return null;
  const factor = factors.reduce((a, b) => a + b, 0) / factors.length;
  const label = kind === 'ff' ? 'Feedforward gain' : 'PI gain（或 Master multiplier）';
  const out = factor < 0.7 || factor > 1.4;
  return (
    `${label} ×${factor.toFixed(2)}（BF 滑块模式等效；非专家范围 0.70–1.40${out ? '，已超出该范围' : ''}）`
  );
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
    /^gyro_notch[12]_(hz|cutoff)$/.test(param) ||
    /^dterm_notch_(hz|cutoff)$/.test(param) ||
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
