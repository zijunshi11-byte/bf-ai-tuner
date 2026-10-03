/**
 * Tests for the operational scaffolding: mandatory backups, the rollback
 * package, the re-fly comparison that drives automatic rollback, and the
 * mass-storage log transfer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BackupStore,
  backupId,
  parseSettings,
  extractSetCommands,
  rollbackSafety,
  majorVersion,
  sanitizeToken,
  formatStamp,
  summarise,
} from '../src/main/backup/backup-store.js';
import { compareRuns, pctChange, maxAcrossAxes, COMPARISONS } from '../src/main/analysis/compare-runs.js';
import { looksLikeFcVolume, listLogFiles, mscAccepted, importLogs, findFcVolumes } from '../src/main/blackbox/msc.js';
import { connectionTroubleshooting, FC_VENDOR_IDS } from '../src/main/msp/msp-transport.js';

/* ------------------------------------------------------------------ *
 * backup naming and parsing
 * ------------------------------------------------------------------ */

test('backup ids carry date, board, firmware, loop rate and note', () => {
  const id = backupId({
    board: 'MAMBAF722_2022A',
    bfVersion: '4.5.1',
    pidHz: 8000,
    note: 'baseline before filter change',
    at: new Date(2026, 9, 3, 20, 15, 0),
  });
  assert.match(id, /^20261003-201500_MAMBAF722_2022A_4\.5\.1_8000Hz_/);
  assert.match(id, /baseline-before-filter-change$/);
  // No separators that would confuse Finder or a shell.
  assert.doesNotMatch(id, /[\/\\:]/);
});

test('naming helpers degrade gracefully on missing input', () => {
  assert.equal(sanitizeToken('', 'fallback'), 'fallback');
  assert.equal(sanitizeToken('a b/c:d'), 'a-b-c-d');
  assert.equal(formatStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  const id = backupId({ at: new Date(2026, 0, 2, 3, 4, 5) });
  assert.match(id, /^20260102-030405_unknown-board_unknown-bf_nohz_manual$/);
});

test('parseSettings reads name = value output and ignores comments', () => {
  const map = parseSettings([
    '# version',
    'p_roll = 45',
    'd_min_roll = 30',
    '',
    'gyro_lpf1_static_hz = 250',
    'not a setting line',
  ].join('\n'));
  assert.equal(map.p_roll, '45');
  assert.equal(map.d_min_roll, '30');
  assert.equal(map.gyro_lpf1_static_hz, '250');
  assert.equal(Object.keys(map).length, 3);
});

test('extractSetCommands pulls only set lines, in order', () => {
  const cmds = extractSetCommands([
    '# diff all',
    'set p_roll = 45',
    'profile 0',
    'set d_min_roll = 30',
    'save',
  ].join('\r\n'));
  assert.deepEqual(cmds, ['set p_roll = 45', 'set d_min_roll = 30']);
});

/* ------------------------------------------------------------------ *
 * restore safety - the rule that protects against cross-board restores
 * ------------------------------------------------------------------ */

test('rollback refuses a different board or a different BF major version', () => {
  assert.equal(majorVersion('4.5.1'), '4');
  assert.equal(majorVersion('2026.6.0-rc3'), '2026');

  const meta = { board: 'MAMBAF722_2022A', bfVersion: '4.5.1' };

  assert.equal(rollbackSafety(meta, { board: 'MAMBAF722_2022A', bfVersion: '4.5.2' }).ok, true);

  const otherBoard = rollbackSafety(meta, { board: 'SPEEDYBEEF7V3', bfVersion: '4.5.1' });
  assert.equal(otherBoard.ok, false);
  assert.match(otherBoard.reasons.join(), /板型不一致/);

  const otherMajor = rollbackSafety(meta, { board: 'MAMBAF722_2022A', bfVersion: '2026.6.0' });
  assert.equal(otherMajor.ok, false);
  assert.match(otherMajor.reasons.join(), /大版本不一致/);
});

/* ------------------------------------------------------------------ *
 * the store itself
 * ------------------------------------------------------------------ */

test('the store round-trips a backup and lists newest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'bf-backups-'));
  try {
    const store = new BackupStore(root);
    const diffAll = '# diff all\nset p_roll = 45\nset gyro_lpf1_static_hz = 250\nsave\n';

    const a = store.create({
      diffAll,
      settings: 'p_roll = 45\ngyro_lpf1_static_hz = 250\n',
      pendingDiff: ['set d_roll = 36'],
      connection: { board: 'MAMBAF722_2022A', bfVersion: '4.5.1', pidHz: 8000 },
      note: 'first',
      at: new Date(2026, 9, 3, 10, 0, 0),
    });
    const b = store.create({
      diffAll,
      connection: { board: 'MAMBAF722_2022A', bfVersion: '4.5.1', pidHz: 8000 },
      note: 'second',
      at: new Date(2026, 9, 3, 11, 0, 0),
    });

    assert.ok(existsSync(a.dir));
    assert.deepEqual(a.summary.params, ['d_roll']);

    const listed = store.list();
    assert.equal(listed.length, 2);
    assert.equal(listed[0].id, b.id, 'newest first');
    assert.equal(listed[1].items, 1, 'the first backup recorded one pending change');

    const got = store.get(a.id);
    assert.equal(got.diffAll, diffAll);
    assert.equal(got.meta.board, 'MAMBAF722_2022A');
    assert.equal(got.meta.restoreKind, 'diff-all');
    assert.equal(got.package.pendingDiff.length, 1);
    assert.equal(store.latest().meta.id, b.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the store refuses to create a backup with no diff all', () => {
  const root = mkdtempSync(join(tmpdir(), 'bf-backups-'));
  try {
    const store = new BackupStore(root);
    assert.throws(() => store.create({ diffAll: '   ' }), /diff all/);
    assert.throws(() => store.create({}), /diff all/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summarise reports the parameters a pending change touches', () => {
  assert.deepEqual(summarise(['set a = 1', 'set b = 2']), { count: 2, params: ['a', 'b'], text: 'a, b' });
  assert.equal(summarise([]).text, '无参数改动');
});

/* ------------------------------------------------------------------ *
 * re-fly comparison
 * ------------------------------------------------------------------ */

function metricsWith(overrides = {}) {
  const axis = (extra = {}) => ({
    gyroRms: 50,
    propwashIndex: 0.2,
    dTermToGyroRatio: 0.2,
    iTermWindupScore: 0.2,
    step: { overshootPct: 10, settlingTimeMs: 60 },
    ...extra,
  });
  return {
    dropRatePct: 0.1,
    motorSaturationPct: 0,
    axes: { roll: axis(), pitch: axis(), yaw: axis() },
    ...overrides,
  };
}

test('pctChange and maxAcrossAxes behave at their edges', () => {
  assert.equal(pctChange(10, 12), 20);
  assert.equal(pctChange(10, 8), -20);
  assert.equal(pctChange(0, 0), 0);
  assert.equal(pctChange(0, 5), null, 'growth from zero has no meaningful percentage');
  assert.equal(pctChange(null, 5), null);

  assert.equal(maxAcrossAxes(metricsWith(), (a) => a.gyroRms), 50);
  assert.equal(maxAcrossAxes(metricsWith({ axes: {} }), (a) => a.gyroRms), 0);
});

test('an unchanged flight is judged unchanged', () => {
  const v = compareRuns(metricsWith(), metricsWith());
  assert.equal(v.verdict, 'unchanged');
  assert.equal(v.shouldRollback, false);
  assert.equal(v.reasons.every((r) => !r.worse), true);
});

test('a clear regression is judged worse and earns an automatic rollback', () => {
  const after = metricsWith({
    axes: {
      roll: { ...metricsWith().axes.roll, step: { overshootPct: 45, settlingTimeMs: 60 }, propwashIndex: 0.9 },
      pitch: metricsWith().axes.pitch,
      yaw: metricsWith().axes.yaw,
    },
  });
  const v = compareRuns(metricsWith(), after);
  assert.equal(v.verdict, 'worse');
  assert.equal(v.shouldRollback, true);
  assert.ok(v.hardWorse >= 1);
  assert.match(v.summary, /判定变差/);
  const overshoot = v.reasons.find((r) => r.key === 'overshoot');
  assert.equal(overshoot.worse, true);
  assert.ok(overshoot.delta > 12);
});

test('a drifting soft metric alone does NOT trigger a rollback', () => {
  // Gyro RMS up 30% (past its 20% tolerance) but nothing hard regressed.
  const after = metricsWith({
    axes: {
      roll: { ...metricsWith().axes.roll, gyroRms: 65 },
      pitch: metricsWith().axes.pitch,
      yaw: metricsWith().axes.yaw,
    },
  });
  const v = compareRuns(metricsWith(), after);
  assert.equal(v.shouldRollback, false);
  assert.equal(v.hardWorse, 0);
});

test('the targeted metric improving while nothing regresses reads as better', () => {
  const after = metricsWith({
    axes: {
      roll: { ...metricsWith().axes.roll, propwashIndex: 0.1, step: { overshootPct: 5, settlingTimeMs: 55 } },
      pitch: { ...metricsWith().axes.pitch, propwashIndex: 0.1 },
      yaw: { ...metricsWith().axes.yaw, propwashIndex: 0.1 },
    },
  });
  const v = compareRuns(metricsWith(), after);
  assert.equal(v.verdict, 'better');
  assert.equal(v.shouldRollback, false);
  assert.match(v.summary, /判定改善/);
});

test('every comparison declares a tolerance and a direction', () => {
  for (const c of COMPARISONS) {
    assert.equal(typeof c.key, 'string');
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.pick, 'function');
    assert.equal(typeof c.worseIsHigher, 'boolean');
    assert.ok(c.tolPct > 0, `${c.key} needs a noise tolerance`);
  }
});

/* ------------------------------------------------------------------ *
 * mass-storage transfer
 * ------------------------------------------------------------------ */

test('only flight-controller volumes are offered', () => {
  assert.equal(looksLikeFcVolume('Betaflight Onboard Flash'), true);
  assert.equal(looksLikeFcVolume('BF_FLASH'), true);
  assert.equal(looksLikeFcVolume('Macintosh HD'), false);
  assert.equal(looksLikeFcVolume(''), false);
});

test('msc acceptance is read from the firmware banner', () => {
  assert.equal(mscAccepted(['# Restarting in mass storage mode', 'Rebooting']), true);
  assert.equal(mscAccepted(['# Storage not present or failed to initialize!']), false);
  assert.equal(mscAccepted([]), false);
});

test('listLogFiles returns log files newest-largest first and skips the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-vol-'));
  try {
    writeFileSync(join(dir, 'btfl_all.bbl'), 'x'.repeat(100));
    writeFileSync(join(dir, 'small.bbl'), 'x');
    writeFileSync(join(dir, 'notes.md'), 'ignored');
    mkdirSync(join(dir, 'subdir'));
    const files = listLogFiles(dir);
    assert.deepEqual(files.map((f) => f.name), ['btfl_all.bbl', 'small.bbl']);
    assert.equal(files[0].size, 100);
    assert.ok(files[0].mtime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importLogs copies the selected files and reports what it could not find', () => {
  const vol = mkdtempSync(join(tmpdir(), 'bf-vol-'));
  const dest = mkdtempSync(join(tmpdir(), 'bf-dest-'));
  try {
    writeFileSync(join(vol, 'flight1.bbl'), 'a'.repeat(10));
    writeFileSync(join(vol, 'flight2.bbl'), 'b'.repeat(20));

    const res = importLogs({ volumePath: vol, files: ['flight1.bbl', 'missing.bbl'], destDir: dest });
    assert.equal(res.ok, true);
    assert.equal(res.imported.length, 1);
    assert.equal(res.imported[0].bytes, 10);
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0].reason, /不存在/);

    // No selection means "everything on the volume".
    const all = importLogs({ volumePath: vol, destDir: dest });
    assert.equal(all.imported.length, 2);
  } finally {
    rmSync(vol, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});

test('importLogs refuses cleanly instead of throwing', () => {
  assert.equal(importLogs({}).ok, false);
  assert.equal(importLogs({ volumePath: '/nope/not/here', destDir: '/tmp' }).ok, false);
  const empty = mkdtempSync(join(tmpdir(), 'bf-vol-'));
  try {
    assert.equal(importLogs({ volumePath: empty, destDir: '/tmp' }).ok, false);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('findFcVolumes tolerates a missing /Volumes root', () => {
  assert.deepEqual(findFcVolumes('/definitely/not/a/real/path'), []);
});

test('connection troubleshooting names the real causes, cheapest first', () => {
  const none = connectionTroubleshooting([]);
  assert.equal(none.found, false);
  assert.ok(none.steps.length >= 4);
  assert.match(none.steps.join(' '), /数据线/, 'the cable is the most common cause and must be mentioned');
  assert.match(none.steps.join(' '), /CP210x|CH340|FTDI/);
  assert.match(none.steps.join(' '), /Web Serial|占用/, 'a port held by another app must be called out');

  const some = connectionTroubleshooting([{ path: '/dev/cu.usbserial-1' }]);
  assert.equal(some.found, true);
  assert.match(some.steps[0], /没有识别为飞控/);
});

test('the vendor list covers the common USB-UART bridges', () => {
  // STM32 VCP, CP210x, CH340, FTDI.
  assert.ok(FC_VENDOR_IDS.has('0x0483'));
  assert.ok(FC_VENDOR_IDS.has('0x10c4'));
  assert.ok(FC_VENDOR_IDS.has('0x1a86'));
  assert.ok(FC_VENDOR_IDS.has('0x0403'));
});
