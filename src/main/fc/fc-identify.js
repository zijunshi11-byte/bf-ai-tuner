/**
 * Flight controller identification.
 *
 * Three layers, in the order the workflow requires, each contributing evidence
 * and confidence rather than a single yes/no answer:
 *
 *   1. MSP layer      - variant, firmware version, API version, board info,
 *                       build info, 32-byte build signature
 *   2. CLI/status     - `version`, `status`, and target-revealing `get` values
 *   3. Capabilities   - loop rates, motor protocol, bidirectional DShot,
 *                       RPM filter, blackbox media
 *
 * The result is a fingerprint plus a 0..1 confidence and a match level. An
 * unrecognised board is NOT guessed at: it drops to SAFE MODE (read-only
 * analysis, no parameter writes) and its observed capabilities are recorded
 * locally so the next connection is better informed.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MSP, firmwareFamily } from '../msp/msp-codes.js';
import { ByteReader } from '../msp/msp-codec.js';
import { BLACKBOX_DEVICE } from '../../shared/contracts.js';

/**
 * Motor protocol names, indexed by the firmware enum value
 * (src/main/drivers/motor_types.h, MOTOR_PROTOCOL_*).
 *
 * Index 10 changed meaning: DSHOT1200 was removed and the slot is now
 * DRONECAN. Only the MSP fallback reads this table - `motor_pwm_protocol` from
 * the CLI is authoritative and is preferred wherever it is available.
 */
export const MOTOR_PROTOCOLS = [
  'PWM',
  'ONESHOT125',
  'ONESHOT42',
  'MULTISHOT',
  'BRUSHED',
  'DSHOT150',
  'DSHOT300',
  'DSHOT600',
  'PROSHOT1000',
  'DISABLED',
  'DRONECAN',
];

/** CLI parameters that reveal tuning-relevant capability. */
export const CAPABILITY_CLI_PARAMS = [
  'motor_pwm_protocol',
  'dshot_bidir',
  'rpm_filter_harmonics',
  'rpm_filter_min_hz',
  'gyro_lpf1_static_hz',
  'gyro_lpf2_static_hz',
  'dterm_lpf1_static_hz',
  'dterm_lpf2_static_hz',
  'dyn_notch_count',
  'dyn_notch_q',
  'dyn_notch_min_hz',
  'dyn_notch_max_hz',
  'gyro_rpm_notch_q',
  'blackbox_device',
  'blackbox_sample_rate',
];

/**
 * CLI parameters that pin down the bidirectional DShot / RPM-filter state.
 * `motor_poles` is essential: RPM is derived from eRPM / polePairs, so a wrong
 * pole count quietly corrupts every RPM reading and the filter placement.
 */
export const BIDIR_CLI_PARAMS = [
  'motor_pwm_protocol',
  'dshot_bidir',
  'motor_poles',
  'rpm_filter_harmonics',
  'rpm_filter_q',
  'rpm_filter_min_hz',
];

export class FcIdentifier {
  /**
   * @param {import('../msp/msp-helper.js').MspHelper} helper
   * @param {{seedMapPath?:string, localMapPath?:string, onLog?:Function}} opts
   */
  constructor(helper, { seedMapPath = null, localMapPath = null, onLog = () => {} } = {}) {
    this.helper = helper;
    this.onLog = onLog;
    this.seedMapPath = seedMapPath;
    this.localMapPath = localMapPath;

    /** @type {FcIdentity|null} */
    this.identity = null;
    /** @type {object|null} */
    this.capabilities = null;

    this.modelMap = this.#loadModelMap();
  }

  /* ---------------- model map ---------------- */

  #loadModelMap() {
    const map = { seed: {}, learned: {} };
    if (this.seedMapPath && existsSync(this.seedMapPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.seedMapPath, 'utf8'));
        map.seed = raw.models || {};
      } catch (err) {
        this.onLog('warn', `model map unreadable (${err.message}); continuing with learned entries only`);
      }
    }
    if (this.localMapPath && existsSync(this.localMapPath)) {
      try {
        const raw = JSON.parse(readFileSync(this.localMapPath, 'utf8'));
        map.learned = raw.models || {};
      } catch (err) {
        this.onLog('warn', `local model map unreadable (${err.message})`);
      }
    }
    return map;
  }

  /** Looks an entry up by board id first, then by fingerprint. */
  lookupModel(fingerprint, boardIdentifier) {
    const { seed, learned } = this.modelMap;
    if (learned[fingerprint]) return { entry: learned[fingerprint], source: 'learned' };
    if (seed[boardIdentifier]) return { entry: seed[boardIdentifier], source: 'seed' };
    return { entry: null, source: null };
  }

  /**
   * Records an observed board so future connections have a starting point.
   * This stores *measured* capability only - it never marks a board "safe".
   */
  learnModel(fingerprint, entry) {
    if (!this.localMapPath) return false;
    try {
      const existing = existsSync(this.localMapPath)
        ? JSON.parse(readFileSync(this.localMapPath, 'utf8'))
        : { version: 1, models: {} };
      existing.models = existing.models || {};
      existing.models[fingerprint] = entry;
      mkdirSync(dirname(this.localMapPath), { recursive: true });
      writeFileSync(this.localMapPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
      this.modelMap.learned[fingerprint] = entry;
      return true;
    } catch (err) {
      this.onLog('warn', `could not persist learned board fingerprint: ${err.message}`);
      return false;
    }
  }

  /* ---------------- layer 1: MSP ---------------- */

  async #probeMspLayer() {
    const evidence = [];
    const msp = {};

    const api = await this.helper.readApiVersion();
    msp.apiVersion = api.apiVersion;
    msp.mspProtocolVersion = api.mspProtocolVersion;
    evidence.push(`MSP API ${api.apiVersion} (protocol ${api.mspProtocolVersion})`);

    msp.variant = await this.helper.readFcVariant();
    evidence.push(`FC variant "${msp.variant}"`);

    msp.version = await this.helper.readFcVersion();
    evidence.push(`Firmware ${msp.variant} ${msp.version}`);

    const board = await this.helper.readBoardInfo();
    msp.board = board;
    evidence.push(`Board ${board.boardIdentifier} (${board.boardName || 'unnamed'}), target ${board.targetName || 'unknown'}`);
    if (board.sampleRateHz) evidence.push(`Gyro sample rate reported as ${board.sampleRateHz} Hz`);

    const build = await this.helper.readBuildInfo();
    msp.build = build;
    if (build.gitRevision) evidence.push(`Build ${build.buildInfo} rev ${build.gitRevision}`);

    msp.craftName = await this.helper.readName();

    return { msp, evidence };
  }

  /* ---------------- layer 2: CLI / status ---------------- */

  async #probeCliLayer() {
    const evidence = [];
    const cli = { versionLine: null, statusLines: [], params: {} };

    try {
      const { lines } = await this.helper.client.cli('version', { timeoutMs: this.helper.client.cliTimeoutMs });
      cli.versionLine = lines.find((l) => /BTFL|version|build/i.test(l)) || lines[0] || null;
      if (cli.versionLine) evidence.push(`CLI version: ${cli.versionLine.trim()}`);
    } catch (err) {
      evidence.push(`CLI version probe unavailable (${err.message})`);
    }

    try {
      const { lines } = await this.helper.client.cli('status', { timeoutMs: this.helper.client.cliTimeoutMs });
      cli.statusLines = lines;
      // `status` reports which sensors and features the firmware was built with,
      // which disambiguates boards that share a boardIdentifier.
      const useful = lines.filter((l) => /Gyro|Acc|Baro|Mag|Blackbox|DShot|RPM|Arming|detected/i.test(l));
      if (useful.length) evidence.push(`CLI status: ${useful.slice(0, 3).map((l) => l.trim()).join(' | ')}`);
    } catch (err) {
      evidence.push(`CLI status probe unavailable (${err.message})`);
    }

    try {
      cli.params = await this.helper.cliGet(['motor_pwm_protocol', 'dshot_bidir', 'rpm_filter_harmonics']);
    } catch (err) {
      evidence.push(`CLI capability params unavailable (${err.message})`);
    }

    return { cli, evidence };
  }

  /* ---------------- layer 3: capability probe ---------------- */

  /**
   * Probes loop rates, RPM filter and blackbox media.
   * @returns {Promise<object>} Capabilities
   */
  async probeCapabilities({ deep = true } = {}) {
    const warnings = [];
    const helper = this.helper;

    const board = await helper.readBoardInfo();
    const adv = await helper.readAdvancedConfig();

    // Gyro rate: MSP_BOARD_INFO reports it as of API 1.43. Older firmware does
    // not, so fall back to a conservative 8 kHz which is what 5" racing FCs use.
    let gyroRateHz = board.sampleRateHz || 0;
    if (!gyroRateHz) {
      gyroRateHz = 8000;
      warnings.push('Firmware did not report a gyro sample rate; assuming 8000 Hz for rate maths.');
    }

    const pidProcessDenom = Math.max(1, adv.pidProcessDenom || 1);
    const pidRateHz = Math.round(gyroRateHz / pidProcessDenom);
    const pidLooptimeUs = Math.round(1e6 / pidRateHz);

    const blackbox = await helper.readBlackboxConfig();
    const dataflash = await helper.readDataflashSummary();
    const sdcard = await helper.readSdCardSummary();

    // CLI is the stable source for these; MSP enum values shift between versions.
    const params = await helper.cliGet(CAPABILITY_CLI_PARAMS).catch((err) => {
      warnings.push(`CLI capability read failed: ${err.message}`);
      return {};
    });

    const protocolName =
      typeof params.motor_pwm_protocol === 'string'
        ? String(params.motor_pwm_protocol).toUpperCase()
        : MOTOR_PROTOCOLS[adv.motorProtocol] || `UNKNOWN(${adv.motorProtocol})`;

    const dshotActive = /^DSHOT|^PROSHOT/.test(protocolName);
    const bidirDshot = params.dshot_bidir === 1 || params.dshot_bidir === 'ON';
    const rpmHarmonics = num(params.rpm_filter_harmonics, 0);
    const rpmFilterActive = bidirDshot && rpmHarmonics > 0;

    if (dshotActive && !bidirDshot) {
      warnings.push(
        'Bidirectional DShot is OFF. RPM filtering cannot work without it, which limits how much filtering can safely be removed.',
      );
    }
    if (!blackbox.supported) {
      warnings.push('Firmware reports no blackbox support; logging must be enabled on a SERIAL device instead.');
    }
    if (blackbox.device === 0) {
      warnings.push('Blackbox device is set to NONE; logging is currently disabled.');
    }
    if (dataflash.supported && dataflash.usedSize > 0) {
      warnings.push(
        `Flash already holds ${(dataflash.usedSize / 1024 / 1024).toFixed(1)} MiB of logs; erase before capturing.`,
      );
    }
    if (!dataflash.supported && !sdcard.supported && blackbox.device !== 3) {
      warnings.push('No flash or SD card detected and no serial blackbox configured.');
    }

    const capabilities = {
      pidLooptimeUs,
      gyroRateHz,
      pidRateHz,
      pidProcessDenom,
      motorProtocol: protocolName,
      dshotActive,
      bidirDshot,
      rpmFilterActive,
      rpmFilterHarmonics: rpmHarmonics,
      blackboxSupported: blackbox.supported,
      hasFlash: dataflash.supported,
      hasSdCard: sdcard.supported,
      flashTotalBytes: dataflash.totalSize,
      flashUsedBytes: dataflash.usedSize,
      flashSectors: dataflash.sectors,
      sdFreeKb: sdcard.freeSizeKB,
      sdTotalKb: sdcard.totalSizeKB,
      blackbox: {
        device: BLACKBOX_DEVICE[blackbox.device] || 'NONE',
        deviceId: blackbox.device,
        rateNum: blackbox.rateNum,
        rateDenom: blackbox.rateDenom,
        sampleRateExp: blackbox.sampleRateExp,
        disabledMask: blackbox.disabledMask,
        pRatio: blackbox.pRatio,
      },
      filterProfile: describeFilterProfile(params),
      gyroFilterHz: num(params.gyro_lpf1_static_hz, 0),
      gyroFilter2Hz: num(params.gyro_lpf2_static_hz, 0),
      dtermFilterHz: num(params.dterm_lpf1_static_hz, 0),
      dtermFilter2Hz: num(params.dterm_lpf2_static_hz, 0),
      dynamicNotchCount: num(params.dyn_notch_count, 0),
      dynamicNotchQ: num(params.dyn_notch_q, 0),
      dynamicNotchMinHz: num(params.dyn_notch_min_hz, 0),
      dynamicNotchMaxHz: num(params.dyn_notch_max_hz, 0),
      _raw: params,
      warnings,
    };

    this.capabilities = capabilities;
    this.onLog(
      'info',
      `Capabilities: ${pidRateHz} Hz PID loop (gyro ${gyroRateHz} Hz), ${protocolName}` +
        `${bidirDshot ? ', bidir DShot' : ''}${rpmFilterActive ? ', RPM filter' : ''}`,
    );
    if (deep) this.onLog('debug', `Filter profile: ${capabilities.filterProfile}`);
    return capabilities;
  }

  /**
   * Dedicated bidirectional DShot / RPM-filter probe.
   *
   * Collection order follows the brief:
   *   1. MSP: motor protocol (advanced config), battery voltage (analog),
   *      per-motor telemetry (MSP_MOTOR_TELEMETRY).
   *   2. CLI: `get` fills the settings MSP does not carry (dshot_bidir,
   *      motor_poles, rpm_filter_*), then `status` and `dshot_telemetry_info`
   *      (best effort on older firmware).
   *
   * Read-only by design: the probe NEVER writes. Suggestions for enabling
   * bidir/RPM filtering are returned as `suggestedCli`, and the caller routes
   * them through the dry-run/confirm flow.
   *
   * @returns {Promise<object>} see contracts.js BidirProbe
   */
  async probeBidirDshot() {
    const warnings = [];
    const notes = [];
    const evidence = [];

    // --- layer 1: MSP ---
    const adv = await this.helper.readAdvancedConfig();

    const analog = await this.helper.client
      .request(MSP.MSP_ANALOG, null, { retries: 0, timeoutMs: 1000 })
      .then((r) => parseAnalog(r.raw))
      .catch(() => null);

    const mspTelemetry = await this.helper.client
      .request(MSP.MSP_MOTOR_TELEMETRY, null, { retries: 1, timeoutMs: 1500 })
      .then((r) => parseMspMotorTelemetry(r.raw))
      .catch(() => null);

    // --- layer 2: CLI ---
    const params = await this.helper.cliGet(BIDIR_CLI_PARAMS).catch((err) => {
      warnings.push(`CLI get 失败：${err.message}`);
      return {};
    });

    let cliTelemetry = null;
    try {
      const { lines } = await this.helper.client.cli('status', { timeoutMs: this.helper.client.cliTimeoutMs }).catch(() => ({ lines: [] }));
      // `status` output is captured for evidence; battery state comes from MSP.
      if (lines.length) evidence.push(`status: ${lines.find((l) => /dshot|Dshot/i.test(l))?.trim() || '无 DShot 相关行'}`);
    } catch {
      /* optional */
    }

    try {
      const { lines } = await this.helper.client.cli('dshot_telemetry_info', {
        timeoutMs: Math.min(4000, this.helper.client.cliTimeoutMs),
      });
      cliTelemetry = parseDshotTelemetryInfo(lines);
      if (cliTelemetry.enabled) evidence.push(`dshot_telemetry_info: reads=${cliTelemetry.reads} invalid=${cliTelemetry.invalidPackets}`);
    } catch {
      warnings.push('固件不支持 dshot_telemetry_info（若双向 DShot 已启用可忽略）');
    }

    const protocol = String(params.motor_pwm_protocol || MOTOR_PROTOCOLS[adv.motorProtocol] || '').toUpperCase();
    const bidirOn = params.dshot_bidir === 1 || params.dshot_bidir === 'ON';
    const poles = num(params.motor_poles, null);

    const rpmFilter = {
      enabled: (num(params.rpm_filter_harmonics, 0) ?? 0) > 0,
      harmonics: num(params.rpm_filter_harmonics, 0) ?? 0,
      q: num(params.rpm_filter_q, 0) ?? 0,
      minHz: num(params.rpm_filter_min_hz, 0) ?? 0,
    };

    // Battery vs USB-only: MSP_ANALOG reports vbat in 0.1 V steps; below 3.0 V
    // means the FC is powered from USB alone.
    const powerState = analog !== null && analog.vbatTenths !== null && analog.vbatTenths > 30 ? 'battery' : 'usb-only';
    if (powerState === 'usb-only') {
      notes.push('当前仅 USB 供电，未做动力验证：请接锂电后在 Motors 页手拨电机，再验证遥测。');
    }

    const telemetryPerMotor = mergeTelemetry(mspTelemetry, cliTelemetry);

    const judgment = judgeBidirDshot({
      protocol,
      bidirOn,
      rpmFilter,
      telemetryPerMotor,
      poles,
      powerState,
      telemetryReads: cliTelemetry?.reads ?? null,
    });

    const probe = {
      protocol,
      bidirOn,
      motorPoles: poles,
      rpmFilter,
      telemetryPerMotor,
      powerState,
      escSupported: judgment.escSupported,
      confidence: judgment.confidence,
      conclusion: judgment.conclusion,
      evidence: [...evidence, ...judgment.evidence],
      warnings,
      notes: [...notes, ...judgment.notes],
      suggestedCli: judgment.suggestedCli,
      checkedAt: new Date().toISOString(),
    };

    this.bidir = probe;
    this.onLog(
      'info',
      `双向 DShot 探测：${protocol} bidir=${bidirOn ? 'ON' : 'OFF'} ` +
        `escSupported=${probe.escSupported} confidence=${(probe.confidence * 100).toFixed(0)}% - ${probe.conclusion}`,
    );
    return probe;
  }

  /* ---------------- orchestration ---------------- */

  /**
   * Runs all three layers and returns an FcIdentity.
   * Never throws for a merely unknown board - that is a normal, handled outcome.
   */
  async identify({ probeCapabilities = true } = {}) {
    const evidence = [];

    const { msp, evidence: mspEvidence } = await this.#probeMspLayer();
    evidence.push(...mspEvidence);

    // Layer 2 requires a working CLI session; it is best-effort by design.
    // Best-effort by design: the CLI layer adds evidence but identification
    // must still succeed on MSP alone. Each CLI command is a one-shot, so there
    // is no session to unwind here.
    let cli = { versionLine: null, statusLines: [], params: {} };
    try {
      const cliResult = await this.#probeCliLayer();
      cli = cliResult.cli;
      evidence.push(...cliResult.evidence);
    } catch (err) {
      evidence.push(`CLI layer skipped: ${err.message}`);
    }

    const fingerprint = buildFingerprint({
      variant: msp.variant,
      boardIdentifier: msp.board.boardIdentifier,
      targetName: msp.board.targetName,
      mcuTypeId: msp.board.mcuTypeId,
      signature: msp.board.signature,
    });

    const { entry: model, source } = this.lookupModel(fingerprint, msp.board.boardIdentifier);

    const { confidence, matchLevel, reasons } = scoreConfidence({ msp, cli, model, source });
    evidence.push(...reasons);

    const known = Boolean(model) && matchLevel !== 'unknown';

    // Capability probing is layer 3 and also the seed data for learning.
    let capabilities = this.capabilities;
    if (probeCapabilities) {
      try {
        capabilities = await this.probeCapabilities();
        evidence.push(
          `Capability layer: ${capabilities.pidRateHz} Hz PID / ${capabilities.gyroRateHz} Hz gyro, ` +
            `${capabilities.motorProtocol}, blackbox=${capabilities.blackbox.device}`,
        );
      } catch (err) {
        evidence.push(`Capability layer failed: ${err.message}`);
      }
    }

    const identity = {
      variant: msp.variant,
      version: msp.version,
      apiVersion: msp.apiVersion,
      boardIdentifier: msp.board.boardIdentifier,
      boardName: msp.board.boardName,
      targetName: msp.board.targetName,
      manufacturerId: msp.board.manufacturerId,
      mcuTypeId: msp.board.mcuTypeId,
      buildInfo: msp.build.buildInfo,
      gitRevision: msp.build.gitRevision,
      signatureHex: Buffer.from(msp.board.signature).toString('hex'),
      craftName: msp.craftName,
      firmwareFamily: firmwareFamily(msp.version),
      fingerprint,
      confidence,
      matchLevel,
      evidence,
      known,
      modelHint: model ? `${model.name || 'known board'}${model.notes ? ` - ${model.notes}` : ''}` : undefined,
      modelSource: source,
      capabilitiesProbed: Boolean(capabilities),
    };

    // Record what we measured for boards we have never seen. Observation only.
    if (!known && capabilities) {
      this.learnModel(fingerprint, {
        name: identity.boardName || identity.boardIdentifier,
        target: identity.targetName,
        mcuTypeId: identity.mcuTypeId,
        observedAt: new Date().toISOString(),
        observed: {
          gyroRateHz: capabilities.gyroRateHz,
          pidRateHz: capabilities.pidRateHz,
          motorProtocol: capabilities.motorProtocol,
          bidirDshot: capabilities.bidirDshot,
          hasFlash: capabilities.hasFlash,
          flashTotalBytes: capabilities.flashTotalBytes,
        },
        verified: false,
        confidence: 'observed',
      });
      evidence.push('Unrecognised board: capabilities recorded locally; running in SAFE MODE (read-only).');
      identity.known = false;
    }

    this.identity = identity;
    this.onLog(
      identity.known ? 'info' : 'warn',
      `Identified ${identity.boardIdentifier} (${identity.boardName || 'unknown'}) ` +
        `confidence ${(confidence * 100).toFixed(0)}% [${matchLevel}]${identity.known ? '' : ' - SAFE MODE'}`,
    );
    return identity;
  }

  /** True when the board is unknown and the app must stay read-only. */
  requiresSafeMode() {
    return !this.identity || !this.identity.known;
  }
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * Stable fingerprint across sessions. The build signature is included when
 * present because two boards can share a boardIdentifier while differing in
 * hardware revision.
 */
export function buildFingerprint({ variant, boardIdentifier, targetName, mcuTypeId, signature }) {
  const sig = Array.isArray(signature) && signature.some((b) => b !== 0) ? Buffer.from(signature).toString('hex') : '';
  const material = [variant || '', boardIdentifier || '', targetName || '', String(mcuTypeId ?? ''), sig].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Confidence scoring. Deliberately additive and explainable: every point has a
 * stated reason, and an unknown board still reports a real number rather than 0
 * or a silent 1.
 */
export function scoreConfidence({ msp, cli, model, source }) {
  let score = 0;
  const reasons = [];

  if (msp.variant === 'BTFL') {
    score += 0.35;
    reasons.push('+0.35 recognised Betaflight variant');
  } else {
    reasons.push(`+0.00 variant "${msp.variant}" is not Betaflight`);
  }

  const board = msp.board.boardIdentifier || '';
  if (/^[A-Z0-9]{4}$/.test(board)) {
    score += 0.15;
    reasons.push(`+0.15 plausible board identifier "${board}"`);
  } else {
    reasons.push('+0.00 board identifier is missing or malformed');
  }

  if (msp.board.targetName) {
    score += 0.10;
    reasons.push(`+0.10 target name reported ("${msp.board.targetName}")`);
  } else {
    reasons.push('+0.00 no target name reported');
  }

  const hasSignature = Array.isArray(msp.board.signature) && msp.board.signature.some((b) => b !== 0);
  if (hasSignature) {
    score += 0.15;
    reasons.push('+0.15 build signature present');
  } else {
    reasons.push('+0.00 build signature absent or all zero');
  }

  if (cli.versionLine) {
    score += 0.10;
    reasons.push('+0.10 CLI version layer answered');
  } else {
    reasons.push('+0.00 CLI version layer unavailable');
  }

  if (msp.board.sampleRateHz) {
    score += 0.05;
    reasons.push(`+0.05 firmware reported gyro rate (${msp.board.sampleRateHz} Hz)`);
  }

  let matchLevel = 'unknown';
  if (model && source === 'seed' && hasSignature) {
    score += 0.10;
    matchLevel = 'exact';
    reasons.push('+0.10 exact match in local model map (board id + build signature)');
  } else if (model && source === 'seed') {
    score += 0.05;
    matchLevel = 'board';
    reasons.push('+0.05 board identifier found in local model map');
  } else if (model && source === 'learned') {
    matchLevel = 'family';
    reasons.push('+0.00 previously observed board (capability data only, not a verified model)');
  } else if (msp.board.targetName && msp.variant === 'BTFL') {
    matchLevel = 'family';
    reasons.push('+0.00 Betaflight target known but this board is not in the local model map');
  }

  return { confidence: Math.max(0, Math.min(1, Number(score.toFixed(2)))), matchLevel, reasons };
}

/** Summarises the filter configuration into a short human label. */
export function describeFilterProfile(params) {
  const parts = [];
  const gyro = num(params.gyro_lpf1_static_hz, 0);
  const gyro2 = num(params.gyro_lpf2_static_hz, 0);
  const dterm = num(params.dterm_lpf1_static_hz, 0);
  const notch = num(params.dyn_notch_count, 0);
  const rpm = num(params.rpm_filter_harmonics, 0);

  if (gyro) parts.push(`gyro LPF1 ${gyro}Hz`);
  if (gyro2) parts.push(`gyro LPF2 ${gyro2}Hz`);
  if (dterm) parts.push(`D-term LPF1 ${dterm}Hz`);
  if (notch) parts.push(`${notch}x dynamic notch`);
  if (rpm) parts.push(`RPM filter x${rpm}`);
  return parts.length ? parts.join(', ') : 'unknown filter profile';
}

/* ------------------------------------------------------------------ *
 * Bidirectional DShot / RPM pure logic (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * MSP_ANALOG (110): u8 vbat (0.1 V), u16 mAhDrawn, u16 rssi, u16 amperage (cA).
 */
export function parseAnalog(payload) {
  const r = new ByteReader(payload);
  if (r.remaining < 1) return { vbatTenths: null };
  return {
    vbatTenths: r.u8(),
    mAhDrawn: r.remaining >= 2 ? r.u16() : null,
    rssi: r.remaining >= 2 ? r.u16() : null,
  };
}

/**
 * MSP_MOTOR_TELEMETRY (139), verified against firmware src/main/msp/msp.c:
 * u8 motorCount, then per motor:
 *   u32 rpm, u16 invalidPct (0.01 % units; 10000 = 100 %), u8 escTemperature,
 *   u16 escVoltage (0.01 V), u16 escCurrent (A), u16 escConsumption (mAh)
 */
export function parseMspMotorTelemetry(payload) {
  const r = new ByteReader(payload);
  const motorCount = r.u8();
  const motors = [];
  // 13 bytes per motor: u32 rpm, u16 invalidPct, u8 temp, u16 voltage,
  // u16 current, u16 consumption.
  for (let i = 0; i < motorCount && r.remaining >= 13; i++) {
    motors.push({
      index: i,
      rpm: r.u32(),
      invalidPct: r.u16() / 100,
      temp: r.u8(),
      voltage: r.u16() / 100,
      current: r.u16(),
      consumption: r.u16(),
    });
  }
  return { motorCount, motors };
}

/**
 * CLI `dshot_telemetry_info` (firmware src/main/cli/cli.c cliDshotTelemetryInfo):
 *
 *   Dshot reads: 12345
 *   Dshot invalid pkts: 0
 *   Motor    Type   eRPM    RPM     Hz Invalid   TEMP ...
 *   =====  ====== ====== ====== ====== ======= ...
 *       1   R----  15234   2176     36  0.12%    ...
 *       2   R----  15234   2176     36 NO DATA
 *
 * Note: the printed eRPM column is `getDshotErpm(i) * 100` (electrical RPM);
 * the RPM column is mechanical RPM (eRPM / polePairs). `NO DATA` marks a motor
 * whose telemetry never became active.
 */
export function parseDshotTelemetryInfo(lines = []) {
  const out = { enabled: false, reads: null, invalidPackets: null, motors: [] };
  for (const line of lines || []) {
    const t = String(line).trim();
    if (!t) continue;
    if (t.startsWith('Dshot telemetry not enabled')) return out;

    let m = /^Dshot reads:\s*(\d+)/.exec(t);
    if (m) { out.reads = Number(m[1]); out.enabled = true; continue; }

    m = /^Dshot invalid pkts:\s*(\d+)/.exec(t);
    if (m) { out.invalidPackets = Number(m[1]); continue; }

    if (/^Motor\s+Type/.test(t) || /^=+$/.test(t.replace(/\s/g, ''))) continue;

    m = /^\s*(\d+)\s+([\w-]{5})\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(?:\s+(\d+)\.(\d{2})%)?/.exec(t);
    if (m) {
      const motor = {
        index: Number(m[1]) - 1,
        types: m[2],
        erpm: Number(m[3]),
        rpm: Number(m[4]),
        hz: Number(m[5]),
        invalidPct: m[6] !== undefined ? Number(`${m[6]}.${m[7]}`) : null,
        noData: false,
      };
      if (t.includes('NO DATA')) {
        motor.noData = true;
        motor.rpm = 0;
        motor.erpm = 0;
        motor.invalidPct = null;
      }
      out.motors.push(motor);
    }
  }
  return out;
}

/**
 * Prefers the MSP payload (always available while connected) and overlays the
 * CLI table's erpm/hz/types where present. Both are read-only sources of the
 * same physical values.
 */
export function mergeTelemetry(mspTelemetry, cliTelemetry) {
  const cliByIndex = new Map((cliTelemetry?.motors || []).map((m) => [m.index, m]));
  const base = mspTelemetry?.motors?.length ? mspTelemetry.motors : cliTelemetry?.motors || [];
  return base.map((m) => {
    const extra = cliByIndex.get(m.index) || {};
    return {
      index: m.index,
      rpm: m.rpm || extra.rpm || 0,
      erpm: extra.erpm ?? null,
      hz: extra.hz ?? null,
      types: extra.types ?? null,
      invalidPct: m.invalidPct ?? extra.invalidPct ?? null,
      noData: Boolean(extra.noData),
      temp: m.temp,
      voltage: m.voltage,
      current: m.current,
      consumption: m.consumption,
    };
  });
}

/** Pole-count sanity: 5-inch racing quads are 14-pole (7 pairs) or 12-pole. */
export function assessMotorPoles(poles) {
  if (poles === null || poles === undefined || poles === 0 || poles === '') {
    return {
      ok: false,
      issue: true,
      message: 'motor_poles 未设置或为 0：RPM 换算会失真。请按电机规格设置（常见 5 寸机 14 极 / 12 极），需用户确认。',
      suggested: 'set motor_poles = 14',
    };
  }
  if (poles === 12 || poles === 14) {
    return { ok: true, issue: false, message: `motor_poles = ${poles}（常见值）`, suggested: null };
  }
  return {
    ok: false,
    issue: true,
    message: `motor_poles = ${poles} 与常见电机库不符：请核对电机规格（常见 14/12 极），确认后再继续。`,
    suggested: null,
  };
}

/**
 * The decision matrix from the operating brief. Returns a plain object so it
 * can be unit-tested without a flight controller.
 */
export function judgeBidirDshot({ protocol, bidirOn, rpmFilter, telemetryPerMotor, poles, powerState, telemetryReads }) {
  const evidence = [];
  const warnings = [];
  const notes = [];
  const motors = Array.isArray(telemetryPerMotor) ? telemetryPerMotor : [];
  const isDshot = /DSHOT/.test(String(protocol || '').toUpperCase());
  // A motor counts as live when it reported rotation. Telemetry that never
  // became active carries invalidPct = 100 and must not poison the live set.
  const live = motors.filter((m) => !m.noData && ((m.rpm ?? 0) > 0 || (m.erpm ?? 0) > 0));
  const liveInvalid = live.map((m) => m.invalidPct ?? 0);
  const maxInvalid = liveInvalid.length ? Math.max(...liveInvalid) : 0;

  evidence.push(
    `protocol=${protocol || '?'} bidir=${bidirOn ? 'ON' : 'OFF'} ` +
      `rpmFilter=${rpmFilter?.enabled ? 'ON' : 'OFF'} liveMotors=${live.length}/${motors.length || 0}`,
  );

  let escSupported = 'unknown';
  let confidence = 0;
  let conclusion = '';
  const suggestedCli = [];

  if (!isDshot) {
    conclusion = `电机协议为 ${protocol || '未知'}，非 DShot：双向 DShot/RPM 滤波不适用。`;
    escSupported = 'no';
    confidence = 0.9;
    evidence.push('protocol is not DShot');
  } else if (bidirOn && rpmFilter?.enabled && motors.length > 0 && live.length === motors.length && maxInvalid < 1) {
    conclusion = '双向 DShot/RPM 已生效：每电机遥测正常，无效包率 < 1%。';
    escSupported = 'yes';
    confidence = 0.95;
    evidence.push(`maxInvalid=${maxInvalid.toFixed(2)}% live=${live.length}/${motors.length}`);
  } else if (bidirOn && live.length === 0 && powerState === 'usb-only') {
    // Zero telemetry on USB power is EXPECTED: the ESCs have no power, so they
    // cannot answer. Do not mistake this for missing ESC support.
    conclusion = '双向 DShot/RPM 配置已就绪，但未接锂电，无法验证电调遥测。';
    escSupported = 'unknown';
    confidence = 0.5;
    evidence.push(`reads=${telemetryReads ?? 0} allMotorsZero usb-only`);
    notes.push('请接锂电后在 Motors 页手拨电机（反电动势即可让 eRPM 回传），再点验证。');
  } else if (bidirOn && live.length === 0) {
    conclusion = '固件已开启双向 DShot，但电调无遥测回传。';
    escSupported = 'no';
    confidence = 0.6;
    evidence.push(`reads=${telemetryReads ?? '?'} allMotorsZero`);
    warnings.push(
      '检查电调固件是否支持遥测（BLHeli_32 ≥ 32.7 / Bluejay / AM32）、信号线连接，修改后保存并重启（reboot）。',
    );
  } else if (bidirOn && live.length > 0 && live.length < motors.length) {
    conclusion = `双向 DShot 已开启，但仅 ${live.length}/${motors.length} 个电机有遥测。`;
    escSupported = 'yes';
    confidence = 0.45;
    warnings.push('部分电机无回传：检查对应电调的固件与信号线，接锂电后手拨电机复验。');
  } else if (!bidirOn && rpmFilter?.enabled) {
    conclusion = 'RPM 滤波器已设置，但双向 DShot 未开启：滤波不会生效。';
    escSupported = 'unknown';
    confidence = 0.55;
    suggestedCli.push('set dshot_bidir = ON');
    warnings.push('dshot_bidir 属于危险项，本工具不会自动写入；请在确认后手动执行或走 dry-run 确认流程。');
  } else if (bidirOn && maxInvalid >= 1) {
    conclusion = '双向 DShot 已开启，但遥测无效包率过高。';
    escSupported = 'yes';
    confidence = 0.4;
    warnings.push(`最大无效包率 ${maxInvalid.toFixed(2)}%（阈值 1%）：检查电调固件与信号质量。`);
  } else {
    conclusion = '无法确定双向 DShot/RPM 状态：请接锂电后在 Motors 页手拨电机再验证。';
    escSupported = 'unknown';
    confidence = 0.25;
  }

  const polesCheck = assessMotorPoles(poles);
  if (polesCheck.issue) {
    warnings.push(polesCheck.message);
    evidence.push(`motorPoles=${poles ?? 'unset'}`);
  } else {
    evidence.push(polesCheck.message);
  }

  if (powerState === 'usb-only') {
    notes.push('仅 USB 供电，未做动力验证。');
  }

  return { escSupported, confidence, conclusion, evidence, warnings, notes, suggestedCli };
}

function num(value, fallback) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(n) ? n : fallback;
}

export default FcIdentifier;
