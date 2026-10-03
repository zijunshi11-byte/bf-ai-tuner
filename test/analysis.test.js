/**
 * Tests for the blackbox decoding + signal analysis layer.
 *
 * The centrepiece is a test-only BBL *encoder*: it writes a real header plus
 * I-frames and P-frames (encodings 0/1/6/7/8, predictors 0/1/2/6/11) exactly the
 * way the firmware does, so `decodeBbl` has to round-trip actual bytes rather
 * than mock data.
 *
 * Run with: node --test test/
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decodeBbl, decodeLog, findLogBoundaries, parseLogHeader } from '../src/main/analysis/bbl-decode.js';
import { bandPower, findPeaks, matchRpmHarmonics, noiseFloorDbfs, welchPsd } from '../src/main/analysis/bbl-fft.js';
import {
  computeMetrics,
  computeSampleQuality,
  detectDescentSegments,
  estimateStepResponse,
  iTermWindupScore,
  trackingMetrics,
} from '../src/main/analysis/bbl-metrics.js';

/* ------------------------------------------------------------------ *
 * Test-only blackbox encoder
 * ------------------------------------------------------------------ */

const PRODUCT_LINE = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';

const ENC = { SIGNED_VB: 0, UNSIGNED_VB: 1, TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9 };
const PRED = { ZERO: 0, PREVIOUS: 1, STRAIGHT_LINE: 2, INC: 6, MINMOTOR: 11 };

/** Unsigned variable-byte (7 bits per byte, little endian, high bit = continue). */
function uvb(value) {
  let v = Math.trunc(value);
  if (v < 0) v = 0;
  const out = [];
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

/** Signed VB: zig-zag then unsigned VB (matches readSignedVB). */
function svb(value) {
  const v = Math.trunc(value);
  return uvb(v < 0 ? -v * 2 - 1 : v * 2);
}

function bytesOf(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) out.push(text.codePointAt(i));
  return out;
}

/**
 * A field specification:
 *   { name, i: {encoding, predictor}, p: {encoding, predictor}, value(index) }
 */
function field(name, iDef, pDef, value) {
  return { name, i: iDef, p: pDef, value };
}

/** Prediction the firmware subtracts before writing (mirrors applyPrediction). */
function predictionFor(predictor, index, previous, previous2, current, opts) {
  switch (predictor) {
    case PRED.ZERO:
      return 0;
    case PRED.PREVIOUS:
      return previous ? previous[index] : 0;
    case PRED.STRAIGHT_LINE:
      return previous && previous2 ? 2 * previous[index] - previous2[index] : previous ? previous[index] : 0;
    case PRED.MINMOTOR:
      return opts.motorOutputMin;
    default:
      return 0;
  }
}

/**
 * Encode one frame body. Grouped encodings consume 3, 4 or a run of fields at
 * once, exactly like their decoders in vendor/betaflight/decoders.js.
 */
function encodeFrameBody(spec, values, previous, previous2, opts) {
  const bytes = [];
  let i = 0;
  while (i < spec.length) {
    const { encoding, predictor } = spec[i];

    if (predictor === PRED.INC) {
      i++; // INC fields are derived, nothing is written
      continue;
    }

    if (encoding === ENC.TAG2_3S32) {
      // Case 3 selector with one signed byte per value (leadByte >> 6 === 3).
      bytes.push(0xc0);
      for (let g = 0; g < 3; g++) {
        const delta = values[i + g] - predictionFor(spec[i + g].predictor, i + g, previous, previous2, values, opts);
        assert.ok(delta >= -128 && delta <= 127, `TAG2_3S32 8-bit delta out of range for ${spec[i + g].name}: ${delta}`);
        bytes.push(delta & 0xff);
      }
      i += 3;
      continue;
    }

    if (encoding === ENC.TAG8_4S16) {
      // Selector 0xff => four 16-bit big-endian values (data version >= 2).
      bytes.push(0xff);
      for (let g = 0; g < 4; g++) {
        const delta = values[i + g] - predictionFor(spec[i + g].predictor, i + g, previous, previous2, values, opts);
        assert.ok(delta >= -32768 && delta <= 32767, `TAG8_4S16 delta out of range for ${spec[i + g].name}: ${delta}`);
        const raw = delta & 0xffff;
        bytes.push((raw >> 8) & 0xff, raw & 0xff);
      }
      i += 4;
      continue;
    }

    if (encoding === ENC.TAG8_8SVB) {
      let run = 0;
      while (i + run < spec.length && spec[i + run].encoding === ENC.TAG8_8SVB) run++;
      assert.ok(run >= 2, 'TAG8_8SVB requires a run of at least 2 fields');
      const group = spec.slice(i, i + run);
      let headerByte = 0;
      const payload = [];
      for (let g = 0; g < group.length; g++) {
        const delta = values[i + g] - predictionFor(group[g].predictor, i + g, previous, previous2, values, opts);
        headerByte |= 1 << g;
        payload.push(...svb(delta));
      }
      bytes.push(headerByte, ...payload);
      i += run;
      continue;
    }

    const delta = values[i] - predictionFor(predictor, i, previous, previous2, values, opts);
    switch (encoding) {
      case ENC.SIGNED_VB:
        bytes.push(...svb(delta));
        break;
      case ENC.UNSIGNED_VB:
        assert.ok(delta >= 0, `unsigned VB field ${spec[i].name} would need to write ${delta}`);
        bytes.push(...uvb(delta));
        break;
      case ENC.NULL:
        break;
      default:
        throw new Error(`test encoder does not implement encoding ${encoding}`);
    }
    i++;
  }
  return bytes;
}

/** Header lines describing the I/P/S frame definitions and the log config. */
function headerLines(spec, options) {
  const names = spec.map((f) => f.name).join(',');
  const lines = [
    PRODUCT_LINE,
    'H Data version:2',
    `H Firmware revision:${options.firmware ?? 'BTFL 4.5.0 (abcdef) STM32F405'}`,
    'H Craft name:SYNTHQUAD',
    `H I interval:${options.iIntervalLoops}`,
    `H P interval:${options.pIntervalHeader}`,
    `H looptime:${options.looptime}`,
    'H gyro_scale:0x3f800000',
    `H motorOutput:${options.motorOutputMin},2047`,
    'H maxthrottle:2000',
    'H minthrottle:1070',
    'H vbatref:4095',
    `H motor_poles:14`,
    `H Field I name:${names}`,
    `H Field I signed:${spec.map((f) => (f.i.encoding === ENC.UNSIGNED_VB ? 0 : 1)).join(',')}`,
    `H Field I predictor:${spec.map((f) => f.i.predictor).join(',')}`,
    `H Field I encoding:${spec.map((f) => f.i.encoding).join(',')}`,
    `H Field P predictor:${spec.map((f) => f.p.predictor).join(',')}`,
    `H Field P encoding:${spec.map((f) => f.p.encoding).join(',')}`,
    'H Field S name:flightModeFlags',
    'H Field S signed:0',
    'H Field S predictor:0',
    'H Field S encoding:1',
  ];
  return lines;
}

/**
 * Build a complete synthetic BBL file.
 *
 * @returns {{buffer: Uint8Array, expected: object}}
 */
function buildSyntheticLog(options = {}) {
  const sampleCount = options.sampleCount ?? 4000;
  const sampleRateHz = options.sampleRateHz ?? 2000;
  const looptime = 125;
  const pIntervalHeader = options.pIntervalHeader ?? '1/4';
  const loopsPerFrame = options.pIntervalHeader === '4' ? 4 : 4;
  const iIntervalLoops = options.iIntervalLoops ?? 32;
  const spec = options.spec;
  const motorOutputMin = 1000;
  const opts = { motorOutputMin };

  const timeUs = [];
  const loopIteration = [];
  const values = []; // values[fieldIndex][] = per-sample value
  for (let f = 0; f < spec.length; f++) values.push([]);

  for (let n = 0; n < sampleCount; n++) {
    const loop = n * loopsPerFrame;
    const isIFrame = loop % iIntervalLoops === 0;
    timeUs.push(1_500_000 + n * Math.round(1e6 / sampleRateHz));
    loopIteration.push(options.absoluteIterationGapAt === n ? loop + (options.absoluteIterationGapLoops ?? 8) : loop);
    for (let f = 0; f < spec.length; f++) {
      values[f].push(spec[f].value(n, { isIFrame, loop, sampleRateHz, loopIteration: loopIteration[n] }));
    }
  }

  const bytes = [];
  for (const line of headerLines(spec, { iIntervalLoops, pIntervalHeader, looptime, motorOutputMin, firmware: options.firmware })) {
    bytes.push(...bytesOf(line), 0x0a);
  }

  const iSpec = spec.map((f) => ({ ...f, ...f.i }));
  const pSpec = spec.map((f) => ({ ...f, ...f.p }));
  const fieldIndices = {};
  spec.forEach((f, index) => {
    fieldIndices[f.name] = index;
  });
  const valueRow = (n) => spec.map((f, index) => values[index][n]);

  let previous = null;
  let previous2 = null;
  let lastIFrame = null;
  let frameCount = 0;

  for (let n = 0; n < sampleCount; n++) {
    const loop = n * loopsPerFrame;
    const isIFrame = loop % iIntervalLoops === 0;
    const row = valueRow(n);

    if (isIFrame) {
      if (options.insertSlowFrameAt === n) bytes.push(0x53, ...uvb(11));
      bytes.push(0x49);
      bytes.push(...encodeFrameBody(iSpec, row, lastIFrame, null, opts));
      lastIFrame = row;
      previous = row;
      previous2 = row; // both history slots become the I-frame (firmware rule)
      frameCount++;
    } else {
      if (options.insertSlowFrameAt === n) bytes.push(0x53, ...uvb(11));
      bytes.push(0x50);
      bytes.push(...encodeFrameBody(pSpec, row, previous, previous2, opts));
      previous2 = previous;
      previous = row;
      frameCount++;
    }
  }

  bytes.push(0x45, 255, ...bytesOf('End of log\0'));

  return {
    buffer: Uint8Array.from(bytes),
    expected: {
      sampleCount,
      sampleRateHz,
      frameCount,
      timeUs,
      loopIteration,
      values,
      spec,
      fieldIndices,
      durationS: (timeUs[timeUs.length - 1] - timeUs[0]) / 1e6,
    },
  };
}

/** The field set used by most decoder tests. */
function standardSpec() {
  return [
    field('loopIteration', { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.NULL, predictor: PRED.INC }, (n, ctx) => ctx.loopIteration),
    field('time', { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.STRAIGHT_LINE }, (n, ctx) => 1_500_000 + n * Math.round(1e6 / ctx.sampleRateHz)),
    field('gyroADC[0]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(120 * Math.sin((2 * Math.PI * 50 * n) / ctx.sampleRateHz))),
    field('gyroADC[1]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(90 * Math.sin((2 * Math.PI * 70 * n) / ctx.sampleRateHz + 0.5))),
    field('gyroADC[2]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(40 * Math.sin((2 * Math.PI * 30 * n) / ctx.sampleRateHz + 1.1))),
    field('setpoint[0]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(100 * Math.sin((2 * Math.PI * 20 * n) / ctx.sampleRateHz))),
    field('setpoint[1]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(80 * Math.sin((2 * Math.PI * 25 * n) / ctx.sampleRateHz))),
    field('setpoint[2]', { encoding: ENC.SIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => Math.round(20 * Math.sin((2 * Math.PI * 10 * n) / ctx.sampleRateHz))),
    field('motor[0]', { encoding: ENC.UNSIGNED_VB, predictor: PRED.MINMOTOR }, { encoding: ENC.SIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => 1200 + Math.round(150 * Math.sin((2 * Math.PI * 5 * n) / ctx.sampleRateHz))),
    field('eRPM[0]', { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.UNSIGNED_VB, predictor: PRED.PREVIOUS }, (n, ctx) => 400 + n + Math.round(20 * Math.sin((2 * Math.PI * 3 * n) / ctx.sampleRateHz))),
  ];
}

/* ------------------------------------------------------------------ *
 * 1. Log boundaries and headers
 * ------------------------------------------------------------------ */

test('findLogBoundaries finds every log and ignores the marker text inside binary payload', () => {
  const first = buildSyntheticLog({ spec: standardSpec(), sampleCount: 400 }).buffer;
  const second = buildSyntheticLog({ spec: standardSpec(), sampleCount: 400 }).buffer;

  const payload = Uint8Array.from([
    0x11, 0x22, 0x0a, // binary junk, then a newline
    ...bytesOf(PRODUCT_LINE), 0x0a,
    ...bytesOf('H NotARealHeader:1'), 0x0a,
    0x7f, 0x01, 0x02, 0x03,
  ]);

  const file = new Uint8Array(first.length + payload.length + second.length);
  file.set(first, 0);
  file.set(payload, first.length);
  file.set(second, first.length + payload.length);

  const boundaries = findLogBoundaries(file);
  assert.equal(boundaries.length, 2, `expected 2 real logs, got ${boundaries.length}`);
  assert.equal(boundaries[0], 0);
  assert.equal(boundaries[1], first.length + payload.length);
});

test('parseLogHeader returns raw header keys, field definitions and sysConfig', () => {
  const { buffer } = buildSyntheticLog({ spec: standardSpec(), sampleCount: 400, pIntervalHeader: '1/4' });
  const { header, fieldDefs, sysConfig } = parseLogHeader(buffer, 0, buffer.length);

  assert.equal(header['Data version'], '2');
  assert.match(header['Firmware revision'], /BTFL/);
  assert.equal(fieldDefs.I.count, 10);
  assert.deepEqual(fieldDefs.I.name.slice(0, 3), ['loopIteration', 'time', 'gyroADC[0]']);
  assert.equal(fieldDefs.P.count, 10);
  assert.equal(sysConfig.dataVersion, 2);
  assert.equal(sysConfig.looptime, 125);
  assert.equal(sysConfig.frameIntervalPDenom, 4);
  assert.equal(sysConfig.gyroScale, 1);
  assert.equal(sysConfig.fieldIndices['gyroADC[2]'], 4);
});

test('a bare "P interval:4" is read as 1/4 and yields the same 2 kHz log rate', async () => {
  const fraction = buildSyntheticLog({ spec: standardSpec(), sampleCount: 800, pIntervalHeader: '1/4' });
  const bare = buildSyntheticLog({ spec: standardSpec(), sampleCount: 800, pIntervalHeader: '4' });

  for (const built of [fraction, bare]) {
    const { logs } = await decodeBbl(built.buffer);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].sampleRateHz, 2000);
  }
});

/* ------------------------------------------------------------------ *
 * 2. Round-trip decode
 * ------------------------------------------------------------------ */

test('decodeLog decodes an explicit byte range the way decodeBbl does', async () => {
  const built = buildSyntheticLog({ spec: standardSpec(), sampleCount: 1000 });
  const boundaries = findLogBoundaries(built.buffer);
  assert.deepEqual(boundaries, [0]);

  const direct = decodeLog(built.buffer, boundaries[0], built.buffer.length, { index: 0 });
  const viaBbl = (await decodeBbl(built.buffer)).logs[0];

  assert.equal(direct.frameCount, viaBbl.frameCount);
  assert.equal(direct.sampleRateHz, viaBbl.sampleRateHz);
  assert.equal(direct.headerOffset, viaBbl.headerOffset);
  assert.ok(direct.dataOffset > direct.headerOffset);
  assert.deepEqual(direct.channels['gyroADC[1]'], viaBbl.channels['gyroADC[1]']);
  assert.deepEqual(direct.timeUs, viaBbl.timeUs);
  assert.deepEqual(Object.keys(direct).sort(), [
    'axesPresent',
    'channels',
    'craftName',
    'dataOffset',
    'dropRatePct',
    'droppedFrames',
    'durationS',
    'fieldsPresent',
    'firmware',
    'frameCount',
    'header',
    'headerOffset',
    'index',
    'sampleRateHz',
    'timeUs',
    'warnings',
  ]);
});

test('decodeBbl round-trips a synthetic 2 kHz log', async () => {
  const built = buildSyntheticLog({ spec: standardSpec(), sampleCount: 4000 });
  const { logs, stats } = await decodeBbl(built.buffer, { maxLogs: 4 });

  assert.equal(stats.logCount, 1);
  assert.equal(stats.decoded, 1);
  assert.equal(stats.failed, 0);
  assert.equal(logs.length, 1);

  const log = logs[0];
  assert.equal(log.firmware, 'BTFL 4.5.0 (abcdef) STM32F405');
  assert.equal(log.craftName, 'SYNTHQUAD');
  assert.equal(log.sampleRateHz, 2000);
  assert.equal(log.frameCount, built.expected.frameCount);
  assert.equal(log.droppedFrames, 0);
  assert.equal(log.dropRatePct, 0);
  assert.deepEqual(log.axesPresent, ['roll', 'pitch', 'yaw']);
  assert.ok(Math.abs(log.durationS - built.expected.durationS) < 0.01, `durationS ${log.durationS}`);

  // channel set: exactly the channels present in the header, nothing invented
  const flatKeys = Object.keys(log.channels).filter((key) => key.includes('[')).sort();
  assert.deepEqual(flatKeys, [
    'eRPM[0]',
    'gyroADC[0]',
    'gyroADC[1]',
    'gyroADC[2]',
    'motor[0]',
    'setpoint[0]',
    'setpoint[1]',
    'setpoint[2]',
  ]);
  assert.equal(log.channels['axisP[0]'], undefined, 'absent channels must not be fabricated');
  assert.equal(log.channels.gyroADC[0], log.channels['gyroADC[0]'], 'grouped alias must reference the same array');
  assert.equal(log.channels['gyroADC[0]'].length, built.expected.sampleCount);

  // decoded values must match the encoded ones exactly (both encodings are lossless)
  const spec = built.expected.spec;
  const channels = ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'setpoint[0]', 'setpoint[1]', 'setpoint[2]', 'motor[0]', 'eRPM[0]'];
  for (const name of channels) {
    const index = built.expected.fieldIndices[name];
    const decoded = log.channels[name];
    for (let n = 0; n < built.expected.sampleCount; n++) {
      assert.equal(decoded[n] || 0, built.expected.values[index][n] || 0, `${name} sample ${n}`);
    }
  }

  // time column round-trips through the straight-line predictor
  assert.equal(log.timeUs.length, built.expected.sampleCount);
  assert.equal(log.timeUs[0], built.expected.timeUs[0]);
  assert.equal(log.timeUs.at(-1), built.expected.timeUs.at(-1));
  assert.equal(log.warnings.filter((w) => /truncated|corrupt/i.test(w)).length, 0, `unexpected damage: ${log.warnings}`);
});

test('decodeBbl accepts a filesystem path as well as a Buffer', async () => {
  const built = buildSyntheticLog({ spec: standardSpec(), sampleCount: 600 });
  const dir = await mkdtemp(join(tmpdir(), 'bf-ai-tuner-'));
  const file = join(dir, 'synthetic.bbl');
  try {
    await writeFile(file, built.buffer);
    const { logs, stats } = await decodeBbl(file, { maxLogs: 1 });
    assert.equal(stats.file, file);
    assert.equal(stats.bytes, built.buffer.length);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].sampleRateHz, 2000);
    assert.equal(logs[0].channels['gyroADC[0]'].length, 600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decodeBbl keeps only the most recent maxLogs logs', async () => {
  const a = buildSyntheticLog({ spec: standardSpec(), sampleCount: 400 }).buffer;
  const b = buildSyntheticLog({ spec: standardSpec(), sampleCount: 500 }).buffer;
  const c = buildSyntheticLog({ spec: standardSpec(), sampleCount: 600 }).buffer;
  const file = new Uint8Array(a.length + b.length + c.length);
  file.set(a, 0);
  file.set(b, a.length);
  file.set(c, a.length + b.length);

  const { logs, stats } = await decodeBbl(file, { maxLogs: 2 });
  assert.equal(stats.logCount, 3);
  assert.equal(stats.skipped, 1);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((log) => log.index), [1, 2]);
  assert.equal(logs[1].frameCount, 600);
});

/* ------------------------------------------------------------------ *
 * 3. Dropped frames and truncation
 * ------------------------------------------------------------------ */

test('dropped frames are counted from loopIteration gaps', async () => {
  const spec = standardSpec();
  // Make loopIteration an absolute column in P-frames so a real gap is visible.
  spec[0] = field(
    'loopIteration',
    { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO },
    { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO },
    (n, ctx) => ctx.loopIteration,
  );
  const clean = buildSyntheticLog({ spec, sampleCount: 1200 });
  const gapped = buildSyntheticLog({ spec, sampleCount: 1200, absoluteIterationGapAt: 600, absoluteIterationGapLoops: 8 });

  const cleanLog = (await decodeBbl(clean.buffer)).logs[0];
  assert.equal(cleanLog.droppedFrames, 0);

  const gappedLog = (await decodeBbl(gapped.buffer)).logs[0];
  assert.ok(gappedLog.droppedFrames >= 1, `expected at least one dropped frame, got ${gappedLog.droppedFrames}`);
  assert.ok(gappedLog.dropRatePct > 0);
  assert.equal(gappedLog.frameCount, 1200);
});

test('a truncated log decodes partially, reports the damage and never throws', async () => {
  const built = buildSyntheticLog({ spec: standardSpec(), sampleCount: 4000 });
  const full = built.buffer;
  const chopped = full.slice(0, Math.floor(full.length / 2));
  const { logs, stats } = await decodeBbl(chopped);
  assert.equal(logs.length, 1);
  assert.equal(stats.failed, 0);
  assert.deepEqual(stats.errors, []);

  const log = logs[0];
  assert.ok(log.frameCount > 0, 'partial data must still decode');
  assert.ok(log.frameCount < built.expected.frameCount, `expected fewer than ${built.expected.frameCount} frames, got ${log.frameCount}`);
  assert.ok(
    log.warnings.some((w) => /truncated|corrupt/i.test(w)),
    `expected a damage warning, got: ${JSON.stringify(log.warnings)}`,
  );
  assert.ok(log.channels['gyroADC[0]'].length === log.frameCount);
  assert.ok(log.durationS > 0);
});

test('decodeBbl returns an empty result instead of throwing when there is no log', async () => {
  const garbage = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37) % 256);
  const { logs, stats } = await decodeBbl(garbage);
  assert.deepEqual(logs, []);
  assert.equal(stats.logCount, 0);
  assert.equal(stats.decoded, 0);
  assert.ok(stats.warnings.length > 0);

  const { logs: emptyLogs } = await decodeBbl(new Uint8Array(0));
  assert.deepEqual(emptyLogs, []);
});

test('a valid header followed by binary garbage reports damage instead of throwing', async () => {
  const head = [];
  const push = (text) => {
    head.push(...bytesOf(text), 0x0a);
  };
  push(PRODUCT_LINE);
  push('H Data version:2');
  push('H I interval:32');
  push('H P interval:1/4');
  push('H looptime:125');
  push('H Field I name:loopIteration,time,gyroADC[0]');
  push('H Field I signed:0,0,1');
  push('H Field I predictor:0,0,0');
  push('H Field I encoding:1,1,0');
  push('H Field P predictor:6,2,1');
  push('H Field P encoding:9,0,0');

  const random = mulberry32(99);
  const corrupt = new Uint8Array(head.length + 200_000);
  corrupt.set(Uint8Array.from(head), 0);
  for (let i = head.length; i < corrupt.length; i++) corrupt[i] = Math.floor(random() * 256);

  const { logs, stats } = await decodeBbl(corrupt, { maxLogs: 1 });
  assert.equal(stats.failed, 0);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].warnings.some((w) => /truncated|corrupt/i.test(w)), JSON.stringify(logs[0].warnings));
});

/* ------------------------------------------------------------------ *
 * 4. Grouped encodings
 * ------------------------------------------------------------------ */

test('decodeBbl reads TAG2_3S32, TAG8_4S16 and TAG8_8SVB groups', async () => {
  const slow = (amplitude, hz) => (n, ctx) => Math.round(amplitude * Math.sin((2 * Math.PI * hz * n) / ctx.sampleRateHz));
  const spec = [
    field('loopIteration', { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.NULL, predictor: PRED.INC }, (n, ctx) => ctx.loopIteration),
    field('time', { encoding: ENC.UNSIGNED_VB, predictor: PRED.ZERO }, { encoding: ENC.SIGNED_VB, predictor: PRED.STRAIGHT_LINE }, (n, ctx) => 2_000_000 + n * 500),
    field('gyroADC[0]', { encoding: ENC.TAG2_3S32, predictor: PRED.ZERO }, { encoding: ENC.TAG2_3S32, predictor: PRED.PREVIOUS }, slow(40, 40)),
    field('gyroADC[1]', { encoding: ENC.TAG2_3S32, predictor: PRED.ZERO }, { encoding: ENC.TAG2_3S32, predictor: PRED.PREVIOUS }, slow(40, 50)),
    field('gyroADC[2]', { encoding: ENC.TAG2_3S32, predictor: PRED.ZERO }, { encoding: ENC.TAG2_3S32, predictor: PRED.PREVIOUS }, slow(40, 60)),
    field('axisP[0]', { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, slow(300, 5)),
    field('axisP[1]', { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, slow(300, 6)),
    field('axisP[2]', { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, slow(300, 7)),
    field('axisP[3]', { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, { encoding: ENC.TAG8_4S16, predictor: PRED.ZERO }, slow(300, 8)),
    field('setpoint[0]', { encoding: ENC.TAG8_8SVB, predictor: PRED.ZERO }, { encoding: ENC.TAG8_8SVB, predictor: PRED.PREVIOUS }, slow(120, 15)),
    field('setpoint[1]', { encoding: ENC.TAG8_8SVB, predictor: PRED.ZERO }, { encoding: ENC.TAG8_8SVB, predictor: PRED.PREVIOUS }, slow(120, 16)),
    field('setpoint[2]', { encoding: ENC.TAG8_8SVB, predictor: PRED.ZERO }, { encoding: ENC.TAG8_8SVB, predictor: PRED.PREVIOUS }, slow(120, 17)),
  ];

  const built = buildSyntheticLog({ spec, sampleCount: 1500 });
  const { logs } = await decodeBbl(built.buffer);
  assert.equal(logs.length, 1);
  const log = logs[0];
  assert.equal(log.frameCount, built.expected.frameCount);
  assert.equal(log.droppedFrames, 0);
  assert.equal(log.warnings.filter((w) => /truncated|corrupt/i.test(w)).length, 0, `unexpected damage: ${log.warnings}`);

  for (const name of ['gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]', 'axisP[0]', 'axisP[1]', 'axisP[2]', 'setpoint[0]', 'setpoint[1]', 'setpoint[2]']) {
    const index = built.expected.fieldIndices[name];
    const decoded = log.channels[name];
    assert.ok(decoded, `${name} should be present`);
    for (let n = 0; n < built.expected.sampleCount; n++) {
      assert.equal(decoded[n] || 0, built.expected.values[index][n] || 0, `${name} sample ${n}`);
    }
  }
});

test('an S-frame in the middle of the stream does not disturb decoding', async () => {
  const built = buildSyntheticLog({ spec: standardSpec(), sampleCount: 1000, insertSlowFrameAt: 128 });
  const { logs } = await decodeBbl(built.buffer);
  assert.equal(logs[0].frameCount, 1000);
  assert.equal(logs[0].droppedFrames, 0);
  assert.equal(logs[0].channels['gyroADC[0]'].length, 1000);
});

/* ------------------------------------------------------------------ *
 * 5. FFT
 * ------------------------------------------------------------------ */

function sineSignal({ length, sampleRateHz, hz, amplitude, noise = 0, seed = 1 }) {
  const random = mulberry32(seed);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRateHz) + noise * (random() * 2 - 1);
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('welchPsd puts the dominant bin within one bin of a pure sine', () => {
  const fs = 2000;
  const signal = sineSignal({ length: 4096, sampleRateHz: fs, hz: 123, amplitude: 50, noise: 1 });
  const spectrum = welchPsd(signal, fs, { segmentSize: 512 });

  assert.equal(spectrum.binHz, fs / 512);
  assert.equal(spectrum.segments, 15);
  assert.equal(spectrum.freqs.length, 257);

  let best = 0;
  for (let k = 1; k < spectrum.psd.length; k++) if (spectrum.psd[k] > spectrum.psd[best]) best = k;
  assert.ok(Math.abs(spectrum.freqs[best] - 123) <= spectrum.binHz, `peak at ${spectrum.freqs[best]} Hz`);

  // A Hann-windowed 50 Hz-amplitude sine carries A^2/2 = 1250 units^2 of power.
  const power = bandPower(spectrum, 110, 136);
  assert.ok(Math.abs(power - 1250) / 1250 < 0.1, `band power ${power}`);

  // Shorter than one segment: shrink to the largest power of two that fits.
  const short = welchPsd(signal.subarray(0, 100), fs, { segmentSize: 512 });
  assert.equal(short.binHz, fs / 64);
  assert.ok(short.segments >= 1);
  assert.equal(welchPsd([], fs).segments, 0);
  assert.equal(welchPsd([1], fs).segments, 1);
});

test('findPeaks finds the sine and not the noise', () => {
  const fs = 2000;
  const random = mulberry32(7);
  const signal = new Float64Array(8192);
  for (let i = 0; i < signal.length; i++) {
    signal[i] =
      50 * Math.sin((2 * Math.PI * 100 * i) / fs) +
      0.4 * Math.sin((2 * Math.PI * 400 * i) / fs) + // ~42 dB below the sine
      1 * (random() * 2 - 1);
  }
  const spectrum = welchPsd(signal, fs, { segmentSize: 512 });
  const peaks = findPeaks(spectrum, { maxPeaks: 5, minProminenceDb: 12, minHz: 20 });

  assert.ok(peaks.length >= 1);
  assert.ok(Math.abs(peaks[0].hz - 100) <= spectrum.binHz, `top peak at ${peaks[0].hz} Hz`);
  assert.ok(peaks[0].prominenceDb > 20, `prominence ${peaks[0].prominenceDb} dB`);
  assert.ok(peaks[0].bandwidthHz > 0);
  // Nothing else may come close to the sine; the 42 dB-down 400 Hz line is
  // allowed to register, but only as a whisper (prominence is relative to the
  // local noise floor, not to the strongest peak in the spectrum).
  for (const peak of peaks.slice(1)) {
    assert.ok(peak.psd < peaks[0].psd / 1000, `secondary peak ${peak.hz} Hz is not noise: ${JSON.stringify(peaks)}`);
  }

  const noiseOnly = findPeaks(welchPsd(Float64Array.from({ length: 8192 }, () => random() * 2 - 1), fs), {
    maxPeaks: 5,
    minProminenceDb: 12,
  });
  assert.equal(noiseOnly.length, 0, `white noise produced peaks: ${JSON.stringify(noiseOnly)}`);

  assert.ok(Number.isFinite(noiseFloorDbfs(spectrum)));
  assert.ok(noiseFloorDbfs(spectrum) < 10 * Math.log10(peaks[0].psd));
});

test('matchRpmHarmonics matches eRPM harmonics and rejects unrelated peaks', () => {
  const fs = 2000;
  // 3000 mechanical rpm on a 7-pole-pair motor = 21000 eRPM = 50 Hz fundamental,
  // so a 100 Hz peak is its 2nd harmonic.
  const erpm = [];
  for (let i = 0; i < 4000; i++) erpm.push(21000);
  const matching = matchRpmHarmonics([{ hz: 100, psd: 1, prominenceDb: 20, bandwidthHz: 2 }], [erpm], fs, { maxOrder: 4, polePairs: 7 });
  assert.ok(matching.match > 0.9, `match ${matching.match}`);
  assert.deepEqual(matching.orders, [2]);

  const unrelated = matchRpmHarmonics([{ hz: 100, psd: 1, prominenceDb: 20, bandwidthHz: 2 }], [erpm], fs, { maxOrder: 1, polePairs: 7 });
  assert.equal(unrelated.match, 0);
  assert.deepEqual(unrelated.orders, []);

  // No eRPM data at all: no match, no throw.
  assert.deepEqual(matchRpmHarmonics([{ hz: 100, psd: 1, prominenceDb: 20, bandwidthHz: 2 }], [], fs), { match: 0, orders: [] });
});

/* ------------------------------------------------------------------ *
 * 6. Metrics
 * ------------------------------------------------------------------ */

const FS = 2000;

/** Build a DecodedLog-shaped object with generated channels. */
function makeLog({ durationS = 30, sampleRateHz = FS, gyro, throttle, extraChannels = {}, overrides = {} } = {}) {
  const length = Math.round(durationS * sampleRateHz);
  const timeUs = new Array(length);
  for (let i = 0; i < length; i++) timeUs[i] = 1_000_000 + Math.round((i * 1e6) / sampleRateHz);
  const channels = { ...extraChannels };
  if (gyro) {
    for (let axis = 0; axis < 3; axis++) {
      channels[`gyroADC[${axis}]`] = gyro(axis, length, i => timeUs[i] / 1e6);
    }
  }
  if (throttle) channels.throttle = throttle(length, i => timeUs[i] / 1e6);

  return {
    index: 0,
    headerOffset: 0,
    dataOffset: 512,
    header: { gyro_scale: '0x3f800000', motor_poles: '14', maxthrottle: '2000', 'Firmware revision': 'BTFL 4.5.0' },
    firmware: 'BTFL 4.5.0',
    sampleRateHz,
    durationS,
    frameCount: length,
    droppedFrames: 0,
    dropRatePct: 0,
    axesPresent: ['roll', 'pitch', 'yaw'],
    fieldsPresent: [],
    timeUs,
    channels,
    warnings: [],
    ...overrides,
  };
}

test('computeMetrics measures propwash on descending-throttle segments only', () => {
  const descendWindows = [
    [5, 5.6],
    [10, 10.6],
    [15, 15.6],
    [20, 20.6],
    [25, 25.6],
  ];
  const throttle = (length, secondsAt) => {
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
      const t = secondsAt(i);
      const window = descendWindows.find(([start, end]) => t >= start && t <= end);
      out[i] = window ? 1500 - ((t - window[0]) / 0.6) * 400 : 1500;
    }
    return out;
  };
  const gyro = (axis, length, secondsAt) => {
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
      const t = secondsAt(i);
      const window = descendWindows.find(([start, end]) => t >= start && t <= end);
      // 50 Hz oscillation only while the props unload; 250 Hz the rest of the time.
      out[i] = window ? 60 * Math.sin(2 * Math.PI * 50 * t) : 20 * Math.sin(2 * Math.PI * 250 * t);
    }
    return out;
  };

  const log = makeLog({
    durationS: 30,
    gyro,
    throttle,
    extraChannels: {
      'setpoint[0]': new Array(30 * FS).fill(0),
      'axisD[0]': new Array(30 * FS).fill(0),
      'axisI[0]': new Array(30 * FS).fill(0),
    },
  });

  const report = computeMetrics(log);
  const roll = report.axes.roll;
  assert.ok(roll.propwashEvents > 0, `expected descent events, got ${roll.propwashEvents}`);
  assert.ok(roll.propwashIndex > 0, `propwashIndex ${roll.propwashIndex}`);
  assert.ok(roll.propwashIndex > 0.3, `50 Hz line should dominate the 20-100 Hz band, got ${roll.propwashIndex}`);
  assert.equal(report.blocksTuning, false, `unexpected faults: ${JSON.stringify(report.faults)}`);
  assert.equal(report.faults.some((f) => f.code === 'SEVERE_VIBRATION'), false);
  assert.equal(report.faults.some((f) => f.code === 'NO_RPM_DATA'), true);

  // No descending throttle => no propwash measurement (and no invented number).
  const flat = makeLog({ durationS: 30, gyro: (axis, length) => new Array(length).fill(10), throttle: (length) => new Array(length).fill(1500) });
  const flatReport = computeMetrics(flat);
  assert.equal(flatReport.axes.roll.propwashIndex, 0);
  assert.equal(flatReport.axes.roll.propwashEvents, 0);
});

test('computeMetrics flags severe vibration and blocks tuning', () => {
  const random = mulberry32(11);
  const noisy = makeLog({
    durationS: 30,
    gyro: (axis, length) => Array.from({ length }, () => 100 * (random() * 2 - 1)),
    throttle: (length) => new Array(length).fill(1500),
  });
  const report = computeMetrics(noisy);
  const vibration = report.faults.find((f) => f.code === 'SEVERE_VIBRATION');

  assert.ok(vibration, `expected SEVERE_VIBRATION, got ${JSON.stringify(report.faults)}`);
  assert.equal(vibration.blocksTuning, true);
  assert.equal(vibration.severity, 'critical');
  assert.equal(report.blocksTuning, true);
  assert.match(vibration.evidence, /deg\/s RMS/);
  assert.match(vibration.evidence, /\d/);

  // A clean 80 Hz oscillation must not be flagged.
  const clean = makeLog({
    durationS: 30,
    gyro: (axis, length, secondsAt) => Array.from({ length }, (_, i) => 40 * Math.sin(2 * Math.PI * 80 * secondsAt(i)) + 0.5 * (random() * 2 - 1)),
    throttle: (length) => new Array(length).fill(1500),
  });
  const cleanReport = computeMetrics(clean);
  assert.equal(cleanReport.faults.some((f) => f.code === 'SEVERE_VIBRATION'), false);
  assert.equal(cleanReport.blocksTuning, false, JSON.stringify(cleanReport.faults));
});

test('computeMetrics reports the short-log, drop-rate, sample-rate and clipping faults with numbers', () => {
  const shortLog = makeLog({ durationS: 5, gyro: () => new Array(5 * FS).fill(1) });
  const shortReport = computeMetrics(shortLog);
  const tooShort = shortReport.faults.find((f) => f.code === 'SAMPLE_TOO_SHORT');
  assert.ok(tooShort);
  // Informational only: no duration requirement is imposed any more.
  assert.equal(tooShort.severity, 'info');
  assert.equal(tooShort.blocksTuning, false);
  assert.match(tooShort.evidence, /5\.0 s/);
  // A short log no longer blocks: the operator decides how much flying is enough.
  assert.equal(shortReport.blocksTuning, false);

  const dropped = makeLog({ durationS: 30, gyro: () => new Array(30 * FS).fill(1), overrides: { droppedFrames: 1000, dropRatePct: 3.2 } });
  const droppedReport = computeMetrics(dropped);
  const drops = droppedReport.faults.find((f) => f.code === 'FRAME_DROP_HIGH');
  assert.ok(drops);
  assert.equal(drops.blocksTuning, false);
  assert.match(drops.evidence, /3\.20%/);

  const wrongRate = makeLog({ durationS: 30, sampleRateHz: 1000, gyro: () => new Array(30 * FS).fill(1) });
  const wrongRateReport = computeMetrics(wrongRate);
  assert.ok(wrongRateReport.faults.some((f) => f.code === 'SAMPLE_RATE_MISMATCH'));

  const clipped = makeLog({
    durationS: 30,
    gyro: (axis, length) => Array.from({ length }, (_, i) => (i % 2 ? 2000 : 1995)),
  });
  const clippedReport = computeMetrics(clipped);
  const clipping = clippedReport.faults.find((f) => f.code === 'GYRO_CLIPPING');
  assert.ok(clipping, JSON.stringify(clippedReport.faults));
  assert.equal(clipping.blocksTuning, true);
  assert.match(clipping.evidence, /deg\/s/);

  const desyncLog = makeLog({
    durationS: 10,
    gyro: () => new Array(10 * FS).fill(5),
    extraChannels: {
      'eRPM[0]': new Array(10 * FS).fill(600),
      'eRPM[1]': Array.from({ length: 10 * FS }, (_, i) => (i > 1000 && i < 1100 ? 0 : 600)),
    },
    overrides: { durationS: 10 },
  });
  const desyncReport = computeMetrics(desyncLog);
  const desync = desyncReport.faults.find((f) => f.code === 'MOTOR_DESYNC');
  assert.ok(desync, JSON.stringify(desyncReport.faults));
  assert.equal(desync.blocksTuning, true);
  assert.match(desync.evidence, /eRPM/);

  // LOG_TRUNCATED comes from the decoder's warnings.
  const truncated = makeLog({ durationS: 30, gyro: () => new Array(30 * FS).fill(1), overrides: { warnings: ['truncated: log ended mid-frame at byte 100 of 200 (50 frame(s) decoded)'] } });
  const truncatedReport = computeMetrics(truncated);
  const logTruncated = truncatedReport.faults.find((f) => f.code === 'LOG_TRUNCATED');
  assert.ok(logTruncated);
  assert.equal(logTruncated.blocksTuning, true);
  assert.match(logTruncated.evidence, /mid-frame/);
});

test('a healthy synthetic log produces a zero-fault, contract-shaped report', () => {
  const length = 30 * FS;
  const gyro = (axis, n, secondsAt) => Array.from({ length: n }, (_, i) => 30 * Math.sin(2 * Math.PI * (60 + axis * 10) * secondsAt(i)));
  const setpoint = (axis) => Array.from({ length }, (_, i) => 50 * Math.sin((2 * Math.PI * 2 * i) / FS));
  const log = makeLog({
    durationS: 30,
    gyro,
    throttle: (n) => Array.from({ length: n }, (_, i) => 1400 + 100 * Math.sin((2 * Math.PI * 0.5 * i) / FS)),
    extraChannels: {
      'setpoint[0]': setpoint(0),
      'setpoint[1]': setpoint(1),
      'setpoint[2]': setpoint(2),
      'axisD[0]': Array.from({ length }, () => 5),
      'axisI[0]': Array.from({ length }, () => 2),
      'axisP[0]': Array.from({ length }, () => 20),
      'rcCommand[0]': Array.from({ length }, () => 10),
      'motor[0]': Array.from({ length }, () => 1400),
      'motor[1]': Array.from({ length }, () => 1410),
      'vbat': Array.from({ length }, () => 2350),
      'eRPM[0]': Array.from({ length }, (_, i) => 400 + Math.round(100 * Math.sin(i / 500))),
      'eRPM[1]': Array.from({ length }, (_, i) => 400 + Math.round(100 * Math.sin(i / 500 + 0.1))),
    },
  });

  const report = computeMetrics(log);
  assert.equal(report.blocksTuning, false, JSON.stringify(report.faults));
  assert.deepEqual(report.faults, []);
  assert.equal(report.sampleRateHz, 2000);
  assert.equal(report.rpmAvailable, 2);
  assert.ok(report.rpmMin > 0 && report.rpmMax > report.rpmMin);
  // sampleQuality = 0.5*drop(1.0) + 0.2*duration(30/60) + 0.3*channels(8/8) = 0.9
  assert.equal(report.sampleQuality, 0.9);

  for (const axis of ['roll', 'pitch', 'yaw']) {
    const metrics = report.axes[axis];
    assert.equal(metrics.axis, axis);
    for (const key of [
      'gyroRms',
      'gyroPeak',
      'noiseFloorDbfs',
      'gyroSpectrum',
      'peaks',
      'motorNoisePeakHz',
      'propwashIndex',
      'propwashEvents',
      'dTermRms',
      'dTermToGyroRatio',
      'step',
      'trackingGainDb',
      'trackingCoherence',
      'trackingPhaseDeg',
      'iTermWindupScore',
    ]) {
      assert.ok(key in metrics, `AxisMetrics.${key} is missing`);
    }
    assert.ok(metrics.gyroSpectrum.freqs.length > 0);
    assert.ok(metrics.trackingCoherence >= 0 && metrics.trackingCoherence <= 1);
    assert.ok(metrics.propwashIndex >= 0 && metrics.propwashIndex <= 1);
  }

  for (const key of ['file', 'logIndex', 'sampleRateHz', 'durationS', 'dropRatePct', 'motorSaturationPct', 'rpmAvailable', 'rpmMin', 'rpmMax', 'axes', 'faults', 'blocksTuning', 'warnings', 'sampleQuality']) {
    assert.ok(key in report, `MetricsReport.${key} is missing`);
  }
});

test('an empty or channel-less log yields zeroed metrics instead of throwing', () => {
  const empty = {
    index: 0,
    header: {},
    firmware: 'unknown',
    sampleRateHz: 0,
    durationS: 0,
    frameCount: 0,
    droppedFrames: 0,
    dropRatePct: 0,
    axesPresent: [],
    fieldsPresent: [],
    timeUs: [],
    channels: {},
    warnings: [],
  };
  const report = computeMetrics(empty);
  assert.deepEqual(Object.keys(report.axes), ['roll', 'pitch', 'yaw']);
  for (const axis of ['roll', 'pitch', 'yaw']) {
    assert.equal(report.axes[axis].gyroRms, 0);
    assert.equal(report.axes[axis].propwashIndex, 0);
    assert.deepEqual(report.axes[axis].peaks, []);
    assert.equal(report.axes[axis].step.samples, 0);
  }
  assert.equal(report.sampleQuality, 0);
  assert.equal(report.blocksTuning, true);
  assert.ok(report.faults.some((f) => f.code === 'GYRO_ABSENT'));
  assert.ok(report.faults.some((f) => f.code === 'SAMPLE_TOO_SHORT'));
  assert.ok(report.warnings.length > 0);

  // computeMetrics() must also survive being handed nothing at all.
  assert.equal(computeMetrics(undefined).blocksTuning, true);
});

test('estimateStepResponse recovers overshoot, rise time and latency from a known response', () => {
  const length = 20 * FS;
  const setpoint = new Array(length).fill(0);
  const gyro = new Array(length).fill(0);
  const stepStarts = [2, 6, 10, 14].map((second) => second * FS);
  const steadyGain = 1.1;
  let gyroLevel = 0;
  let setpointLevel = 0;
  for (const start of stepStarts) {
    for (let i = start; i < length; i++) {
      const dt = (i - start) / FS;
      // Second-order-ish response to a +300 setpoint step: ~6 % overshoot and a
      // 1.1 steady-state gain (330 deg/s of gyro per 300 deg/s of setpoint).
      gyro[i] = gyroLevel + 300 * steadyGain * (1 - Math.exp(-dt / 0.03) * Math.cos(2 * Math.PI * 8 * dt));
      setpoint[i] = setpointLevel + 300;
    }
    gyroLevel += 300 * steadyGain;
    setpointLevel += 300;
  }

  const step = estimateStepResponse(setpoint, gyro, FS);
  assert.equal(step.samples, 4);
  assert.ok(step.overshootPct > 0, `overshoot ${step.overshootPct}`);
  assert.ok(step.riseTimeMs > 0 && step.riseTimeMs < 60, `riseTime ${step.riseTimeMs}`);
  assert.ok(step.latencyMs > 0 && step.latencyMs < 40, `latency ${step.latencyMs}`);
  assert.ok(Math.abs(step.steadyStateErrorPct - 10) < 3, `steadyStateError ${step.steadyStateErrorPct}`);
  assert.ok(step.settlingTimeMs > 0);

  // Fewer than 3 steps: keep the count, invent nothing.
  const oneStep = estimateStepResponse(setpoint.slice(0, 3 * FS), gyro.slice(0, 3 * FS), FS);
  assert.equal(oneStep.samples, 1);
  assert.equal(oneStep.overshootPct, 0);
  assert.equal(oneStep.riseTimeMs, 0);
  assert.equal(oneStep.latencyMs, 0);
  assert.equal(oneStep.steadyStateErrorPct, 0);
});

test('trackingMetrics reports unity gain and full coherence for identical signals', () => {
  const length = 10 * FS;
  const signal = Array.from({ length }, (_, i) => 50 * Math.sin((2 * Math.PI * 30 * i) / FS));
  const tracking = trackingMetrics(signal, signal, FS);
  assert.ok(Math.abs(tracking.gainDb) < 0.5, `gain ${tracking.gainDb} dB`);
  assert.ok(tracking.coherence > 0.99, `coherence ${tracking.coherence}`);
  assert.ok(Math.abs(tracking.phaseDeg) < 1, `phase ${tracking.phaseDeg}`);
  assert.ok(tracking.bins > 0);

  const unrelated = trackingMetrics(signal, Array.from({ length }, (_, i) => 50 * Math.sin((2 * Math.PI * 300 * i) / FS)), FS);
  assert.ok(unrelated.coherence < 0.2, `unrelated coherence ${unrelated.coherence}`);
});

test('supporting helpers behave sanely at their edges', () => {
  // detectDescentSegments: a 0.2 s long, 1 unit/sample descent (400 samples)
  const throttle = new Array(4000).fill(1500);
  for (let i = 1000; i < 1400; i++) throttle[i] = 1500 - (i - 1000);
  const segments = detectDescentSegments(throttle, FS);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].start <= 1050 && segments[0].end >= 1300, JSON.stringify(segments));
  assert.deepEqual(detectDescentSegments(new Array(4000).fill(1500), FS), []);
  assert.deepEqual(detectDescentSegments([], FS), []);

  // iTermWindupScore: a large I-term with no error is windup, a large I-term
  // that is still tracking an error is not.
  const length = 2000;
  const setpoint = new Array(length).fill(0);
  const gyro = new Array(length).fill(0);
  const woundUp = new Array(length).fill(100);
  const working = Array.from({ length }, (_, i) => (i < 500 ? 100 : 0));
  const workingSetpoint = Array.from({ length }, (_, i) => (i < 500 ? 200 : 0));
  assert.ok(iTermWindupScore(woundUp, setpoint, gyro) > 0.9);
  assert.ok(iTermWindupScore(working, workingSetpoint, gyro) < 0.5);
  assert.equal(iTermWindupScore(null, setpoint, gyro), 0);

  // computeSampleQuality: documented formula.
  assert.equal(computeSampleQuality({ dropRatePct: 0, durationS: 60, presentGroups: 8 }), 1);
  assert.equal(computeSampleQuality({ dropRatePct: 10, durationS: 0, presentGroups: 0 }), 0);
  assert.equal(computeSampleQuality({ dropRatePct: 2.5, durationS: 30, presentGroups: 4 }), 0.5);
});
