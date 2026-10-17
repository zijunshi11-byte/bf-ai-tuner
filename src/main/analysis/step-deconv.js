/**
 * Step response by Wiener deconvolution of setpoint -> gyro.
 *
 * Real stick inputs are ramps shaped by RC smoothing and feedforward
 * interpolation, never one-frame jumps, so an "isolated step" detector finds
 * nothing in an ordinary racing or freestyle log (it found 0 steps on every
 * real log we have). The approach PID-Analyzer and PIDtoolbox use works on any
 * stick input instead: in overlapping windows, estimate the impulse response h
 * from  gyro = h * setpoint  with a regularised (Wiener) inverse, integrate it
 * to a step response, and average the windows that carried real stick input.
 *
 * Regularisation follows PID-Analyzer's v0.52 shape: almost none below
 * `cutHz` (where the stick has energy), rising smoothly (Gaussian) above it so
 * noise-band division by a near-zero input spectrum cannot blow up.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ComplexFFT } from '../../../vendor/betaflight/fft.js';

const FFT_CACHE = new Map();
function fftFor(size, inverse) {
  const key = `${size}:${inverse ? 'i' : 'f'}`;
  let fft = FFT_CACHE.get(key);
  if (!fft) {
    fft = new ComplexFFT(size, inverse);
    if (FFT_CACHE.size > 16) FFT_CACHE.clear();
    FFT_CACHE.set(key, fft);
  }
  return fft;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function toFloat(signal) {
  if (!signal) return null;
  if (signal instanceof Float64Array) return signal;
  return Float64Array.from(signal, Number);
}

/**
 * Overshoot, latency, rise, settling and steady-state error of a normalised
 * step response (input step of 1 at index `start`). Shared shape with
 * estimateStepResponse so rules read either source the same way.
 */
export function responseMetrics(response, start, sampleRateHz) {
  const out = { overshootPct: 0, riseTimeMs: 0, settlingTimeMs: 0, steadyStateErrorPct: 0, latencyMs: 0, delay50Ms: 0 };
  const n = response.length;
  if (n - start < 8) return out;
  const tailStart = Math.max(start, Math.floor(n * 0.8));
  let final = 0;
  for (let k = tailStart; k < n; k++) final += response[k];
  final /= n - tailStart;
  if (!(Math.abs(final) > 0.01)) return out;

  let peak = -Infinity;
  for (let k = start; k < n; k++) peak = Math.max(peak, response[k]);
  out.overshootPct = round(Math.max(0, ((peak - final) / Math.abs(final)) * 100));

  let cross10 = -1;
  for (let k = start; k < n; k++) if (response[k] >= 0.1 * final) { cross10 = k; break; }
  // (Searched from the onset: a band-limited fit may cross 10 % slightly
  // before it, which then reads as 0 ms rather than a negative latency.)
  if (cross10 < 0) return out;
  let cross90 = -1;
  for (let k = cross10; k < n; k++) if (response[k] >= 0.9 * final) { cross90 = k; break; }
  out.latencyMs = round(((cross10 - start) / sampleRateHz) * 1000);
  for (let k = start; k < n; k++) {
    if (response[k] >= 0.5 * final) { out.delay50Ms = round(((k - start) / sampleRateHz) * 1000); break; }
  }
  if (cross90 >= 0) out.riseTimeMs = round(((cross90 - cross10) / sampleRateHz) * 1000);

  const tolerance = 0.02 * Math.abs(final);
  let settled = -1;
  for (let k = n - 1; k >= start; k--) {
    if (Math.abs(response[k] - final) > tolerance) { settled = k; break; }
  }
  out.settlingTimeMs = settled >= 0 ? round(((settled - start) / sampleRateHz) * 1000) : 0;
  out.steadyStateErrorPct = round(Math.abs(1 - final) * 100);
  return out;
}

/**
 * @param {ArrayLike<number>} setpoint deg/s
 * @param {ArrayLike<number>} gyro deg/s
 * @param {number} sampleRateHz
 * @param {{windowS?:number, hopS?:number, responseS?:number, cutHz?:number,
 *          minInputDps?:number, minWindows?:number, curvePoints?:number}} [opts]
 * @returns {{overshootPct:number, riseTimeMs:number, settlingTimeMs:number,
 *   steadyStateErrorPct:number, latencyMs:number, samples:number,
 *   method:'deconvolution', windowsTried:number,
 *   curve:{dtMs:number, values:number[]}|null}}
 *   `samples` counts accepted windows; with the default 50 % hop that is one
 *   window per half second of real stick input. `delay50Ms` (time to 50 %,
 *   PIDtoolbox's latency convention) is the robust delay figure here; the
 *   10 % `latencyMs` is pulled early by the band-limit smear.
 *   NOTE: setpoint -> gyro includes feedforward, so overshoot here is the
 *   overshoot the pilot feels, not proof that P is too high.
 */
export function deconvolveStepResponse(setpoint, gyro, sampleRateHz, {
  windowS = 1,
  hopS = 0.5,
  responseS = 0.5,
  cutHz = 25,
  minInputDps = 50,
  minWindows = 3,
  curvePoints = 100,
} = {}) {
  const empty = {
    overshootPct: 0, riseTimeMs: 0, settlingTimeMs: 0, steadyStateErrorPct: 0, latencyMs: 0,
    samples: 0, method: 'deconvolution', windowsTried: 0, curve: null,
  };
  const sp = toFloat(setpoint);
  const gy = toFloat(gyro);
  const fs = Number(sampleRateHz);
  if (!sp || !gy || !(fs > 0)) return empty;
  const n = Math.min(sp.length, gy.length);

  const size = 2 ** Math.round(Math.log2(Math.max(64, windowS * fs)));
  const hop = Math.max(1, Math.round(hopS * fs));
  const respLen = Math.min(size, Math.max(8, Math.round(responseS * fs)));
  const pre = Math.min(Math.round(0.02 * fs), size - respLen);
  if (n < size || pre < 0) return empty;

  // Hann window, and the Wiener regulariser per FFT bin (two-sided spectrum).
  const win = new Float64Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const lambdaScale = new Float64Array(size);
  const sigma = cutHz / 3;
  for (let k = 0; k < size; k++) {
    const f = (Math.min(k, size - k) * fs) / size;
    const over = Math.max(0, f - cutHz);
    // ~1 in the stick band, growing as a Gaussian beyond the cut-off.
    lambdaScale[k] = Math.exp(0.5 * (over / sigma) ** 2);
  }

  const fwd = fftFor(size, false);
  const inv = fftFor(size, true);
  const inX = new Float64Array(size);
  const inY = new Float64Array(size);
  const X = new Float64Array(2 * size);
  const Y = new Float64Array(2 * size);
  const H = new Float64Array(2 * size);
  const h = new Float64Array(2 * size);

  const acc = new Float64Array(pre + respLen);
  let accepted = 0;
  let tried = 0;

  for (let start = 0; start + size <= n; start += hop) {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < size; i++) { mx += sp[start + i]; my += gy[start + i]; }
    mx /= size;
    my /= size;
    let peak = 0;
    for (let i = 0; i < size; i++) peak = Math.max(peak, Math.abs(sp[start + i] - mx));
    if (peak < minInputDps) continue; // no stick input worth identifying
    tried++;

    let powerSum = 0;
    for (let i = 0; i < size; i++) {
      inX[i] = (sp[start + i] - mx) * win[i];
      inY[i] = (gy[start + i] - my) * win[i];
    }
    fwd.simple(X, inX, 'real');
    fwd.simple(Y, inY, 'real');
    for (let k = 0; k < size; k++) powerSum += X[2 * k] ** 2 + X[2 * k + 1] ** 2;
    // Base regulariser: 1e-3 of the mean input power keeps the stick band
    // essentially unregularised while still bounding empty bins.
    const base = 1e-3 * (powerSum / size);

    for (let k = 0; k < size; k++) {
      const xr = X[2 * k];
      const xi = X[2 * k + 1];
      const yr = Y[2 * k];
      const yi = Y[2 * k + 1];
      const denom = xr * xr + xi * xi + base * lambdaScale[k];
      // Y * conj(X) / (|X|^2 + lambda)
      H[2 * k] = denom > 0 ? (yr * xr + yi * xi) / denom : 0;
      H[2 * k + 1] = denom > 0 ? (yi * xr - yr * xi) / denom : 0;
    }
    inv.simple(h, H, 'complex');

    // Integrate the impulse response into a step response, starting `pre`
    // samples BEFORE the step: the regulariser band-limits h, which smears it
    // symmetrically in time, and that leading part wraps to the end of the
    // circular result. Dropping it biases the final value low (measured: 0.72
    // instead of ~1.0 on a real log).
    const step = new Float64Array(pre + respLen);
    let sum = 0;
    for (let k = 0; k < pre + respLen; k++) {
      const lag = k - pre;
      sum += h[2 * (lag < 0 ? size + lag : lag)] / size;
      step[k] = sum;
    }
    // Quality: a usable window settles near unity gain. Wind gusts, crashes and
    // saturated motors produce wild fits; leave them out of the average.
    let tail = 0;
    const tailStart = pre + Math.floor(respLen * 0.6);
    for (let k = tailStart; k < step.length; k++) tail += step[k];
    tail /= step.length - tailStart;
    if (!(tail > 0.5 && tail < 1.5)) continue;

    for (let k = 0; k < step.length; k++) acc[k] += step[k];
    accepted++;
  }

  if (accepted < minWindows) return { ...empty, samples: accepted, windowsTried: tried };

  const averaged = new Float64Array(acc.length);
  for (let k = 0; k < acc.length; k++) averaged[k] = acc[k] / accepted;
  // A 3 ms centred moving average: the regulariser leaves narrow ripples that
  // would otherwise be read as the overshoot peak.
  const half = Math.max(1, Math.round(0.0015 * fs));
  const response = new Float64Array(averaged.length);
  for (let k = 0; k < averaged.length; k++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, k - half); j <= Math.min(averaged.length - 1, k + half); j++) { sum += averaged[j]; count++; }
    response[k] = sum / count;
  }

  const stride = Math.max(1, Math.floor(response.length / curvePoints));
  const values = [];
  for (let k = 0; k < response.length; k += stride) values.push(round(response[k], 3));

  return {
    ...responseMetrics(response, pre, fs),
    samples: accepted,
    method: 'deconvolution',
    windowsTried: tried,
    curve: { dtMs: round((stride / fs) * 1000, 3), t0Ms: round((-pre / fs) * 1000, 3), values },
  };
}

export default { deconvolveStepResponse, responseMetrics };
