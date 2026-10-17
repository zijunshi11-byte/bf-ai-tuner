/**
 * Transfer-function based PID gain recommendation.
 *
 * Ported from BetaflightAssistant's chirp autotune (GPL-3.0-or-later):
 *   src/js/blackbox/spectral_analysis.js
 *
 * Computes the closed-loop transfer function T(f) = Sxy / Sxx from setpoint
 * (input) to gyro (output) using Welch's cross-spectral method, extracts
 * control-loop metrics (-3 dB bandwidth, gain crossover, phase margin,
 * low-frequency tracking error, noise floor) and derives multiplicative gain
 * scales for P/I/D/feedforward. Unlike the chirp tool, this works on any log
 * that contains setpoint and gyro.
 *
 * The returned scales are intentionally clamped to the conservative range the
 * rest of the tuner uses; the transfer function is the *authority* for the
 * recommendation, but the step size stays bounded.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { welchCross } from './bbl-fft.js';

/** Default targets, taken from BetaflightAssistant's autotune defaults. */
export const TF_TARGETS = {
  bandwidthHz: 45,
  phaseMarginDeg: 50,
  lowFreqErrorDb: 0,
  defaultFilterHz: 150,
};

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * @param {{freqs:number[], sxyRe:number[], sxyIm:number[], sxx:number[], syy:number[], coherence:number[]}} cross
 * @returns {{frequencies:Float64Array, magnitude:Float64Array, phase:Float64Array, coherence:Float64Array}}
 */
export function toTransferFunction(cross) {
  const freqs = cross.freqs || [];
  const n = freqs.length;
  const frequencies = Float64Array.from(freqs);
  const magnitude = new Float64Array(n);
  const phase = new Float64Array(n);
  const coherence = Float64Array.from(cross.coherence || []);
  for (let k = 0; k < n; k++) {
    const sxx = cross.sxx[k];
    const re = cross.sxyRe[k];
    const im = cross.sxyIm[k];
    if (sxx > 0) {
      const mag = Math.hypot(re, im) / sxx;
      magnitude[k] = round(20 * Math.log10(Math.max(1e-12, mag)));
      phase[k] = round((Math.atan2(im, re) * 180) / Math.PI);
    } else {
      magnitude[k] = -Infinity;
      phase[k] = 0;
    }
  }
  return { frequencies, magnitude, phase, coherence };
}

function interpolate(frequencies, values, hz) {
  if (!frequencies.length) return null;
  if (hz <= frequencies[0]) return values[0];
  const last = frequencies.length - 1;
  if (hz >= frequencies[last]) return values[last];
  for (let k = 1; k <= last; k++) {
    if (hz >= frequencies[k - 1] && hz <= frequencies[k]) {
      const frac = (hz - frequencies[k - 1]) / (frequencies[k] - frequencies[k - 1]);
      return values[k - 1] + frac * (values[k] - values[k - 1]);
    }
  }
  return values[last];
}

function isCoherent(frequencies, coherence, hz, threshold = 0.3) {
  if (!frequencies.length || hz <= frequencies[0]) return false;
  const last = frequencies.length - 1;
  if (hz >= frequencies[last]) return false;
  for (let k = 1; k <= last; k++) {
    if (hz >= frequencies[k - 1] && hz <= frequencies[k]) {
      return coherence[k - 1] >= threshold && coherence[k] >= threshold;
    }
  }
  return false;
}

export function findBandwidth(frequencies, magnitude, coherence, targetBandwidthHz) {
  const last = frequencies.length - 1;
  let best = 0;
  for (let k = 1; k <= last; k++) {
    if (coherence[k - 1] < 0.3 || coherence[k] < 0.3) continue;
    const prev = magnitude[k - 1];
    const cur = magnitude[k];
    if (prev >= -3 && cur < -3) {
      const frac = (-3 - prev) / (cur - prev);
      return round(frequencies[k - 1] + frac * (frequencies[k] - frequencies[k - 1]));
    }
    best = frequencies[k];
  }
  return round(Math.min(best, targetBandwidthHz * 2));
}

export function findResonantPeak(frequencies, magnitude, coherence) {
  let peakDb = 0;
  let peakHz = 0;
  const last = frequencies.length - 1;
  for (let k = 0; k <= last; k++) {
    if (frequencies[k] < 10 || frequencies[k] > 200 || coherence[k] < 0.3) continue;
    if (magnitude[k] > peakDb) {
      peakDb = magnitude[k];
      peakHz = frequencies[k];
    }
  }
  return { resonantPeakDb: round(peakDb), resonantFreqHz: round(peakHz) };
}

export function findGainCrossover(frequencies, magnitude, coherence) {
  const last = frequencies.length - 1;
  for (let k = 1; k <= last; k++) {
    if (coherence[k - 1] < 0.3 || coherence[k] < 0.3) continue;
    const prev = magnitude[k - 1];
    const cur = magnitude[k];
    if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0)) {
      const frac = (0 - prev) / (cur - prev);
      return round(frequencies[k - 1] + frac * (frequencies[k] - frequencies[k - 1]));
    }
  }
  return 0;
}

export function computeLowFreqError(frequencies, magnitude, coherence) {
  let sum = 0;
  let count = 0;
  for (let k = 0; k < frequencies.length; k++) {
    if (frequencies[k] >= 2 && frequencies[k] <= 10 && coherence[k] > 0.3) {
      sum += magnitude[k];
      count++;
    }
  }
  return count > 0 ? round(sum / count) : 0;
}

export function findNoiseFloor(frequencies, coherence) {
  for (let k = 0; k < frequencies.length; k++) {
    if (frequencies[k] > 20 && coherence[k] < 0.5) return round(frequencies[k]);
  }
  return 0;
}

export function computeMeanCoherence(frequencies, coherence) {
  let sum = 0;
  let count = 0;
  for (let k = 0; k < frequencies.length; k++) {
    if (frequencies[k] >= 5 && frequencies[k] <= 100) {
      sum += coherence[k];
      count++;
    }
  }
  return count > 0 ? round(sum / count) : 0;
}

export function extractTfMetrics(tf, targetBandwidthHz = TF_TARGETS.bandwidthHz) {
  const bandwidthHz = findBandwidth(tf.frequencies, tf.magnitude, tf.coherence, targetBandwidthHz);
  const { resonantPeakDb, resonantFreqHz } = findResonantPeak(
    tf.frequencies,
    tf.magnitude,
    tf.coherence,
  );
  const gainCrossoverHz = findGainCrossover(tf.frequencies, tf.magnitude, tf.coherence);
  const phaseAtCrossover = gainCrossoverHz > 0
    ? interpolate(tf.frequencies, tf.phase, gainCrossoverHz)
    : 0;
  const phaseMarginDeg = round(180 + phaseAtCrossover);
  const lowFreqErrorDb = computeLowFreqError(tf.frequencies, tf.magnitude, tf.coherence);
  const noiseFloorHz = findNoiseFloor(tf.frequencies, tf.coherence);
  const meanCoherence = computeMeanCoherence(tf.frequencies, tf.coherence);
  return {
    bandwidthHz,
    resonantPeakDb,
    resonantFreqHz,
    gainCrossoverHz,
    phaseMarginDeg,
    lowFreqErrorDb,
    noiseFloorHz,
    meanCoherence,
  };
}

/**
 * Derive multiplicative gain scales. Mirrors BetaflightAssistant's
 * computeGainScales exactly, then clamps to the conservative range used by
 * this tuner's rule engine so one round never shocks the quad.
 */
export function computeGainScales(
  metrics,
  tf,
  targetBandwidthHz = TF_TARGETS.bandwidthHz,
  targetPhaseMarginDeg = TF_TARGETS.phaseMarginDeg,
) {
  const { bandwidthHz, gainCrossoverHz, lowFreqErrorDb, noiseFloorHz, resonantPeakDb } = metrics;

  let piScale = bandwidthHz > 0 ? targetBandwidthHz / bandwidthHz : 1;

  let dScale = 1;
  const predictedCrossoverHz = gainCrossoverHz * piScale;
  if (predictedCrossoverHz > 0 && isCoherent(tf.frequencies, tf.coherence, predictedCrossoverHz, 0.3)) {
    const predictedPhase = interpolate(tf.frequencies, tf.phase, predictedCrossoverHz);
    const predictedPhaseMargin = 180 + predictedPhase;
    if (predictedPhaseMargin > 0 && predictedPhaseMargin < 180) {
      dScale = 1 + (targetPhaseMarginDeg - predictedPhaseMargin) / 90;
    }
  }

  let iScale = 1;
  if (lowFreqErrorDb < -1) {
    iScale = 1 + Math.abs(lowFreqErrorDb) * 0.1;
  } else if (lowFreqErrorDb > 2) {
    iScale = 1 - lowFreqErrorDb * 0.05;
  }

  let ffScale = piScale;

  if (resonantPeakDb > 6) {
    piScale *= 0.75;
    dScale *= 0.85;
    ffScale *= 0.8;
  } else if (resonantPeakDb > 3) {
    piScale *= 0.9;
    dScale *= 0.95;
  }

  const filterScale = noiseFloorHz > 0 ? noiseFloorHz / TF_TARGETS.defaultFilterHz : 1;

  // Conservative per-round bounds: the transfer-function authority is strong,
  // but this tuner still applies only one moderate step per session.
  return {
    piScale: clamp(piScale, 0.93, 1.07),
    iScale: clamp(iScale, 0.93, 1.07),
    dScale: clamp(dScale, 0.93, 1.07),
    ffScale: clamp(ffScale, 0.93, 1.07),
    filterScale: clamp(filterScale, 0.9, 1.1),
  };
}

/**
 * Build per-axis scales from setpoint/gyro.
 * @returns {{tf: object, metrics: object, scales: object, coherent: boolean}|null}
 */
export function recommendAxis(setpoint, gyro, sampleRateHz) {
  if (!setpoint || !gyro || !Number.isFinite(sampleRateHz) || sampleRateHz <= 0) return null;
  const cross = welchCross(setpoint, gyro, sampleRateHz, { segmentSize: 1024, overlap: 0.5 });
  if (!cross.freqs.length) return null;
  const tf = toTransferFunction(cross);
  const metrics = extractTfMetrics(tf);
  if (metrics.meanCoherence < 0.5) return null; // do not trust low-coherence data
  const scales = computeGainScales(metrics, tf);
  return { tf, metrics, scales, coherent: true };
}

export default { toTransferFunction, extractTfMetrics, computeGainScales, recommendAxis };
