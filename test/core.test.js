/**
 * Core test suite: protocol codec, MSP parsers, identification, blackbox maths,
 * the safety guard and the proposal engine.
 *
 * The analysis modules (bbl-decode / bbl-fft / bbl-metrics) have their own
 * suite in analysis.test.js.
 *
 * Run with: node --test
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { encodeV1, encodeV2, encode, encodeCli, MspParser, parseAll, crc8DvbS2Buf, ByteReader, ByteWriter, SYM } from '../src/main/msp/msp-codec.js';
import { MSP } from '../src/main/msp/msp-codes.js';
import {
  parseApiVersion,
  parseFcVariant,
  parseFcVersion,
  parseBoardInfo,
  parseBuildInfo,
  parseBlackboxConfig,
  parseDataflashSummary,
  parseSdCardSummary,
  parseAdvancedConfig,
  parseCliAssignments,
  coerceCliValue,
} from '../src/main/msp/msp-helper.js';
import { MspClient } from '../src/main/msp/msp-client.js';
import { VirtualTransport, SILENT } from '../src/main/msp/msp-transport.js';
import { buildFingerprint, scoreConfidence, describeFilterProfile } from '../src/main/fc/fc-identify.js';
import { isPlausibleCliDump, buildPidProfile, buildFilterConfig } from '../src/main/fc/fc-settings.js';
import { computeBlackboxRate, computeDisabledMask, fieldsFromDisabledMask, resolveDevice } from '../src/main/blackbox/blackbox-manager.js';
import { SafetyGuard } from '../src/main/safety/guard.js';
import { proposeTune, filterDiff, isTunableParam, clampStepPercent, clampStepD } from '../src/main/analysis/ai-tune.js';
import { CH, FORBIDDEN_PARAMS, BLACKBOX_FIELDS, REQUIRED_BB_FIELDS } from '../src/shared/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const ascii = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u16 = (v) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff]);
const u32 = (v) => Uint8Array.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

/* ================================================================== *
 * 1. Module loading — catches undeclared private fields and bad imports,
 *    which `node --check` does NOT catch.
 * ================================================================== */

describe('module loading', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js')) files.push(full);
    }
  };
  // Node-side modules only. src/renderer/** needs a DOM (it is exercised by the
  // renderer's own harness and by `npm run lint:syntax`), so importing it here
  // would test the presence of a browser, not our code.
  walk(join(projectRoot, 'src', 'main'));
  walk(join(projectRoot, 'src', 'shared'));

  test('every Node-side src module loads', async () => {
    assert.ok(files.length > 5, `expected to find modules, found ${files.length}`);
    const failures = [];
    const electronOnly = [];

    for (const file of files) {
      // Electron entry points import 'electron', which plain Node resolves to a
      // shim that exports a path string - named imports from it cannot work
      // outside the Electron runtime. Those files are covered by
      // `npm run lint:syntax` and by launching the packaged app instead.
      if (/from 'electron'/.test(readFileSync(file, 'utf8'))) {
        electronOnly.push(file.replace(projectRoot, ''));
        continue;
      }
      try {
        await import(pathToFileURL(file).href);
      } catch (err) {
        // Catches undeclared private fields and broken specifiers, which
        // `node --check` does NOT report.
        failures.push(`${file.replace(projectRoot, '')}: ${err.message}`);
      }
    }

    assert.deepEqual(failures, [], `modules failed to load:\n${failures.join('\n')}`);
    // Exactly one file may be exempt. A growing list means something is quietly
    // escaping this check.
    assert.deepEqual(electronOnly, ['/src/main/main.js']);
  });
});

/* ================================================================== *
 * 2. MSP codec
 * ================================================================== */

describe('MSP codec', () => {
  test('MSPv1 round-trips through the parser', () => {
    const frame = encodeV1(MSP.MSP_FC_VARIANT, ascii('BTFL'));
    assert.equal(frame[0], SYM.BEGIN);
    assert.equal(frame[1], SYM.PROTO_V1);
    assert.equal(frame[2], SYM.TO_FC);
    assert.equal(frame[3], 4);
    assert.equal(frame[4], MSP.MSP_FC_VARIANT);

    const [msg] = parseAll(frame);
    assert.equal(msg.type, 'msp');
    assert.equal(msg.version, 1);
    assert.equal(msg.code, MSP.MSP_FC_VARIANT);
    assert.equal(msg.checksumOk, true);
    assert.equal(Buffer.from(msg.payload).toString('ascii'), 'BTFL');
  });

  test('MSPv1 reply direction is recognised', () => {
    // $M> len cmd payload xor  — build the reply form by hand.
    const payload = ascii('BTFL');
    const len = payload.length;
    let checksum = len ^ MSP.MSP_FC_VARIANT;
    for (const b of payload) checksum ^= b;
    const reply = concat([SYM.BEGIN, SYM.PROTO_V1, SYM.FROM_FC, len, MSP.MSP_FC_VARIANT], payload, [checksum]);

    const [msg] = parseAll(reply);
    assert.equal(msg.direction, 'response');
    assert.equal(msg.error, false);
    assert.equal(msg.checksumOk, true);
  });

  test('MSPv1 detects a bad checksum without dropping the message', () => {
    const frame = encodeV1(MSP.MSP_STATUS, [1, 2, 3]);
    frame[frame.length - 1] ^= 0xff;
    const [msg] = parseAll(frame);
    assert.equal(msg.checksumOk, false);
    assert.equal(msg.code, MSP.MSP_STATUS);
  });

  test('MSP error replies are flagged', () => {
    const reply = Uint8Array.from([SYM.BEGIN, SYM.PROTO_V1, SYM.UNSUPPORTED, 0x00, 0x63, 0x63]);
    const [msg] = parseAll(reply);
    assert.equal(msg.error, true);
    assert.equal(msg.code, 0x63);
  });

  test('MSPv2 round-trips and uses CRC8 DVB-S2', () => {
    const frame = encodeV2(0x300c, [0xde, 0xad]);
    assert.equal(frame[1], SYM.PROTO_V2);
    assert.equal(frame[4], 0x0c);
    assert.equal(frame[5], 0x30);

    const [msg] = parseAll(frame);
    assert.equal(msg.version, 2);
    assert.equal(msg.code, 0x300c);
    assert.equal(msg.checksumOk, true);
    assert.deepEqual([...msg.payload], [0xde, 0xad]);
  });

  test('encode() picks the version from the code width', () => {
    assert.equal(encode(101, null)[1], SYM.PROTO_V1);
    assert.equal(encode(0x300c, null)[1], SYM.PROTO_V2);
  });

  test('CRC8 DVB-S2 matches the reference vector', () => {
    // CRC8/DVB-S2 of the ASCII bytes "123456789" is 0xBC (standard check value).
    assert.equal(crc8DvbS2Buf(ascii('123456789')), 0xbc);
  });

  test('CLI frames round-trip with STX/LF/ETX', () => {
    const frame = encodeCli('get p_roll');
    assert.equal(frame[0], SYM.STX);
    assert.equal(frame[frame.length - 2], SYM.LF);
    assert.equal(frame[frame.length - 1], SYM.ETX);

    const [msg] = parseAll(frame);
    assert.equal(msg.type, 'cli');
    assert.deepEqual(msg.lines, ['get p_roll']);
  });

  test('a CLI reply splits into lines and closes on ETX', () => {
    const reply = concat([SYM.STX], ascii('p_roll = 45\ni_roll = 80\n'), [SYM.ETX]);
    const [msg] = parseAll(reply);
    assert.equal(msg.type, 'cli');
    assert.equal(msg.closed, true);
    assert.deepEqual(msg.lines, ['p_roll = 45', 'i_roll = 80']);
  });

  test('the parser survives byte-at-a-time delivery', () => {
    const frame = concat(encodeV1(MSP.MSP_BOARD_INFO, ascii('S405')), encodeCli('status'));
    const parser = new MspParser();
    const messages = [];
    for (const byte of frame) messages.push(...parser.push(Uint8Array.from([byte])));

    assert.equal(messages.length, 2);
    assert.equal(messages[0].code, MSP.MSP_BOARD_INFO);
    assert.equal(messages[1].type, 'cli');
  });

  test('noise before a frame does not desynchronise the parser', () => {
    const noise = Uint8Array.from([0x00, 0x11, 0x24, 0x99, 0xff]);
    const parser = new MspParser();
    const messages = parser.push(concat(noise, encodeV1(MSP.MSP_API_VERSION, [0, 1, 46])));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].code, MSP.MSP_API_VERSION);
  });

  test('ByteWriter/ByteReader agree on widths', () => {
    const w = new ByteWriter();
    w.u8(0x12).u16(0x3456).u32(0x789abcde);
    const r = new ByteReader(w.toUint8Array());
    assert.equal(r.u8(), 0x12);
    assert.equal(r.u16(), 0x3456);
    assert.equal(r.u32(), 0x789abcde);
  });
});

/* ================================================================== *
 * 3. MSP payload parsers (layouts verified against firmware msp.c)
 * ================================================================== */

describe('MSP payload parsers', () => {
  test('MSP_API_VERSION', () => {
    const parsed = parseApiVersion(Uint8Array.from([0, 1, 46]));
    assert.equal(parsed.mspProtocolVersion, 0);
    assert.equal(parsed.apiVersion, '1.46.0');
  });

  test('MSP_FC_VARIANT', () => {
    assert.equal(parseFcVariant(ascii('BTFL')), 'BTFL');
  });

  test('MSP_FC_VERSION legacy 3-byte form', () => {
    assert.equal(parseFcVersion(Uint8Array.from([4, 5, 1])), '4.5.1');
  });

  test('MSP_FC_VERSION new string form', () => {
    const payload = concat([Uint8Array.from([12])], u16(0), ascii('4.6.0'), [0]);
    assert.equal(parseFcVersion(payload), '4.6.0');
  });

  test('MSP_BOARD_INFO derives the signature length from the payload', () => {
    const signature = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const payload = concat(
      ascii('S405'),
      u16(1), // hardware revision
      Uint8Array.from([0]), // board type
      Uint8Array.from([0b01001001]), // target capabilities
      ascii('STM32F405'), [0],
      ascii('SpeedyBee F405'), [0],
      ascii('SBF'), [0],
      signature,
      Uint8Array.from([0]), // mcuTypeId
      Uint8Array.from([0]), // configurationState (>=1.42)
      u16(8000), // sampleRateHz (>=1.43)
      u32(0), // configurationProblems
      Uint8Array.from([0]), // spiDeviceCount (>=1.44)
      Uint8Array.from([0]), // i2cDeviceCount (>=1.44)
    );

    const info = parseBoardInfo(payload, '1.46.0');
    assert.equal(info.boardIdentifier, 'S405');
    assert.equal(info.targetName, 'STM32F405');
    assert.equal(info.boardName, 'SpeedyBee F405');
    assert.equal(info.manufacturerId, 'SBF');
    assert.equal(info.signature.length, 32);
    assert.equal(info.signature[31], 32);
    assert.equal(info.sampleRateHz, 8000);
  });

  test('MSP_BOARD_INFO tolerates older API versions', () => {
    const payload = concat(
      ascii('XXXX'),
      u16(0),
      Uint8Array.from([0]),
      Uint8Array.from([0]),
      ascii('T'), [0],
      [0],
      [0],
      Uint8Array.from({ length: 32 }, () => 0),
      Uint8Array.from([0]),
    );
    const info = parseBoardInfo(payload, '1.41.0');
    assert.equal(info.boardIdentifier, 'XXXX');
    assert.equal(info.sampleRateHz, 0);
    assert.equal(info.signature.length, 32);
  });

  test('MSP_BOARD_INFO decodes length-prefixed (PString) names from real hardware', () => {
    // Exact bytes captured from a MAMBAF722_2022A running BTFL 2025.12.2,
    // MSP API 1.47.0. Modern firmware writes the three names with
    // sbufWritePString (u8 length + chars), not NUL-terminated.
    const payload = Uint8Array.from(
      ('46 37 32 32 00 00 02 41 09 53 54 4d 33 32 46 37 58 32 0f 4d 41 4d 42 41 46 37 32 32 5f 32 30 32 32 41' +
       ' 04 44 49 41 54' + ' 00'.repeat(32) + ' 04 01 40 1f 00 00 00 00 01 00').split(' ').map((h) => parseInt(h, 16)),
    );

    const info = parseBoardInfo(payload, '1.47.0');

    assert.equal(info.boardIdentifier, 'F722');
    assert.equal(info.targetName, 'STM32F7X2');
    assert.equal(info.boardName, 'MAMBAF722_2022A');
    assert.equal(info.manufacturerId, 'DIAT');
    // The signature must still be exactly 32 bytes despite the new trailing
    // spi/i2c counters, otherwise every field after it shifts.
    assert.equal(info.signature.length, 32);
    assert.equal(info.sampleRateHz, 8000);
    assert.equal(info.spiDeviceCount, 1);
    assert.equal(info.i2cDeviceCount, 0);
  });

  test('MSP_FC_VERSION decodes the calendar-version PString from real hardware', () => {
    // u8 year-since-2000 (0x19 = 25), u8 month (12), u8 patch (2), then a
    // length-prefixed "2025.12.2".
    const payload = Uint8Array.from('19 0c 02 09 32 30 32 35 2e 31 32 2e 32'.split(' ').map((h) => parseInt(h, 16)));
    assert.equal(parseFcVersion(payload), '2025.12.2');
  });

  test('MSP_BUILD_INFO', () => {
    const payload = concat(ascii('Jan 01 2025'), ascii('12:00:00'), ascii('abc1234'));
    const info = parseBuildInfo(payload);
    assert.equal(info.buildInfo, 'Jan 01 2025 12:00:00');
    assert.equal(info.gitRevision, 'abc1234');
  });

  test('MSP_BLACKBOX_CONFIG reads the 1.45 disabled mask', () => {
    const payload = concat(
      Uint8Array.from([1, 1, 1, 4]),
      u16(32),
      Uint8Array.from([2]),
      u32(0b10000000),
    );
    const cfg = parseBlackboxConfig(payload, '1.45.0');
    assert.equal(cfg.supported, true);
    assert.equal(cfg.device, 1);
    assert.equal(cfg.rateDenom, 4);
    assert.equal(cfg.sampleRateExp, 2);
    assert.equal(cfg.rateDivisor, 4);
    assert.equal(cfg.disabledMask, 128);
  });

  test('MSP_BLACKBOX_CONFIG omits the mask below API 1.45', () => {
    const payload = concat(Uint8Array.from([1, 1, 1, 2]), u16(0), Uint8Array.from([1]));
    const cfg = parseBlackboxConfig(payload, '1.44.0');
    assert.equal(cfg.disabledMask, 0);
    assert.equal(cfg.rateDivisor, 2);
  });

  test('MSP_DATAFLASH_SUMMARY', () => {
    const payload = concat(Uint8Array.from([0b11]), u32(512), u32(16 * 1024 * 1024), u32(1024));
    const summary = parseDataflashSummary(payload);
    assert.equal(summary.ready, true);
    assert.equal(summary.supported, true);
    assert.equal(summary.sectors, 512);
    assert.equal(summary.totalSize, 16 * 1024 * 1024);
    assert.equal(summary.usedSize, 1024);
  });

  test('MSP_DATAFLASH_SUMMARY treats a short payload as unsupported', () => {
    const summary = parseDataflashSummary(Uint8Array.from([1, 2, 3]));
    assert.equal(summary.supported, false);
  });

  test('MSP_SDCARD_SUMMARY', () => {
    const payload = concat(Uint8Array.from([1, 3, 0]), u32(4096), u32(32768));
    const summary = parseSdCardSummary(payload);
    assert.equal(summary.supported, true);
    assert.equal(summary.state, 3);
    assert.equal(summary.freeSizeKB, 4096);
    assert.equal(summary.totalSizeKB, 32768);
  });

  test('MSP_ADVANCED_CONFIG exposes pid_process_denom', () => {
    const payload = concat(Uint8Array.from([1, 2, 0, 5]), u16(480), u16(550));
    const adv = parseAdvancedConfig(payload);
    assert.equal(adv.pidProcessDenom, 2);
    assert.equal(adv.motorProtocol, 5);
  });

  test('CLI assignment parsing handles every shape Betaflight emits', () => {
    assert.deepEqual(parseCliAssignments('p_roll = 45'), { p_roll: 45 });
    assert.deepEqual(parseCliAssignments('set dshot_bidir = ON'), { dshot_bidir: 1 });
    assert.deepEqual(parseCliAssignments('set dshot_bidir = OFF'), { dshot_bidir: 0 });
    assert.deepEqual(parseCliAssignments('motor_pwm_protocol = DSHOT600'), { motor_pwm_protocol: 'DSHOT600' });
    assert.deepEqual(parseCliAssignments('Allowed values: 0, 1, 2'), {});
  });

  test('coerceCliValue maps ON/OFF to 1/0 only', () => {
    assert.equal(coerceCliValue('ON'), 1);
    assert.equal(coerceCliValue('OFF'), 0);
    assert.equal(coerceCliValue('on'), 1);
    assert.equal(coerceCliValue('-5'), -5);
    assert.equal(coerceCliValue('DSHOT600'), 'DSHOT600');
  });
});

/* ================================================================== *
 * 4. Client against a synthetic flight controller
 * ================================================================== */

/** @param {{silent?: number[]}} opts codes the synthetic FC never answers */
function makeVirtualFc({ silent = [] } = {}) {
  const boardInfo = concat(
    ascii('S405'),
    u16(1),
    Uint8Array.from([0]),
    Uint8Array.from([0b01000001]),
    ascii('STM32F405'), [0],
    ascii('Test Racer F405'), [0],
    ascii('TST'), [0],
    Uint8Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff),
    Uint8Array.from([0]),
    Uint8Array.from([0]),
    u16(8000),
    u32(0),
  );

  const handlers = {
    [MSP.MSP_API_VERSION]: () => Uint8Array.from([0, 1, 46]),
    [MSP.MSP_FC_VARIANT]: () => ascii('BTFL'),
    [MSP.MSP_FC_VERSION]: () => Uint8Array.from([4, 5, 1]),
    [MSP.MSP_BOARD_INFO]: () => boardInfo,
    [MSP.MSP_BUILD_INFO]: () => concat(ascii('Jan 01 2025'), ascii('12:00:00'), ascii('abc1234')),
    [MSP.MSP_ADVANCED_CONFIG]: () => concat(Uint8Array.from([1, 1, 0, 5]), u16(480), u16(550)),
    [MSP.MSP_BLACKBOX_CONFIG]: () => concat(Uint8Array.from([1, 1, 1, 4]), u16(32), Uint8Array.from([2]), u32(0)),
    [MSP.MSP_DATAFLASH_SUMMARY]: () => concat(Uint8Array.from([0b11]), u32(512), u32(16 * 1024 * 1024), u32(0)),
    [MSP.MSP_SDCARD_SUMMARY]: () => concat(Uint8Array.from([0, 0, 0]), u32(0), u32(0)),
    [MSP.MSP_NAME]: () => concat(ascii('RacerX'), [0]),
  };

  // Simulate a wedged flight controller for the listed commands.
  for (const code of silent) handlers[code] = () => SILENT;

  const cliHandler = (text) => {
    if (text.startsWith('version')) return ['# Betaflight / STM32F405 (S405) 4.5.1'];
    if (text.startsWith('status')) return ['Gyro detected', 'Arming disabled'];
    if (text.startsWith('get')) {
      const names = text.replace(/^get\s+/, '').split(/\s+/);
      const values = {
        motor_pwm_protocol: 'DSHOT600',
        dshot_bidir: 'ON',
        rpm_filter_harmonics: 3,
        gyro_lpf1_static_hz: 250,
        dyn_notch_count: 3,
        p_roll: 45,
      };
      return names.filter((n) => n in values).map((n) => `${n} = ${values[n]}`);
    }
    return [];
  };

  return new VirtualTransport(handlers, { cliHandler });
}

describe('MSP client against a synthetic FC', () => {
  test('requests are answered and decoded', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 500, retries: 0 });
    await client.open();

    const res = await client.request(MSP.MSP_FC_VARIANT);
    assert.equal(Buffer.from(res.raw).toString('ascii'), 'BTFL');

    await client.close();
  });

  test('unknown commands surface as protocol errors', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 300, retries: 0 });
    await client.open();

    await assert.rejects(() => client.request(0x7f), /rejected MSP command/);
    await client.close();
  });

  test('CLI commands are stateless one-shots; MSP works immediately after', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 800, retries: 0, cliTimeoutMs: 800 });
    await client.open();

    // No enterCli() call is needed, or wanted: the firmware enters and leaves
    // non-interactive CLI itself when a command is framed with STX.
    const { lines } = await client.cli('get motor_pwm_protocol');
    assert.deepEqual(lines, ['motor_pwm_protocol = DSHOT600']);

    // The regression this guards: the FC has left CLI on its own, so MSP must
    // answer straight away. This used to fail with
    // "cannot send MSP 1 while in CLI mode".
    const res = await client.request(MSP.MSP_FC_VARIANT, null, { retries: 0 });
    assert.equal(Buffer.from(res.raw).toString('ascii'), 'BTFL');

    await client.close();
  });

  test('the client never writes a bare "#" (that enters INTERACTIVE cli)', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 500, retries: 0, cliTimeoutMs: 500 });
    await client.open();

    await client.cli('status');
    await client.cliBatch(['version', 'status']);

    // A lone 0x23 byte switches the FC into interactive CLI, which never emits
    // STX/ETX framing - the exact deadlock being guarded against here.
    for (const bytes of transport.sent) {
      if (bytes.length === 1) assert.notEqual(bytes[0], 0x23, 'a bare "#" must never be sent');
    }

    await client.close();
  });

  test('a timed-out request degrades the link and the next call self-heals', async () => {
    const transport = makeVirtualFc({ silent: [MSP.MSP_STATUS] });
    const client = new MspClient(transport, { timeoutMs: 120, retries: 0, probeTimeoutMs: 400 });
    await client.open();

    await assert.rejects(() => client.request(MSP.MSP_STATUS, null, { retries: 0 }), /timed out/);
    assert.equal(client.isHealthy, false, 'a timeout must mark the link degraded');

    // Recovery path: unframed `exit`, then a probe, then serve the request.
    const res = await client.request(MSP.MSP_FC_VARIANT, null, { retries: 0 });
    assert.equal(Buffer.from(res.raw).toString('ascii'), 'BTFL');
    assert.equal(client.isHealthy, true, 'the link must be reported healthy again');

    const exitWrites = transport.sent.filter((b) => Buffer.from(b).toString('latin1').includes('exit'));
    assert.ok(exitWrites.length >= 1, 'recovery must send an unframed exit');

    await client.close();
  });

  test('reconnect() closes, waits and genuinely reopens the port', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 500, retries: 0, reopenDelayMs: 5, probeTimeoutMs: 400 });
    await client.open();
    const before = transport.openCount;

    const ok = await client.reconnect({ delayMs: 5 });

    assert.equal(ok, true);
    assert.equal(transport.openCount, before + 1, 'the transport must actually be reopened');
    assert.equal(client.linkState, 'msp');

    await client.close();
  });

  test('ping() reports the API version and a latency', async () => {
    const transport = makeVirtualFc();
    const client = new MspClient(transport, { timeoutMs: 500, retries: 0, probeTimeoutMs: 400 });
    await client.open();

    const result = await client.ping();
    assert.equal(result.ok, true);
    assert.equal(result.apiVersion, '1.46.0');
    assert.ok(result.latencyMs >= 0);

    await client.close();
  });

  test('a timed-out request rejects with MspTimeoutError', async () => {
    // The synthetic FC never answers MSP_STATUS.
    const transport = makeVirtualFc({ silent: [MSP.MSP_STATUS] });
    const client = new MspClient(transport, { timeoutMs: 120, retries: 0 });
    await client.open();
    await assert.rejects(() => client.request(MSP.MSP_STATUS, null, { retries: 0 }), /timed out/);
    await client.close();
  });
});

/* ================================================================== *
 * 5. Identification
 * ================================================================== */

describe('identification', () => {
  test('fingerprint is stable and sensitive to the signature', () => {
    const base = { variant: 'BTFL', boardIdentifier: 'S405', targetName: 'STM32F405', mcuTypeId: 0, signature: [1, 2, 3] };
    assert.equal(buildFingerprint(base), buildFingerprint({ ...base }));
    assert.notEqual(buildFingerprint(base), buildFingerprint({ ...base, signature: [1, 2, 4] }));
    assert.notEqual(buildFingerprint(base), buildFingerprint({ ...base, boardIdentifier: 'S406' }));
  });

  test('an all-zero signature is ignored, not hashed as data', () => {
    const zeros = { variant: 'BTFL', boardIdentifier: 'S405', targetName: 'T', mcuTypeId: 0, signature: new Array(32).fill(0) };
    const none = { variant: 'BTFL', boardIdentifier: 'S405', targetName: 'T', mcuTypeId: 0, signature: [] };
    assert.equal(buildFingerprint(zeros), buildFingerprint(none));
  });

  test('a well-formed Betaflight board scores highly and reaches "family"', () => {
    const msp = {
      variant: 'BTFL',
      board: { boardIdentifier: 'S405', targetName: 'STM32F405', signature: [1, 2, 3], sampleRateHz: 8000 },
    };
    const { confidence, matchLevel } = scoreConfidence({ msp, cli: { versionLine: 'BTFL 4.5.1' }, model: null, source: null });
    // 0.35 + 0.15 + 0.10 + 0.15 + 0.10 + 0.05
    assert.equal(confidence, 0.9);
    assert.equal(matchLevel, 'family');
  });

  test('an unknown non-Betaflight FC scores low', () => {
    const msp = { variant: 'CLFL', board: { boardIdentifier: '', targetName: '', signature: [], sampleRateHz: 0 } };
    const { confidence, matchLevel } = scoreConfidence({ msp, cli: { versionLine: null }, model: null, source: null });
    assert.equal(confidence, 0);
    assert.equal(matchLevel, 'unknown');
  });

  test('a seed-map hit with a signature is an exact match', () => {
    const msp = { variant: 'BTFL', board: { boardIdentifier: 'S405', targetName: 'T', signature: [9], sampleRateHz: 8000 } };
    const { matchLevel } = scoreConfidence({ msp, cli: { versionLine: 'x' }, model: { name: 'Board' }, source: 'seed' });
    assert.equal(matchLevel, 'exact');
  });

  test('filter profile description is readable', () => {
    const text = describeFilterProfile({ gyro_lpf1_static_hz: 250, dyn_notch_count: 3, rpm_filter_harmonics: 3 });
    assert.match(text, /gyro LPF1 250Hz/);
    assert.match(text, /3x dynamic notch/);
    assert.match(text, /RPM filter x3/);
  });
});

/* ================================================================== *
 * 6. Settings: backup validation and profile building
 * ================================================================== */

describe('settings', () => {
  test('a real dump is accepted', () => {
    assert.equal(isPlausibleCliDump('# Betaflight\nset p_roll = 45\n'), true);
  });

  test('empty, binary or comment-less output is rejected', () => {
    assert.equal(isPlausibleCliDump(''), false);
    assert.equal(isPlausibleCliDump('set p_roll = 45'), false);
    assert.equal(isPlausibleCliDump('# ok\u0000\u0001binary'), false);
  });

  test('PidProfile is built from flat CLI parameters', () => {
    const pid = buildPidProfile({ p_roll: 45, i_roll: 80, d_roll: 34, f_roll: 120, p_pitch: 47, pid_profile: 1 });
    assert.equal(pid.profileIndex, 1);
    assert.equal(pid.roll.P, 45);
    assert.equal(pid.roll.F, 120);
    assert.equal(pid.pitch.P, 47);
    // Not reported stays null rather than silently becoming zero.
    assert.equal(pid.yaw.P, null);
  });

  test('FilterConfig reports zeros for absent filters', () => {
    const filter = buildFilterConfig({ gyro_lpf1_static_hz: 250 });
    assert.equal(filter.gyroLpf1Hz, 250);
    assert.equal(filter.dtermLpf1Hz, 0);
    assert.equal(filter.dynamicNotchEnabled, false);
  });
});

/* ================================================================== *
 * 7. Blackbox rate maths — the exact rules from the brief
 * ================================================================== */

describe('blackbox rate calculation', () => {
  test('8 kHz loop targeting 2 kHz uses 1/4 (exp 2)', () => {
    const plan = computeBlackboxRate(8000, 2000);
    assert.equal(plan.sampleRateExp, 2);
    assert.equal(plan.denom, 4);
    assert.equal(plan.actualRate, 2000);
    assert.equal(plan.achievable, true);
  });

  test('4 kHz loop targeting 2 kHz uses 1/2 (exp 1)', () => {
    const plan = computeBlackboxRate(4000, 2000);
    assert.equal(plan.sampleRateExp, 1);
    assert.equal(plan.denom, 2);
    assert.equal(plan.actualRate, 2000);
    assert.equal(plan.achievable, true);
  });

  test('a 4 kHz loop asked for 1.6 kHz reports the closest real rate', () => {
    const plan = computeBlackboxRate(4000, 1600);
    assert.equal(plan.denom, 2);
    assert.equal(plan.actualRate, 2000);
    assert.equal(plan.achievable, false);
    assert.match(plan.reason, /2000 Hz/);
  });

  test('a target above the loop rate is refused', () => {
    const plan = computeBlackboxRate(2000, 4000);
    assert.equal(plan.achievable, false);
    assert.match(plan.reason, /slower than/);
  });

  test('an unknown loop rate does not produce a bogus plan', () => {
    const plan = computeBlackboxRate(0, 2000);
    assert.equal(plan.achievable, false);
    assert.match(plan.reason, /unknown/i);
  });

  test('the exponent is clamped to the firmware enum range 0..4', () => {
    assert.equal(computeBlackboxRate(32000, 1000).sampleRateExp, 4);
    assert.equal(computeBlackboxRate(32000, 1000).denom, 16);
  });
});

describe('blackbox field mask', () => {
  test('enabling exactly the required fields clears only their bits', () => {
    const mask = computeDisabledMask(REQUIRED_BB_FIELDS);
    for (const field of BLACKBOX_FIELDS) {
      const enabled = REQUIRED_BB_FIELDS.includes(field.key);
      const bitSet = (mask & (1 << field.bit)) !== 0;
      assert.equal(bitSet, !enabled, `field ${field.key} bit ${field.bit}`);
    }
  });

  test('mask round-trips back to field names', () => {
    const fields = ['gyro', 'setpoint', 'pid', 'rc', 'motor', 'rpm'];
    assert.deepEqual(fieldsFromDisabledMask(computeDisabledMask(fields)).sort(), [...fields].sort());
  });

  test('bit positions match the firmware enum', () => {
    const byKey = Object.fromEntries(BLACKBOX_FIELDS.map((f) => [f.key, f.bit]));
    assert.equal(byKey.pid, 0);
    assert.equal(byKey.rc, 1);
    assert.equal(byKey.setpoint, 2);
    assert.equal(byKey.gyro, 7);
    assert.equal(byKey.motor, 11);
    assert.equal(byKey.rpm, 13);
  });

  test('device auto-resolution prefers flash, then SD, then serial', () => {
    assert.equal(resolveDevice('auto', { hasFlash: true, hasSdCard: true }), 'SPIFLASH');
    assert.equal(resolveDevice('auto', { hasFlash: false, hasSdCard: true }), 'SDCARD');
    assert.equal(resolveDevice('auto', { hasFlash: false, hasSdCard: false }), 'SERIAL');
    assert.equal(resolveDevice('sdcard', { hasFlash: true }), 'SDCARD');
  });
});

/* ================================================================== *
 * 8. Safety guard
 * ================================================================== */

describe('safety guard', () => {
  test('failsafe, ESC protocol and voltage calibration are all blocked', () => {
    const guard = new SafetyGuard();
    const { allowed, blocked } = guard.screenCommands([
      'set p_roll = 45',
      'set failsafe_throttle = 1000',
      'set motor_pwm_protocol = DSHOT300',
      'set vbat_scale = 110',
      'set yaw_motors_reversed = ON',
      'set dshot_bidir = ON',
    ]);

    assert.deepEqual(allowed, ['set p_roll = 45']);
    assert.equal(blocked.length, 5);
    assert.ok(blocked.every((b) => /immutable safety list/.test(b.reason)));
  });

  test('every forbidden prefix in the contract is actually rejected', () => {
    const guard = new SafetyGuard();
    for (const prefix of FORBIDDEN_PARAMS) {
      const param = prefix.endsWith('_') ? `${prefix}test` : prefix;
      const { blocked } = guard.screenCommands([`set ${param} = 1`]);
      assert.equal(blocked.length, 1, `expected "${param}" to be blocked`);
    }
  });

  test('arbitrary non-set commands are not allowed through', () => {
    const guard = new SafetyGuard();
    const { allowed, blocked } = guard.screenCommands(['get p_roll', 'dump', 'defaults', 'bl', 'reboot']);
    assert.deepEqual(allowed, ['get p_roll', 'dump', 'defaults']);
    assert.equal(blocked.length, 2);
  });

  test('writes are refused until a backup exists', () => {
    const guard = new SafetyGuard();
    assert.equal(guard.canWrite({ kind: 'tune' }).ok, false);
    assert.match(guard.canWrite({ kind: 'tune' }).reasons.join(), /backup/);

    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    assert.equal(guard.canWrite({ kind: 'tune' }).ok, true);
  });

  test('only one tuning round is permitted', () => {
    const guard = new SafetyGuard();
    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    guard.recordWrite('p1', ['set p_roll = 46']);
    const gate = guard.canWrite({ kind: 'tune' });
    assert.equal(gate.ok, false);
    assert.match(gate.reasons.join(), /single permitted tuning round/);
  });

  test('safe mode blocks tuning but still allows logging configuration', () => {
    const guard = new SafetyGuard();
    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    guard.enterSafeMode('Unknown board');
    assert.equal(guard.canWrite({ kind: 'tune' }).ok, false);
    assert.equal(guard.canWrite({ kind: 'logging' }).ok, true);
  });

  test('a desync latches read-only and is not cleared by acknowledging', () => {
    const guard = new SafetyGuard();
    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    guard.latchFaults([{ code: 'MOTOR_DESYNC', severity: 'critical', evidence: 'motor 2 dropped to 0', blocksTuning: true }]);
    assert.equal(guard.readOnly, true);
    guard.ack();
    assert.equal(guard.readOnly, true);
    assert.match(guard.canWrite({ kind: 'tune' }).reasons.join(), /MOTOR_DESYNC/);
  });

  test('a non-latching advisory does not force read-only', () => {
    const guard = new SafetyGuard();
    guard.latchFaults([{ code: 'NO_RPM_DATA', severity: 'warn', evidence: 'no eRPM', blocksTuning: false }]);
    assert.equal(guard.readOnly, false);
  });

  test('force-trust lifts SAFE MODE but keeps flight-parameter writes disabled', () => {
    const guard = new SafetyGuard();
    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    guard.enterSafeMode('Unknown board - SAFE MODE (read-only analysis, no parameter writes)');

    assert.equal(guard.canWrite({ kind: 'tune' }).ok, false);

    const result = guard.forceTrust();
    assert.equal(result.ok, true);
    assert.equal(guard.status.readOnly, false, 'the SAFE MODE lockdown is lifted');
    assert.match(guard.status.tuningLocked, /flight-parameter writes remain disabled/);

    // Logging is allowed...
    assert.equal(guard.canWrite({ kind: 'logging' }).ok, true);
    // ...but tuning stays refused for the rest of the session.
    const gate = guard.canWrite({ kind: 'tune' });
    assert.equal(gate.ok, false);
    assert.match(gate.reasons.join(' '), /flight-parameter writes remain disabled/);
  });

  test('force-trust cannot override a latched hardware fault', () => {
    const guard = new SafetyGuard();
    guard.markBackup({ path: '/tmp/b', sha256: 'abc' });
    guard.latchFaults([{ code: 'MOTOR_DESYNC', severity: 'critical', evidence: 'motor 2 dropped to 0', blocksTuning: true }]);

    const result = guard.forceTrust();
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot be overridden/);
    assert.equal(guard.readOnly, true);
  });

  test('stale diffs are detected against live values', () => {
    const guard = new SafetyGuard();
    assert.equal(guard.verifyAgainstLive([{ param: 'p_roll', from: 45, to: 48 }], { p_roll: 45 }).ok, true);
    const drift = guard.verifyAgainstLive([{ param: 'p_roll', from: 45, to: 48 }], { p_roll: 52 });
    assert.equal(drift.ok, false);
    assert.equal(drift.mismatches[0].live, 52);
  });
});

/* ================================================================== *
 * 9. Proposal engine
 * ================================================================== */

/** Minimal but shape-correct metrics report. */
/**
 * Synthetic Welch spectrum: a flat floor, optionally rising above it from
 * `onsetHz` upward. Used to drive the filter advisor without a real log.
 */
function makeSpectrum({ floorDb = -60, onsetHz = null, bins = 256, binHz = 10, liftDb = 20 } = {}) {
  const freqs = [];
  const psd = [];
  const floor = 10 ** (floorDb / 10);
  const lifted = floor * 10 ** (liftDb / 10);
  for (let i = 0; i < bins; i++) {
    const f = i * binHz;
    freqs.push(f);
    psd.push(onsetHz !== null && f >= onsetHz ? lifted : floor);
  }
  return { freqs, psd, binHz, segments: 4 };
}

function makeMetrics(overrides = {}) {
  const axis = (extra = {}) => ({
    axis: 'roll',
    gyroRms: 50,
    gyroPeak: 400,
    noiseFloorDbfs: -40,
    gyroSpectrum: { freqs: [], psd: [], binHz: 1, segments: 1 },
    peaks: [],
    motorNoisePeakHz: 0,
    propwashIndex: 0,
    propwashEvents: 0,
    dTermRms: 5,
    dTermToGyroRatio: 0.1,
    step: { overshootPct: 5, riseTimeMs: 40, settlingTimeMs: 60, steadyStateErrorPct: 2, latencyMs: 8, samples: 8 },
    trackingGainDb: 0,
    trackingCoherence: 0.9,
    trackingPhaseDeg: -10,
    iTermWindupScore: 0,
    ...extra,
  });

  return {
    file: 'test.bbl',
    logIndex: 0,
    sampleRateHz: 2000,
    durationS: 45,
    dropRatePct: 0.1,
    motorSaturationPct: 2,
    rpmAvailable: 1,
    rpmMin: 1000,
    rpmMax: 25000,
    axes: { roll: axis(), pitch: axis({ axis: 'pitch' }), yaw: axis({ axis: 'yaw' }) },
    faults: [],
    blocksTuning: false,
    warnings: [],
    sampleQuality: 0.9,
    ...overrides,
  };
}

const PID = { roll: { P: 45, I: 80, D: 34 }, pitch: { P: 47, I: 85, D: 36 }, yaw: { P: 45, I: 80, D: 0 } };
const FILTER = { gyroLpf1Hz: 250, dtermLpf1Hz: 120, rpmFilterHarmonics: 3, rpmFilterQ: 500, rpmFilterMinHz: 100 };

describe('proposal engine', () => {
  test('a blocking fault produces only hardware advice', () => {
    const metrics = makeMetrics({
      blocksTuning: true,
      faults: [{ code: 'MOTOR_DESYNC', severity: 'critical', evidence: 'motor 2 eRPM dropped to 0 at t=12.4s', blocksTuning: true }],
    });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    assert.ok(proposals.length >= 1);
    assert.ok(proposals.every((p) => p.category === 'hardware'));
    assert.ok(proposals.every((p) => p.safeToApply === false));
    assert.ok(proposals.every((p) => p.cli.length === 0));
  });

  test('propwash raises D by 2-3 units and quotes the evidence', () => {
    const metrics = makeMetrics({
      axes: {
        roll: { ...makeMetrics().axes.roll, propwashIndex: 0.51, propwashEvents: 7 },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const [p] = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    assert.equal(p.category, 'pid');
    assert.match(p.problem, /propwash|洗流/);
    assert.match(p.evidence, /0\.51/);

    const dRoll = p.diff.find((d) => d.param === 'd_roll');
    assert.ok(dRoll, 'expected a d_roll change');
    const delta = dRoll.to - dRoll.from;
    assert.ok(delta >= 2 && delta <= 3, `D step ${delta} outside the 2-3 unit window`);
    assert.ok(p.cli.includes(`set d_roll = ${dRoll.to}`));
  });

  test('overshoot lowers P by 5-10%', () => {
    const metrics = makeMetrics({
      axes: {
        roll: {
          ...makeMetrics().axes.roll,
          step: { overshootPct: 42, riseTimeMs: 25, settlingTimeMs: 200, steadyStateErrorPct: 1, latencyMs: 6, samples: 10 },
        },
        pitch: {
          ...makeMetrics().axes.pitch,
          step: { overshootPct: 38, riseTimeMs: 26, settlingTimeMs: 190, steadyStateErrorPct: 1, latencyMs: 6, samples: 9 },
        },
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    const p = proposals.find((x) => x.id.startsWith('overshoot'));
    assert.ok(p, 'expected an overshoot proposal');

    for (const d of p.diff) {
      const pct = ((d.from - d.to) / d.from) * 100;
      assert.ok(pct >= 5 && pct <= 10, `P reduced by ${pct.toFixed(1)}%, outside the 5-10% window`);
    }
    // Roll and pitch should be handled together.
    assert.equal(p.diff.length, 2);
  });

  test('a sluggish response raises P', () => {
    const metrics = makeMetrics({
      axes: {
        roll: {
          ...makeMetrics().axes.roll,
          step: { overshootPct: 3, riseTimeMs: 120, settlingTimeMs: 150, steadyStateErrorPct: 1, latencyMs: 20, samples: 8 },
        },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    const p = proposals.find((x) => x.id.startsWith('sluggish'));
    assert.ok(p);
    assert.ok(p.diff.every((d) => d.to > d.from));
  });

  test('propwash prefers raising D_min over static D (5-inch race profile)', () => {
    const noisy = (extra = {}) => ({
      propwashIndex: 0.8, propwashEvents: 9, dTermToGyroRatio: 0.2, gyroRms: 50,
      step: { overshootPct: 5, settlingTimeMs: 50, samples: 20 }, peaks: [], ...extra,
    });
    const metrics = makeMetrics({
      sampleQuality: 0.9,
      motorSaturationPct: 0,
      axes: { roll: noisy(), pitch: noisy(), yaw: noisy() },
    });
    const filter = { ...FILTER, gyroLpf1Hz: 250, dtermLpf1Hz: 120, rpmFilterHarmonics: 3 };

    // D_min unset: raise it to a meaningful floor near the cruise D, because
    // nudging a disabled floor from 0 by one step changes nothing.
    const unset = proposeTune({ metrics, currentPid: PID, currentFilter: filter, dynamics: { dMin: { roll: 0, pitch: 0, yaw: 0 } } });
    const a = unset.find((p) => p.category === 'pid');
    assert.ok(a.cli.some((c) => /^set d_min_roll = \d+$/.test(c)), `unexpected: ${a.cli.join(', ')}`);
    const rollTarget = Number(/d_min_roll = (\d+)/.exec(a.cli.join(' '))[1]);
    assert.ok(rollTarget >= 20 && rollTarget <= 34, `d_min_roll ${rollTarget} should approach the cruise D`);

    // Already in the right region: move conservatively.
    const inRegion = proposeTune({ metrics, currentPid: PID, currentFilter: filter, dynamics: { dMin: { roll: 30, pitch: 30, yaw: 0 } } });
    const b = inRegion.find((p) => p.category === 'pid');
    const stepTarget = Number(/d_min_roll = (\d+)/.exec(b.cli.join(' '))[1]);
    assert.ok(stepTarget > 30 && stepTarget <= 34, `d_min_roll ${stepTarget} should step up toward D`);

    // Without D_min data, fall back to static D.
    const noData = proposeTune({ metrics, currentPid: PID, currentFilter: filter });
    const c = noData.find((p) => p.category === 'pid');
    assert.ok(c.cli.some((x) => /^set d_roll = \d+$/.test(x)), `unexpected: ${c.cli.join(', ')}`);
  });

  test('filter advice is produced with RPM filtering OFF (it is never required)', () => {
    const metrics = makeMetrics({
      axes: {
        roll: { ...makeMetrics().axes.roll, dTermToGyroRatio: 0.7, dTermRms: 40 },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({
      metrics,
      currentPid: PID,
      currentFilter: { ...FILTER, rpmFilterHarmonics: 0 },
      capabilities: { bidirDshot: false, motorProtocol: 'DSHOT600' },
    });
    const dterm = proposals.find((x) => x.id === 'filter-dterm-lpf1');
    assert.ok(dterm, 'D-term filter advice must exist without RPM filtering');
    assert.equal(dterm.category, 'filter');
    assert.deepEqual(dterm.blockedBy, [], 'RPM filtering must never be a blocker');
  });

  test('a short log produces no blocking "insufficient sample" proposal', () => {
    const metrics = makeMetrics({ sampleQuality: 0.3, durationS: 4 });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    assert.equal(proposals.find((x) => x.id === 'sample-quality'), undefined);
    for (const p of proposals) {
      assert.equal((p.blockedBy || []).includes('样本不足'), false);
    }
  });

  test('filter advisor tightens gyro LPF1 when the chain fails to attenuate the noise band', () => {
    const metrics = makeMetrics({
      axes: {
        roll: { ...makeMetrics().axes.roll, gyroUnfiltSpectrum: makeSpectrum(), filterAttenuationDb: 5 },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({
      metrics,
      currentPid: PID,
      currentFilter: { ...FILTER, gyroLpf1Hz: 250 },
    });
    const p = proposals.find((x) => x.id === 'filter-gyro-lpf1-open');
    assert.ok(p, 'expected a gyro LPF1 proposal');
    assert.equal(p.category, 'filter');
    assert.equal(p.diff[0].param, 'gyro_lpf1_static_hz');
    assert.ok(p.diff[0].to < 250, `target ${p.diff[0].to} must be below the current 250 Hz`);
    // Never below the sane floor - an over-aggressive LPF would wreck the feel.
    assert.ok(p.diff[0].to >= 150, `target ${p.diff[0].to} must stay >= 150 Hz`);
    assert.match(p.evidence, /200 Hz/);
  });

  test('filter advisor leaves a chain that already attenuates well alone', () => {
    const metrics = makeMetrics({
      axes: {
        roll: { ...makeMetrics().axes.roll, gyroUnfiltSpectrum: makeSpectrum(), filterAttenuationDb: 26 },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({
      metrics,
      currentPid: PID,
      currentFilter: { ...FILTER, gyroLpf1Hz: 250 },
    });
    assert.equal(proposals.find((x) => x.id === 'filter-gyro-lpf1-open'), undefined);
  });

  test('filter advice claims one of the three slots even when PID findings rank higher', () => {
    const raw = makeSpectrum({ floorDb: -60, onsetHz: 100 });
    const base = makeMetrics();
    const metrics = makeMetrics({
      sampleQuality: 0.95,
      axes: {
        roll: {
          ...base.axes.roll,
          propwashIndex: 0.9,
          propwashEvents: 9,
          dTermToGyroRatio: 0.8,
          gyroUnfiltSpectrum: raw,
          filterAttenuationDb: 5,
        },
        pitch: { ...base.axes.pitch, propwashIndex: 0.85, step: { ...base.axes.pitch.step, overshootPct: 45 } },
        yaw: base.axes.yaw,
      },
    });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: { ...FILTER, gyroLpf1Hz: 350 } });
    assert.ok(proposals.some((p) => p.category === 'filter'), 'a filter proposal must survive the top-3 cut');
  });

  test('no faults and good metrics produce no actionable changes', () => {
    const proposals = proposeTune({ metrics: makeMetrics(), currentPid: PID, currentFilter: FILTER });
    // A non-actionable filter assessment is always reported (so the page can
    // show a filter verdict), but nothing here should propose a write.
    for (const p of proposals) {
      assert.deepEqual(p.diff, [], `${p.id} must not propose a change`);
      assert.equal(p.safeToApply, false, `${p.id} must not be applicable`);
    }
    const assessment = proposals.find((p) => p.id === 'filter-assessment');
    assert.ok(assessment, 'the filter verdict must always be reported');
    assert.equal(assessment.category, 'filter');
  });

  test('at most three proposals are returned', () => {
    const metrics = makeMetrics({
      sampleQuality: 0.2,
      axes: {
        roll: {
          ...makeMetrics().axes.roll,
          propwashIndex: 0.9,
          dTermToGyroRatio: 0.9,
          iTermWindupScore: 0.9,
          peaks: [{ hz: 150, psd: 1, prominenceDb: 20, bandwidthHz: 10 }],
        },
        pitch: { ...makeMetrics().axes.pitch, propwashIndex: 0.8, dTermToGyroRatio: 0.8 },
        yaw: makeMetrics().axes.yaw,
      },
    });
    const proposals = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    assert.ok(proposals.length <= 3, `got ${proposals.length}`);
  });

  test('every proposal renders in the four-part format', () => {
    const metrics = makeMetrics({
      axes: {
        roll: { ...makeMetrics().axes.roll, propwashIndex: 0.6, propwashEvents: 5 },
        pitch: makeMetrics().axes.pitch,
        yaw: makeMetrics().axes.yaw,
      },
    });
    const [p] = proposeTune({ metrics, currentPid: PID, currentFilter: FILTER });
    assert.ok(p.problem && p.evidence && p.verification);
    assert.ok(Array.isArray(p.cli));
    assert.ok(p.confidence > 0 && p.confidence <= 1);
  });
});

describe('diff screening', () => {
  test('forbidden parameters never reach the diff', () => {
    const { allowed, blocked } = filterDiff([
      { param: 'p_roll', from: 45, to: 48 },
      { param: 'failsafe_throttle', from: 1000, to: 1200 },
      { param: 'vbat_scale', from: 110, to: 115 },
    ]);
    assert.deepEqual(allowed.map((a) => a.param), ['p_roll']);
    assert.equal(blocked.length, 2);
  });

  test('the tunable whitelist accepts real parameters and rejects others', () => {
    for (const ok of ['p_roll', 'd_yaw', 'f_pitch', 'd_max_roll', 'gyro_lpf1_static_hz', 'dterm_lpf2_static_hz', 'dyn_notch_q', 'rpm_filter_harmonics', 'blackbox_sample_rate']) {
      assert.equal(isTunableParam(ok), true, `${ok} should be tunable`);
    }
    for (const bad of ['failsafe_throttle', 'motor_pwm_protocol', 'reboot', 'serialrx_provider', 'gtune_0']) {
      assert.equal(isTunableParam(bad), false, `${bad} should not be tunable`);
    }
  });

  test('step helpers respect their floors', () => {
    assert.equal(clampStepPercent(45, -0.07), 42); // 7% of 45 = 3.15 -> 3
    assert.equal(clampStepPercent(45, 0.07), 48);
    assert.equal(clampStepD(34, 3), 37);
    assert.equal(clampStepD(1, -3), 0); // never negative
    assert.equal(clampStepPercent(250, -0.1, 5, 100), 225);
  });
});

/* ================================================================== *
 * 10. Contract drift
 * ================================================================== */

describe('contracts', () => {
  test('the preload bridge mirrors every IPC channel', () => {
    const preload = readFileSync(join(projectRoot, 'src', 'main', 'preload.cjs'), 'utf8');
    const missing = Object.entries(CH)
      .filter(([name]) => !new RegExp(`\\b${name}:\\s*'`).test(preload))
      .map(([name, value]) => `${name} (${value})`);
    assert.deepEqual(missing, [], `preload.cjs is missing channels: ${missing.join(', ')}`);
  });

  test('every channel value is unique', () => {
    const values = Object.values(CH);
    assert.equal(new Set(values).size, values.length);
  });

  test('the preload mirrors the exact channel strings', () => {
    const preload = readFileSync(join(projectRoot, 'src', 'main', 'preload.cjs'), 'utf8');
    for (const [name, value] of Object.entries(CH)) {
      assert.match(preload, new RegExp(`${name}: '${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    }
  });
});
