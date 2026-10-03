/**
 * Step 1 of the workflow: read the whole configuration and take the mandatory
 * backup before anything is allowed to write to the flight controller.
 *
 * PID and filter values come from CLI `get`, not from MSP binary structs,
 * because those structs change shape between MSP API versions while parameter
 * names are stable across Betaflight 4.x.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliAssignments } from '../msp/msp-helper.js';

/** PID parameters, per axis. */
export const PID_PARAMS = [
  'p_roll', 'i_roll', 'd_roll', 'f_roll',
  'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch',
  'p_yaw', 'i_yaw', 'd_yaw', 'f_yaw',
];

/** BF 4.3+ dynamic D. */
export const DMAX_PARAMS = ['d_max_roll', 'd_max_pitch', 'd_max_yaw'];

/**
 * Dynamic-D floor and the I-term relax / anti-gravity / TPA knobs.
 *
 * These matter for the 5-inch race profile: propwash is handled by raising
 * D_min toward the cruise D (and letting D_max sit above it) rather than by
 * piling on static D, which is what heats motors.
 */
export const DYNAMIC_PARAMS = [
  'd_min_roll', 'd_min_pitch', 'd_min_yaw',
  'd_min_boost_gain', 'd_min_advance',
  'iterm_relax', 'iterm_relax_type', 'iterm_relax_cutoff',
  'anti_gravity_gain', 'anti_gravity_cutoff',
  'tpa_rate', 'tpa_breakpoint', 'tpa_mode',
];

/** Filter parameters worth reading for analysis. */
export const FILTER_PARAMS = [
  'gyro_lpf1_static_hz',
  'gyro_lpf2_static_hz',
  'gyro_lpf1_dyn_min_hz',
  'gyro_lpf1_dyn_max_hz',
  'gyro_lpf1_dyn_expo',
  'dterm_lpf1_static_hz',
  'dterm_lpf2_static_hz',
  'dterm_lpf1_dyn_min_hz',
  'dterm_lpf1_dyn_max_hz',
  'dterm_notch_hz',
  'dterm_notch_cutoff',
  'gyro_notch_hz',
  'gyro_notch_cutoff',
  'dyn_notch_count',
  'dyn_notch_q',
  'dyn_notch_min_hz',
  'dyn_notch_max_hz',
  'rpm_filter_harmonics',
  'rpm_filter_min_hz',
  'rpm_filter_q',
  'rpm_filter_weights',
  'dterm_lpf1_type',
  'gyro_lpf1_type',
];

/** BF 4.3+ simplified-tuning sliders; their state changes what advice is valid. */
export const SIMPLIFIED_PARAMS = [
  'simplified_pids_mode',
  'simplified_master_multiplier',
  'simplified_i_gain',
  'simplified_d_gain',
  'simplified_pi_gain',
  'simplified_dterm_filter',
  'simplified_dterm_filter_multiplier',
  'simplified_gyro_filter',
  'simplified_gyro_filter_multiplier',
];

export const ALL_READ_PARAMS = [
  ...PID_PARAMS,
  ...DMAX_PARAMS,
  ...DYNAMIC_PARAMS,
  ...FILTER_PARAMS,
  ...SIMPLIFIED_PARAMS,
  'pid_profile',
];

export class FcSettingsReader {
  /**
   * @param {import('../msp/msp-helper.js').MspHelper} helper
   * @param {import('./fc-identify.js').FcIdentifier} identifier
   * @param {{backupDir:string, onLog?:Function}} opts
   */
  constructor(helper, identifier, { backupDir, onLog = () => {} }) {
    this.helper = helper;
    this.identifier = identifier;
    this.backupDir = backupDir;
    this.onLog = onLog;
    this.settings = null;
  }

  /**
   * Reads everything and writes the backup.
   *
   * The backup is taken BEFORE any other command that could mutate state, and
   * its failure is fatal by design: the safety boundary says nothing is written
   * to the FC until a verified dump exists on disk.
   *
   * @returns {Promise<import('../../shared/contracts.js').FcSettings>}
   */
  async read({ identity = null } = {}) {
    const id = identity || this.identifier.identity || (await this.identifier.identify());
    this.onLog('info', 'Reading full configuration over CLI...');

    // Each CLI command is a self-contained one-shot; nothing to unwind.
    const dump = await this.helper.cliDump();
    const diffAll = await this.helper.cliDiffAll();
    const params = await this.helper.cliGet(ALL_READ_PARAMS);

    if (!isPlausibleCliDump(dump)) {
      throw new Error('`dump` output was empty or malformed; refusing to continue without a valid backup');
    }

    const backup = this.#writeBackup({ id, dump, diffAll, params });

    const pid = buildPidProfile(params);
    const filter = buildFilterConfig(params);

    const settings = {
      identity: id,
      capabilities: this.identifier.capabilities,
      dump,
      diffAll,
      raw: params,
      pid,
      filter,
      backupPath: backup.path,
      backupSha256: backup.sha256,
      backedUpAt: backup.takenAt,
    };

    this.settings = settings;
    this.onLog('info', `Backup written to ${backup.path} (sha256 ${backup.sha256.slice(0, 12)}...)`);
    return settings;
  }

  #writeBackup({ id, dump, diffAll, params }) {
    const takenAt = new Date().toISOString();
    const stamp = takenAt.replace(/[:.]/g, '-');
    const safeBoard = (id.boardIdentifier || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '');
    const dir = join(this.backupDir, `${stamp}_${safeBoard}_${id.version || 'unknown'}`);
    mkdirSync(dir, { recursive: true });

    const dumpPath = join(dir, 'dump.txt');
    writeFileSync(dumpPath, dump, 'utf8');
    writeFileSync(join(dir, 'diff-all.txt'), diffAll || '', 'utf8');
    writeFileSync(join(dir, 'read-params.json'), `${JSON.stringify(params, null, 2)}\n`, 'utf8');

    const sha256 = createHash('sha256').update(dump).digest('hex');

    writeFileSync(
      join(dir, 'manifest.json'),
      `${JSON.stringify(
        {
          takenAt,
          board: id.boardIdentifier,
          boardName: id.boardName,
          target: id.targetName,
          firmware: `${id.variant} ${id.version}`,
          apiVersion: id.apiVersion,
          fingerprint: id.fingerprint,
          confidence: id.confidence,
          matchLevel: id.matchLevel,
          dumpSha256: sha256,
          dumpBytes: Buffer.byteLength(dump, 'utf8'),
          restoreHint: `Enter CLI, paste the contents of dump.txt, then type save.`,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    return { path: dir, sha256, takenAt };
  }

  /**
   * Verifies a previously written backup still matches, used before a write.
   * @param {string} backupPath
   * @param {string} expectedSha
   */
  static verifyBackup(backupPath, expectedSha, dumpText) {
    const actual = createHash('sha256').update(dumpText).digest('hex');
    return { ok: actual === expectedSha, actual, expected: expectedSha, path: backupPath };
  }
}

/* ------------------------------------------------------------------ *
 * Pure builders (unit-tested)
 * ------------------------------------------------------------------ */

/**
 * CLI dumps are printable ASCII with `#` comment headers. Anything else means
 * we are not talking to a CLI (still in MSP mode, wrong baud, garbage).
 * Mirrors `isPlausibleCliDump` in the official configurator's AutoBackup.
 */
export function isPlausibleCliDump(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const printable = c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126);
    if (!printable) return false;
  }
  return text.split(/\r?\n/).some((line) => line.startsWith('#'));
}

/**
 * Turns flat CLI parameters into the PidProfile shape used by the analysis and
 * proposal engines. Missing values stay null rather than defaulting to a
 * number, so the UI can distinguish "0" from "not reported".
 *
 * @returns {import('../../shared/contracts.js').PidProfile}
 */
export function buildPidProfile(params = {}) {
  const axis = (name, prefix) => ({
    P: value(params[`p_${prefix}`]),
    I: value(params[`i_${prefix}`]),
    D: value(params[`d_${prefix}`]),
    F: value(params[`f_${prefix}`]),
  });

  return {
    profileIndex: value(params.pid_profile) ?? 0,
    roll: axis('roll', 'roll'),
    pitch: axis('pitch', 'pitch'),
    yaw: axis('yaw', 'yaw'),
    // Array form preserves the contract shape consumed by the tool API.
    axes: [axis('roll', 'roll'), axis('pitch', 'pitch'), axis('yaw', 'yaw')],
    dMax: {
      roll: value(params.d_max_roll),
      pitch: value(params.d_max_pitch),
      yaw: value(params.d_max_yaw),
    },
    simplified: {
      mode: params.simplified_pids_mode ?? null,
      masterMultiplier: value(params.simplified_master_multiplier),
      iGain: value(params.simplified_i_gain),
      dGain: value(params.simplified_d_gain),
      piGain: value(params.simplified_pi_gain),
      gyroFilter: value(params.simplified_gyro_filter),
      gyroFilterMultiplier: value(params.simplified_gyro_filter_multiplier),
      dtermFilter: value(params.simplified_dterm_filter),
      dtermFilterMultiplier: value(params.simplified_dterm_filter_multiplier),
    },
  };
}

/**
 * @returns {import('../../shared/contracts.js').FilterConfig}
 */
export function buildFilterConfig(params = {}) {
  return {
    gyroLpf1Hz: value(params.gyro_lpf1_static_hz) ?? 0,
    gyroLpf2Hz: value(params.gyro_lpf2_static_hz) ?? 0,
    gyroLpf1Type: params.gyro_lpf1_type ?? null,
    dtermLpf1Hz: value(params.dterm_lpf1_static_hz) ?? 0,
    dtermLpf2Hz: value(params.dterm_lpf2_static_hz) ?? 0,
    dtermLpf1Type: params.dterm_lpf1_type ?? null,
    dtermNotchHz: value(params.dterm_notch_hz) ?? 0,
    dtermNotchCutoffHz: value(params.dterm_notch_cutoff) ?? 0,
    gyroNotch1Hz: value(params.gyro_notch_hz) ?? 0,
    gyroNotch1CutoffHz: value(params.gyro_notch_cutoff) ?? 0,
    dynamicNotchEnabled: (value(params.dyn_notch_count) ?? 0) > 0,
    dynamicNotchCount: value(params.dyn_notch_count) ?? 0,
    dynamicNotchQ: value(params.dyn_notch_q) ?? 0,
    dynamicNotchMinHz: value(params.dyn_notch_min_hz) ?? 0,
    dynamicNotchMaxHz: value(params.dyn_notch_max_hz) ?? 0,
    rpmFilterHarmonics: value(params.rpm_filter_harmonics) ?? 0,
    rpmFilterMinHz: value(params.rpm_filter_min_hz) ?? 0,
    rpmFilterQ: value(params.rpm_filter_q) ?? 0,
    gyroLpf1DynMinHz: value(params.gyro_lpf1_dyn_min_hz) ?? 0,
    gyroLpf1DynMaxHz: value(params.gyro_lpf1_dyn_max_hz) ?? 0,
    dtermLpf1DynMinHz: value(params.dterm_lpf1_dyn_min_hz) ?? 0,
    dtermLpf1DynMaxHz: value(params.dterm_lpf1_dyn_max_hz) ?? 0,
  };
}

function value(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export default FcSettingsReader;
