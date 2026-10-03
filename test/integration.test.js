/**
 * End-to-end test of the safety-critical path.
 *
 * Drives the real Session -> SafetyGuard -> MspClient -> transport stack against
 * a synthetic flight controller, so the rules that protect the aircraft are
 * exercised as a whole rather than unit by unit:
 *
 *   - an unknown board really does end up read-only
 *   - no flight-behaviour write happens before a backup exists on disk
 *   - apply_tune is genuinely two-phase and the token is genuinely required
 *   - the immutable parameter list is enforced at the last possible moment
 *   - only one tuning round is possible per session
 *
 * Run with: node --test
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Session } from '../src/main/session.js';
import { VirtualTransport } from '../src/main/msp/msp-transport.js';
import { MSP } from '../src/main/msp/msp-codes.js';

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u16 = (v) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff]);
const u32 = (v) => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** Live values the synthetic FC reports for `get`. */
const FC_PARAMS = {
  motor_pwm_protocol: 'DSHOT600',
  dshot_bidir: 'ON',
  rpm_filter_harmonics: 3,
  rpm_filter_q: 500,
  rpm_filter_min_hz: 100,
  gyro_lpf1_static_hz: 250,
  gyro_lpf2_static_hz: 0,
  dterm_lpf1_static_hz: 120,
  dterm_lpf2_static_hz: 0,
  dyn_notch_count: 3,
  dyn_notch_q: 300,
  dyn_notch_min_hz: 100,
  dyn_notch_max_hz: 600,
  p_roll: 45,
  i_roll: 80,
  d_roll: 34,
  f_roll: 120,
  p_pitch: 47,
  i_pitch: 85,
  d_pitch: 36,
  f_pitch: 125,
  p_yaw: 45,
  i_yaw: 80,
  d_yaw: 0,
  f_yaw: 120,
  pid_profile: 0,
};

function makeFc() {
  const boardInfo = concat(
    ascii('S405'),
    u16(1),
    Uint8Array.from([0]),
    Uint8Array.from([0b01000001]),
    ascii('STM32F405'), [0],
    ascii('Test Racer F405'), [0],
    ascii('TST'), [0],
    Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff),
    Uint8Array.from([0]), // mcuTypeId
    Uint8Array.from([0]), // configurationState
    u16(8000), // sampleRateHz
    u32(0),
  );

  const handlers = {
    [MSP.MSP_API_VERSION]: () => Uint8Array.from([0, 1, 46]),
    [MSP.MSP_FC_VARIANT]: () => ascii('BTFL'),
    [MSP.MSP_FC_VERSION]: () => Uint8Array.from([4, 5, 1]),
    [MSP.MSP_BOARD_INFO]: () => boardInfo,
    [MSP.MSP_BUILD_INFO]: () => concat(ascii('Jan 01 2025'), ascii('12:00:00'), ascii('abc1234')),
    [MSP.MSP_NAME]: () => concat(ascii('RacerX'), [0]),
    [MSP.MSP_ADVANCED_CONFIG]: () => concat(Uint8Array.from([1, 1, 0, 5]), u16(480), u16(550)),
    [MSP.MSP_BLACKBOX_CONFIG]: () => concat(Uint8Array.from([1, 1, 1, 4]), u16(32), Uint8Array.from([2]), u32(0)),
    [MSP.MSP_DATAFLASH_SUMMARY]: () => concat(Uint8Array.from([0b11]), u32(512), u32(16 * 1024 * 1024), u32(0)),
    [MSP.MSP_SDCARD_SUMMARY]: () => concat(Uint8Array.from([0, 0, 0]), u32(0), u32(0)),
  };

  const sentCli = [];

  const cliHandler = (text) => {
    const t = text.trim();
    if (t === '#') return ['Entering CLI Mode'];
    if (t === 'exit') return ['Leaving CLI mode'];
    if (t === 'version') return ['# Betaflight / STM32F405 (S405) 4.5.1 Jan 01 2025'];
    if (t === 'status') return ['Gyro detected', 'Arming disabled'];
    if (t === 'dump' || t === 'diff all') {
      return ['# Betaflight / STM32F405 (S405) 4.5.1', '# dump', 'set p_roll = 45', 'set d_roll = 34'];
    }
    if (t === 'save') { sentCli.push(t); return ['Saving']; }
    if (t.startsWith('set ')) {
      sentCli.push(t);
      return [t];
    }
    if (t.startsWith('get ')) {
      const names = t.replace(/^get\s+/, '').split(/\s+/);
      return names.filter((n) => n in FC_PARAMS).map((n) => `${n} = ${FC_PARAMS[n]}`);
    }
    return [];
  };

  return { transport: new VirtualTransport(handlers, { cliHandler }), sentCli };
}

/** Metrics that produce one safe, applicable proposal: propwash on roll+pitch. */
function propwashMetrics() {
  const axis = (name, index) => ({
    axis: name,
    gyroRms: 60,
    gyroPeak: 500,
    noiseFloorDbfs: -40,
    gyroSpectrum: { freqs: [], psd: [], binHz: 1, segments: 1 },
    peaks: [],
    motorNoisePeakHz: 0,
    propwashIndex: index,
    propwashEvents: 6,
    dTermRms: 5,
    dTermToGyroRatio: 0.1,
    step: { overshootPct: 6, riseTimeMs: 40, settlingTimeMs: 60, steadyStateErrorPct: 1, latencyMs: 8, samples: 8 },
    trackingGainDb: 0,
    trackingCoherence: 0.9,
    trackingPhaseDeg: -10,
    iTermWindupScore: 0,
  });

  return {
    file: 'synthetic.bbl',
    logIndex: 0,
    sampleRateHz: 2000,
    durationS: 45,
    dropRatePct: 0.1,
    motorSaturationPct: 2,
    rpmAvailable: 1,
    rpmMin: 1000,
    rpmMax: 25000,
    axes: { roll: axis('roll', 0.55), pitch: axis('pitch', 0.5), yaw: axis('yaw', 0.02) },
    faults: [],
    blocksTuning: false,
    warnings: [],
    sampleQuality: 0.9,
  };
}

let workDir;
let session;
let fc;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'bf-tuner-test-'));
  fc = makeFc();
});

afterEach(async () => {
  try {
    await session?.disconnect();
  } catch {
    /* already gone */
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** A seed model map that makes the synthetic board "known". */
function writeKnownMap() {
  const path = join(workDir, 'model-map.json');
  writeFileSync(path, JSON.stringify({ version: 1, models: { S405: { name: 'Test Racer F405', verified: true } } }));
  return path;
}

async function connect({ known = true } = {}) {
  session = new Session({
    userDataDir: workDir,
    seedMapPath: known ? writeKnownMap() : join(workDir, 'does-not-exist.json'),
    localMapPath: join(workDir, 'model-map.local.json'),
    transportFactory: () => fc.transport,
  });
  await session.connect('/dev/cu.test');
  return session;
}

describe('bidir/RPM scoped writes and history', () => {
  test('applyBidir is two-phase, whitelisted, and requires a backup', async () => {
    await connect();
    await session.identify();

    // No backup yet -> refused even in phase 1.
    const early = await session.applyBidir({ commands: ['set motor_poles = 14'] });
    assert.equal(early.applied, false);
    assert.match(early.reason, /备份/);

    await session.getSettings();

    // Whitelist: everything outside dshot_bidir/motor_poles/rpm_filter_* is blocked.
    const screened = await session.applyBidir({ commands: ['set p_roll = 50', 'set motor_poles = 14'], requireConfirm: true });
    assert.equal(screened.applied, false);
    assert.equal(screened.blocked.length, 1);
    assert.equal(screened.wouldSend.length, 1);
    assert.ok(screened.token, 'phase 1 must issue a token');
    assert.equal(fc.sentCli.length, 0, 'phase 1 must not write');

    // Phase 2 with the token writes via CLI and saves.
    const done = await session.applyBidir({ commands: ['set motor_poles = 14'], requireConfirm: true, token: screened.token });
    assert.equal(done.applied, true, done.reason);
    assert.ok(fc.sentCli.some((c) => c === 'set motor_poles = 14'));
    assert.ok(fc.sentCli.includes('save'), 'the confirmed write must end with save');
  });

  test('proposeTune persists a history report that can be listed and reopened', async () => {
    await connect();
    await session.identify();
    await session.getSettings();

    await session.proposeTune({ metrics: propwashMetrics() });

    const { reports } = await session.listReports();
    assert.equal(reports.length, 1);
    assert.ok(reports[0].summary.proposalCount >= 1);

    const { report } = await session.getReport(reports[0].id);
    assert.equal(report.id, reports[0].id);
    assert.ok(Array.isArray(report.proposals));
    assert.equal(report.metrics.file, 'synthetic.bbl');
  });
});

describe('end-to-end safety path', () => {
  test('an unknown board is identified but forced read-only', async () => {
    await connect({ known: false });

    const identity = await session.identify();

    assert.equal(identity.variant, 'BTFL');
    assert.equal(identity.version, '4.5.1');
    assert.equal(identity.boardIdentifier, 'S405');
    assert.equal(identity.apiVersion, '1.46.0');
    assert.equal(identity.known, false);
    assert.equal(session.guard.readOnly, true);
    assert.match(session.guard.status.reasons.join(' '), /SAFE MODE/);

    // Capabilities are still probed - analysis is allowed, writing is not.
    assert.equal(session.capabilities.pidRateHz, 8000);
    assert.equal(session.capabilities.motorProtocol, 'DSHOT600');
    assert.equal(session.capabilities.rpmFilterActive, true);
  });

  test('identification survives a flight controller stuck in interactive CLI', async () => {
    await connect();

    // Reproduce the reported failure: the FC is sitting in INTERACTIVE CLI, where
    // it accepts framed commands and never answers them. Before the rewrite this
    // wedged the session permanently ("cannot send MSP while in CLI mode").
    fc.transport.wedged = true;
    session.client.cliTimeoutMs = 150;

    const identity = await session.identify();

    // MSP-based identification must still succeed...
    assert.equal(identity.variant, 'BTFL');
    assert.equal(identity.boardIdentifier, 'S405');
    assert.equal(identity.apiVersion, '1.46.0');

    // ...and critically the session must not be left dead. The last thing
    // identify() did was a CLI probe that timed out, so the link is expected to
    // be flagged degraded at this point - that flag is what triggers recovery.
    assert.equal(session.connected, true, 'the port must still be open');

    // The very next MSP call must restore the link on its own.
    const pinged = await session.ping();
    assert.equal(pinged.ok, true, 'MSP must answer after self-recovery');
    assert.equal(session.client.isHealthy, true, 'the link must be healthy again');

    // The recovery had to write the unframed exit text at least once.
    const exitWrites = fc.transport.sent.filter((b) => Buffer.from(b).toString('latin1').includes('exit'));
    assert.ok(exitWrites.length >= 1, 'recovery must try to leave the interactive CLI');
  });

  test('a known board with a signature is an exact match and stays writable', async () => {
    await connect({ known: true });
    const identity = await session.identify();

    assert.equal(identity.known, true);
    assert.equal(identity.matchLevel, 'exact');
    assert.ok(identity.confidence >= 0.9, `confidence was ${identity.confidence}`);
    assert.equal(session.guard.readOnly, false);
  });

  test('capabilities are reachable through the API (property must not shadow the method)', async () => {
    await connect();
    await session.identify();

    // Regression: an instance property named `capabilities` shadowed the
    // prototype method, so this threw "session.capabilities is not a function".
    const caps = await session.probeCapabilities();

    assert.equal(typeof caps, 'object');
    assert.equal(caps.pidRateHz, 8000);
    assert.equal(caps.gyroRateHz, 8000);
    assert.equal(caps.motorProtocol, 'DSHOT600');
    // And the cached value is the same object the rest of the app reads.
    assert.equal(session.capabilities, caps);
  });

  test('getSettings writes a real backup to disk and unlocks writes', async () => {
    await connect();
    await session.identify();
    assert.equal(session.guard.backupDone, false);

    const settings = await session.getSettings();

    assert.equal(session.guard.backupDone, true);
    assert.ok(existsSync(settings.backupPath), 'backup directory should exist');
    assert.match(settings.backupSha256, /^[0-9a-f]{64}$/);

    const files = readdirSync(settings.backupPath).sort();
    assert.deepEqual(files, ['diff-all.txt', 'dump.txt', 'manifest.json', 'read-params.json']);

    // PID and filter values come from CLI, not MSP structs.
    assert.equal(settings.pid.roll.P, 45);
    assert.equal(settings.pid.pitch.D, 36);
    assert.equal(settings.filter.gyroLpf1Hz, 250);
    assert.equal(settings.filter.dynamicNotchEnabled, true);
  });

  test('a tuning write is refused until the backup exists', async () => {
    await connect();
    await session.identify();

    const result = await session.applyTune({
      diff: [{ param: 'p_roll', from: 45, to: 48 }],
      requireConfirm: false,
    });

    assert.equal(result.applied, false);
    assert.match(result.reason, /backup/);
    assert.equal(fc.sentCli.length, 0, 'nothing may reach the FC');
  });

  test('apply_tune is genuinely two-phase and requires the token', async () => {
    await connect();
    await session.identify();
    await session.getSettings();

    const proposals = await session.proposeTune({ metrics: propwashMetrics() });
    const proposal = proposals[0];
    assert.ok(proposal, 'expected at least one proposal');
    assert.equal(proposal.applyGate.ok, true, `gate blocked: ${proposal.applyGate.reasons.join(', ')}`);

    // Phase 1: dry run. Nothing is written.
    const dry = await session.applyTune({ proposalId: proposal.id, diff: proposal.diff, requireConfirm: true });
    assert.equal(dry.applied, false);
    assert.equal(dry.dryRun, true);
    assert.ok(dry.token, 'a confirmation token should be issued');
    assert.ok(dry.wouldSend.length > 0);
    assert.ok(dry.wouldSend.every((c) => c.startsWith('set ')));
    assert.equal(fc.sentCli.length, 0, 'phase 1 must not write');

    // Phase 2 with a wrong token: still nothing.
    const bad = await session.applyTune({ diff: proposal.diff, requireConfirm: true, token: 'not-the-token' });
    assert.equal(bad.applied, false);
    assert.match(bad.reason, /token/);
    assert.equal(fc.sentCli.length, 0);

    // Phase 2 with the real token: the write happens.
    const applied = await session.applyTune({
      diff: proposal.diff,
      requireConfirm: true,
      token: dry.token,
    });
    assert.equal(applied.applied, true, `write failed: ${applied.reason}`);
    assert.deepEqual(applied.cliSent, dry.wouldSend);
    assert.ok(fc.sentCli.length >= 1, 'the FC should have received the commands');
    // Propwash is fixed through the D term. D_min is preferred (it dampens the
    // low-throttle part of the flight without the steady-state D heat), falling
    // back to static D when there is no D_min to work with.
    assert.ok(
      fc.sentCli.some((c) => /^set (d_min_|d_)(roll|pitch) = \d+$/.test(c)),
      `sent: ${fc.sentCli.join(' | ')}`,
    );
  });

  test('only one tuning round is possible per session', async () => {
    await connect();
    await session.identify();
    await session.getSettings();
    const proposals = await session.proposeTune({ metrics: propwashMetrics() });
    const proposal = proposals[0];

    const dry = await session.applyTune({ proposalId: proposal.id, diff: proposal.diff, requireConfirm: true });
    const first = await session.applyTune({ diff: proposal.diff, requireConfirm: true, token: dry.token });
    assert.equal(first.applied, true);
    assert.equal(session.guard.roundsUsed, 1);

    const second = await session.applyTune({ diff: proposal.diff, requireConfirm: false });
    assert.equal(second.applied, false);
    assert.match(second.reason, /single permitted tuning round/);
  });

  test('the immutable parameter list is enforced at the last moment', async () => {
    await connect();
    await session.identify();
    await session.getSettings();

    // A hostile or buggy caller supplies a forbidden parameter directly.
    const result = await session.applyTune({
      diff: [
        { param: 'p_roll', from: 45, to: 48 },
        { param: 'failsafe_throttle', from: 1000, to: 1200 },
      ],
      requireConfirm: false,
    });

    assert.equal(result.applied, false);
    assert.match(result.reason, /immutable safety list/);
    assert.equal(fc.sentCli.length, 0, 'not even the legitimate half may be written');
  });

  test('manual CLI passthrough is screened and defaults to dry-run', async () => {
    await connect();
    await session.identify();
    await session.getSettings();

    const dry = await session.runCli(['set motor_pwm_protocol = DSHOT300', 'set p_roll = 50']);
    assert.equal(dry.ok, false);
    assert.match(dry.reason, /immutable safety list/);
    assert.equal(fc.sentCli.length, 0);

    const ok = await session.runCli(['set blackbox_sample_rate = 4'], { dryRun: true });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.wouldSend, ['set blackbox_sample_rate = 4']);
    assert.equal(fc.sentCli.length, 0, 'dry-run must not write');
  });

  test('blackbox configuration dry-run computes 1/4 for an 8 kHz loop without writing', async () => {
    await connect();
    await session.identify();

    const result = await session.blackboxConfig({ rate: 2000, device: 'auto', dryRun: true });

    assert.equal(result.applied, false);
    assert.equal(result.deviceName, 'SPIFLASH');
    assert.equal(result.ratePlan.denom, 4);
    assert.equal(result.ratePlan.actualRate, 2000);
    assert.ok(result.commands.some((c) => c === 'set blackbox_sample_rate = 4'));
    assert.ok(result.commands.some((c) => c === 'set blackbox_disable_gyro = OFF'));
    assert.equal(fc.sentCli.length, 0);
  });

  test('logging configuration stays available in SAFE MODE', async () => {
    await connect({ known: false });
    await session.identify();
    assert.equal(session.guard.readOnly, true);

    // Safe mode blocks flight-behaviour writes...
    const rc = await session.runCli(['set blackbox_sample_rate = 4'], { dryRun: false, kind: 'tune' });
    assert.equal(rc.ok, false);

    // ...but not logging configuration, which cannot change how it flies.
    const logging = await session.blackboxConfig({ rate: 2000, device: 'auto', dryRun: false });
    assert.equal(logging.applied, true);
    assert.ok(fc.sentCli.some((c) => c === 'set blackbox_sample_rate = 4'));
  });
});
