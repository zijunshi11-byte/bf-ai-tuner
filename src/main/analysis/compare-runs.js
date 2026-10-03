/**
 * Compares two flights and decides whether a tuning change made things better
 * or worse - the judgement behind automatic rollback.
 *
 * The rule set is deliberately narrow and biased toward false negatives: an
 * automatic revert is only justified when a metric the change was *supposed*
 * to improve got clearly worse. Every comparison is reported with its numbers
 * so the operator can disagree with the verdict.
 *
 * Motor temperature cannot be logged, so D-term energy is used as the proxy:
 * on a 5-inch quad, rising D energy at unchanged flying style is what cooks
 * motors.
 */

/** Percent change from `before` to `after`, or null when it is undefined. */
export function pctChange(before, after) {
  const a = Number(before);
  const b = Number(after);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a === 0) return b === 0 ? 0 : null;
  return ((b - a) / Math.abs(a)) * 100;
}

/** Highest value of `pick` across the three axes. */
export function maxAcrossAxes(metrics, pick) {
  let best = null;
  for (const axis of ['roll', 'pitch', 'yaw']) {
    const m = metrics?.axes?.[axis];
    if (!m) continue;
    const v = Number(pick(m));
    if (!Number.isFinite(v)) continue;
    if (best === null || v > best.value) best = { value: v, axis };
  }
  return best ? best.value : 0;
}

/**
 * What gets compared.
 *
 * `tolPct` is the band inside which a change is treated as noise: gyro RMS and
 * spectral metrics move a few percent between any two flights even with an
 * identical tune, so a revert must not fire on that.
 */
export const COMPARISONS = [
  {
    key: 'overshoot',
    label: '超调 / overshoot',
    hard: true,
    pick: (m) => maxAcrossAxes(m, (a) => a.step?.overshootPct),
    worseIsHigher: true,
    tolPct: 12,
  },
  {
    key: 'propwash',
    label: '洗桨 / propwash',
    hard: true,
    pick: (m) => maxAcrossAxes(m, (a) => a.propwashIndex),
    worseIsHigher: true,
    tolPct: 15,
  },
  {
    key: 'dterm',
    label: 'D 项能量（电机发热代理） / D-term energy',
    hard: true,
    pick: (m) => maxAcrossAxes(m, (a) => a.dTermToGyroRatio),
    worseIsHigher: true,
    tolPct: 12,
  },
  {
    key: 'saturation',
    label: '电机饱和 / motor saturation',
    hard: true,
    pick: (m) => Number(m?.motorSaturationPct ?? 0),
    worseIsHigher: true,
    tolPct: 25,
  },
  {
    key: 'dropRate',
    label: '丢帧率 / frame drop',
    hard: true,
    pick: (m) => Number(m?.dropRatePct ?? 0),
    worseIsHigher: true,
    tolPct: 40,
  },
  {
    key: 'gyroNoise',
    label: '陀螺噪声 / gyro noise RMS',
    hard: false,
    pick: (m) => maxAcrossAxes(m, (a) => a.gyroRms),
    worseIsHigher: true,
    tolPct: 20,
  },
  {
    key: 'settling',
    label: '安定时间 / settling time',
    hard: false,
    pick: (m) => maxAcrossAxes(m, (a) => a.step?.settlingTimeMs),
    worseIsHigher: true,
    tolPct: 20,
  },
  {
    key: 'itermWindup',
    label: 'I 项积卷 / I-term windup',
    hard: false,
    pick: (m) => maxAcrossAxes(m, (a) => a.iTermWindupScore),
    worseIsHigher: true,
    tolPct: 25,
  },
];

/**
 * Judges `after` against `before`.
 *
 * @returns {{verdict:'better'|'worse'|'unchanged', reasons:Array, hardWorse:number, improved:number}}
 */
export function compareRuns(before, after, { comparisons = COMPARISONS } = {}) {
  const reasons = [];
  let hardWorse = 0;
  let improved = 0;
  let material = 0;

  for (const c of comparisons) {
    const b = c.pick(before);
    const a = c.pick(after);
    const deltaPct = pctChange(b, a);
    if (deltaPct === null) continue;

    const worse = c.worseIsHigher ? deltaPct > c.tolPct : deltaPct < -c.tolPct;
    const better = c.worseIsHigher ? deltaPct < -c.tolPct : deltaPct > c.tolPct;

    if (worse) {
      material += 1;
      if (c.hard) hardWorse += 1;
    } else if (better) {
      material += 1;
      improved += 1;
    }

    reasons.push({
      metric: c.label,
      key: c.key,
      before: Number.isFinite(b) ? Math.round(b * 100) / 100 : null,
      after: Number.isFinite(a) ? Math.round(a * 100) / 100 : null,
      delta: Math.round(deltaPct * 10) / 10,
      tolerance: c.tolPct,
      hard: c.hard,
      worse,
      better,
    });
  }

  // A revert needs a clear regression: any hard metric past tolerance, or a
  // majority of the softer ones. One soft metric drifting is not enough.
  let verdict = 'unchanged';
  if (hardWorse > 0) verdict = 'worse';
  else if (reasons.filter((r) => r.worse).length >= 2 && improved === 0) verdict = 'worse';
  else if (improved > 0 && reasons.filter((r) => r.worse).length === 0) verdict = 'better';

  const regressed = reasons.filter((r) => r.worse);
  const helped = reasons.filter((r) => r.better);

  return {
    verdict,
    reasons,
    hardWorse,
    improved,
    material,
    summary: verdict === 'worse'
      ? `判定变差：${regressed.map((r) => `${r.metric} ${r.delta > 0 ? '+' : ''}${r.delta}%`).join('；')}`
      : verdict === 'better'
        ? `判定改善：${helped.map((r) => `${r.metric} ${r.delta > 0 ? '+' : ''}${r.delta}%`).join('；')}`
        : '判定无明显变化（各项均在容差内）',
    // Only a "worse" verdict with a hard regression earns an automatic revert.
    shouldRollback: verdict === 'worse' && hardWorse > 0,
  };
}

export default { compareRuns, COMPARISONS, pctChange, maxAcrossAxes };
