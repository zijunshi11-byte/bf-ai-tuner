/**
 * Frequency-domain helpers for blackbox signal analysis.
 *
 * Pure DSP: no file I/O, no Electron, no globals. The FFT itself is the
 * vendored Betaflight Configurator implementation
 * (../../../vendor/betaflight/fft.js, `ComplexFFT`), used through a small
 * instance cache so a Welch average does not re-derive twiddle factors for
 * every segment.
 *
 * Conventions
 *   - `psd` is a one-sided power spectral density in units of
 *     (input unit)^2 / Hz, so integrating it over a band with `bandPower()`
 *     gives the mean-square power in that band.
 *   - `freqs[k] = k * binHz`, `binHz = sampleRateHz / (effective segment size)`.
 *     DC is bin 0 and the last bin is the Nyquist frequency.
 *   - Signals are plain arrays or typed arrays of numbers.
 *
 * eRPM units (important, see `matchRpmHarmonics`)
 *   Betaflight's blackbox `eRPM[N]` column is the electrical RPM divided by
 *   100 (the upstream viewer converts it with `rpm = value * 200 / motor_poles`),
 *   while this module's default is the literal interpretation, "the samples are
 *   electrical RPM". Callers that pass raw blackbox columns must therefore pass
 *   `erpmScale: 100`; `bbl-metrics.js` does exactly that.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComplexFFT } from '../../../vendor/betaflight/fft.js';

/** Default segment length: 512 samples ≈ 3.9 Hz bins at a 2 kHz log rate. */
const DEFAULT_SEGMENT_SIZE = 512;

const FFT_CACHE = new Map();

function getFft(size) {
  let fft = FFT_CACHE.get(size);
  if (!fft) {
    fft = new ComplexFFT(size, false);
    if (FFT_CACHE.size > 32) FFT_CACHE.clear();
    FFT_CACHE.set(size, fft);
  }
  return fft;
}

function toFloatArray(signal) {
  if (!signal) return new Float64Array(0);
  if (signal instanceof Float64Array) return signal;
  if (ArrayBuffer.isView(signal) || Array.isArray(signal)) return Float64Array.from(signal);
  return new Float64Array(0);
}

function largestPowerOfTwoAtMost(n) {
  if (n < 1) return 0;
  return 2 ** Math.floor(Math.log2(n));
}

/** Window coefficients (symmetric form, w[0] and w[n-1] both taper). */
function windowCoefficients(name, n) {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const kind = typeof name === 'string' ? name.toLowerCase() : 'hann';
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / (n - 1);
    switch (kind) {
      case 'rect':
      case 'none':
      case 'boxcar':
        w[i] = 1;
        break;
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(t);
        break;
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
        break;
      case 'hann':
      default:
        w[i] = 0.5 - 0.5 * Math.cos(t);
        break;
    }
  }
  return w;
}

/**
 * Resolve the effective segment size / hop for a signal.
 * Shrinks the segment to the largest power of two that fits when the signal is
 * shorter than the requested segment, and falls back to a single segment when
 * even that is impossible.
 */
function planSegments(signalLength, segmentSize, overlap) {
  let requested = Number.isFinite(segmentSize) ? Math.trunc(segmentSize) : DEFAULT_SEGMENT_SIZE;
  if (requested < 2) requested = DEFAULT_SEGMENT_SIZE;

  let size = Math.min(requested, signalLength);
  if (size < requested) size = largestPowerOfTwoAtMost(signalLength);

  const clampedOverlap = Number.isFinite(overlap) ? Math.min(0.95, Math.max(0, overlap)) : 0.5;
  let hop = Math.max(1, Math.round(size * (1 - clampedOverlap)));
  if (hop > size) hop = size;
  return { size, hop };
}

/**
 * Welch periodogram core, shared by the auto- and cross-spectrum entry points.
 * When `b` is null only the auto spectrum of `a` is produced.
 */
function welchCore(a, b, sampleRateHz, options) {
  const fs = Number(sampleRateHz);
  const requestedSegment = Number.isFinite(options.segmentSize) ? options.segmentSize : DEFAULT_SEGMENT_SIZE;
  const empty = { freqs: [], psd: [], sxyRe: [], sxyIm: [], sxx: [], syy: [], coherence: [], binHz: 0, segments: 0 };
  if (!Number.isFinite(fs) || fs <= 0) return empty;

  const sigA = toFloatArray(a);
  const sigB = b ? toFloatArray(b) : null;
  const length = sigB ? Math.min(sigA.length, sigB.length) : sigA.length;
  if (length < 1) return { ...empty, binHz: fs / Math.max(1, requestedSegment) };
  if (length === 1) {
    // One sample: a single-segment, DC-only spectrum (detrended, so zero).
    return { ...empty, freqs: [0], psd: [0], sxx: [0], syy: [0], coherence: [0], binHz: fs, segments: 1 };
  }

  const { size, hop } = planSegments(length, requestedSegment, options.overlap);
  if (size < 2) return { ...empty, binHz: fs / Math.max(1, requestedSegment) };

  let win = windowCoefficients(options.window, size);
  let winSqSum = 0;
  for (let i = 0; i < size; i++) winSqSum += win[i] * win[i];
  if (winSqSum < 1e-12) {
    // Degenerate window (a symmetric Hann over 2 samples is all zeros):
    // fall back to rectangular so the segment is not annihilated.
    win = windowCoefficients('rect', size);
    winSqSum = size;
  }

  const bins = Math.floor(size / 2) + 1;
  const freqs = new Float64Array(bins);
  const binHz = fs / size;
  for (let k = 0; k < bins; k++) freqs[k] = k * binHz;

  const psd = new Float64Array(bins);
  const sxyRe = new Float64Array(bins);
  const sxyIm = new Float64Array(bins);
  const sxx = new Float64Array(bins);
  const syy = new Float64Array(bins);

  const detrend = options.detrend !== false;
  const input = new Float64Array(size);
  const output = new Float64Array(2 * size);
  const inputB = sigB ? new Float64Array(size) : null;
  const outputB = sigB ? new Float64Array(2 * size) : null;
  const fft = getFft(size);

  let segments = 0;
  for (let start = 0; start + size <= length; start += hop) {
    let mean = 0;
    if (detrend) {
      for (let i = 0; i < size; i++) mean += sigA[start + i];
      mean /= size;
    }
    for (let i = 0; i < size; i++) input[i] = (sigA[start + i] - mean) * win[i];
    fft.simple(output, input, 'real');

    if (sigB) {
      let meanB = 0;
      if (detrend) {
        for (let i = 0; i < size; i++) meanB += sigB[start + i];
        meanB /= size;
      }
      for (let i = 0; i < size; i++) inputB[i] = (sigB[start + i] - meanB) * win[i];
      fft.simple(outputB, inputB, 'real');
    }

    segments++;
    for (let k = 0; k < bins; k++) {
      const re = output[2 * k];
      const im = output[2 * k + 1];
      // One-sided: double every bin except DC and (for even sizes) Nyquist.
      const oneSided = k === 0 || (size % 2 === 0 && k === size / 2) ? 1 : 2;
      const norm = fs * winSqSum;
      const p = ((re * re + im * im) * oneSided) / norm;
      psd[k] += p;
      sxx[k] += p;
      if (sigB) {
        const reB = outputB[2 * k];
        const imB = outputB[2 * k + 1];
        const pB = ((reB * reB + imB * imB) * oneSided) / norm;
        syy[k] += pB;
        // X * conj(Y)
        sxyRe[k] += (re * reB + im * imB) * (oneSided / norm);
        sxyIm[k] += (im * reB - re * imB) * (oneSided / norm);
      }
    }
  }

  if (segments === 0) return { ...empty, binHz };

  for (let k = 0; k < bins; k++) {
    psd[k] /= segments;
    sxx[k] /= segments;
    syy[k] /= segments;
    sxyRe[k] /= segments;
    sxyIm[k] /= segments;
  }

  const coherence = new Float64Array(bins);
  if (sigB) {
    for (let k = 0; k < bins; k++) {
      const denom = sxx[k] * syy[k];
      coherence[k] = denom > 0 ? Math.min(1, (sxyRe[k] * sxyRe[k] + sxyIm[k] * sxyIm[k]) / denom) : 0;
    }
  }

  return {
    freqs: Array.from(freqs),
    psd: Array.from(psd),
    sxyRe: Array.from(sxyRe),
    sxyIm: Array.from(sxyIm),
    sxx: Array.from(sxx),
    syy: Array.from(syy),
    coherence: Array.from(coherence),
    binHz,
    segments,
  };
}

/**
 * Welch power spectral density.
 *
 * Mean-subtracts each segment, applies the window and averages the one-sided
 * periodograms of `overlap`-overlapped segments. A signal shorter than one
 * segment shrinks the segment to the largest power of two that fits; a signal
 * that cannot even fill two samples yields an empty spectrum instead of throw.
 *
 * @param {ArrayLike<number>} signal
 * @param {number} sampleRateHz
 * @param {{segmentSize?: number, overlap?: number, window?: 'hann'|'hamming'|'blackman'|'rect', detrend?: boolean}} [options]
 * @returns {import('../../shared/contracts.js').Spectrum}
 */
export function welchPsd(signal, sampleRateHz, { segmentSize = DEFAULT_SEGMENT_SIZE, overlap = 0.5, window = 'hann', detrend = true } = {}) {
  const core = welchCore(signal, null, sampleRateHz, { segmentSize, overlap, window, detrend });
  return { freqs: core.freqs, psd: core.psd, binHz: core.binHz, segments: core.segments };
}

/**
 * Welch cross-spectrum of two equal-length signals plus the magnitude-squared
 * coherence, used by bbl-metrics for the setpoint → gyro tracking estimate.
 *
 * @returns {{freqs:number[], sxyRe:number[], sxyIm:number[], sxx:number[],
 *            syy:number[], coherence:number[], binHz:number, segments:number}}
 */
export function welchCross(a, b, sampleRateHz, { segmentSize = DEFAULT_SEGMENT_SIZE, overlap = 0.5, window = 'hann', detrend = true } = {}) {
  return welchCore(a, b, sampleRateHz, { segmentSize, overlap, window, detrend });
}

/** Sum of `psd[k] * binHz` over the bins inside [lowHz, highHz]. */
export function bandPower(spectrum, lowHz, highHz) {
  const freqs = spectrum && spectrum.freqs;
  const psd = spectrum && spectrum.psd;
  if (!freqs || !psd || !freqs.length) return 0;
  let low = Number.isFinite(lowHz) ? lowHz : 0;
  let high = Number.isFinite(highHz) ? highHz : freqs[freqs.length - 1];
  if (high < low) [low, high] = [high, low];
  const binHz = Number.isFinite(spectrum.binHz) && spectrum.binHz > 0
    ? spectrum.binHz
    : freqs.length > 1
      ? freqs[1] - freqs[0]
      : 0;
  let power = 0;
  for (let k = 0; k < freqs.length; k++) {
    if (freqs[k] >= low && freqs[k] <= high) power += psd[k] * binHz;
  }
  return power;
}

/**
 * Median PSD expressed in dB (10*log10 of the median bin power).
 *
 * The name follows the contract field `noiseFloorDbfs`: with a signal
 * normalised to full scale this is dBFS; with a deg/s signal it is dB relative
 * to 1 (deg/s)^2/Hz. A floor of -300 dB keeps a silent spectrum finite.
 */
export function noiseFloorDbfs(spectrum) {
  const psd = spectrum && spectrum.psd;
  if (!psd || !psd.length) return -300;
  const sorted = Float64Array.from(psd).sort();
  const mid = sorted.length >> 1;
  const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return 10 * Math.log10(Math.max(med, 1e-30));
}

/** Topographic prominence (in dB) of bin `i` in a dB spectrum. */
function prominenceAt(db, i) {
  const peak = db[i];
  let leftMin = peak;
  for (let j = i - 1; j >= 0; j--) {
    if (db[j] > peak) break;
    if (db[j] < leftMin) leftMin = db[j];
  }
  let rightMin = peak;
  for (let j = i + 1; j < db.length; j++) {
    if (db[j] > peak) break;
    if (db[j] < rightMin) rightMin = db[j];
  }
  return peak - Math.max(leftMin, rightMin);
}

/** -3 dB bandwidth of the peak at bin `i`, in Hz. */
function bandwidthAt(db, i, binHz) {
  const half = db[i] - 3;
  let left = i;
  while (left > 0 && db[left - 1] > half) left--;
  let right = i;
  while (right < db.length - 1 && db[right + 1] > half) right++;
  return (right - left) * binHz;
}

/**
 * Local-maximum peak picking on the PSD, ranked by power.
 *
 * @param {import('../../shared/contracts.js').Spectrum} spectrum
 * @param {{maxPeaks?: number, minProminenceDb?: number, minHz?: number}} [options]
 * @returns {import('../../shared/contracts.js').SpectralPeak[]}
 */
export function findPeaks(spectrum, { maxPeaks = 5, minProminenceDb = 6, minHz = 20 } = {}) {
  const freqs = spectrum && spectrum.freqs;
  const psd = spectrum && spectrum.psd;
  if (!freqs || !psd || psd.length < 3) return [];
  const binHz = Number.isFinite(spectrum.binHz) && spectrum.binHz > 0
    ? spectrum.binHz
    : freqs.length > 1
      ? freqs[1] - freqs[0]
      : 1;

  const db = new Float64Array(psd.length);
  for (let k = 0; k < psd.length; k++) db[k] = 10 * Math.log10(Math.max(psd[k], 1e-30));

  const candidates = [];
  for (let k = 1; k < psd.length - 1; k++) {
    if (db[k] >= db[k - 1] && db[k] > db[k + 1] && freqs[k] >= minHz) {
      const prominenceDb = prominenceAt(db, k);
      if (prominenceDb >= minProminenceDb) {
        candidates.push({
          hz: freqs[k],
          psd: psd[k],
          prominenceDb,
          bandwidthHz: bandwidthAt(db, k, binHz),
        });
      }
    }
  }

  candidates.sort((x, y) => y.psd - x.psd);
  const limit = Number.isFinite(maxPeaks) && maxPeaks > 0 ? Math.trunc(maxPeaks) : candidates.length;
  return candidates.slice(0, limit);
}

/**
 * Match spectral peaks against harmonics of the motor fundamental.
 *
 * The fundamental mechanical frequency of a motor is
 *   f_mech = (eRPM * erpmScale) / 60 / polePairs
 * (`erpmScale` is 1 for true electrical RPM and 100 for a raw Betaflight
 * blackbox `eRPM[]` column — see the module header).
 *
 * Each peak is scored by the fraction of eRPM samples whose harmonic of order
 * 1..maxOrder lies within `tolerancePct` of the peak; the returned `match` is
 * the prominence-weighted mean of those scores, so a peak that only coincides
 * with a small part of the RPM range scores low.
 *
 * @param {import('../../shared/contracts.js').SpectralPeak[]} peaks
 * @param {ArrayLike<number>[]} erpmChannels one time series per motor
 * @param {number} sampleRateHz
 * @param {{maxOrder?: number, polePairs?: number, tolerancePct?: number, erpmScale?: number}} [options]
 * @returns {{match: number, orders: number[]}}
 */
export function matchRpmHarmonics(
  peaks,
  erpmChannels,
  sampleRateHz,
  { maxOrder = 4, polePairs = 7, tolerancePct = 3, erpmScale = 1 } = {},
) {
  const result = { match: 0, orders: [] };
  if (!Array.isArray(peaks) || !peaks.length) return result;
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return result;

  const pairs = Number.isFinite(polePairs) && polePairs > 0 ? polePairs : 7;
  const scale = Number.isFinite(erpmScale) && erpmScale > 0 ? erpmScale : 1;
  const orders = Number.isFinite(maxOrder) && maxOrder > 0 ? Math.trunc(maxOrder) : 4;
  const tol = Number.isFinite(tolerancePct) && tolerancePct > 0 ? tolerancePct / 100 : 0.03;

  // Mechanical frequencies present in the log, subsampled so a long flight
  // does not turn this into an O(peaks * samples) walk over millions of values.
  const mechanical = [];
  const channels = Array.isArray(erpmChannels) ? erpmChannels : [erpmChannels];
  for (const channel of channels) {
    const values = toFloatArray(channel);
    if (values.length < 2) continue;
    const stride = Math.max(1, Math.floor(values.length / 2000));
    for (let i = 0; i < values.length; i += stride) {
      const value = values[i] * scale;
      if (value > 1) mechanical.push(value / 60 / pairs);
    }
  }
  if (!mechanical.length) return result;

  const matchedOrders = new Set();
  let weightSum = 0;
  let weightedScore = 0;

  for (const peak of peaks) {
    if (!peak || !Number.isFinite(peak.hz) || peak.hz <= 0) continue;
    let bestScore = 0;
    let bestOrder = 0;
    for (let order = 1; order <= orders; order++) {
      let hits = 0;
      for (let i = 0; i < mechanical.length; i++) {
        const target = order * mechanical[i];
        if (target > 0 && Math.abs(peak.hz - target) / target <= tol) hits++;
      }
      const score = hits / mechanical.length;
      if (score > bestScore) {
        bestScore = score;
        bestOrder = order;
      }
    }
    if (bestScore > 0 && bestOrder > 0) matchedOrders.add(bestOrder);
    const weight = Number.isFinite(peak.prominenceDb) && peak.prominenceDb > 0 ? peak.prominenceDb : 1;
    weightSum += weight;
    weightedScore += weight * bestScore;
  }

  return {
    match: weightSum > 0 ? Math.min(1, Math.max(0, weightedScore / weightSum)) : 0,
    orders: Array.from(matchedOrders).sort((a, b) => a - b),
  };
}

export default { welchPsd, welchCross, findPeaks, matchRpmHarmonics, bandPower, noiseFloorDbfs };
