/**
 * Mechanical health: per-motor once-per-rev vibration and fixed-vs-moving
 * resonance classification.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyPeak, classifyResonances, perMotorOnceVibration, rotationHz } from '../src/main/analysis/mechanical.js';
import { proposeTune } from '../src/main/analysis/ai-tune.js';

const FS = 2000;
const POLE_PAIRS = 7;

/**
 * Four motors sweeping 150..450 Hz out of phase with each other, gyro made of
 * each motor's 1x (amplitudes `amps`), an optional fixed resonance, and noise.
 */
function synthFlight({ seconds = 24, amps = [0.5, 0.5, 0.5, 0.5], resonanceHz = 0, sweep = 150 } = {}) {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const n = seconds * FS;
  const rot = [0, 1, 2, 3].map((m) =>
    Float64Array.from({ length: n }, (_, i) => 300 + sweep * Math.sin((2 * Math.PI * i) / (FS * 9) + m * 0.3) + m * 7 + (rnd() - 0.5) * 2),
  );
  const erpm = rot.map((r) => Float64Array.from(r, (hz) => (hz * 60 * POLE_PAIRS) / 100));
  const roll = new Float64Array(n);
  const pitch = new Float64Array(n);
  const phase = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    let r = (rnd() - 0.5) * 6;
    let p = (rnd() - 0.5) * 6;
    for (let m = 0; m < 4; m++) {
      phase[m] += (2 * Math.PI * rot[m][i]) / FS;
      r += amps[m] * Math.cos(phase[m]);
      p += amps[m] * Math.sin(phase[m] + m);
    }
    if (resonanceHz) {
      r += 2.5 * Math.sin((2 * Math.PI * resonanceHz * i) / FS);
      p += 2.5 * Math.cos((2 * Math.PI * resonanceHz * i) / FS);
    }
    roll[i] = r;
    pitch[i] = p;
  }
  const speed = Float64Array.from({ length: n }, (_, i) => (rot[0][i] + rot[1][i] + rot[2][i] + rot[3][i]) / 4);
  return { roll, pitch, erpm, speed };
}

test('rotationHz converts Betaflight eRPM/100 to mechanical Hz', () => {
  // 14 poles = 7 pole pairs; 2100 x 100 eRPM / 7 / 60 = 500 Hz.
  assert.deepEqual(Array.from(rotationHz([2100, 0, -5], 7)), [500, 0, 0]);
  assert.equal(rotationHz([1, 2], 0), null);
});

test('one unbalanced prop is named by motor number', () => {
  const f = synthFlight({ amps: [0.5, 3, 0.5, 0.6] });
  const r = perMotorOnceVibration({ gyros: [f.roll, f.pitch], erpm: f.erpm, sampleRateHz: FS, polePairs: POLE_PAIRS });
  assert.equal(r.available, true);
  assert.ok(r.outlier, JSON.stringify(r.motors));
  assert.equal(r.outlier.index, 1);
  assert.ok(r.outlier.ratioToOthers >= 1.8);
  assert.ok(r.outlier.snr >= 2.5);
});

test('balanced props raise no outlier', () => {
  const f = synthFlight({ amps: [0.6, 0.5, 0.55, 0.6] });
  const r = perMotorOnceVibration({ gyros: [f.roll, f.pitch], erpm: f.erpm, sampleRateHz: FS, polePairs: POLE_PAIRS });
  assert.equal(r.available, true);
  assert.equal(r.outlier, null);
});

test('without eRPM the prop check reports itself unavailable instead of guessing', () => {
  const f = synthFlight();
  const r = perMotorOnceVibration({ gyros: [f.roll], erpm: [], sampleRateHz: FS, polePairs: POLE_PAIRS });
  assert.equal(r.available, false);
  assert.match(r.reason, /eRPM/);
});

test('motors locked at the same speed cannot be separated and say so', () => {
  const f = synthFlight({ amps: [0.5, 3, 0.5, 0.5] });
  const same = f.erpm.map(() => f.erpm[0]);
  const r = perMotorOnceVibration({ gyros: [f.roll, f.pitch], erpm: same, sampleRateHz: FS, polePairs: POLE_PAIRS });
  assert.equal(r.available, false);
  assert.equal(r.outlier, null);
});

test('a fixed frame resonance is told apart from motor noise that moves with RPM', () => {
  const f = synthFlight({ amps: [0.5, 3, 0.5, 0.6], resonanceHz: 180 });
  const r = classifyResonances({
    gyros: [f.roll, f.pitch],
    speed: f.speed,
    speedUnit: 'hz',
    sampleRateHz: FS,
    filteredPeaks: [{ hz: 181, prominenceDb: 10 }],
  });
  assert.equal(r.available, true);
  const fixed = r.resonances.find((x) => Math.abs(x.hz - 180) <= 6);
  assert.ok(fixed, JSON.stringify(r));
  assert.ok(fixed.bands >= 2);
  assert.equal(fixed.survivesFilter, true);
  assert.ok(r.tracking.length >= 1, 'the unbalanced motor 1x moves with speed');
  assert.ok(r.tracking.every((t) => Math.abs(t.hz - 180) > 6));
});

test('without enough speed spread the classifier refuses to classify', () => {
  const f = synthFlight({ resonanceHz: 180, sweep: 10 });
  const r = classifyResonances({ gyros: [f.roll], speed: f.speed, speedUnit: 'hz', sampleRateHz: FS });
  assert.equal(r.available, false);
  assert.match(r.reason, /转速变化只有/);
});

test('a few seconds of log are not enough to classify resonances', () => {
  const f = synthFlight({ seconds: 4, resonanceHz: 180 });
  const r = classifyResonances({ gyros: [f.roll], speed: f.speed, speedUnit: 'hz', sampleRateHz: FS });
  assert.equal(r.available, false);
  assert.match(r.reason, /片段太少/);
});

test('classifyPeak answers fixed / tracking / unknown', () => {
  const mech = { resonance: { available: true, resonances: [{ hz: 200 }], tracking: [{ hz: 450 }] } };
  assert.equal(classifyPeak(mech, 203), 'fixed');
  assert.equal(classifyPeak(mech, 455), 'tracking');
  assert.equal(classifyPeak(mech, 320), 'unknown');
  assert.equal(classifyPeak({ resonance: { available: false } }, 200), 'unknown');
  assert.equal(classifyPeak(null, 200), 'unknown');
});

/* ---------------- residual-peak rule uses the classification ---------------- */

function residualMetrics(mechanical) {
  const axis = (extra = {}) => ({
    step: { overshootPct: 0, riseTimeMs: 0, settlingTimeMs: 0, steadyStateErrorPct: 0, latencyMs: 0, samples: 0 },
    peaks: [],
    rawPeaks: [],
    filterAttenuationDb: 22,
    gyroUnfiltSpectrum: { freqs: [0, 1], psd: [1, 1], segments: 40 },
    dTermToGyroRatio: 0.1,
    ...extra,
  });
  return {
    sampleQuality: 0.9,
    motorSaturationPct: 0,
    rpmAvailable: 4,
    faults: [],
    axes: { roll: axis({ peaks: [{ hz: 475, prominenceDb: 14 }] }), pitch: axis(), yaw: axis() },
    mechanical,
  };
}
const FILTER = { gyroLpf1Hz: 250, dtermLpf1Hz: 120, rpmFilterHarmonics: 3, bidirDshot: true, itermRelaxCutoff: 30, gyroNotch1Hz: 0, gyroNotch1CutoffHz: 0 };

test('a residual peak that moves with motor speed gets no static notch', () => {
  const mech = {
    resonance: {
      available: true,
      bands: [{ speed: 258, peakHz: [289] }, { speed: 356, peakHz: [375] }, { speed: 437, peakHz: [473] }],
      resonances: [],
      tracking: [{ hz: 473, order: 1.08, bands: 3 }],
    },
  };
  const p = proposeTune({ metrics: residualMetrics(mech), currentPid: null, currentFilter: FILTER }).find((x) => x.id === 'filter-residual-peak');
  assert.ok(p);
  assert.deepEqual(p.diff, []);
  assert.equal(p.safeToApply, false);
  assert.match(p.evidence, /随转速移动/);
  assert.match(p.verification, /rpm_filter_harmonics/);
});

test('a fixed frame resonance keeps the static notch and says it is the frame', () => {
  const mech = {
    resonance: { available: true, bands: [], resonances: [{ hz: 475, prominenceDb: 20, bands: 3, survivesFilter: true }], tracking: [] },
  };
  const p = proposeTune({ metrics: residualMetrics(mech), currentPid: null, currentFilter: FILTER }).find((x) => x.id === 'filter-residual-peak');
  assert.ok(p);
  assert.ok(p.diff.some((d) => d.param === 'gyro_notch1_hz' && d.to === 475));
  assert.match(p.evidence, /机架/);
});
