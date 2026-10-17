/**
 * Evidence sufficiency (replaces the 30 s duration gate, HANDOFF §6.1).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_NEEDS,
  FLIGHT_CARDS,
  assessEvidence,
  domainsForProposal,
  evidenceGapProposal,
  gateProposals,
  normaliseThrottle,
  opensFilter,
  throttleProfile,
} from '../src/main/analysis/evidence.js';
import { proposeTune } from '../src/main/analysis/ai-tune.js';

const RAW_SPECTRUM = { freqs: [0, 100, 200, 300], psd: [1, 1, 1, 1], binHz: 100, segments: 40 };

/** A metrics report whose every domain is satisfied, with per-field overrides. */
function richMetrics({ axes = {}, ...top } = {}) {
  const axis = (name, extra = {}) => ({
    axis: name,
    step: { overshootPct: 5, riseTimeMs: 30, settlingTimeMs: 60, steadyStateErrorPct: 0, latencyMs: 10, samples: 12 },
    trackingCoherence: 0.9,
    transfer: null,
    propwashEvents: 6,
    propwashIndex: 0,
    gyroUnfiltSpectrum: RAW_SPECTRUM,
    gyroSpectrum: RAW_SPECTRUM,
    filterAttenuationDb: 22,
    peaks: [],
    rawPeaks: [],
    dTermToGyroRatio: 0.2,
    iTermWindupScore: 0,
    pidError: { means: [], slopeRatio: 0, samples: 0 },
    ...extra,
  });
  const report = {
    sampleRateHz: 2000,
    durationS: 60,
    sampleQuality: 0.9,
    motorSaturationPct: 0,
    rpmAvailable: 4,
    faults: [],
    throttleProfile: { available: true, bandsS: [10, 20, 20, 10], bandsPct: [17, 33, 33, 17], highS: 8, maxPct: 100 },
    axes: {
      roll: axis('roll', axes.roll),
      pitch: axis('pitch', axes.pitch),
      yaw: axis('yaw', axes.yaw),
    },
    ...top,
  };
  report.evidence = assessEvidence(report);
  return report;
}

/* ---------------- throttle ---------------- */

test('normaliseThrottle recognises rcCommand (1000..2000) and setpoint (0..1000) scales', () => {
  const rc = normaliseThrottle([1000, 1250, 1500, 1750, 2000, 1000, 1500, 2000]);
  assert.deepEqual(Array.from(rc), [0, 0.25, 0.5, 0.75, 1, 0, 0.5, 1]);
  const unit = normaliseThrottle([0, 250, 500, 750, 1000, 0, 500, 1000]);
  assert.deepEqual(Array.from(unit), [0, 0.25, 0.5, 0.75, 1, 0, 0.5, 1]);
});

test('normaliseThrottle refuses an unrecognisable scale instead of guessing', () => {
  assert.equal(normaliseThrottle([-5000, 0, 5000, 9000, 1, 2, 3, 4]), null);
  assert.equal(normaliseThrottle([1, 2]), null);
  assert.equal(normaliseThrottle(null), null);
});

test('throttleProfile reports seconds above the high-throttle level', () => {
  const fs = 100;
  // 3 s at 1800 (80 %), 7 s at 1300 (30 %).
  const values = [...new Array(3 * fs).fill(1800), ...new Array(7 * fs).fill(1300)];
  const p = throttleProfile(values, fs);
  assert.equal(p.available, true);
  assert.equal(p.highS, 3);
  assert.deepEqual(p.bandsS, [0, 7, 0, 3]);
  assert.equal(p.maxPct, 80);
});

test('throttleProfile with an unknown scale claims no high-throttle time', () => {
  const p = throttleProfile(new Array(1000).fill(50000), 100);
  assert.equal(p.available, false);
  assert.equal(p.highS, 0);
});

/* ---------------- assessment ---------------- */

test('a complete log satisfies every evidence domain and asks for no flight', () => {
  const ev = richMetrics().evidence;
  assert.deepEqual(ev.missing, []);
  assert.deepEqual(ev.flights, []);
});

test('missing steps are reported per axis with how many more to fly', () => {
  const ev = richMetrics({ axes: { pitch: { step: { samples: 2 } }, yaw: { step: { samples: 1 } } } }).evidence;
  assert.equal(ev.domains.steps.ok, false);
  assert.equal(ev.domains.steps.axes.roll.ok, true);
  assert.match(ev.domains.steps.advice, /俯仰还差 3 次/);
  assert.match(ev.domains.steps.advice, /偏航还差 2 次/);
  assert.ok(ev.flights.includes('B'));
});

test('tracking needs coherence AND stick excitation on the same axis', () => {
  const lowCoh = richMetrics({ axes: { roll: { trackingCoherence: 0.3 } } }).evidence;
  assert.equal(lowCoh.domains.tracking.axes.roll.ok, false);
  const noSteps = richMetrics({ axes: { roll: { step: { samples: 1 }, trackingCoherence: 0.95 } } }).evidence;
  assert.equal(noSteps.domains.tracking.axes.roll.ok, false, 'a coherent fit with no steps is not trusted');
});

test('opening filters needs high-throttle time even when the spectrum is fine', () => {
  const ev = richMetrics({ throttleProfile: { available: true, bandsS: [30, 30, 0, 0], bandsPct: [50, 50, 0, 0], highS: 0.5, maxPct: 60 } }).evidence;
  assert.equal(ev.domains.noise.ok, true);
  assert.equal(ev.domains.noiseOpen.ok, false);
  assert.match(ev.domains.noiseOpen.advice, /70% 以上油门只有 0\.5 秒/);
  assert.ok(ev.flights.includes('A'));
});

test('no raw gyro means a logging fix, not more flying', () => {
  const ev = richMetrics({
    axes: { roll: { gyroUnfiltSpectrum: null }, pitch: { gyroUnfiltSpectrum: null }, yaw: { gyroUnfiltSpectrum: null } },
  }).evidence;
  assert.equal(ev.domains.logging.ok, false);
  assert.equal(ev.domains.noise.ok, false);
  assert.match(ev.domains.noise.advice, /gyroUnfilt/);
});

test('a 1 kHz floor applies to the noise band', () => {
  const ev = richMetrics({ sampleRateHz: 500 }).evidence;
  assert.equal(ev.domains.logging.ok, false);
  assert.match(ev.domains.logging.advice, /500 Hz/);
});

/* ---------------- gating ---------------- */

test('opensFilter recognises every loosening direction and nothing else', () => {
  assert.equal(opensFilter([{ param: 'dterm_lpf1_static_hz', from: 82, to: 90 }]), true);
  assert.equal(opensFilter([{ param: 'gyro_lpf1_static_hz', from: 250, to: 225 }]), false);
  assert.equal(opensFilter([{ param: 'dterm_lpf1_dyn_max_hz', from: 150, to: 165 }]), true);
  assert.equal(opensFilter([{ param: 'dyn_notch_count', from: 3, to: 2 }]), true);
  assert.equal(opensFilter([{ param: 'rpm_filter_harmonics', from: 3, to: 2 }]), true);
  assert.equal(opensFilter([{ param: 'iterm_relax_cutoff', from: 15, to: 20 }]), false);
  assert.equal(opensFilter([{ param: 'p_roll', from: 45, to: 48 }]), false);
});

test('a filter-opening diff from an unknown rule still needs high-throttle proof', () => {
  assert.deepEqual(domainsForProposal({ id: 'something-new', diff: [{ param: 'gyro_lpf1_static_hz', from: 200, to: 220 }] }), ['noise', 'noiseOpen']);
  assert.equal(domainsForProposal({ id: 'something-new', diff: [{ param: 'p_roll', from: 45, to: 48 }] }), null);
});

test('per-axis gating checks only the axes a proposal changes', () => {
  const ev = richMetrics({ axes: { yaw: { step: { samples: 0 } } } }).evidence;
  const rollFix = { id: 'overshoot-roll', diff: [{ param: 'p_roll', from: 45, to: 42 }] };
  const rpFix = { id: 'overshoot-rp', diff: [{ param: 'p_roll', from: 45, to: 42 }, { param: 'p_pitch', from: 46, to: 43 }] };
  const yawFix = { id: 'overshoot-yaw', diff: [{ param: 'p_yaw', from: 35, to: 33 }] };
  const { kept, withheld } = gateProposals([rollFix, rpFix, yawFix], ev);
  assert.deepEqual(kept.map((p) => p.id), ['overshoot-roll', 'overshoot-rp']);
  assert.deepEqual(withheld, [{ id: 'overshoot-yaw', domains: ['steps'] }]);
});

test('hardware faults and configuration-only advice are never gated', () => {
  const ev = richMetrics({ axes: { roll: { step: { samples: 0 } } }, rpmAvailable: 0 }).evidence;
  const fault = { id: 'fault-MOTOR_DESYNC-0', diff: [] };
  const cfg = { id: 'filter-rpm-inactive', diff: [] };
  const tpa = { id: 'tpa-high-throttle-d', diff: [{ param: 'tpa_rate', from: 50, to: 55 }] };
  const { kept } = gateProposals([fault, cfg, tpa], ev);
  assert.equal(kept.length, 3);
});

test('without an evidence block nothing is gated (unit fixtures)', () => {
  const p = [{ id: 'overshoot-roll', diff: [{ param: 'p_roll', from: 45, to: 42 }] }];
  assert.deepEqual(gateProposals(p, undefined), { kept: p, withheld: [] });
});

test('evidence-gap proposal is six-part, diff-free, never applicable and names the cards to fly', () => {
  const ev = richMetrics({ axes: { roll: { step: { samples: 1 } } }, throttleProfile: { highS: 0 } }).evidence;
  const gap = evidenceGapProposal(ev, [
    { id: 'overshoot-roll', domains: ['steps'] },
    { id: 'filter-dterm-latency', domains: ['noiseOpen'] },
  ]);
  for (const key of ['problem', 'evidence', 'cli', 'why', 'verification', 'ifNotApplied']) assert.ok(key in gap, key);
  assert.deepEqual(gap.diff, []);
  assert.deepEqual(gap.cli, []);
  assert.equal(gap.safeToApply, false);
  assert.equal(gap.category, 'evidence');
  assert.deepEqual(gap.flightCards.sort(), ['A', 'B']);
  assert.match(gap.problem, /2 条建议/);
});

test('flight cards cover every gateable domain and chirp is optional', () => {
  const covered = new Set(FLIGHT_CARDS.filter((c) => !c.optional).flatMap((c) => c.domains));
  for (const d of ['steps', 'tracking', 'propwash', 'noise', 'noiseOpen', 'rpm']) assert.ok(covered.has(d), d);
  assert.equal(FLIGHT_CARDS.find((c) => c.id === 'D').optional, true);
  assert.match(FLIGHT_CARDS.find((c) => c.id === 'B').steps.join(' '), new RegExp(`≥ ${EVIDENCE_NEEDS.stepsPerAxis.roll} 次`));
});

/* ---------------- proposeTune integration ---------------- */

test('proposeTune withholds a D-term LPF opening on a hover-only log and says what to fly', () => {
  // Heavy D-term filtering (60 Hz) triggers the configuration latency rule,
  // which OPENS the filter. Without high-throttle time that is exactly the
  // btfl_003 crash path, so it must be withheld.
  const metrics = richMetrics({ throttleProfile: { available: true, bandsS: [40, 20, 0, 0], bandsPct: [67, 33, 0, 0], highS: 0, maxPct: 45 } });
  const filter = { gyroLpf1Hz: 250, dtermLpf1Hz: 60, rpmFilterHarmonics: 3, bidirDshot: true, itermRelaxCutoff: 30 };
  const pid = { roll: { P: 45, I: 80, D: 30, F: 90 }, pitch: { P: 46, I: 82, D: 31, F: 92 }, yaw: { P: 35, I: 80, D: 0, F: 90 } };
  const proposals = proposeTune({ metrics, currentPid: pid, currentFilter: filter });
  assert.equal(proposals.find((p) => p.id === 'filter-dterm-latency'), undefined);
  const gap = proposals.find((p) => p.id === 'evidence-gap');
  assert.ok(gap, JSON.stringify(proposals.map((p) => p.id)));
  assert.ok(gap.withheld.some((w) => w.id === 'filter-dterm-latency' && w.domains.includes('noiseOpen')));
  assert.ok(gap.flightCards.includes('A'));

  // Same log with high-throttle coverage: the step is allowed (bounded <= 10 %).
  const covered = richMetrics();
  const allowed = proposeTune({ metrics: covered, currentPid: pid, currentFilter: filter });
  const dterm = allowed.find((p) => p.id === 'filter-dterm-latency');
  assert.ok(dterm, JSON.stringify(allowed.map((p) => p.id)));
  assert.ok(dterm.diff[0].to <= Math.ceil(60 * 1.1 / 5) * 5);
  assert.equal(allowed.find((p) => p.id === 'evidence-gap'), undefined);
});

test('the "filters are fine" verdict is not given without a noise spectrum', () => {
  const metrics = richMetrics({
    axes: { roll: { gyroUnfiltSpectrum: null }, pitch: { gyroUnfiltSpectrum: null }, yaw: { gyroUnfiltSpectrum: null } },
  });
  const filter = { gyroLpf1Hz: 250, dtermLpf1Hz: 120, rpmFilterHarmonics: 3, bidirDshot: true, itermRelaxCutoff: 30 };
  const proposals = proposeTune({ metrics, currentPid: null, currentFilter: filter });
  assert.equal(proposals.find((p) => p.id === 'filter-assessment'), undefined);
});

test('the evidence notice never takes one of the three action slots', () => {
  const metrics = richMetrics({ axes: { yaw: { step: { samples: 0 } } } });
  const proposals = proposeTune({ metrics, currentPid: null, currentFilter: null });
  const actions = proposals.filter((p) => p.id !== 'evidence-gap');
  assert.ok(actions.length <= 3);
});

test('a null transfer coherence falls back to the tracking estimate instead of reading as 0', () => {
  const metrics = {
    sampleRateHz: 2000,
    axes: Object.fromEntries(['roll', 'pitch', 'yaw'].map((a) => [a, {
      step: { samples: 9 },
      transfer: { metrics: { meanCoherence: null } },
      trackingCoherence: 0.8,
    }])),
  };
  const ev = assessEvidence(metrics);
  assert.equal(ev.domains.tracking.axes.roll.have, 0.8);
  assert.equal(ev.domains.tracking.ok, true);
});
