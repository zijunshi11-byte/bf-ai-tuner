/**
 * AI agent layer for blackbox analysis.
 *
 * Division of labour: the rule engine does the *measuring* (spectra, step
 * response, propwash index, RPM harmonics - all of it numeric and offline),
 * and the model does the *reasoning* over those measurements. The raw .bbl is
 * never uploaded - a 6 MB log is neither affordable nor necessary when the
 * engine has already reduced it to a few hundred numbers.
 *
 * Safety model (unchanged from the rest of the app):
 *   - The model NEVER writes. It returns text plus, optionally, a structured
 *     `diff` that is then run through the exact same screen every rule-produced
 *     diff goes through (`filterDiff`: FORBIDDEN_PARAMS + tunable whitelist).
 *   - A suggestion that names a forbidden or unknown parameter is kept in the
 *     report but marked blocked, so the operator sees what the model tried and
 *     why it was refused.
 *   - Nothing here touches the two-phase token flow; applying is still an
 *     explicit, separately confirmed action.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { filterDiff, isTunableParam } from './ai-tune.js';
import { opensFilter } from './evidence.js';
import { FORBIDDEN_PARAMS, STEP_LIMITS } from '../../shared/contracts.js';

/** Defaults target an OpenAI-compatible `/chat/completions` endpoint. */
export const DEFAULT_AI_CONFIG = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  maxTokens: 2400,
  temperature: 0.2,
  timeoutMs: 90000,
};

/** Config that is safe to hand to the renderer: the key never travels back. */
export function publicAiConfig(config = {}) {
  const merged = { ...DEFAULT_AI_CONFIG, ...config };
  return {
    enabled: Boolean(merged.enabled),
    baseUrl: String(merged.baseUrl || ''),
    model: String(merged.model || ''),
    hasApiKey: typeof merged.apiKey === 'string' && merged.apiKey.trim().length > 0,
    maxTokens: Number(merged.maxTokens) || DEFAULT_AI_CONFIG.maxTokens,
    temperature: Number.isFinite(Number(merged.temperature)) ? Number(merged.temperature) : DEFAULT_AI_CONFIG.temperature,
  };
}

/** Merge a partial patch into a stored config without dropping the key. */
export function mergeAiConfig(current = {}, patch = {}) {
  const next = { ...DEFAULT_AI_CONFIG, ...current };
  for (const key of ['enabled', 'baseUrl', 'model', 'apiKey', 'maxTokens', 'temperature', 'timeoutMs']) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (key === 'apiKey' && patch[key] === '') continue; // '' means "leave as is"
    next[key] = patch[key];
  }
  next.enabled = Boolean(next.enabled);
  next.baseUrl = String(next.baseUrl || '').replace(/\/+$/, '');
  next.model = String(next.model || '');
  next.apiKey = String(next.apiKey || '');
  return next;
}

/* ------------------------------------------------------------------ *
 * Evidence pack - the only thing that leaves the machine
 * ------------------------------------------------------------------ */

const round = (v, d = 2) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

function axisSummary(axis) {
  const a = axis || {};
  return {
    gyroRmsDps: round(a.gyroRms, 1),
    gyroPeakDps: round(a.gyroPeak, 1),
    noiseFloorDbfs: round(a.noiseFloorDbfs, 1),
    filterAttenuationDb: round(a.filterAttenuationDb, 1),
    propwashIndex: round(a.propwashIndex, 3),
    propwashEvents: a.propwashEvents ?? 0,
    dTermToGyroRatio: round(a.dTermToGyroRatio, 3),
    iTermWindupScore: round(a.iTermWindupScore, 3),
    trackingGainDb: round(a.trackingGainDb, 2),
    trackingCoherence: round(a.trackingCoherence, 2),
    trackingPhaseDeg: round(a.trackingPhaseDeg, 1),
    rpmHarmonicMatch: round(a.rpmHarmonicMatch, 2),
    step: a.step
      ? {
          overshootPct: round(a.step.overshootPct, 1),
          riseTimeMs: round(a.step.riseTimeMs, 1),
          settlingTimeMs: round(a.step.settlingTimeMs, 1),
          latencyMs: round(a.step.latencyMs, 1),
          samples: a.step.samples ?? 0,
        }
      : null,
    // Wiener-deconvolved setpoint->gyro step (PIDtoolbox method). Includes
    // feedforward: overshoot here is what the pilot feels, not proof of high P.
    stepDeconv: a.stepDeconv && a.stepDeconv.samples
      ? {
          overshootPct: round(a.stepDeconv.overshootPct, 1),
          delay50Ms: round(a.stepDeconv.delay50Ms, 1),
          riseTimeMs: round(a.stepDeconv.riseTimeMs, 1),
          steadyStateErrorPct: round(a.stepDeconv.steadyStateErrorPct, 1),
          windows: a.stepDeconv.samples,
          includesFeedforward: true,
        }
      : null,
    peaks: (a.peaks || [])
      .slice()
      .sort((x, y) => (y.prominenceDb ?? 0) - (x.prominenceDb ?? 0))
      .slice(0, 6)
      .map((p) => ({ hz: round(p.hz, 0), prominenceDb: round(p.prominenceDb, 1) })),
    transfer: a.transfer
      ? {
          coherent: Boolean(a.transfer.coherent),
          bandwidthHz: round(a.transfer.metrics?.bandwidthHz, 0),
          gainCrossoverHz: round(a.transfer.metrics?.gainCrossoverHz, 0),
          phaseMarginDeg: round(a.transfer.metrics?.phaseMarginDeg, 0),
          lowFreqErrorDb: round(a.transfer.metrics?.lowFreqErrorDb, 2),
          resonantPeakDb: round(a.transfer.metrics?.resonantPeakDb, 1),
          meanCoherence: round(a.transfer.metrics?.meanCoherence, 2),
        }
      : null,
  };
}

/* ------------------------------------------------------------------ *
 * Detail levels
 * ------------------------------------------------------------------ */

/**
 * How much of the log travels with the request.
 *
 * `compact` is the "cheap sanity check" tier: derived numbers only. `standard`
 * adds the full header, every channel statistic, every detected peak and the
 * decimated spectra. `full` additionally serialises the whole flight as
 * downsampled time series so the model can see *when* things happened, not just
 * the aggregate - which is what "analyse the entire log" actually needs.
 *
 * `maxChars` is the serialised budget; the time-series decimation is computed to
 * fit it, so the pack never silently blows past the model's context window.
 */
export const PACK_LEVELS = {
  compact: {
    id: 'compact',
    label: '紧凑 / compact',
    maxChars: 9000,
    fullHeader: false,
    channelStats: false,
    spectraPoints: 0,
    allPeaks: false,
    timeSeries: false,
    segmented: false,
  },
  standard: {
    id: 'standard',
    label: '标准 / standard',
    maxChars: 120000,
    fullHeader: true,
    channelStats: true,
    spectraPoints: 128,
    allPeaks: true,
    timeSeries: true,
    segmented: true,
  },
  full: {
    id: 'full',
    label: '完整 / full',
    maxChars: 400000,
    fullHeader: true,
    channelStats: true,
    spectraPoints: 256,
    allPeaks: true,
    timeSeries: true,
    segmented: true,
  },
};

export function packLevel(id) {
  return PACK_LEVELS[id] || PACK_LEVELS.compact;
}

/** Channels worth serialising, most useful first. */
const TIME_SERIES_CORE = [
  'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]',
  'setpoint[0]', 'setpoint[1]', 'setpoint[2]',
  'throttle',
  'motor[0]', 'motor[1]', 'motor[2]', 'motor[3]',
  'eRPM[0]', 'eRPM[1]', 'eRPM[2]', 'eRPM[3]',
];

const TIME_SERIES_EXTENDED = [
  ...TIME_SERIES_CORE,
  'gyroUnfilt[0]', 'gyroUnfilt[1]', 'gyroUnfilt[2]',
  'axisP[0]', 'axisP[1]', 'axisP[2]',
  'axisD[0]', 'axisD[1]', 'axisD[2]',
  'axisI[0]', 'axisI[1]', 'axisI[2]',
  'axisF[0]', 'axisF[1]', 'axisF[2]',
  'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]',
  'vbat',
];

/** Which channels a level serialises (all of them for `full`). */
export function timeSeriesChannelsFor(level) {
  return level === 'full' ? TIME_SERIES_EXTENDED : TIME_SERIES_CORE;
}


/** Read a channel's flat array out of a decoded log (flat key, then grouped). */
function readRawChannel(log, name) {
  const channels = log?.channels;
  if (!channels) return null;
  const flat = channels[name];
  if (Array.isArray(flat) && flat.length) return flat;
  const m = /^([A-Za-z_]+)\[(\d+)\]$/.exec(name);
  if (m) {
    const grouped = channels[m[1]];
    const idx = Number(m[2]);
    if (Array.isArray(grouped) && Array.isArray(grouped[idx]) && grouped[idx].length) return grouped[idx];
  }
  return null;
}

/** Every channel present in the log, flat keys only (the grouped aliases are dups). */
export function listChannels(log) {
  const channels = log?.channels;
  if (!channels) return [];
  return Object.entries(channels)
    .filter(([name, v]) => /\[\d+\]$/.test(name) && Array.isArray(v) && v.length)
    .map(([name]) => name)
    .concat(
      Object.entries(channels)
        .filter(([name, v]) => !/\[\d+\]$/.test(name) && Array.isArray(v) && v.length && typeof v[0] === 'number')
        .map(([name]) => name),
    )
    .filter((name, i, all) => all.indexOf(name) === i);
}

function channelStats(values) {
  if (!Array.isArray(values) || !values.length) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  let zeros = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
    if (v === 0) zeros++;
    n++;
  }
  if (!n) return null;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return {
    n,
    min: round(min, 1),
    max: round(max, 1),
    mean: round(mean, 2),
    rms: round(Math.sqrt(variance + mean * mean), 2),
    zeroPct: round((zeros / n) * 100, 2),
  };
}

/**
 * Decimate `values` to at most `points` samples, preserving the extremes.
 *
 * Plain stride sampling would hide exactly the spikes the model is looking for,
 * so each bucket contributes its min and max as well as its midpoint. The
 * result is a faithful envelope at a fraction of the size.
 */
export function decimateEnvelope(values, points) {
  const n = Array.isArray(values) ? values.length : 0;
  if (!n) return [];
  if (points >= n) return values.map((v) => round(v, 1));
  const buckets = Math.max(1, Math.floor(points / 3));
  const bucketSize = Math.ceil(n / buckets);
  const out = [];
  for (let start = 0; start < n; start += bucketSize) {
    const end = Math.min(n, start + bucketSize);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
    }
    if (!count) continue;
    // [min, mean, max] per bucket: the envelope plus its centre.
    out.push(round(min, 1), round(sum / count, 1), round(max, 1));
  }
  return out;
}

/** Per-segment summary so the model can see WHERE in the flight a problem sits. */
function segmentSummary(log, segments = 12) {
  const gyro = ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]'].map((n) => readRawChannel(log, n)).filter(Boolean);
  const throttle = readRawChannel(log, 'throttle') || readRawChannel(log, 'rcCommand[3]');
  const motors = [0, 1, 2, 3].map((i) => readRawChannel(log, `motor[${i}]`)).filter(Boolean);
  const erpm = [0, 1, 2, 3].map((i) => readRawChannel(log, `eRPM[${i}]`)).filter(Boolean);
  if (!gyro.length) return null;

  const n = Math.min(...gyro.map((g) => g.length));
  if (n < segments * 4) return null;
  const size = Math.floor(n / segments);
  const out = [];

  for (let s = 0; s < segments; s++) {
    const start = s * size;
    const end = s === segments - 1 ? n : start + size;
    const row = { t: round(start / (log.sampleRateHz || 1), 2) };
    const axisRms = [];
    for (const g of gyro) {
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        const v = g[i];
        if (Number.isFinite(v)) {
          sum += v * v;
          count++;
        }
      }
      axisRms.push(count ? round(Math.sqrt(sum / count), 1) : null);
    }
    row.gyroRms = axisRms;
    if (throttle) {
      let sum = 0;
      let count = 0;
      let mx = 0;
      for (let i = start; i < end; i++) {
        const v = throttle[i];
        if (Number.isFinite(v)) {
          sum += v;
          if (v > mx) mx = v;
          count++;
        }
      }
      row.thrMean = count ? round(sum / count, 0) : null;
      row.thrMax = count ? round(mx, 0) : null;
    }
    if (motors.length) {
      const len = Math.min(...motors.map((x) => x.length));
      let sat = 0;
      let count = 0;
      for (let i = start; i < Math.min(end, len); i++) {
        // "saturated" = at least half the motors above 97% of their observed max.
        const mx = motors.map((x) => x[i]).filter(Number.isFinite);
        if (!mx.length) continue;
        const hi = Math.max(...mx);
        if (mx.filter((v) => v >= hi * 0.97).length >= Math.ceil(mx.length / 2)) sat++;
        count++;
      }
      row.motorSatPct = count ? round((sat / count) * 100, 1) : 0;
    }
    if (erpm.length) {
      const len = Math.min(...erpm.map((x) => x.length));
      let dropped = 0;
      let count = 0;
      for (let i = start; i < Math.min(end, len); i++) {
        const vals = erpm.map((x) => x[i] * 100).filter(Number.isFinite);
        if (!vals.length) continue;
        const hi = Math.max(...vals);
        if (hi > 5000 && vals.some((v) => v < 0.1 * hi)) dropped++;
        count++;
      }
      row.erpmDropoutPct = count ? round((dropped / count) * 100, 2) : 0;
    }
    out.push(row);
  }
  return out;
}

/** A spectrum reduced to a fixed point count, as {hz:[], db:[]} pairs. */
function spectrumFor(axis, points) {
  const spec = axis?.gyroSpectrum;
  if (!points || !spec?.freqs?.length || !spec?.psd?.length) return null;
  const n = Math.min(spec.freqs.length, spec.psd.length);
  if (n <= points) {
    return { hz: spec.freqs.map((f) => round(f, 1)), db: spec.psd.map((p) => round(p, 1)) };
  }
  const stride = n / points;
  const hz = [];
  const db = [];
  for (let i = 0; i < points; i++) {
    const idx = Math.min(n - 1, Math.round(i * stride));
    hz.push(round(spec.freqs[idx], 1));
    db.push(round(spec.psd[idx], 1));
  }
  return { hz, db };
}

/**
 * Reduce a metrics report (+ the decoded log, when a richer tier is asked for)
 * to the brief that is actually sent to the model.
 */
export function buildEvidencePack({
  metrics = null,
  craftSettings = null,
  proposals = [],
  identity = null,
  header = null,
  log = null,
  level = 'compact',
} = {}) {
  const m = metrics || {};
  const craft = craftSettings || {};
  const L = packLevel(level);

  const pack = {
    level: L.id,
    craft: {
      board: identity?.boardName ?? null,
      firmware: identity?.version ?? null,
      target: identity?.targetName ?? null,
      pid: craft.pid ?? null,
      filter: craft.filter
        ? {
            gyroLpf1Hz: craft.filter.gyroLpf1Hz,
            gyroLpf1DynMinHz: craft.filter.gyroLpf1DynMinHz,
            gyroLpf1DynMaxHz: craft.filter.gyroLpf1DynMaxHz,
            dtermLpf1Hz: craft.filter.dtermLpf1Hz,
            dtermLpf1DynMinHz: craft.filter.dtermLpf1DynMinHz,
            dtermLpf1DynMaxHz: craft.filter.dtermLpf1DynMaxHz,
            dtermNotchHz: craft.filter.dtermNotchHz,
            gyroNotch1Hz: craft.filter.gyroNotch1Hz,
            gyroNotch1CutoffHz: craft.filter.gyroNotch1CutoffHz,
            dynamicNotchEnabled: craft.filter.dynamicNotchEnabled,
            dynamicNotchCount: craft.filter.dynamicNotchCount,
            dynamicNotchQ: craft.filter.dynamicNotchQ,
            dynamicNotchMinHz: craft.filter.dynamicNotchMinHz,
            dynamicNotchMaxHz: craft.filter.dynamicNotchMaxHz,
            rpmFilterHarmonics: craft.filter.rpmFilterHarmonics,
            rpmFilterQ: craft.filter.rpmFilterQ,
            rpmFilterMinHz: craft.filter.rpmFilterMinHz,
            bidirDshot: craft.filter.bidirDshot,
            rpmFilterActive: craft.filter.rpmFilterActive,
            itermRelaxCutoff: craft.filter.itermRelaxCutoff,
            antiGravityGain: craft.filter.antiGravityGain,
            tpaRate: craft.filter.tpaRate,
            tpaBreakpoint: craft.filter.tpaBreakpoint,
          }
        : null,
      dMax: craft.dynamics?.dMax ?? null,
      dMaxGain: craft.dynamics?.dMaxGain ?? null,
    },
    log: {
      file: m.file ?? null,
      durationS: round(m.durationS, 1),
      sampleRateHz: m.sampleRateHz ?? null,
      dropRatePct: round(m.dropRatePct, 3),
      motorSaturationPct: round(m.motorSaturationPct, 1),
      rpmAvailable: m.rpmAvailable ?? 0,
      rpmMin: m.rpmMin ?? null,
      rpmMax: m.rpmMax ?? null,
      sampleQuality: round(m.sampleQuality, 2),
      throttleHighS: m.throttleProfile?.highS ?? null,
      // Which analysis domains this log can support; a short domain means the
      // rule engine withheld advice there, and so should the model.
      evidenceMissing: m.evidence?.missing ?? null,
      // Mechanical findings: fix these before any PID/filter change.
      mechanical: m.mechanical
        ? {
            propOutlierMotor: m.mechanical.onceVibration?.outlier ? m.mechanical.onceVibration.outlier.index + 1 : null,
            propOutlierRatio: m.mechanical.onceVibration?.outlier?.ratioToOthers ?? null,
            fixedResonancesHz: (m.mechanical.resonance?.resonances || []).map((r) => ({ hz: r.hz, survivesFilter: r.survivesFilter })),
            movingPeaksHz: (m.mechanical.resonance?.tracking || []).map((t) => t.hz),
          }
        : null,
      warnings: L.id === 'compact' ? (m.warnings || []).slice(0, 8) : m.warnings || [],
    },
    faults: (m.faults || []).map((f) => ({
      code: f.code,
      severity: f.severity,
      blocksTuning: Boolean(f.blocksTuning),
      evidence: String(f.evidence || '').slice(0, L.id === 'compact' ? 400 : 2000),
    })),
    axes: {
      roll: axisSummary(m.axes?.roll),
      pitch: axisSummary(m.axes?.pitch),
      yaw: axisSummary(m.axes?.yaw),
    },
    ruleFindings: (proposals || []).map((p) => ({
      id: p.id,
      problem: String(p.problem || '').slice(0, 300),
      evidence: String(p.evidence || '').slice(0, L.id === 'compact' ? 600 : 2000),
      diff: p.diff || [],
      category: p.category,
      confidence: p.confidence,
    })),
  };

  if (L.id === 'compact') return pack;

  /* ---- richer tiers ---- */

  // The full blackbox header: every setting the craft was flying with. Small,
  // and the single most useful context for judging whether advice is in range.
  if (L.fullHeader && header && typeof header === 'object') {
    pack.blackboxHeader = { ...header };
  }

  if (L.allPeaks) {
    for (const axis of ['roll', 'pitch', 'yaw']) {
      const src = m.axes?.[axis];
      if (!src) continue;
      pack.axes[axis].peaks = (src.peaks || [])
        .slice()
        .sort((a, b) => (b.prominenceDb ?? 0) - (a.prominenceDb ?? 0))
        .map((p) => ({ hz: round(p.hz, 1), prominenceDb: round(p.prominenceDb, 1), widthHz: round(p.widthHz, 1) ?? null }));
      if (src.transfer) pack.axes[axis].transfer = axisSummary(src).transfer;
    }
  }

  if (L.spectraPoints) {
    pack.spectra = {
      note: 'gyroADC filtered PSD, dB; decimated, evenly spaced in Hz',
      roll: spectrumFor(m.axes?.roll, L.spectraPoints),
      pitch: spectrumFor(m.axes?.pitch, L.spectraPoints),
      yaw: spectrumFor(m.axes?.yaw, L.spectraPoints),
    };
  }

  if (log?.channels) {
    if (L.channelStats) {
      const stats = {};
      for (const name of listChannels(log)) {
        const s = channelStats(readRawChannel(log, name));
        if (s) stats[name] = s;
      }
      pack.channelStats = stats;
    }
    if (L.segmented) {
      pack.segments = {
        note: '整段飞行按时间等分为若干段；gyroRms 单位 deg/s，thr 为 1000-2000 油门',
        rows: segmentSummary(log, 12),
      };
    }
    if (L.timeSeries) {
      // Size the time series against what is ACTUALLY left, rather than a fixed
      // fraction: everything else in the pack was built above and measured here,
      // so the total lands just under the level's budget whatever the log size.
      const used = packSizeChars(pack);
      const remaining = Math.max(2000, L.maxChars - used - 512);
      pack.timeSeries = buildTimeSeries(log, remaining, timeSeriesChannelsFor(L.id));
      trimPackToBudget(pack, L.maxChars);
    }
  }

  return pack;
}

/**
 * Last-resort guard: drop the least important time-series channels until the
 * serialised pack is inside `maxChars`.
 *
 * The per-channel estimate in buildTimeSeries is close but not exact (rounded
 * values have varying widths), and blowing the model's context window is a hard
 * failure, so the size is verified rather than assumed.
 */
export function trimPackToBudget(pack, maxChars) {
  if (!pack?.timeSeries?.channels) return pack;
  const order = Object.keys(pack.timeSeries.channels);
  // TIME_SERIES_CORE is ordered gyro -> setpoint -> throttle -> motors -> eRPM,
  // so trimming from the tail keeps the channels a desync diagnosis needs.
  while (order.length > 1 && packSizeChars(pack) > maxChars) {
    const drop = order.pop();
    delete pack.timeSeries.channels[drop];
  }
  if (!order.length) delete pack.timeSeries;
  return pack;
}

/**
 * Serialise decimated time series for the whole flight, fitting `budgetChars`.
 *
 * The budget is split EVENLY across the channel list rather than handed to the
 * first channel until it runs out. Filling greedily gave gyro/setpoint maximum
 * resolution and dropped every motor and eRPM channel - exactly the evidence a
 * desync diagnosis needs. A fair share means every channel is present for the
 * entire flight, just coarser; the precise numbers live in channelStats and the
 * peak/spectrum sections.
 */
export function buildTimeSeries(log, budgetChars, channels = TIME_SERIES_CORE) {
  const present = channels
    .map((name) => ({ name, values: readRawChannel(log, name) }))
    .filter((c) => Array.isArray(c.values) && c.values.length);
  if (!present.length) return null;

  const sampleRateHz = log.sampleRateHz || 1;
  const length = Math.max(...present.map((c) => c.values.length));
  const out = {
    note:
      '每条通道是全程降采样包络，每桶依次为 [最小值, 平均值, 最大值]，按时间顺序排列。' +
      'everySamples 是每桶覆盖的原始采样点数；t = index * everySamples / sampleRateHz 秒。',
    durationS: round(length / sampleRateHz, 2),
    sampleRateHz,
    bucketsPerChannel: 0,
    channels: {},
  };

  // ~5.5 chars per serialised number (rounded values + separators); a bucket is 3.
  const maxCharsPerChannel = Math.max(240, Math.floor(budgetChars / present.length));
  const maxNumbers = Math.max(3, Math.floor(maxCharsPerChannel / 5.5));
  const points = Math.max(3, maxNumbers - (maxNumbers % 3));

  for (const { name, values } of present) {
    const series = decimateEnvelope(values, points);
    if (!series.length) continue;
    const buckets = Math.max(1, Math.round(series.length / 3));
    out.channels[name] = {
      everySamples: Math.max(1, Math.round(values.length / buckets)),
      buckets,
      values: series,
    };
    out.bucketsPerChannel = Math.max(out.bucketsPerChannel, buckets);
  }

  return Object.keys(out.channels).length ? out : null;
}

/** Serialised size, in characters, of whatever the pack currently holds. */
export function packSizeChars(pack) {
  try {
    return JSON.stringify(pack).length;
  } catch {
    return Infinity;
  }
}


/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

export const AI_SYSTEM_PROMPT = `你是一名 5 寸竞速穿越机（Betaflight 4.x/2025.x）调参专家，负责复核一份已经由离线分析引擎测量好的黑匣子日志报告，并给出可执行的修改建议。

硬性规则（必须遵守）：
1. 只使用输入里给出的测量数字。绝对不要编造任何你没有看到的数值、轴或频点。
2. 修改必须是保守的：P/I 单次变化不超过 7%，D 单次不超过 ±2~3 个单位，滤波器单次不超过 10%，每轮只动一个方向。
3. 严禁建议修改安全相关参数：failsafe、电机方向、ESC 协议、电压/电流校准、resource/timer。这些不在可写白名单里。
4. 只建议白名单内的参数：p_/i_/d_/f_(roll|pitch|yaw)、d_max_*、d_min_*、gyro_lpf1/2_*、dterm_lpf1/2_*、dterm_notch_*、gyro_notch1/2_*、dyn_notch_*、rpm_filter_*、iterm_relax*、anti_gravity_gain、tpa_*、blackbox_sample_rate/device。
5. 如果日志里有 blocksTuning=true 的硬件故障（失步/削波/剧烈震动/日志截断），必须明确说"先修硬件，本轮不要改 PID/滤波"，并把 suggestions 置空。
6. 如果测量数据不足以判断某件事，就直说数据不足，不要猜。
7. 少于 3 条真正有证据支撑的建议时，宁少勿多。
8. 如果输入包里有 timeSeries（时间序列包络），结合它判断问题出现的时机与工况（例如抖动只出现在高油门还是收油门段、哪一段电机掉速、陀螺何时饱和），并把这类观察写进 evidence。
9. 如果输入包里有 segments（分段统计），用它定位问题集中在整段飞行的哪个阶段，并引用具体段号与秒数。
10. 如果输入包里有 blackboxHeader（完整飞控配置），可据此核对 PID/滤波/TPA/RPM 设置是否互相矛盾；但只能建议上面白名单里的参数。
11. log.evidenceMissing 列出本日志证据不足的分析领域（steps/tracking/propwash/noise/noiseOpen/rpm/logging）。这些领域不要给改参建议，只说明需要补飞什么；包含 noiseOpen 时绝不建议放宽任何滤波（提高低通截止、减少陷波/RPM 谐波）。
12. axes.*.stepDeconv 是反卷积得到的 setpoint→gyro 阶跃响应，包含前馈作用：其中的超调不能单独作为降 P 的依据。
13. log.mechanical.movingPeaksHz 里的峰随电机转速移动：不要为它们建议静态陷波（gyro_notch*），那是 RPM 滤波/动态陷波的工作；fixedResonancesHz 才适合静态陷波。propOutlierMotor 非空时先让用户检查该电机的桨与轴。

只输出一个 JSON 对象，不要任何其他文字、不要 markdown 代码块。格式：
{
  "verdict": "一句话总评（中文）",
  "confidence": 0.0-1.0,
  "suggestions": [
    {
      "problem": "① 哪里不对",
      "evidence": "② 证据：必须引用输入中的具体数字与轴/频点",
      "diff": [{"param": "d_pitch", "from": 17, "to": 20}],
      "cli": ["set d_pitch = 20"],
      "why": "④ 为什么这样改（延迟/电机发热/洗桨机理）",
      "verification": "⑤ 复飞做什么动作、预期看到什么",
      "ifNotApplied": "⑥ 不改会怎样",
      "confidence": 0.0-1.0
    }
  ],
  "notes": "其他需要人工复核的观察（可为空字符串）"
}`;

export function buildUserPrompt(pack) {
  const level = pack?.level || 'compact';
  const shape = {
    compact: '本包为紧凑档：只有派生测量值，没有时间序列。',
    standard: '本包为标准档：含完整黑匣子 header、全部通道统计、全部检测到的峰值、降采样频谱，以及分段统计。',
    full: '本包为完整档：除标准档内容外，还包含整段飞行的时间序列包络（timeSeries）。每条通道的值按时间顺序排列，每 3 个数字为一桶：[最小值, 平均值, 最大值]；everySamples 表示每个桶覆盖多少个原始采样点。',
  }[level] || '';

  const hints = [];
  if (pack?.segments?.rows) hints.push('段号从 0 开始按时间排列，用 t 字段对齐秒数。');
  if (pack?.timeSeries) hints.push('时间序列是包络而非逐点原始值，不要从它推断单点精确数值；精确数值看 channelStats 与 axes。');
  if (pack?.spectra) hints.push('spectra 是滤波后陀螺 PSD（dB），用于判断滤波链与残留峰。');

  return [
    '这是本次黑匣子日志的完整分析包与飞控当前配置。请复核并给出修改建议。',
    shape,
    ...hints,
    '',
    '```json',
    JSON.stringify(pack),
    '```',
    '',
    '请严格按 system 指定的 JSON 格式回答。',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildMessages(pack) {
  return [
    { role: 'system', content: AI_SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(pack) },
  ];
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * One OpenAI-compatible chat completion.
 *
 * `fetchImpl` is injectable so the whole path is unit-testable without network.
 */
export async function callChatCompletions({ config, messages, fetchImpl = globalThis.fetch } = {}) {
  const cfg = { ...DEFAULT_AI_CONFIG, ...config };
  if (!cfg.baseUrl) throw new Error('AI 服务未配置 baseUrl / no base URL configured');
  if (!cfg.model) throw new Error('AI 服务未配置模型名 / no model configured');
  if (!cfg.apiKey) throw new Error('AI 服务未配置 API key / no API key configured');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境没有 fetch / fetch unavailable');

  const url = `${cfg.baseUrl}/chat/completions`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Number(cfg.timeoutMs) || DEFAULT_AI_CONFIG.timeoutMs) : null;

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : DEFAULT_AI_CONFIG.temperature,
        max_tokens: Number(cfg.maxTokens) || DEFAULT_AI_CONFIG.maxTokens,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });

    if (!res || typeof res.ok !== 'boolean') throw new Error('AI 服务返回了无效响应 / invalid response');
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`AI 服务返回 ${res.status}：${body.slice(0, 300)}`);
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('AI 返回内容为空 / empty completion');
    return {
      text,
      usage: json?.usage ?? null,
      model: json?.model ?? cfg.model,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeText(res) {
  try {
    return String(await res.text()).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Parsing + screening
 * ------------------------------------------------------------------ */

/**
 * Pull the first JSON object out of a model reply.
 *
 * Models wrap JSON in ```json fences or add a sentence before it often enough
 * that a bare `JSON.parse` is not good enough; this walks braces instead.
 */
export function extractJsonObject(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(src);
  const body = fenced ? fenced[1] : src;

  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function str(v, max = 1200) {
  return typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max);
}

/**
 * Clamp a model-proposed diff to the SAME step budget the rule engine obeys.
 *
 * The whitelist screens a parameter *name*, not a magnitude: `dterm_lpf1_static_hz`
 * is a perfectly legal parameter, and `82 -> 200` is a perfectly illegal jump -
 * a 46 % filter step is what desynced a quad on the next flight (btfl_003.bbl).
 * Nothing the model returns may exceed these limits, so anything larger is
 * clamped down and flagged rather than passed through.
 *
 * @returns {{diff: object[], clamped: string[], rejected: string[]}}
 */
export function enforceStepLimits(diff = []) {
  const out = [];
  const clamped = [];
  const rejected = [];

  for (const d of diff) {
    const param = String(d.param);
    const rawFrom = d.from;
    const rawTo = d.to;

    // `Number(null) === 0`, so a missing bound would silently become "0 -> X"
    // and pass every check below. Same trap that made an unknown d_min read as
    // "disabled"; check the raw values before coercing.
    const missing = (v) => v === null || v === undefined || v === '';
    if (missing(rawFrom) || missing(rawTo)) {
      rejected.push(`${param}（缺少可比较的 from/to，无法校验步长）`);
      continue;
    }

    const from = Number(rawFrom);
    const to = Number(rawTo);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      rejected.push(`${param}（from/to 不是数字，无法校验步长）`);
      continue;
    }
    if (from === to) continue;

    /** Absolute-unit budgets: D-family moves in whole units. */
    const ABS_LIMIT = {
      '^[dD]_(roll|pitch|yaw)$': STEP_LIMITS.D_ABS,
      '^d_min_(roll|pitch|yaw)$': STEP_LIMITS.D_ABS,
      '^d_max_(roll|pitch|yaw)$': STEP_LIMITS.D_ABS,
      '^tpa_breakpoint$': 50,
    };
    /** Relative budgets, mirroring the rule engine's own step helpers. */
    const PCT_LIMIT = {
      '^[pP]_(roll|pitch|yaw)$': STEP_LIMITS.P_PCT,
      '^[iI]_(roll|pitch|yaw)$': STEP_LIMITS.I_PCT,
      '^[fF]_(roll|pitch|yaw)$': STEP_LIMITS.FF_PCT,
      '^(gyro|dterm)_lpf[12]_(static|dyn_min|dyn_max)_hz$': STEP_LIMITS.FILTER_PCT,
      '^(gyro|dterm)_notch_(hz|cutoff)$': STEP_LIMITS.FILTER_PCT,
      '^gyro_notch[12]_(hz|cutoff)$': STEP_LIMITS.FILTER_PCT,
      '^(dyn_notch_(min_hz|max_hz|q)|rpm_filter_(min_hz|q))$': STEP_LIMITS.FILTER_PCT,
      '^(iterm_relax_cutoff|anti_gravity_gain|tpa_rate)$': STEP_LIMITS.FILTER_PCT,
    };

    const absKey = Object.keys(ABS_LIMIT).find((re) => new RegExp(re).test(param));
    const pctKey = absKey ? null : Object.keys(PCT_LIMIT).find((re) => new RegExp(re).test(param));

    if (!absKey && !pctKey) {
      // Discrete / categorical knobs (harmonics, counts, mode) carry no step
      // budget here; they are single-step changes by nature and stay as-is.
      out.push({ param, from, to, deltaPct: d.deltaPct ?? null });
      continue;
    }

    let allowed;
    if (absKey) {
      allowed = ABS_LIMIT[absKey];
    } else {
      const pct = PCT_LIMIT[pctKey];
      allowed = Math.max(1, Math.round(Math.abs(from) * pct));
      if (Math.abs(from) < 5 && pct > 0) allowed = Math.max(allowed, 1);
    }

    const delta = to - from;
    if (Math.abs(delta) <= allowed) {
      out.push({ param, from, to, deltaPct: d.deltaPct ?? null });
      continue;
    }
    const limited = from + Math.sign(delta) * allowed;
    const rounded = Number.isInteger(from) && Number.isInteger(to) ? Math.round(limited) : Number(limited.toFixed(2));
    clamped.push(`${param}: ${from} → ${to} 超出保守步长上限（${allowed}），已收敛为 ${from} → ${rounded}`);
    out.push({ param, from, to: rounded, deltaPct: d.deltaPct ?? null, clampedFrom: to });
  }

  return { diff: out, clamped, rejected };
}

/**
 * Turn a model reply into TuneProposal-shaped objects.
 *
 * Every param the model names is re-screened here. The model is not trusted to
 * respect the whitelist, and a blocked param must still be *visible* rather
 * than silently dropped - an operator needs to know the model tried.
 */
export function screenAiSuggestions(parsed, { idPrefix = 'ai', evidenceMissing = null } = {}) {
  // Third screen (evidence): a log without high-throttle coverage cannot
  // justify loosening any filter, however the model words it.
  const noOpening = Array.isArray(evidenceMissing) && evidenceMissing.includes('noiseOpen');
  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const proposals = [];

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (!s || typeof s !== 'object') continue;

    const rawDiff = Array.isArray(s.diff)
      ? s.diff
          .filter((d) => d && typeof d.param === 'string')
          .map((d) => ({ param: String(d.param), from: d.from ?? null, to: d.to ?? null, deltaPct: d.deltaPct ?? null }))
      : [];

    const { allowed, blocked } = filterDiff(rawDiff);
    const blockedParams = blocked.map((b) => (FORBIDDEN_PARAMS.some((f) => String(b.param) === f || String(b.param).startsWith(f)) ? `${b.param}(禁止/forbidden)` : `${b.param}(不在白名单/not tunable)`));

    // Second screen: the whitelist checked the *names*, this checks the
    // *magnitudes* against the same conservative step budget the rules use.
    const { diff: stepped, clamped, rejected } = enforceStepLimits(allowed);
    const evidenceBlocked = noOpening ? stepped.filter((d) => opensFilter([d])) : [];
    const bounded = evidenceBlocked.length ? stepped.filter((d) => !evidenceBlocked.includes(d)) : stepped;

    // Prefer the model's own CLI, but re-derive it from the screened diff so a
    // blocked, clamped or hallucinated line can never reach the copy button.
    const cli = bounded.length ? bounded.map((d) => `set ${d.param} = ${d.to}`) : [];

    const notes = [];
    if (blockedParams.length) notes.push(`模型建议了不可写参数，已拦截：${blockedParams.join(', ')}`);
    if (clamped.length) notes.push(`超出保守步长，已收敛：${clamped.join('；')}`);
    if (rejected.length) notes.push(`无法校验步长，已丢弃：${rejected.join('；')}`);
    if (evidenceBlocked.length) {
      notes.push(`日志缺少高油门数据，放宽滤波已拦截：${evidenceBlocked.map((d) => `${d.param} ${d.from}→${d.to}`).join('；')}`);
    }

    proposals.push({
      id: `${idPrefix}-${i + 1}`,
      problem: str(s.problem) || '（模型未给出问题描述）',
      evidence: str(s.evidence),
      cli,
      why: str(s.why),
      verification: str(s.verification),
      ifNotApplied: str(s.ifNotApplied),
      confidence: Number.isFinite(Number(s.confidence)) ? Math.max(0, Math.min(1, Number(s.confidence))) : 0.5,
      category: 'pid',
      // Advisory by construction: the operator applies rule-engine proposals
      // through the audited two-phase flow, and copies the screened CLI from
      // here only after reading it.
      safeToApply: false,
      blockedBy: notes,
      diff: bounded,
      blockedDiff: blocked,
      source: 'ai',
    });
  }

  return {
    verdict: str(parsed?.verdict, 800),
    notes: str(parsed?.notes, 1200),
    confidence: Number.isFinite(Number(parsed?.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : null,
    proposals,
  };
}

/** Full path: pack -> messages -> completion -> parsed -> screened. */
export async function runAiAnalysis({ config, pack, fetchImpl } = {}) {
  const messages = buildMessages(pack);
  const completion = await callChatCompletions({ config, messages, fetchImpl });
  const parsed = extractJsonObject(completion.text);
  if (!parsed) {
    return {
      ok: false,
      error: 'AI 返回的不是可解析的 JSON，已保留原文 / reply was not JSON',
      raw: completion.text.slice(0, 4000),
      usage: completion.usage,
      model: completion.model,
    };
  }
  const screened = screenAiSuggestions(parsed, { evidenceMissing: pack?.log?.evidenceMissing ?? null });
  return {
    ok: true,
    model: completion.model,
    usage: completion.usage,
    verdict: screened.verdict,
    notes: screened.notes,
    confidence: screened.confidence,
    proposals: screened.proposals,
    raw: completion.text.slice(0, 4000),
  };
}

/** Guard used by tests and the IPC layer: keep the whitelist honest. */
export { isTunableParam, filterDiff };

export default {
  DEFAULT_AI_CONFIG,
  PACK_LEVELS,
  packLevel,
  publicAiConfig,
  mergeAiConfig,
  buildEvidencePack,
  buildTimeSeries,
  timeSeriesChannelsFor,
  decimateEnvelope,
  listChannels,
  packSizeChars,
  trimPackToBudget,
  buildMessages,
  buildUserPrompt,
  AI_SYSTEM_PROMPT,
  callChatCompletions,
  extractJsonObject,
  enforceStepLimits,
  screenAiSuggestions,
  runAiAnalysis,
};
