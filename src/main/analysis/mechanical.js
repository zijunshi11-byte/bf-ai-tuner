/**
 * Mechanical health from a blackbox log: things a PID or filter change cannot
 * fix and should not be asked to.
 *
 *  1. Per-motor once-per-revolution vibration. An unbalanced or chipped prop,
 *     or a bent shaft, shakes the frame at exactly that motor's rotation
 *     frequency. Each motor's own eRPM gives its rotation phase, so the gyro
 *     can be demodulated motor by motor ("order tracking") and the motor whose
 *     1x component stands out is named.
 *
 *  2. Frame resonance vs motor noise. A frame/arm/stack resonance stays at one
 *     frequency whatever the motors do; motor noise moves with RPM. Splitting
 *     the flight into speed bands and comparing raw-gyro peaks across them
 *     tells the two apart - which decides whether a static notch is the right
 *     tool (fixed) or the wrong one (moving).
 *
 * Pure functions, no I/O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findPeaks, welchPsd } from './bbl-fft.js';

/** Betaflight logs eRPM / 100. */
const ERPM_SCALE = 100;

export const MECH_THRESHOLDS = Object.freeze({
  /** Motors below this rotation rate are ignored (idle / flight motion band). */
  minRotationHz: 100,
  /** Order-tracking window. */
  windowS: 0.5,
  /** A window is skipped when another motor spins within this many Hz. */
  minSeparationHz: 3,
  /** Windows needed per motor before its 1x amplitude is reported. */
  minWindows: 4,
  /** Outlier: this many times the median of the other motors ... */
  imbalanceRatio: 1.8,
  /** ... and this far above its own non-synchronous noise estimate. */
  minSnr: 2.5,
  /** Frame resonance: speed bands and how far apart they must be. */
  speedBands: 3,
  minSegmentsPerBand: 20,
  minSpeedSpreadPct: 25,
  /** Same peak across bands: within max(6 Hz, 3 %). */
  peakToleranceHz: 6,
  peakTolerancePct: 3,
  minResonanceProminenceDb: 8,
  /**
   * Moving peak: in another band a peak sits at the same multiple of that
   * band's speed within this fraction. Band speed is the four-motor mean, so
   * the strongest motor's peak scatters around it (measured 4-13 % on real
   * logs); a fixed resonance is decided first and is not affected.
   */
  trackingRatioTolerance: 0.2,
});

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function toFloat(signal) {
  if (!signal) return null;
  if (signal instanceof Float64Array) return signal;
  return Float64Array.from(signal, Number);
}

/** Mechanical rotation frequency (Hz) per sample from a raw eRPM column. */
export function rotationHz(erpmRaw, polePairs) {
  const raw = toFloat(erpmRaw);
  if (!raw || !(polePairs > 0)) return null;
  const out = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    out[i] = Number.isFinite(v) && v > 0 ? (v * ERPM_SCALE) / polePairs / 60 : 0;
  }
  return out;
}

/**
 * Amplitude of the gyro component locked to one motor's rotation phase, with
 * the same estimate at a non-harmonic order (1.37x) as its noise reference.
 */
function orderAmplitude(gyros, rot, start, length, fs, order) {
  let phase = 0;
  const re = new Float64Array(gyros.length);
  const im = new Float64Array(gyros.length);
  const means = gyros.map((g) => {
    let m = 0;
    for (let k = 0; k < length; k++) m += g[start + k];
    return m / length;
  });
  for (let k = 0; k < length; k++) {
    phase += (2 * Math.PI * order * rot[start + k]) / fs;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    for (let a = 0; a < gyros.length; a++) {
      const v = gyros[a][start + k] - means[a];
      re[a] += v * c;
      im[a] -= v * s;
    }
  }
  // Single-sided amplitude per axis, combined across axes as power.
  let power = 0;
  for (let a = 0; a < gyros.length; a++) {
    const amp = (2 * Math.hypot(re[a], im[a])) / length;
    power += amp * amp;
  }
  return power;
}

/**
 * Per-motor once-per-revolution vibration.
 *
 * @param {{gyros: ArrayLike<number>[], erpm: ArrayLike<number>[], sampleRateHz:number, polePairs:number}} input
 *   `gyros` are the axes to combine (roll and pitch, raw gyro preferred).
 * @returns {{available:boolean, reason?:string, motors:object[], outlier:object|null}}
 */
export function perMotorOnceVibration({ gyros, erpm, sampleRateHz, polePairs }, T = MECH_THRESHOLDS) {
  const fs = Number(sampleRateHz);
  const g = (gyros || []).map(toFloat).filter((x) => x && x.length);
  const rots = (erpm || []).map((e) => rotationHz(e, polePairs)).filter(Boolean);
  if (!(fs > 0) || !g.length) return { available: false, reason: '没有陀螺数据', motors: [], outlier: null };
  if (rots.length < 2) return { available: false, reason: '没有 eRPM（需双向 DShot）', motors: [], outlier: null };
  // Nyquist: 1x must sit well below fs/2 to be measurable.
  const n = Math.min(...g.map((x) => x.length), ...rots.map((r) => r.length));
  const win = Math.max(64, Math.round(T.windowS * fs));

  const motors = rots.map((_, index) => ({ index, power: 0, noise: 0, windows: 0, hzSum: 0 }));
  for (let start = 0; start + win <= n; start += win) {
    const meanHz = rots.map((r) => {
      let m = 0;
      let min = Infinity;
      for (let k = 0; k < win; k++) {
        m += r[start + k];
        if (r[start + k] < min) min = r[start + k];
      }
      return { mean: m / win, min };
    });
    for (let i = 0; i < rots.length; i++) {
      const me = meanHz[i];
      if (me.min < T.minRotationHz || me.mean > fs * 0.4) continue;
      // A neighbour at nearly the same speed leaks its 1x into this estimate.
      const crowded = meanHz.some((o, j) => j !== i && Math.abs(o.mean - me.mean) < T.minSeparationHz);
      if (crowded) continue;
      motors[i].power += orderAmplitude(g, rots[i], start, win, fs, 1);
      motors[i].noise += orderAmplitude(g, rots[i], start, win, fs, 1.37);
      motors[i].windows++;
      motors[i].hzSum += me.mean;
    }
  }

  const report = motors.map((m) => ({
    index: m.index,
    windows: m.windows,
    meanHz: m.windows ? round(m.hzSum / m.windows, 0) : 0,
    amplitudeDps: m.windows ? round(Math.sqrt(m.power / m.windows), 2) : null,
    noiseDps: m.windows ? round(Math.sqrt(m.noise / m.windows), 2) : null,
  }));
  const measured = report.filter((m) => m.windows >= T.minWindows && m.amplitudeDps !== null);
  if (measured.length < 2) {
    return { available: false, reason: '各电机转速可分离的时段不足', motors: report, outlier: null };
  }
  for (const m of measured) {
    const others = measured.filter((o) => o.index !== m.index).map((o) => o.amplitudeDps);
    m.ratioToOthers = round(m.amplitudeDps / Math.max(1e-6, median(others)), 2);
    m.snr = round(m.amplitudeDps / Math.max(1e-6, m.noiseDps), 2);
  }
  const candidates = measured.filter((m) => m.ratioToOthers >= T.imbalanceRatio && m.snr >= T.minSnr);
  const outlier = candidates.length ? candidates.reduce((a, b) => (b.ratioToOthers > a.ratioToOthers ? b : a)) : null;
  return { available: true, motors: report.map((m) => measured.find((x) => x.index === m.index) || m), outlier };
}

/* ------------------------------------------------------------------ *
 * Frame resonance vs RPM-tracking noise
 * ------------------------------------------------------------------ */

function averagePsd(signals, starts, size, fs) {
  let acc = null;
  let freqs = null;
  let count = 0;
  for (const sig of signals) {
    for (const start of starts) {
      const spec = welchPsd(sig.subarray(start, start + size), fs, { segmentSize: size, overlap: 0 });
      if (!spec.psd?.length) continue;
      if (!acc) {
        acc = new Float64Array(spec.psd.length);
        freqs = spec.freqs;
      }
      for (let k = 0; k < acc.length; k++) acc[k] += spec.psd[k];
      count++;
    }
  }
  if (!acc || !count) return null;
  return { freqs: Array.from(freqs), psd: Array.from(acc, (v) => v / count), binHz: fs / size, segments: count };
}

/**
 * Split the flight into speed bands (mean motor rotation when eRPM exists,
 * throttle otherwise) and classify raw-gyro peaks as fixed-frequency (frame)
 * or speed-tracking (motor).
 *
 * @param {{gyros: ArrayLike<number>[], speed: ArrayLike<number>, speedUnit:'hz'|'throttle',
 *          sampleRateHz:number, filteredPeaks?: {hz:number, prominenceDb:number}[]}} input
 */
export function classifyResonances({ gyros, speed, speedUnit = 'hz', sampleRateHz, filteredPeaks = [] }, T = MECH_THRESHOLDS) {
  const fs = Number(sampleRateHz);
  const g = (gyros || []).map(toFloat).filter((x) => x && x.length);
  const sp = toFloat(speed);
  const empty = { available: false, bands: [], resonances: [], tracking: [] };
  if (!(fs > 0) || !g.length || !sp) return { ...empty, reason: '缺少陀螺或转速/油门数据' };
  const size = 512;
  const n = Math.min(sp.length, ...g.map((x) => x.length));
  const segs = [];
  for (let start = 0; start + size <= n; start += size / 2) {
    let m = 0;
    for (let k = 0; k < size; k++) m += sp[start + k];
    segs.push({ start, speed: m / size });
  }
  const floor = speedUnit === 'hz' ? T.minRotationHz : 0.15;
  const usable = segs.filter((s) => s.speed >= floor).sort((a, b) => a.speed - b.speed);
  // >= 20 half-overlapped 512-sample segments per band (~2.6 s at 2 kHz): a
  // handful of segments from a crash log produced a bogus "fixed" peak.
  if (usable.length < T.speedBands * T.minSegmentsPerBand) return { ...empty, reason: '可用飞行片段太少' };

  const per = Math.floor(usable.length / T.speedBands);
  const bands = [];
  for (let b = 0; b < T.speedBands; b++) {
    const chunk = usable.slice(b * per, b === T.speedBands - 1 ? usable.length : (b + 1) * per);
    const spectrum = averagePsd(g, chunk.map((c) => c.start), size, fs);
    if (!spectrum) continue;
    const meanSpeed = chunk.reduce((a, c) => a + c.speed, 0) / chunk.length;
    bands.push({
      speed: round(meanSpeed, speedUnit === 'hz' ? 0 : 2),
      segments: chunk.length,
      peaks: findPeaks(spectrum, { maxPeaks: 6, minProminenceDb: 6, minHz: 80 }),
    });
  }
  if (bands.length < 2) return { ...empty, reason: '速度分档不足' };
  const spreadPct = ((bands[bands.length - 1].speed - bands[0].speed) / Math.max(1e-6, bands[0].speed)) * 100;
  if (spreadPct < T.minSpeedSpreadPct) {
    return { ...empty, bands: bands.map(({ peaks, ...b }) => b), reason: `转速变化只有 ${round(spreadPct, 0)}%，无法区分固定共振与电机噪声` };
  }

  const near = (a, b) => Math.abs(a - b) <= Math.max(T.peakToleranceHz, (T.peakTolerancePct / 100) * b);
  const resonances = [];
  const tracking = [];
  const seen = [];
  for (const band of bands) {
    for (const pk of band.peaks) {
      if (seen.some((hz) => near(pk.hz, hz))) continue;
      const fixedIn = bands.filter((b) => b.peaks.some((p) => near(p.hz, pk.hz)));
      // Same order of rotation in another band = the peak moved with speed.
      const ratio = pk.hz / band.speed;
      const movedIn = bands.filter((b) => b !== band && b.peaks.some((p) => Math.abs(p.hz / b.speed - ratio) / ratio < T.trackingRatioTolerance && !near(p.hz, pk.hz)));
      seen.push(pk.hz);
      const strongest = Math.max(...fixedIn.map((b) => b.peaks.find((p) => near(p.hz, pk.hz))?.prominenceDb ?? 0));
      if (fixedIn.length >= 2 && fixedIn.length > movedIn.length && strongest >= T.minResonanceProminenceDb) {
        const survives = (filteredPeaks || []).find((p) => near(p.hz, pk.hz) && p.prominenceDb >= 6);
        resonances.push({
          hz: round(pk.hz, 0),
          prominenceDb: round(strongest, 1),
          bands: fixedIn.length,
          survivesFilter: Boolean(survives),
          filteredProminenceDb: survives ? round(survives.prominenceDb, 1) : null,
        });
      } else if (movedIn.length >= 1) {
        tracking.push({ hz: round(pk.hz, 0), order: round(speedUnit === 'hz' ? ratio : 0, 2), bands: movedIn.length + 1 });
      }
    }
  }
  return {
    available: true,
    speedUnit,
    spreadPct: round(spreadPct, 0),
    bands: bands.map(({ peaks, ...b }) => ({ ...b, peakHz: peaks.map((p) => round(p.hz, 0)) })),
    resonances: resonances.sort((a, b) => b.prominenceDb - a.prominenceDb),
    tracking,
  };
}

/** Does a frequency match a classified frame resonance / tracking peak? */
export function classifyPeak(mechanical, hz) {
  const r = mechanical?.resonance;
  if (!r?.available) return 'unknown';
  const near = (a, b) => Math.abs(a - b) <= Math.max(MECH_THRESHOLDS.peakToleranceHz, (MECH_THRESHOLDS.peakTolerancePct / 100) * b);
  if (r.resonances.some((x) => near(x.hz, hz))) return 'fixed';
  if (r.tracking.some((x) => near(x.hz, hz))) return 'tracking';
  return 'unknown';
}

export default { perMotorOnceVibration, classifyResonances, classifyPeak, rotationHz, MECH_THRESHOLDS };
