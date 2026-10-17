/**
 * Wiener-deconvolution step response (PIDtoolbox / PID-Analyzer method).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deconvolveStepResponse, responseMetrics } from '../src/main/analysis/step-deconv.js';

const FS = 2000;

/** Ramped stick moves (40 ms ramps, like RC smoothing) to random rates. */
function stickInput(seconds, seed = 7) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = seconds * FS;
  const sp = new Float64Array(n);
  let target = 0;
  let cur = 0;
  let next = 0;
  const slew = 600 / (0.04 * FS);
  for (let i = 0; i < n; i++) {
    if (i >= next) {
      target = (rnd() * 2 - 1) * 600;
      next = i + Math.round((0.3 + rnd() * 0.5) * FS);
    }
    cur += Math.max(-slew, Math.min(slew, target - cur));
    sp[i] = cur;
  }
  return sp;
}

/** Second-order rate loop with a pure delay and a little sensor noise. */
function plant(sp, { zeta, wnHz = 25, delayS = 0.004, seed = 3 }) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const wn = 2 * Math.PI * wnHz;
  const d = Math.round(delayS * FS);
  const dt = 1 / FS;
  const y = new Float64Array(sp.length);
  let x = 0;
  let v = 0;
  for (let i = 0; i < sp.length; i++) {
    const u = i >= d ? sp[i - d] : 0;
    v += (wn * wn * (u - x) - 2 * zeta * wn * v) * dt;
    x += v * dt;
    y[i] = x + (rnd() - 0.5) * 4;
  }
  return y;
}

const overshootFor = (zeta) => Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)) * 100;

test('deconvolution recovers the overshoot of a known loop from ramped stick input', () => {
  // 20 s of stick work; the band limit shaves a little off a lightly damped
  // peak, so the tolerance is 5 points of overshoot.
  const sp = stickInput(20);
  for (const zeta of [0.35, 0.5, 0.8]) {
    const r = deconvolveStepResponse(sp, plant(sp, { zeta }), FS);
    assert.equal(r.method, 'deconvolution');
    assert.ok(r.samples >= 15, `windows accepted: ${r.samples}`);
    assert.ok(Math.abs(r.overshootPct - overshootFor(zeta)) < 5, `zeta ${zeta}: ${r.overshootPct}% vs ${overshootFor(zeta).toFixed(1)}%`);
    assert.ok(r.steadyStateErrorPct < 5, `final within 5 % of unity: ${r.steadyStateErrorPct}`);
  }
});

test('a longer loop delay reads as a longer 50 % delay', () => {
  const sp = stickInput(12);
  const fast = deconvolveStepResponse(sp, plant(sp, { zeta: 0.6, delayS: 0.003 }), FS);
  const slow = deconvolveStepResponse(sp, plant(sp, { zeta: 0.6, delayS: 0.012 }), FS);
  assert.ok(slow.delay50Ms - fast.delay50Ms > 6, `${fast.delay50Ms} -> ${slow.delay50Ms} ms`);
});

test('hover without stick input yields no windows instead of an invented response', () => {
  const n = 10 * FS;
  const sp = new Float64Array(n).fill(0);
  const gy = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 3);
  const r = deconvolveStepResponse(sp, gy, FS);
  assert.equal(r.samples, 0);
  assert.equal(r.windowsTried, 0);
  assert.equal(r.curve, null);
  assert.equal(r.overshootPct, 0);
});

test('a log shorter than one window and bad inputs return the empty shape', () => {
  assert.equal(deconvolveStepResponse(new Float64Array(100), new Float64Array(100), FS).samples, 0);
  assert.equal(deconvolveStepResponse(null, null, FS).samples, 0);
  assert.equal(deconvolveStepResponse([1, 2, 3], [1, 2, 3], 0).samples, 0);
});

test('the curve starts before the step so the band-limit smear is not cut off', () => {
  const sp = stickInput(8);
  const r = deconvolveStepResponse(sp, plant(sp, { zeta: 0.6 }), FS);
  assert.ok(r.curve.t0Ms < 0);
  assert.ok(r.curve.values.length > 50);
  assert.ok(Math.abs(r.curve.values[0]) < 0.1, 'response is ~0 well before the step');
});

test('responseMetrics on an ideal first-order response', () => {
  const n = 1000;
  const tau = 0.01 * FS;
  const resp = Float64Array.from({ length: n }, (_, k) => 1 - Math.exp(-k / tau));
  const m = responseMetrics(resp, 0, FS);
  assert.equal(m.overshootPct, 0);
  assert.ok(Math.abs(m.delay50Ms - 6.9) < 1, `ln2 * tau = 6.9 ms, got ${m.delay50Ms}`);
  assert.ok(m.steadyStateErrorPct < 1);
});
