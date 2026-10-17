/**
 * Time- and frequency-domain metrics for a decoded blackbox log.
 *
 * Every number in the returned MetricsReport is derived from the log itself;
 * nothing is invented. When a required channel is missing the corresponding
 * metric is reported as 0 (or omitted, for optional contract fields) and a
 * warning plus, where it matters, a Fault explains why.
 *
 * Documented method choices
 *   - gyro units: blackbox logs gyro in deg/s; when the header carries
 *     `gyro_scale` (an IEEE-754 float in hex, normally 0x3f800000 = 1.0) the
 *     column is multiplied by it. Without that header the values are used
 *     as-is and a warning is added.
 *   - tracking (setpoint -> gyro) uses the H1 estimator on a Welch
 *     cross-spectrum: gain = |Sxy| / Sxx, phase = arg(Sxy), coherence =
 *     |Sxy|^2 / (Sxx * Syy), each averaged over 10-100 Hz with the setpoint's
 *     own power as the weight (phase through a circular mean).
 *   - propwashIndex is the fraction of the *descending-throttle* signal power
 *     that sits in the 20-100 Hz band:
 *       bandPower(20..100) / bandPower(10..Nyquist), clamped to 0..1.
 *     Descending segments are found on the throttle channel (a fall of more
 *     than 15 % of the observed throttle span inside a 50 ms window).
 *   - motorNoisePeakHz is the strongest gyro bin at or above 150 Hz, but only
 *     when it stands at least 4x above the median bin power, otherwise 0.
 *   - The eRPM columns are the blackbox encoding (eRPM / 100). RPM harmonic
 *     matching converts them to true electrical RPM (x100) and reports
 *     rpmMin/rpmMax as *mechanical* RPM (eRPM / pole pairs), which is what the
 *     field names mean.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { bandPower, findPeaks, matchRpmHarmonics, noiseFloorDbfs, welchCross, welchPsd } from './bbl-fft.js';
import { readCraftSettings } from './header-settings.js';
import { recommendAxis } from './transfer-tune.js';

/** Betaflight logs `eRPM[n]` as electrical RPM / 100 (upstream viewer: rpm = value * 200 / motor_poles). */
const BLACKBOX_ERPM_SCALE = 100;

/** Nominal Betaflight gyro full scale, in deg/s, used by the clipping detector. */
const GYRO_FULL_SCALE_DPS = 2000;

/** A log shorter than this cannot support a tuning decision. */
const MIN_USABLE_DURATION_S = 20;

/** Drop rate above which the log is considered unreliable. */
const MAX_DROP_RATE_PCT = 2;

/** Sample-rate tolerance against the expected 2 kHz logging rate. */
const EXPECTED_SAMPLE_RATE_HZ = 2000;
const SAMPLE_RATE_TOLERANCE = 0.1;

/** Fault codes whose presence must block PID tuning (contract). */
// A short log weakens the statistics but must not block advice - the operator
// decides how much flying is enough.
// GYRO_ABSENT belongs here: with no gyro channel there is nothing to analyse,
// so any advice would be invented. Duration deliberately does NOT block.
const BLOCKING_FAULTS = new Set([
  'MOTOR_DESYNC',
  'SEVERE_VIBRATION',
  'GYRO_CLIPPING',
  'LOG_TRUNCATED',
  'GYRO_ABSENT',
]);

/* ------------------------------------------------------------------ *
 * Small numeric helpers
 * ------------------------------------------------------------------ */

function toFloat(data, scale = 1) {
  if (!Array.isArray(data) && !ArrayBuffer.isView(data)) return null;
  if (!data.length) return null;
  const out = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = Number(data[i]);
    out[i] = Number.isFinite(v) ? v * scale : 0;
  }
  return out;
}

function rms(values) {
  if (!values || !values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / values.length);
}

function peakAbs(values) {
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function mean(values, start = 0, end = values.length) {
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += values[i];
  return sum / (end - start);
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[idx];
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return 0;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** `0x3f800000` -> 1.0. Mirrors how the firmware stores the gyro scale. */
const FLOAT_SCRATCH = new DataView(new ArrayBuffer(4));
function parseHexFloat(text) {
  if (text === undefined || text === null) return null;
  const m = /^0x([0-9a-fA-F]{8})$/.exec(String(text).trim());
  if (m) {
    FLOAT_SCRATCH.setUint32(0, Number.parseInt(m[1], 16), true);
    const value = FLOAT_SCRATCH.getFloat32(0, true);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read a channel, accepting both the flat contract key and the grouped alias. */
function readChannel(log, group, index = null) {
  const channels = log && log.channels;
  if (!channels) return null;
  if (index === null) {
    const flat = channels[group];
    if (Array.isArray(flat) && flat.length) return flat;
    return null;
  }
  const flat = channels[`${group}[${index}]`];
  if (Array.isArray(flat) && flat.length) return flat;
  const grouped = channels[group];
  if (Array.isArray(grouped) && Array.isArray(grouped[index]) && grouped[index].length) return grouped[index];
  return null;
}

/** Measured frame rate from the time column (median inter-frame interval). */
function measuredSampleRateHz(timeUs) {
  if (!Array.isArray(timeUs) || timeUs.length < 8) return 0;
  const deltas = [];
  for (let i = 1; i < timeUs.length; i++) {
    const d = timeUs[i] - timeUs[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return 0;
  const med = percentile(deltas, 0.5);
  return med > 0 ? 1e6 / med : 0;
}

/* ------------------------------------------------------------------ *
 * Propwash — descending-throttle segments
 * ------------------------------------------------------------------ */

/**
 * Find descending-throttle windows: the throttle falls by more than
 * `dropFraction` of its observed span inside a `windowS` window. Adjacent
 * flagged samples are merged into one event.
 *
 * @param {ArrayLike<number>} throttle
 * @param {number} sampleRateHz
 * @param {{windowS?: number, dropFraction?: number, minDurationS?: number}} [options]
 * @returns {{start: number, end: number}[]} half-open sample ranges
 */
export function detectDescentSegments(throttle, sampleRateHz, { windowS = 0.05, dropFraction = 0.15, minDurationS = 0.1 } = {}) {
  const values = toFloat(throttle);
  if (!values || values.length < 8 || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return [];
  const span = percentile(values, 0.95) - percentile(values, 0.05);
  if (!(span > 0)) return [];
  const window = Math.max(2, Math.round(windowS * sampleRateHz));
  const minLength = Math.max(4, Math.round(minDurationS * sampleRateHz));
  const threshold = dropFraction * span;

  const segments = [];
  let start = -1;
  for (let i = window; i < values.length; i++) {
    const descending = values[i - window] - values[i] >= threshold;
    if (descending && start < 0) start = i - window;
    if (!descending && start >= 0) {
      if (i - start >= minLength) segments.push({ start, end: i });
      start = -1;
    }
  }
  if (start >= 0 && values.length - start >= minLength) segments.push({ start, end: values.length });
  return segments;
}

/**
 * Propwash index measured only on descending-throttle segments.
 * @returns {{index: number, events: number, usableSegments: number, bandPower: number, totalPower: number}}
 */
function propwashFromSegments(gyro, throttle, sampleRateHz) {
  const result = { index: 0, events: 0, usableSegments: 0, bandPower: 0, totalPower: 0 };
  if (!gyro || !throttle || !sampleRateHz) return result;
  const segments = detectDescentSegments(throttle, sampleRateHz);
  result.events = segments.length;
  if (!segments.length) return result;

  const nyquist = sampleRateHz / 2;
  const high = Math.max(120, Math.min(nyquist, 1000));
  const length = Math.min(gyro.length, throttle.length);
  const usable = segments
    .map((segment) => ({ start: segment.start, end: Math.min(segment.end, length) }))
    .filter((segment) => segment.end - segment.start >= 16);
  if (!usable.length) return result;

  // One common segment size keeps every segment on the same frequency grid.
  const shortest = Math.min(...usable.map((segment) => segment.end - segment.start));
  const commonSize = Math.max(16, Math.min(256, 2 ** Math.floor(Math.log2(shortest))));

  const spectra = [];
  for (const segment of usable) {
    const slice = gyro.slice(segment.start, segment.end);
    const spectrum = welchPsd(slice, sampleRateHz, { segmentSize: commonSize });
    if (!spectrum.psd.length) continue;
    spectra.push({ spectrum, weight: slice.length });
  }
  if (!spectra.length) return result;

  const reference = spectra[0].spectrum;
  const bins = reference.freqs.length;
  const acc = new Float64Array(bins);
  let totalWeight = 0;
  for (const { spectrum, weight } of spectra) {
    if (spectrum.freqs.length !== bins) continue;
    for (let k = 0; k < bins; k++) acc[k] += spectrum.psd[k] * weight;
    totalWeight += weight;
    result.usableSegments++;
  }
  if (!totalWeight) return result;

  const averaged = {
    freqs: reference.freqs,
    psd: Array.from(acc, (value) => value / totalWeight),
    binHz: reference.binHz,
    segments: result.usableSegments,
  };

  result.bandPower = bandPower(averaged, 20, 100);
  result.totalPower = bandPower(averaged, 10, high);
  result.index = result.totalPower > 0 ? clamp01(result.bandPower / result.totalPower) : 0;

  // The absolute band fraction above is diluted by however noisy the craft is:
  // motor noise inflates the denominator, so a loud-but-propwash-afflicted quad
  // scores LOWER than a quiet one. Propwash is therefore judged RELATIVELY -
  // how much more the 20-100 Hz band dominates during descents than in level
  // flight. That is scale-free and is what a tuner reads off the spectrogram.
  const levelSegments = complementSegments(segments, length, sampleRateHz);
  const levelAveraged = averageSpectra(gyro, levelSegments, sampleRateHz, commonSize);
  if (levelAveraged) {
    const levelBand = bandPower(levelAveraged, 20, 100);
    const levelTotal = bandPower(levelAveraged, 10, high);
    const levelFraction = levelTotal > 0 ? levelBand / levelTotal : 0;
    const descentFraction = result.index;
    result.levelFraction = levelFraction;
    result.levelSegments = levelSegments.length;
    // > 1 means descents are more low-frequency-noisy than level flight.
    result.score = levelFraction > 1e-6 ? descentFraction / levelFraction : 1;
  } else {
    result.score = 1;
    result.levelFraction = null;
    result.levelSegments = 0;
  }
  return result;
}

/** The gaps between the descent segments: level / cruise flight. */
function complementSegments(segments, length, sampleRateHz) {
  const minSamples = Math.max(16, Math.round(0.15 * sampleRateHz));
  const out = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.start - cursor >= minSamples) out.push({ start: cursor, end: segment.start });
    cursor = Math.max(cursor, segment.end);
  }
  if (length - cursor >= minSamples) out.push({ start: cursor, end: length });
  return out;
}

/** Weighted average spectrum over a set of segments, or null when too short. */
function averageSpectra(gyro, segments, sampleRateHz, segmentSize) {
  if (!segments.length) return null;
  const spectra = [];
  for (const segment of segments) {
    const slice = gyro.slice(segment.start, segment.end);
    if (slice.length < 16) continue;
    const size = Math.max(16, Math.min(segmentSize, 2 ** Math.floor(Math.log2(slice.length))));
    const spectrum = welchPsd(slice, sampleRateHz, { segmentSize: size });
    if (spectrum.psd.length) spectra.push({ spectrum, weight: slice.length });
  }
  if (!spectra.length) return null;

  const reference = spectra[0].spectrum;
  const bins = reference.freqs.length;
  const acc = new Float64Array(bins);
  let totalWeight = 0;
  for (const { spectrum, weight } of spectra) {
    if (spectrum.freqs.length !== bins) continue;
    for (let k = 0; k < bins; k++) acc[k] += spectrum.psd[k] * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return null;
  return { freqs: reference.freqs, psd: Array.from(acc, (v) => v / totalWeight), binHz: reference.binHz };
}

/* ------------------------------------------------------------------ *
 * Step response
 * ------------------------------------------------------------------ */

/**
 * Setpoint -> gyro step response.
 *
 * Steps are the samples where the setpoint moves by more than
 * `max(4 x median|diff|, 10 % of the setpoint span)` in one frame, is quiet
 * (>pre-window range <= 25 % of the step) and holds its new level across the
 * second half of the response window. Requiring an isolated stick input keeps a
 * continuously sweeping signal (a chirp log) from being averaged as if it were
 * a series of steps. Every accepted step is aligned on the first sample of the
 * new level, normalised by the step amplitude (a perfect response settles at
 * 1.0) and averaged.
 *
 * `latencyMs` is the delay from the step to the 10 % crossing, `riseTimeMs`
 * the 10 % -> 90 % time, `settlingTimeMs` the last excursion outside +-2 % of
 * the final value, `steadyStateErrorPct` the residual |1 - final|.
 *
 * Fewer than 3 clean steps => `samples` holds the real count and every derived
 * number stays 0 rather than being invented.
 *
 * @returns {import('../../shared/contracts.js').StepResponse}
 */
export function estimateStepResponse(setpoint, gyro, sampleRateHz, { minSteps = 3, windowS = 0.3, preS = 0.02, maxSteps = 200 } = {}) {
  const empty = { overshootPct: 0, riseTimeMs: 0, settlingTimeMs: 0, steadyStateErrorPct: 0, latencyMs: 0, samples: 0 };
  const sp = toFloat(setpoint);
  const gy = toFloat(gyro);
  if (!sp || !gy || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return empty;
  const n = Math.min(sp.length, gy.length);
  if (n < 16) return empty;

  const diffs = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) diffs[i] = sp[i + 1] - sp[i];
  const absDiffs = Array.from(diffs, Math.abs);
  const medianDiff = percentile(absDiffs, 0.5);
  const span = percentile(sp, 0.95) - percentile(sp, 0.05);
  const threshold = Math.max(4 * medianDiff, 0.1 * span);
  if (!(threshold > 0)) return empty;

  // Collect candidate step indices, keeping only the largest jump in a cluster
  // so a single transition is not counted several frames in a row.
  const candidates = [];
  let i = 0;
  while (i < diffs.length) {
    if (Math.abs(diffs[i]) >= threshold) {
      let best = i;
      let j = i;
      while (j + 1 < diffs.length && Math.abs(diffs[j + 1]) >= threshold * 0.5) {
        j++;
        if (Math.abs(diffs[j]) > Math.abs(diffs[best])) best = j;
      }
      candidates.push(best);
      i = j + 1;
    } else {
      i++;
    }
  }
  if (!candidates.length) return empty;

  const pre = Math.max(1, Math.round(preS * sampleRateHz));
  const post = Math.max(pre + 4, Math.round(windowS * sampleRateHz));
  const isolation = Math.min(post, Math.max(4, Math.round(0.1 * sampleRateHz)));
  const stride = Math.max(1, Math.ceil(candidates.length / maxSteps));

  const accumulator = new Float64Array(pre + post + 1);
  const counts = new Int32Array(pre + post + 1);
  let used = 0;

  for (let c = 0; c < candidates.length; c += stride) {
    const stepIndex = candidates[c];
    const amplitude = diffs[stepIndex];
    if (!Number.isFinite(amplitude) || Math.abs(amplitude) < 1e-9) continue;
    const onset = stepIndex + 1;
    if (onset - pre < 0 || onset + post >= n) continue;

    // Isolated input: no other transition inside the response window.
    const next = candidates[c + 1];
    if (next !== undefined && next - stepIndex < isolation) continue;

    // Quiet before the transition ...
    let preMin = Infinity;
    let preMax = -Infinity;
    for (let k = onset - pre; k < onset; k++) {
      if (sp[k] < preMin) preMin = sp[k];
      if (sp[k] > preMax) preMax = sp[k];
    }
    if (preMax - preMin > 0.25 * Math.abs(amplitude)) continue;

    // ... and flat afterwards (the command holds its new level).
    const holdStart = onset + Math.floor(post * 0.5);
    let holdMin = Infinity;
    let holdMax = -Infinity;
    for (let k = holdStart; k <= onset + post; k++) {
      if (sp[k] < holdMin) holdMin = sp[k];
      if (sp[k] > holdMax) holdMax = sp[k];
    }
    if (holdMax - holdMin > 0.25 * Math.abs(amplitude)) continue;

    let base = 0;
    for (let k = onset - pre; k < onset; k++) base += gy[k];
    base /= pre;

    for (let k = onset - pre; k <= onset + post; k++) {
      const local = k - (onset - pre);
      accumulator[local] += (gy[k] - base) / amplitude;
      counts[local]++;
    }
    used++;
  }
  if (used === 0) return { ...empty, samples: 0 };
  // Fewer clean steps than `minSteps`: keep the honest count, invent nothing.
  if (used < minSteps) return { ...empty, samples: used };

  const response = new Float64Array(accumulator.length);
  for (let k = 0; k < accumulator.length; k++) response[k] = counts[k] ? accumulator[k] / counts[k] : 0;

  const tailStart = Math.max(pre, Math.floor(response.length * 0.8));
  const final = mean(response, tailStart, response.length);
  const result = { ...empty, samples: used };
  if (!(Math.abs(final) > 0.01)) return result;

  let peak = -Infinity;
  for (let k = pre; k < response.length; k++) peak = Math.max(peak, response[k]);
  result.overshootPct = round(Math.max(0, ((peak - final) / Math.abs(final)) * 100));

  const cross10 = (() => {
    for (let k = pre; k < response.length; k++) if (response[k] >= 0.1 * final) return k;
    return -1;
  })();
  if (cross10 < 0) return result;

  let cross90 = -1;
  const target90 = 0.9 * final;
  for (let k = cross10; k < response.length; k++) {
    if (final > 0 ? response[k] >= target90 : response[k] <= target90) {
      cross90 = k;
      break;
    }
  }

  result.latencyMs = round(((cross10 - pre) / sampleRateHz) * 1000);
  if (cross90 >= 0) result.riseTimeMs = round(((cross90 - cross10) / sampleRateHz) * 1000);

  let settled = -1;
  const tolerance = 0.02 * Math.abs(final);
  for (let k = response.length - 1; k >= pre; k--) {
    if (Math.abs(response[k] - final) > tolerance) {
      settled = k;
      break;
    }
  }
  result.settlingTimeMs = settled >= 0 ? round(((settled - pre) / sampleRateHz) * 1000) : 0;
  result.steadyStateErrorPct = round(Math.abs(1 - final) * 100);
  return result;
}

/* ------------------------------------------------------------------ *
 * Tracking (setpoint vs gyro)
 * ------------------------------------------------------------------ */

/**
 * Coherence-weighted setpoint -> gyro tracking over `lowHz..highHz`.
 * H1 gain estimator on a Welch cross-spectrum (see the module header).
 *
 * @returns {{gainDb: number, coherence: number, phaseDeg: number, bins: number}}
 */
export function trackingMetrics(setpoint, gyro, sampleRateHz, { lowHz = 10, highHz = 100, segmentSize = 512 } = {}) {
  const result = { gainDb: 0, coherence: 0, phaseDeg: 0, bins: 0 };
  const sp = toFloat(setpoint);
  const gy = toFloat(gyro);
  if (!sp || !gy || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return result;
  const length = Math.min(sp.length, gy.length);
  if (length < 32) return result;

  const cross = welchCross(sp.subarray(0, length), gy.subarray(0, length), sampleRateHz, { segmentSize });
  if (!cross.freqs.length) return result;

  let weight = 0;
  let gainWeighted = 0;
  let coherenceWeighted = 0;
  let phaseRe = 0;
  let phaseIm = 0;

  for (let k = 0; k < cross.freqs.length; k++) {
    const f = cross.freqs[k];
    if (f < lowHz || f > highHz) continue;
    const sxx = cross.sxx[k];
    if (!(sxx > 0)) continue;
    const magnitude = Math.hypot(cross.sxyRe[k], cross.sxyIm[k]);
    const gain = magnitude / sxx;
    if (!Number.isFinite(gain) || gain <= 0) continue;
    const phase = Math.atan2(cross.sxyIm[k], cross.sxyRe[k]);
    weight += sxx;
    gainWeighted += sxx * gain;
    coherenceWeighted += sxx * cross.coherence[k];
    phaseRe += sxx * Math.cos(phase);
    phaseIm += sxx * Math.sin(phase);
    result.bins++;
  }

  if (!weight) return result;
  result.gainDb = round(20 * Math.log10(gainWeighted / weight));
  result.coherence = round(clamp01(coherenceWeighted / weight));
  result.phaseDeg = round((Math.atan2(phaseIm, phaseRe) * 180) / Math.PI, 1);
  return result;
}

/* ------------------------------------------------------------------ *
 * I-term windup
 * ------------------------------------------------------------------ */

/**
 * I-term windup score, 0..1:
 *   fraction of samples where |axisI| >= 60 % of its own p99 magnitude while
 *   the tracking error |setpoint - gyro| <= 20 % of the p95 |setpoint|.
 * A healthy integrator only holds a large value while it is still working
 * against an error; a wound-up one keeps it after the error is gone.
 */
export function iTermWindupScore(iterm, setpoint, gyro) {
  const iTerm = toFloat(iterm);
  const sp = toFloat(setpoint);
  const gy = toFloat(gyro);
  if (!iTerm || !iTerm.length) return 0;
  const length = Math.min(iTerm.length, sp ? sp.length : 0, gy ? gy.length : 0);
  if (!length) return 0;

  const absI = Array.from(iTerm.subarray(0, length), Math.abs);
  const iReference = percentile(absI, 0.99);
  if (!(iReference > 0)) return 0;

  const absError = new Float64Array(length);
  const absSetpoint = new Float64Array(length);
  for (let k = 0; k < length; k++) {
    absError[k] = Math.abs(sp[k] - gy[k]);
    absSetpoint[k] = Math.abs(sp[k]);
  }
  const errorReference = Math.max(1e-6, percentile(absSetpoint, 0.95) * 0.2);
  const iThreshold = 0.6 * iReference;

  let hits = 0;
  for (let k = 0; k < length; k++) {
    if (absI[k] >= iThreshold && absError[k] <= errorReference) hits++;
  }
  return round(clamp01(hits / length));
}

/* ------------------------------------------------------------------ *
 * PID error x stick deflection (PIDtoolbox-style)
 * ------------------------------------------------------------------ */

/**
 * Mean |setpoint - gyro| bucketed by |setpoint| as a fraction of its own p95
 * (the metric PIDtoolbox plots as "PID error x % stick deflection").
 *
 * A healthy loop keeps the error roughly flat across deflection. A strongly
 * rising slope means the loop runs out of authority exactly at large inputs
 * (too little P / motor headroom); a flat but large error at every deflection
 * is latency instead (feedforward / filtering), which P cannot fix.
 *
 * @returns {{means:number[], slopeRatio:number, samples:number}}
 *   `means` has one entry per bucket (0 for empty buckets), `slopeRatio` is
 *   the last non-empty bucket's mean over the first's (0 when not measurable).
 */
export function pidErrorByDeflection(setpoint, gyro, { buckets = 5 } = {}) {
  const empty = { means: [], slopeRatio: 0, samples: 0 };
  const sp = toFloat(setpoint);
  const gy = toFloat(gyro);
  if (!sp || !gy) return empty;
  const n = Math.min(sp.length, gy.length);
  if (n < 32) return empty;

  const absSp = new Float64Array(n);
  for (let k = 0; k < n; k++) absSp[k] = Math.abs(sp[k]);
  const reference = percentile(absSp, 0.95);
  if (!(reference > 0)) return empty;

  const sums = new Float64Array(buckets);
  const counts = new Int32Array(buckets);
  for (let k = 0; k < n; k++) {
    const b = Math.min(buckets - 1, Math.floor((absSp[k] / reference) * buckets));
    sums[b] += Math.abs(sp[k] - gy[k]);
    counts[b]++;
  }

  const means = [];
  let first = 0;
  let last = 0;
  let samples = 0;
  for (let b = 0; b < buckets; b++) {
    const mean = counts[b] ? sums[b] / counts[b] : 0;
    means.push(round(mean));
    if (counts[b]) {
      if (!first) first = mean;
      last = mean;
      samples += counts[b];
    }
  }
  const slopeRatio = first > 0 ? round(last / first, 2) : 0;
  return { means, slopeRatio, samples };
}

/* ------------------------------------------------------------------ *
 * Motor helpers
 * ------------------------------------------------------------------ */

function motorChannels(log) {
  const motors = [];
  for (let i = 0; i < 8; i++) {
    const channel = readChannel(log, 'motor', i);
    if (channel) motors.push(channel);
  }
  return motors;
}

function erpmChannels(log) {
  const channels = [];
  for (let i = 0; i < 8; i++) {
    const channel = readChannel(log, 'eRPM', i);
    if (channel && channel.length) channels.push(channel);
  }
  return channels;
}

/** Fraction of samples where at least half of the motors sit at the top of their range. */
function motorSaturationPct(motors, motorMaxRef) {
  if (!motors.length) return 0;
  const length = Math.min(...motors.map((m) => m.length));
  if (length <= 0) return 0;
  const threshold = 0.97 * motorMaxRef;
  const needed = Math.ceil(motors.length / 2);
  let saturated = 0;
  for (let k = 0; k < length; k++) {
    let high = 0;
    for (const motor of motors) if (motor[k] >= threshold) high++;
    if (high >= needed) saturated++;
  }
  return round((saturated / length) * 100, 2);
}

/**
 * Motor desync detection.
 *
 * A desync is a *command-feedback mismatch*: the flight controller keeps
 * commanding a motor to spin hard while its eRPM reads near zero for a
 * sustained run. eRPM alone cannot distinguish a stopped motor from one that
 * is legitimately idling, and motor commands alone carry no RPM information -
 * only the two together are sufficient.
 *
 * Two false positives this corrects:
 *
 * 1. A hard roll/yaw legitimately commands the inner motors to minimum while
 *    the outer motors spin to the moon. Comparing eRPM *ratios* therefore
 *    flagged the idling motors as "desynced" on every aggressive manoeuvre:
 *    the fastest motor can hit 200 k eRPM, so "10% of the fastest" is 20 k
 *    eRPM - well above a motor that is correctly idling at ~8 k eRPM. The
 *    fix compares against an *absolute* near-zero floor instead, and only
 *    treats a motor as a dropout while it is still *commanded* to spin.
 *
 * 2. Bidirectional DShot RPM telemetry drops packets during hard braking and
 *    roll reversals, logging 0 eRPM while the command has already been pulled
 *    back to spin the motor down. That is telemetry noise, not a desync. A
 *    near-zero eRPM counts only while the FC is still demanding real throttle.
 *
 * A third signal covers the crash case: two or more motors reading near-zero
 * eRPM *simultaneously* while the quad is still flying. A single motor at zero
 * can be braking or telemetry noise; two motors at zero together means the FC
 * has lost two corners at once and is tumbling - the signature of a real
 * desync-induced crash (btfl_003.bbl), and it fires regardless of the
 * individual commands because the FC is past the point of coherent commands.
 *
 * With no motor command channel, the detector falls back to the absolute
 * eRPM floor only (a motor near zero while another is clearly flying) - the
 * honest but weaker signal. A dropout must also persist for several
 * consecutive samples; one low sample is normal at zero crossings and during
 * motor start/stop.
 */
const DESYNC_MIN_RUN = 5; // samples; 2.5 ms at 2 kHz
const DESYNC_FLYING_ERPM = 5000; // eRPM: at least one motor above this => quad is flying
const DESYNC_ERPM_FLOOR = 2000; // eRPM: a commanded motor below this is "stopped" (idle is ~8k+)
const DESYNC_COMMAND_FRACTION = 0.5; // command above this fraction of its range => "commanded to spin"
const DESYNC_MIN_STOPPED_MOTORS = 2; // motors near zero at once => crash signature

function detectDesync(log, _polePairs) {
    const evidence = { kind: 'none', events: 0, samples: 0, detail: '' };
    const erpm = erpmChannels(log);

    if (erpm.length < 2) {
        evidence.kind = 'unavailable';
        evidence.detail =
            'no eRPM[n] channel is present, so desync cannot be assessed - motor command spread is not evidence of it';
        return evidence;
    }

    const motors = motorChannels(log);
    const hasCommand = motors.length > 0;

    // Observed command range, so "commanded to spin" is decided scale-independently
    // (DShot logs 48..2047, PWM logs 1000..2000).
    let cmdMin = Infinity;
    let cmdMax = -Infinity;
    for (const channel of motors) {
        for (let k = 0; k < channel.length; k++) {
            if (channel[k] < cmdMin) cmdMin = channel[k];
            if (channel[k] > cmdMax) cmdMax = channel[k];
        }
    }
    const spinCommand = cmdMin + DESYNC_COMMAND_FRACTION * (cmdMax - cmdMin);

    const length = Math.min(...erpm.map((c) => c.length));
    let events = 0;
    let firstIndex = -1;
    let run = 0;

    for (let k = 0; k < length; k++) {
        let maxErpm = 0;
        for (const channel of erpm) maxErpm = Math.max(maxErpm, channel[k] * BLACKBOX_ERPM_SCALE);

        if (maxErpm < DESYNC_FLYING_ERPM) {
            run = 0; // motors essentially stopped - not a desync
            continue;
        }

        let dropout = false;
        let stopped = 0;
        for (let m = 0; m < erpm.length; m++) {
            if (erpm[m][k] * BLACKBOX_ERPM_SCALE >= DESYNC_ERPM_FLOOR) continue; // still spinning
            stopped++;
            // This motor reads near-zero eRPM. It is a desync only while the FC
            // is still commanding it to spin; a motor being pulled back to idle
            // during a reversal or braking is supposed to slow down.
            const command = hasCommand && motors[m] ? motors[m][k] : null;
            if (command === null || command >= spinCommand) dropout = true;
        }
        // Two or more motors at zero at once while flying is a crash signature,
        // independent of the per-motor command check above.
        if (stopped >= DESYNC_MIN_STOPPED_MOTORS) dropout = true;

        if (!dropout) {
            run = 0;
            continue;
        }

        run++;
        if (run === DESYNC_MIN_RUN) {
            // Only count once the dropout has proven sustained.
            events++;
            if (firstIndex < 0) firstIndex = k - DESYNC_MIN_RUN + 1;
        } else if (run > DESYNC_MIN_RUN) {
            events++; // keep counting the length of the sustained dropout
        }
    }

    if (events > 0) {
        evidence.kind = 'erpm';
        evidence.events = events;
        evidence.samples = length;
        evidence.detail =
            `${events} consecutive samples (${((events / length) * 100).toFixed(3)}%) hold a motor below ` +
            `${DESYNC_ERPM_FLOOR} eRPM while another motor is above ${DESYNC_FLYING_ERPM} eRPM ` +
            `(sustained command-feedback dropout, or two+ motors at zero together = crash); ` +
            `first run at sample ${firstIndex}`;
    }
    return evidence;
}

/* ------------------------------------------------------------------ *
 * Sample quality
 * ------------------------------------------------------------------ */

/**
 * sampleQuality = 0.5 * dropScore + 0.2 * durationScore + 0.3 * channelScore
 *   dropScore     = clamp(1 - dropRatePct / 5, 0, 1)     (0 % -> 1, >= 5 % -> 0)
 *   durationScore = clamp(durationS / 60, 0, 1)          (>= 60 s -> 1)
 *   channelScore  = presentGroups / 8
 * with the 8 groups mapped to contracts.REQUIRED_BB_FIELDS:
 *   gyroADC, setpoint, axisP (pid), rcCommand (rc), motor, throttle, vbat (batt), eRPM (rpm).
 *
 * A log with no duration or no usable channel scores 0 outright: "no drops"
 * must not read as quality when there is nothing to measure.
 */
export function computeSampleQuality({ dropRatePct = 0, durationS = 0, presentGroups = 0, totalGroups = 8 } = {}) {
  if (!(durationS > 0) || !(presentGroups > 0)) return 0;
  const dropScore = clamp01(1 - Math.max(0, dropRatePct) / 5);
  const durationScore = clamp01(Math.max(0, durationS) / 60);
  const channelScore = totalGroups > 0 ? clamp01(presentGroups / totalGroups) : 0;
  return round(0.5 * dropScore + 0.2 * durationScore + 0.3 * channelScore);
}

/* ------------------------------------------------------------------ *
 * computeMetrics
 * ------------------------------------------------------------------ */

function fault(code, severity, evidence, extra = {}) {
  return {
    code,
    severity,
    evidence,
    blocksTuning: BLOCKING_FAULTS.has(code) || extra.blocksTuning === true,
  };
}

/** Strongest spectral bin at or above `minHz`, if it stands out from the noise. */
/** Band power in dB, or null when the spectrum is unavailable. */
function bandDb(spectrum, lo, hi) {
  if (!spectrum || !Array.isArray(spectrum.psd) || !spectrum.psd.length) return null;
  const p = bandPower(spectrum, lo, hi);
  return p > 0 ? 10 * Math.log10(p) : null;
}

function dominantHighFrequencyPeak(spectrum, minHz = 150, floorFactor = 4) {
  const { freqs, psd } = spectrum || {};
  if (!freqs || !psd || !psd.length) return 0;
  const sorted = Float64Array.from(psd).sort();
  const median = sorted[sorted.length >> 1];
  let bestIndex = -1;
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] < minHz) continue;
    if (bestIndex < 0 || psd[k] > psd[bestIndex]) bestIndex = k;
  }
  if (bestIndex < 0) return 0;
  if (median > 0 && psd[bestIndex] < floorFactor * median) return 0;
  return round(freqs[bestIndex], 1);
}

/**
 * Full metrics report for one decoded log.
 *
 * @param {import('../../shared/contracts.js').DecodedLog} decodedLog
 * @param {{currentPid?: object|null, currentFilter?: object|null, file?: string|null}} [options]
 * @returns {import('../../shared/contracts.js').MetricsReport}
 */
export function computeMetrics(decodedLog, { currentPid = null, currentFilter = null, file = null } = {}) {
  const log = decodedLog || {};
  const header = log.header || {};
  const warnings = Array.isArray(log.warnings) ? [...log.warnings] : [];
  const faults = [];
  if (currentPid || currentFilter) {
    // Accepted for API symmetry with the tuner; the metrics themselves are
    // measured from the log, never from the settings that produced it.
  }

  const sampleRateHz = Number.isFinite(log.sampleRateHz) && log.sampleRateHz > 0 ? log.sampleRateHz : 0;
  const durationS = Number.isFinite(log.durationS) ? log.durationS : 0;
  const dropRatePct = Number.isFinite(log.dropRatePct) ? log.dropRatePct : 0;
  const timeUs = Array.isArray(log.timeUs) ? log.timeUs : [];

  if (!sampleRateHz) warnings.push('sample rate is unknown: spectral metrics and step timing are unavailable');
  if (!timeUs.length) warnings.push('no time column in the log: duration comes from the header only');

  /* ---- gyro scaling ---- */
  const gyroScale = parseHexFloat(header.gyro_scale ?? header['gyro.scale']);
  if (gyroScale === null) {
    warnings.push('gyro_scale header missing: gyroADC values are used as-is (assumed to be deg/s)');
  }

  /* ---- motor / eRPM context ---- */
  const gyroHeaderPoles = Number.parseInt(header.motor_poles, 10);
  const poles = Number.isFinite(gyroHeaderPoles) && gyroHeaderPoles >= 2 ? gyroHeaderPoles : 14;
  const polePairs = poles / 2;

  const motors = motorChannels(log);
  const erpm = erpmChannels(log);
  const motorMaxRef = Number.isFinite(Number(header.maxthrottle)) && Number(header.maxthrottle) > 0
    ? Number(header.maxthrottle)
    : 2000;
  const saturationPct = motorSaturationPct(motors, motorMaxRef);

  const erpmValues = [];
  for (const channel of erpm) {
    for (let k = 0; k < channel.length; k += Math.max(1, Math.floor(channel.length / 500))) {
      const value = channel[k] * BLACKBOX_ERPM_SCALE;
      if (value > 0) erpmValues.push(value);
    }
  }
  const mechanicalRpm = erpmValues.map((v) => v / polePairs);
  const rpmAvailable = erpm.length;
  const rpmMin = mechanicalRpm.length ? round(Math.min(...mechanicalRpm), 0) : 0;
  const rpmMax = mechanicalRpm.length ? round(Math.max(...mechanicalRpm), 0) : 0;

  /* ---- per axis ---- */
  const axisNames = ['roll', 'pitch', 'yaw'];
  const axes = {};

  for (let axis = 0; axis < 3; axis++) {
    const name = axisNames[axis];
    const gyroRaw = readChannel(log, 'gyroADC', axis);
    const gyro = gyroRaw ? toFloat(gyroRaw, gyroScale ?? 1) : null;
    // Betaflight logs the FILTERED gyro as gyroADC and the raw signal as
    // gyroUnfilt. Filter advice has to come from the raw spectrum: judging a
    // low-pass by looking at its own output is circular and always looks clean.
    const gyroUnfiltRaw = readChannel(log, 'gyroUnfilt', axis);
    const gyroUnfilt = gyroUnfiltRaw ? toFloat(gyroUnfiltRaw, gyroScale ?? 1) : null;
    const setpoint = toFloat(readChannel(log, 'setpoint', axis));
    const dTermRaw = readChannel(log, 'axisD', axis);
    const dTerm = toFloat(dTermRaw);
    const iTerm = toFloat(readChannel(log, 'axisI', axis));
    const throttle = toFloat(readChannel(log, 'throttle'));

    if (!gyro) {
      warnings.push(`no gyroADC[${axis}] channel: ${name} metrics are reported as zero`);
      faults.push(
        fault('GYRO_ABSENT', 'warn', `gyroADC[${axis}] is missing from the log header so the ${name} axis could not be analysed`),
      );
    }

    const spectrum = gyro && sampleRateHz ? welchPsd(gyro, sampleRateHz, { segmentSize: 512 }) : { freqs: [], psd: [], binHz: 0, segments: 0 };
    const dSpectrum = dTerm && sampleRateHz
      ? welchPsd(dTerm, sampleRateHz, { segmentSize: 512 })
      : null;
    const peaks = findPeaks(spectrum, { maxPeaks: 5, minProminenceDb: 6, minHz: 20 });

    const rawSpectrum = gyroUnfilt && sampleRateHz
      ? welchPsd(gyroUnfilt, sampleRateHz, { segmentSize: 512 })
      : null;
    const rawPeaks = rawSpectrum ? findPeaks(rawSpectrum, { maxPeaks: 5, minProminenceDb: 6, minHz: 20 }) : [];

    // How much the current filter chain removes in the NOISE band only.
    // The band starts at 200 Hz on purpose: below that the raw gyro is dominated
    // by real aircraft motion and pilot input, which no filter should touch, and
    // including it makes a working filter chain look ineffective.
    const nyquist = sampleRateHz ? sampleRateHz / 2 : 0;
    const noiseBandLo = Math.min(200, nyquist * 0.5);
    const rawBandDb = bandDb(rawSpectrum, noiseBandLo, nyquist);
    const filtBandDb = bandDb(spectrum, noiseBandLo, nyquist);
    const filterAttenuationDb = rawBandDb !== null && filtBandDb !== null ? round(rawBandDb - filtBandDb, 1) : null;

    const propwash = gyro && throttle && sampleRateHz
      ? propwashFromSegments(gyro, throttle, sampleRateHz)
      : { index: 0, events: 0, usableSegments: 0, bandPower: 0, totalPower: 0 };
    if (gyro && !throttle) {
      warnings.push(`no throttle channel: propwash could not be measured for ${name} (reported 0)`);
    } else if (gyro && throttle && sampleRateHz && propwash.events === 0) {
      warnings.push(`no descending-throttle segment found: propwash for ${name} is reported as 0`);
    }

    const step = gyro && setpoint && sampleRateHz
      ? estimateStepResponse(setpoint, gyro, sampleRateHz)
      : { overshootPct: 0, riseTimeMs: 0, settlingTimeMs: 0, steadyStateErrorPct: 0, latencyMs: 0, samples: 0 };
    if (step.samples > 0 && step.samples < 3) {
      warnings.push(`only ${step.samples} clean setpoint step(s) found on ${name}: step metrics are reported as 0`);
    }
    if (!setpoint) warnings.push(`no setpoint[${axis}] channel: step response and tracking are unavailable for ${name}`);

    const tracking = gyro && setpoint && sampleRateHz
      ? trackingMetrics(setpoint, gyro, sampleRateHz)
      : { gainDb: 0, coherence: 0, phaseDeg: 0, bins: 0 };

    const transfer = gyro && setpoint && sampleRateHz
      ? recommendAxis(setpoint, gyro, sampleRateHz)
      : null;
    const transferSummary = transfer
      ? { metrics: transfer.metrics, scales: transfer.scales, coherent: transfer.coherent }
      : null;

    const gyroRms = gyro ? round(rms(gyro)) : 0;
    const dTermRms = dTerm ? round(rms(dTerm)) : 0;

    const axisMetrics = {
      axis: name,
      gyroRms,
      gyroPeak: gyro ? round(peakAbs(gyro)) : 0,
      noiseFloorDbfs: round(noiseFloorDbfs(spectrum), 2),
      gyroSpectrum: spectrum,
      peaks,
      gyroUnfiltRms: gyroUnfilt ? round(rms(gyroUnfilt)) : null,
      gyroUnfiltSpectrum: rawSpectrum,
      rawPeaks,
      filterAttenuationDb,
      motorNoisePeakHz: dominantHighFrequencyPeak(spectrum, 150, 4),
      propwashIndex: round(propwash.index),
      propwashScore: round(propwash.score ?? 1),
      propwashEvents: propwash.usableSegments,
      dTermRms,
      dTermToGyroRatio: gyroRms > 0 ? round(dTermRms / gyroRms) : 0,
      step,
      trackingGainDb: tracking.gainDb,
      trackingCoherence: tracking.coherence,
      trackingPhaseDeg: tracking.phaseDeg,
      iTermWindupScore: iTerm && gyro && setpoint ? iTermWindupScore(iTerm, setpoint, gyro) : 0,
      // PIDtoolbox-style authority check: error growth across stick deflection.
      pidError: gyro && setpoint ? pidErrorByDeflection(setpoint, gyro) : { means: [], slopeRatio: 0, samples: 0 },
      // BetaflightAssistant-style transfer-function recommendation.
      transfer: transferSummary,
    };
    if (dSpectrum) axisMetrics.dTermSpectrum = dSpectrum;
    if (erpm.length && peaks.length && sampleRateHz) {
      const match = matchRpmHarmonics(peaks, erpm, sampleRateHz, {
        maxOrder: 4,
        polePairs,
        tolerancePct: 3,
        erpmScale: BLACKBOX_ERPM_SCALE,
      });
      axisMetrics.rpmHarmonicMatch = round(match.match);
    }
    axes[name] = axisMetrics;

    /* ---- per-axis faults ---- */
    if (gyro) {
      const fullScale = GYRO_FULL_SCALE_DPS * (gyroScale ?? 1);
      const clipLevel = 0.98 * fullScale;
      let clipped = 0;
      let maxAbs = 0;
      for (let k = 0; k < gyro.length; k++) {
        const value = Math.abs(gyro[k]);
        if (value > maxAbs) maxAbs = value;
        if (value >= clipLevel) clipped++;
      }
      const clipFraction = gyro.length ? clipped / gyro.length : 0;
      if (clipFraction >= 0.005) {
        faults.push(
          fault(
            'GYRO_CLIPPING',
            'critical',
            `${name}: ${clipped} of ${gyro.length} samples (${(clipFraction * 100).toFixed(2)}%) sit at or above ` +
              `${clipLevel.toFixed(0)} deg/s (98% of the ${fullScale.toFixed(0)} deg/s full scale); max |gyro| ` +
              `${maxAbs.toFixed(1)} deg/s; threshold 0.5% of samples`,
          ),
        );
      }
    }

    if (spectrum.psd.length && sampleRateHz) {
      const nyquist = sampleRateHz / 2;
      const bandHigh = Math.max(150, nyquist);
      const hfPower = bandPower(spectrum, 300, bandHigh);
      const totalPower = bandPower(spectrum, 20, bandHigh);
      const hfRms = Math.sqrt(Math.max(0, hfPower));
      const hfRatio = totalPower > 0 ? hfPower / totalPower : 0;
      const severe = (hfRatio >= 0.5 && hfRms >= 20) || hfRms >= 60;
      if (severe) {
        faults.push(
          fault(
            'SEVERE_VIBRATION',
            'critical',
            `${name}: 300-${bandHigh.toFixed(0)} Hz gyro noise is ${hfRms.toFixed(1)} deg/s RMS ` +
              `(${(hfRatio * 100).toFixed(1)}% of the 20-${bandHigh.toFixed(0)} Hz energy, noise floor ` +
              `${noiseFloorDbfs(spectrum).toFixed(1)} dB); thresholds are RMS >= 20 deg/s with a >= 50% share, ` +
              `or RMS >= 60 deg/s`,
          ),
        );
      }
    }
  }

  /* ---- report-level faults ---- */
  const desync = detectDesync(log, polePairs);
  if (desync.events > 0) {
    faults.push(fault('MOTOR_DESYNC', 'critical', `eRPM evidence: ${desync.detail}`));
  } else if (desync.kind === 'unavailable') {
    // Informational and NOT blocking: without eRPM there is nothing to judge,
    // and treating that as a fault used to lock tuning on perfectly good logs.
    faults.push(fault('DESYNC_NOT_ASSESSABLE', 'info', desync.detail));
  }

  if (saturationPct > 20) {
    faults.push(
      fault(
        'MOTOR_SATURATION',
        'warn',
        `${saturationPct.toFixed(2)}% of samples have at least half of the motors at or above ` +
          `${(0.97 * motorMaxRef).toFixed(0)} (97% of the ${motorMaxRef} reference); threshold 20%`,
      ),
    );
  }

  if (dropRatePct > MAX_DROP_RATE_PCT) {
    faults.push(
      fault(
        'FRAME_DROP_HIGH',
        'warn',
        `${dropRatePct.toFixed(2)}% of frames were dropped (${log.droppedFrames ?? 0} of ` +
          `${(log.frameCount ?? 0) + (log.droppedFrames ?? 0)}); limit ${MAX_DROP_RATE_PCT}%`,
      ),
    );
  }

  const measuredRate = measuredSampleRateHz(timeUs);
  if (measuredRate > 0 && Math.abs(measuredRate - EXPECTED_SAMPLE_RATE_HZ) / EXPECTED_SAMPLE_RATE_HZ > SAMPLE_RATE_TOLERANCE) {
    faults.push(
      fault(
        'SAMPLE_RATE_MISMATCH',
        'warn',
        `measured ${measuredRate.toFixed(1)} Hz from the frame timestamps vs the expected ` +
          `${EXPECTED_SAMPLE_RATE_HZ} Hz (${(((measuredRate - EXPECTED_SAMPLE_RATE_HZ) / EXPECTED_SAMPLE_RATE_HZ) * 100).toFixed(1)}%, ` +
          `tolerance +-${SAMPLE_RATE_TOLERANCE * 100}%)`,
      ),
    );
  } else if (measuredRate === 0) {
    warnings.push('sample rate mismatch could not be checked: fewer than 8 usable frame timestamps');
  }

  if (durationS < MIN_USABLE_DURATION_S) {
    // Informational only: no duration or manoeuvre requirement is imposed.
    faults.push(
      fault('SAMPLE_TOO_SHORT', 'info', `log is ${durationS.toFixed(1)} s long; frequency analysis is less stable on short logs`),
    );
  }

  if (!erpm.length) {
    faults.push(fault('NO_RPM_DATA', 'info', 'no eRPM[n] channel is present in the log, so RPM harmonic matching is unavailable'));
  }

  const truncatedWarnings = warnings.filter((w) => /^truncated/i.test(w));
  const corruptWarnings = warnings.filter((w) => /^corrupt/i.test(w));
  if (truncatedWarnings.length || corruptWarnings.length) {
    const evidence = [...truncatedWarnings, ...corruptWarnings].slice(0, 2).join(' | ');
    faults.push(fault('LOG_TRUNCATED', truncatedWarnings.length ? 'critical' : 'warn', evidence));
  }

  /* ---- sample quality ---- */
  const requiredGroups = [
    ['gyroADC', readChannel(log, 'gyroADC', 0)],
    ['setpoint', readChannel(log, 'setpoint', 0)],
    ['axisP', readChannel(log, 'axisP', 0)],
    ['rcCommand', readChannel(log, 'rcCommand', 0)],
    ['motor', readChannel(log, 'motor', 0)],
    ['throttle', readChannel(log, 'throttle')],
    ['vbat', readChannel(log, 'vbat')],
    ['eRPM', readChannel(log, 'eRPM', 0)],
  ];
  const presentGroups = requiredGroups.filter(([, channel]) => !!channel).length;
  const missingGroups = requiredGroups.filter(([, channel]) => !channel).map(([key]) => key);
  if (missingGroups.length) warnings.push(`missing channel groups: ${missingGroups.join(', ')}`);

  const sampleQuality = computeSampleQuality({ dropRatePct, durationS, presentGroups, totalGroups: requiredGroups.length });

  const blocksTuning = faults.some((f) => f.blocksTuning);

  return {
    file: file ?? log.file ?? '',
    logIndex: Number.isFinite(log.index) ? log.index : 0,
    sampleRateHz,
    durationS: round(durationS, 3),
    dropRatePct: round(dropRatePct, 3),
    motorSaturationPct: saturationPct,
    rpmAvailable,
    rpmMin,
    rpmMax,
    axes,
    faults,
    blocksTuning,
    warnings,
    sampleQuality,
    // The log describes the craft that produced it: PID, filter, loop rate.
    // Offline analysis has no FC to ask, so the advice reads these instead.
    craftSettings: readCraftSettings(log.header || {}),
  };
}

export default { computeMetrics, detectDescentSegments, estimateStepResponse, trackingMetrics, iTermWindupScore, computeSampleQuality, pidErrorByDeflection };
