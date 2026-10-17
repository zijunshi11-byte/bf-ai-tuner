/**
 * P3: campaign planner, racing scorecard, per-quad journal.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STAGES, annotateStages, planCampaign, stageOf } from '../src/main/analysis/campaign.js';
import { KPIS, buildScorecard, compareScorecards, pt1DelayMs } from '../src/main/analysis/scorecard.js';
import { JournalStore, quadIdFor } from '../src/main/journal/journal-store.js';
import { assessEvidence } from '../src/main/analysis/evidence.js';
import { Session } from '../src/main/session.js';

/* ---------------- campaign ---------------- */

test('stages run logging -> mechanical -> filters -> P/D -> feel', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['logging', 'mechanical', 'filters', 'pd', 'feel']);
});

test('stageOf routes every rule family to its stage', () => {
  assert.equal(stageOf({ id: 'fault-MOTOR_DESYNC-0', category: 'hardware' }), 'mechanical');
  assert.equal(stageOf({ id: 'warn-PROP_IMBALANCE', category: 'hardware' }), 'mechanical');
  assert.equal(stageOf({ id: 'filter-dterm-lpf1', category: 'filter' }), 'filters');
  assert.equal(stageOf({ id: 'filter-residual-peak', category: 'filter' }), 'filters');
  assert.equal(stageOf({ id: 'propwash-rp', category: 'pid' }), 'pd');
  assert.equal(stageOf({ id: 'overshoot-roll', category: 'pid' }), 'pd');
  assert.equal(stageOf({ id: 'tf-tune-rp', category: 'pid' }), 'pd');
  assert.equal(stageOf({ id: 'feedforward-lag-rp', category: 'pid' }), 'feel');
  assert.equal(stageOf({ id: 'i-low-yaw', category: 'pid' }), 'feel');
  assert.equal(stageOf({ id: 'tpa-high-throttle-d', category: 'pid' }), 'feel');
  assert.equal(stageOf({ id: 'filter-iterm-relax-evidence', category: 'filter' }), 'feel');
  assert.equal(stageOf({ id: 'evidence-gap', category: 'evidence' }), null);
});

const diffP = (id, category, param = 'p_roll') => ({ id, category, diff: [{ param, from: 45, to: 42 }], safeToApply: true, blockedBy: [] });

test('a blocking hardware fault parks the campaign at mechanical', () => {
  const metrics = { faults: [{ code: 'MOTOR_DESYNC', severity: 'critical', blocksTuning: true, evidence: 'x' }], evidence: { missing: [] } };
  const plan = planCampaign({ metrics, proposals: [{ id: 'fault-MOTOR_DESYNC-0', category: 'hardware', diff: [] }] });
  assert.equal(plan.current, 'mechanical');
  assert.equal(plan.stages.find((s) => s.id === 'mechanical').status, 'blocked');
  assert.match(plan.summary, /先修硬件/);
});

test('filters come before P/D: a PID proposal is noted, not blocked, while filter work is pending', () => {
  const metrics = { faults: [], evidence: { missing: [] } };
  const proposals = [diffP('filter-dterm-lpf1', 'filter', 'dterm_lpf1_static_hz'), diffP('overshoot-roll', 'pid')];
  const plan = planCampaign({ metrics, proposals });
  assert.equal(plan.current, 'filters');
  assert.equal(plan.stages.find((s) => s.id === 'filters').status, 'action');
  assert.equal(plan.stages.find((s) => s.id === 'pd').status, 'action');
  const annotated = annotateStages(proposals, plan);
  const pid = annotated.find((p) => p.id === 'overshoot-roll');
  assert.equal(pid.stage, 'pd');
  assert.match(pid.stageNote, /先完成「滤波」/);
  // Advisory only: the write path is untouched.
  assert.deepEqual(pid.diff, proposals[1].diff);
  assert.equal(pid.safeToApply, true);
  assert.deepEqual(pid.blockedBy, []);
  assert.equal(annotated.find((p) => p.id === 'filter-dterm-lpf1').stageNote, undefined);
});

test('a withheld proposal marks its stage as needing data', () => {
  const metrics = { faults: [], evidence: { missing: ['steps'] } };
  const gap = { id: 'evidence-gap', category: 'evidence', diff: [], withheld: [{ id: 'overshoot-rp', domains: ['steps'] }] };
  const plan = planCampaign({ metrics, proposals: [gap] });
  assert.equal(plan.stages.find((s) => s.id === 'pd').status, 'needs-data');
  assert.equal(plan.current, 'pd');
  assert.match(plan.summary, /先补飞/);
});

test('with nothing to change the plan says so explicitly', () => {
  const plan = planCampaign({ metrics: { faults: [], evidence: { missing: [] } }, proposals: [{ id: 'filter-assessment', category: 'filter', diff: [] }] });
  assert.equal(plan.current, null);
  assert.match(plan.summary, /没有需要改动/);
});

test('an unbalanced prop is a mechanical check before any tuning', () => {
  const metrics = { faults: [{ code: 'PROP_IMBALANCE', severity: 'warn', blocksTuning: false, evidence: 'M2' }], evidence: { missing: [] } };
  const plan = planCampaign({ metrics, proposals: [diffP('filter-dterm-lpf1', 'filter', 'dterm_lpf1_static_hz')] });
  assert.equal(plan.current, 'mechanical');
  assert.equal(plan.stages.find((s) => s.id === 'mechanical').status, 'check');
});

/* ---------------- scorecard ---------------- */

function scoreMetrics(overrides = {}) {
  const axis = (extra = {}) => ({
    stepDeconv: { samples: 40, delay50Ms: 9, overshootPct: 12 },
    propwashEvents: 5,
    propwashIndex: 0.2,
    dTermToGyroRatio: 0.22,
    filterAttenuationDb: 21,
    ...extra,
  });
  return {
    motorSaturationPct: 2,
    craftSettings: { filter: { gyroLpf1Hz: 250, dtermLpf1Hz: 100 } },
    axes: { roll: axis(overrides.roll), pitch: axis(overrides.pitch), yaw: axis(overrides.yaw) },
  };
}

test('scorecard KPIs come from the report and grade against racing references', () => {
  const card = buildScorecard(scoreMetrics({ pitch: { stepDeconv: { samples: 40, delay50Ms: 16, overshootPct: 35 } } }));
  const k = Object.fromEntries(card.kpis.map((x) => [x.key, x]));
  assert.equal(k.delayMs.value, 16);
  assert.equal(k.delayMs.grade, 'crit');
  assert.equal(k.overshootPct.value, 35);
  assert.equal(k.overshootPct.grade, 'crit');
  assert.equal(k.propwash.grade, 'ok');
  assert.equal(k.noiseAttenuationDb.value, 21);
  assert.equal(k.noiseAttenuationDb.grade, 'ok', 'more attenuation is better');
  // D-term LPF at 100 Hz -> 1.59 ms first-order delay dominates.
  assert.equal(k.filterDelayMs.value, 1.6);
  assert.equal(k.filterDelayMs.grade, 'warn');
  assert.equal(card.kpis.length, KPIS.length);
});

test('a KPI without its measurement is n/a, never zero', () => {
  const card = buildScorecard({ axes: { roll: {}, pitch: {}, yaw: {} } });
  const k = Object.fromEntries(card.kpis.map((x) => [x.key, x]));
  assert.equal(k.delayMs.value, null);
  assert.equal(k.delayMs.grade, 'na');
  assert.equal(k.filterDelayMs.value, null);
});

test('compareScorecards reports better / worse in each KPI\'s own sense', () => {
  const before = buildScorecard(scoreMetrics());
  const after = buildScorecard(scoreMetrics({
    roll: { stepDeconv: { samples: 40, delay50Ms: 7, overshootPct: 12 }, filterAttenuationDb: 15 },
    pitch: { stepDeconv: { samples: 40, delay50Ms: 7, overshootPct: 12 }, filterAttenuationDb: 15 },
    yaw: { filterAttenuationDb: 15 },
  }));
  const d = Object.fromEntries(compareScorecards(before, after).map((x) => [x.key, x]));
  assert.equal(d.delayMs.direction, 'better');
  assert.equal(d.noiseAttenuationDb.direction, 'worse');
  assert.equal(d.propwash.direction, 'same');
});

test('pt1DelayMs is 1/(2 pi fc)', () => {
  assert.ok(Math.abs(pt1DelayMs(100) - 1.5915) < 1e-3);
  assert.equal(pt1DelayMs(0), 0);
  assert.equal(pt1DelayMs(null), 0);
});

/* ---------------- journal store ---------------- */

test('quadIdFor makes stable, path-safe ids', () => {
  assert.equal(quadIdFor({ craftName: 'My Racer 5"' }), 'my-racer-522');
  assert.equal(quadIdFor({ craftName: '竞速一号' }), quadIdFor({ craftName: '竞速一号' }));
  assert.notEqual(quadIdFor({ craftName: '竞速一号' }), quadIdFor({ craftName: '竞速二号' }));
  assert.equal(quadIdFor({ board: 'MAMBAF722_2022A' }), 'mambaf722-2022a');
  assert.equal(quadIdFor({}), 'unnamed-quad');
  assert.match(quadIdFor({ craftName: '../../etc/passwd' }), /^[a-z0-9][a-z0-9-]*$/);
});

test('journal: append creates the quad, list and get read it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-journal-'));
  try {
    const store = new JournalStore(dir);
    store.append('racer-a', { kind: 'analysis', stage: 'filters' }, { craftName: 'Racer A', board: 'F722' });
    store.append('racer-a', { kind: 'apply', diff: [{ param: 'p_roll', from: 45, to: 42 }] });
    const quads = store.list();
    assert.equal(quads.length, 1);
    assert.equal(quads[0].entries, 2);
    assert.equal(quads[0].profile.name, 'Racer A');
    assert.equal(quads[0].board, 'F722');
    const doc = store.get('racer-a');
    assert.deepEqual(doc.entries.map((e) => e.kind), ['analysis', 'apply']);
    assert.ok(doc.entries.every((e) => typeof e.at === 'string'));
    assert.deepEqual(readdirSync(dir), ['racer-a.json'], 'no temp files left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal: profile fields are whitelisted and range-checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-journal-'));
  try {
    const store = new JournalStore(dir);
    const profile = store.setProfile('racer-b', { name: 'B', motorKv: 1950, cells: 6, weightG: 999999, evil: 'x', props: 'HQ 5.1x3x3' });
    assert.equal(profile.name, 'B');
    assert.equal(profile.motorKv, 1950);
    assert.equal(profile.cells, 6);
    assert.equal(profile.weightG, undefined, 'out-of-range weight is dropped');
    assert.equal(profile.evil, undefined);
    assert.equal(profile.props, 'HQ 5.1x3x3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('journal: path traversal ids, bad kinds and empty notes are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-journal-'));
  try {
    const store = new JournalStore(dir);
    assert.throws(() => store.append('../escape', { kind: 'note', text: 'x' }), /invalid quad id/);
    assert.throws(() => store.get('../../etc/passwd'), /invalid quad id/);
    assert.throws(() => store.append('ok-id', { kind: 'write-fc' }), /invalid journal entry kind/);
    assert.throws(() => store.addNote('ok-id', '   '), /empty/);
    assert.equal(store.get('never-seen'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- session integration ---------------- */

test('Session.proposeTune records an analysis entry and serves the plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-session-journal-'));
  try {
    const session = new Session({ userDataDir: dir, seedMapPath: join(dir, 'none.json'), localMapPath: join(dir, 'local.json') });
    const metrics = {
      file: 'x.bbl',
      sampleRateHz: 2000,
      sampleQuality: 0.9,
      motorSaturationPct: 0,
      rpmAvailable: 4,
      faults: [],
      craft: { name: 'Racer C', board: 'F722', firmware: '4.5' },
      throttleProfile: { available: true, highS: 0, bandsS: [1, 1, 0, 0], bandsPct: [50, 50, 0, 0], maxPct: 45 },
      craftSettings: { filter: { gyroLpf1Hz: 250, dtermLpf1Hz: 60, rpmFilterHarmonics: 3, bidirDshot: true, itermRelaxCutoff: 30 } },
      axes: Object.fromEntries(['roll', 'pitch', 'yaw'].map((a) => [a, {
        step: { samples: 0 },
        gyroUnfiltSpectrum: { freqs: [0, 1], psd: [1, 1], segments: 40 },
        filterAttenuationDb: 22,
        peaks: [],
        rawPeaks: [],
        propwashEvents: 5,
        dTermToGyroRatio: 0.1,
      }])),
    };
    metrics.evidence = assessEvidence(metrics);
    const proposals = await session.proposeTune({ metrics });
    assert.ok(Array.isArray(proposals), 'renderer contract: a bare array');
    const { plan, scorecard, quadId } = session.getPlan();
    assert.equal(quadId, 'racer-c');
    assert.ok(plan.stages.length === 5);
    assert.ok(scorecard.kpis.length > 0);
    const { quad } = session.getQuad('racer-c');
    assert.equal(quad.entries.length, 1);
    assert.equal(quad.entries[0].kind, 'analysis');
    assert.equal(quad.entries[0].stage, plan.current);
    assert.ok(quad.entries[0].missing.includes('noiseOpen'));
    assert.equal(session.listQuads().quads[0].id, 'racer-c');
    session.addQuadNote('racer-c', '换了 HQ 5.1 桨');
    assert.equal(session.getQuad('racer-c').quad.entries.at(-1).kind, 'note');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
