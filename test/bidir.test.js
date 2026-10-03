/**
 * Bidirectional DShot / RPM detection tests.
 *
 * Parser fixtures mirror the exact firmware outputs they were taken from:
 *   - src/main/cli/cli.c        cliDshotTelemetryInfo
 *   - src/main/msp/msp.c        MSP_MOTOR_TELEMETRY / MSP_ANALOG
 *
 * Run with: node --test
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDshotTelemetryInfo,
  parseMspMotorTelemetry,
  parseAnalog,
  mergeTelemetry,
  judgeBidirDshot,
  assessMotorPoles,
  BIDIR_CLI_PARAMS,
} from '../src/main/fc/fc-identify.js';

const CLI_INFO = [
  'Dshot reads: 48213',
  'Dshot invalid pkts: 3',
  '',
  'Motor    Type   eRPM    RPM     Hz Invalid   TEMP    VCC   CURR  ST/EV   DBG1   DBG2   DBG3',
  '=====  ====== ====== ====== ====== ======= ====== ====== ====== ====== ====== ====== ======',
  '    1   R----  15234   2176     36  0.12%   28   12.6   0.5     --      0     0     0',
  '    2   R----  15198   2171     36  0.09%   27   12.5   0.5     --      0     0     0',
  '    3   R----  15300   2185     36 NO DATA',
  '    4   R----  15270   2181     36  0.15%   28   12.5   0.4     --      0     0     0',
];

function mspPayload(motors) {
  const bytes = [motors.length];
  for (const m of motors) {
    const rpm = m.rpm >>> 0;
    const invalid = Math.round((m.invalidPct ?? 0) * 100);
    bytes.push(
      rpm & 0xff, (rpm >>> 8) & 0xff, (rpm >>> 16) & 0xff, (rpm >>> 24) & 0xff,
      invalid & 0xff, (invalid >>> 8) & 0xff,
      m.temp ?? 0,
      m.voltage & 0xff, (m.voltage >>> 8) & 0xff,
      m.current & 0xff, (m.current >>> 8) & 0xff,
      m.consumption & 0xff, (m.consumption >>> 8) & 0xff,
    );
  }
  return Uint8Array.from(bytes);
}

describe('dshot_telemetry_info parser', () => {
  test('parses the real table including NO DATA motors', () => {
    const out = parseDshotTelemetryInfo(CLI_INFO);
    assert.equal(out.enabled, true);
    assert.equal(out.reads, 48213);
    assert.equal(out.invalidPackets, 3);
    assert.equal(out.motors.length, 4);

    assert.deepEqual(
      { ...out.motors[0], noData: false },
      { index: 0, types: 'R----', erpm: 15234, rpm: 2176, hz: 36, invalidPct: 0.12, noData: false },
    );
    // NO DATA motor: zeroed rpm/erpm, flagged.
    assert.equal(out.motors[2].noData, true);
    assert.equal(out.motors[2].rpm, 0);
    assert.equal(out.motors[2].invalidPct, null);
  });

  test('reports disabled telemetry without throwing', () => {
    const out = parseDshotTelemetryInfo(['Dshot telemetry not enabled']);
    assert.equal(out.enabled, false);
    assert.deepEqual(out.motors, []);
  });

  test('tolerates empty and garbage input', () => {
    assert.equal(parseDshotTelemetryInfo([]).enabled, false);
    assert.equal(parseDshotTelemetryInfo(null).enabled, false);
    assert.deepEqual(parseDshotTelemetryInfo(['', 'banner', '# prompt']).motors, []);
  });
});

describe('MSP motor telemetry parser', () => {
  test('parses 13 bytes per motor', () => {
    const payload = mspPayload([
      { rpm: 2176, invalidPct: 0.12, temp: 28, voltage: 126, current: 5, consumption: 12 },
      { rpm: 0, invalidPct: 100, temp: 0, voltage: 0, current: 0, consumption: 0 },
    ]);
    const out = parseMspMotorTelemetry(payload);
    assert.equal(out.motorCount, 2);
    assert.equal(out.motors[0].rpm, 2176);
    assert.equal(out.motors[0].invalidPct, 0.12);
    assert.equal(out.motors[0].voltage, 1.26);
    assert.equal(out.motors[0].consumption, 12);
    // Firmware reports 100.00% for telemetry that never became active.
    assert.equal(out.motors[1].invalidPct, 100);
  });

  test('a short payload yields no phantom motors', () => {
    const out = parseMspMotorTelemetry(Uint8Array.from([4, 1, 2, 3]));
    assert.deepEqual(out.motors, []);
  });
});

describe('analog parser', () => {
  test('vbat in 0.1 V units', () => {
    assert.equal(parseAnalog(Uint8Array.from([125, 0, 0, 0, 0])).vbatTenths, 125);
    assert.equal(parseAnalog(Uint8Array.from([0])).vbatTenths, 0);
  });
});

describe('mergeTelemetry', () => {
  test('MSP base with CLI overlay', () => {
    const msp = parseMspMotorTelemetry(
      mspPayload([
        { rpm: 2176, invalidPct: 0.12, temp: 28, voltage: 126, current: 5, consumption: 12 },
        { rpm: 0, invalidPct: 100, temp: 0, voltage: 0, current: 0, consumption: 0 },
      ]),
    );
    const cli = parseDshotTelemetryInfo(CLI_INFO);
    const merged = mergeTelemetry(msp, cli);

    assert.equal(merged.length, 2);
    assert.equal(merged[0].rpm, 2176);
    assert.equal(merged[0].erpm, 15234);
    assert.equal(merged[0].hz, 36);
    assert.equal(merged[0].types, 'R----');
    assert.equal(merged[0].invalidPct, 0.12); // MSP value wins
  });

  test('falls back to CLI-only when MSP is unavailable', () => {
    const merged = mergeTelemetry(null, parseDshotTelemetryInfo(CLI_INFO));
    assert.equal(merged.length, 4);
    assert.equal(merged[0].rpm, 2176);
    assert.equal(merged[2].noData, true);
  });
});

describe('judgeBidirDshot decision matrix', () => {
  const BASE = {
    protocol: 'DSHOT600',
    rpmFilter: { enabled: true, harmonics: 3, q: 500, minHz: 100 },
    poles: 14,
    powerState: 'battery',
    telemetryReads: 48213,
  };
  const liveMotors = (n, rpm = 2000) =>
    Array.from({ length: n }, (_, i) => ({ index: i, rpm: rpm + i * 10, erpm: 15000 + i * 10, invalidPct: 0.1, noData: false }));

  test('bidir ON + DShot + rpm filter + all motors live + invalid < 1% -> high confidence', () => {
    const j = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: liveMotors(4) });
    assert.equal(j.escSupported, 'yes');
    assert.ok(j.confidence >= 0.9);
    assert.match(j.conclusion, /已生效/);
  });

  test('bidir ON but no telemetry -> "firmware on, ESC silent", medium confidence', () => {
    const j = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: [], telemetryReads: 0 });
    assert.equal(j.escSupported, 'no');
    assert.ok(j.confidence >= 0.5 && j.confidence < 0.9);
    assert.match(j.conclusion, /无遥测回传/);
    assert.match(j.warnings.join(' '), /BLHeli_32/);
  });

  test('bidir OFF with rpm filter set -> suggests enabling, never auto-writes', () => {
    const j = judgeBidirDshot({ ...BASE, bidirOn: false, telemetryPerMotor: [] });
    assert.equal(j.escSupported, 'unknown');
    assert.ok(j.suggestedCli.includes('set dshot_bidir = ON'));
    assert.match(j.warnings.join(' '), /不会自动写入/);
  });

  test('partial telemetry is its own verdict', () => {
    const j = judgeBidirDshot({
      ...BASE,
      bidirOn: true,
      telemetryPerMotor: [...liveMotors(3), { index: 3, rpm: 0, erpm: 0, invalidPct: 100, noData: true }],
    });
    assert.match(j.conclusion, /3\/4/);
    assert.ok(j.confidence < 0.6);
  });

  test('high invalid rate on live motors lowers confidence', () => {
    const bad = liveMotors(4).map((m) => ({ ...m, invalidPct: 2.4 }));
    const j = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: bad });
    assert.match(j.conclusion, /无效包率过高/);
    assert.ok(j.confidence < 0.5);
  });

  test('USB-only with zero telemetry is "cannot verify", NOT "ESC has no telemetry"', () => {
    const j = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: [], telemetryReads: 0, powerState: 'usb-only' });
    assert.equal(j.escSupported, 'unknown');
    assert.match(j.conclusion, /未接锂电/);
    assert.doesNotMatch(j.conclusion, /无遥测回传/);

    // With a battery the same all-zero state IS an ESC-side problem.
    const k = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: [], telemetryReads: 0, powerState: 'battery' });
    assert.equal(k.escSupported, 'no');
    assert.match(k.conclusion, /无遥测回传/);
  });

  test('non-DShot protocol is a definitive no', () => {
    const j = judgeBidirDshot({ ...BASE, protocol: 'ONESHOT125', bidirOn: false, telemetryPerMotor: [] });
    assert.equal(j.escSupported, 'no');
    assert.ok(j.confidence >= 0.9);
  });

  test('usb-only power adds the "not power-verified" note', () => {
    const j = judgeBidirDshot({ ...BASE, bidirOn: true, telemetryPerMotor: liveMotors(4), powerState: 'usb-only' });
    assert.match(j.notes.join(' '), /未做动力验证/);
  });
});

describe('assessMotorPoles', () => {
  test('unset/zero is flagged with a suggestion', () => {
    for (const poles of [null, undefined, 0, '']) {
      const a = assessMotorPoles(poles);
      assert.equal(a.issue, true, `poles=${poles}`);
      assert.ok(a.suggested);
    }
  });
  test('12 and 14 pass', () => {
    assert.equal(assessMotorPoles(12).issue, false);
    assert.equal(assessMotorPoles(14).issue, false);
  });
  test('unusual counts are flagged but not auto-corrected', () => {
    const a = assessMotorPoles(16);
    assert.equal(a.issue, true);
    assert.equal(a.suggested, null);
  });
});

describe('CLI param coverage', () => {
  test('the probe reads everything the judgment consumes', () => {
    for (const needed of ['motor_pwm_protocol', 'dshot_bidir', 'motor_poles', 'rpm_filter_harmonics', 'rpm_filter_q', 'rpm_filter_min_hz']) {
      assert.ok(BIDIR_CLI_PARAMS.includes(needed), needed);
    }
  });
});
