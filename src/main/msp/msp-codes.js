/**
 * MSP command codes and API-version helpers.
 *
 * Codes are ported from betaflight-configurator `src/js/msp/MSPCodes.js`
 * (upstream commit 00dcc98d) and cross-checked against firmware
 * `src/main/msp/msp_protocol.h`. Only the subset this app uses is listed, but
 * the values are the canonical ones — never renumber anything here.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const MSP = {
  MSP_API_VERSION: 1,
  MSP_FC_VARIANT: 2,
  MSP_FC_VERSION: 3,
  MSP_BOARD_INFO: 4,
  MSP_BUILD_INFO: 5,
  MSP_NAME: 10,

  MSP_FEATURE_CONFIG: 36,
  MSP_MIXER_CONFIG: 42,
  MSP_RX_CONFIG: 44,

  MSP_DATAFLASH_SUMMARY: 70,
  MSP_DATAFLASH_READ: 71,
  MSP_DATAFLASH_ERASE: 72,
  MSP_LOOP_TIME: 73,
  MSP_SDCARD_SUMMARY: 79,
  MSP_BLACKBOX_CONFIG: 80,
  MSP_SET_BLACKBOX_CONFIG: 81,
  MSP_ADVANCED_CONFIG: 90,
  MSP_FILTER_CONFIG: 92,

  MSP_STATUS: 101,
  MSP_MOTOR: 104,
  MSP_RC: 105,
  MSP_ATTITUDE: 108,
  MSP_ANALOG: 110,
  MSP_RC_TUNING: 111,
  MSP_PID: 112,
  MSP_PIDNAMES: 117,
  MSP_MOTOR_CONFIG: 131,
  MSP_MOTOR_TELEMETRY: 139,

  MSP_SIMPLIFIED_TUNING: 140,
  MSP_SET_SIMPLIFIED_TUNING: 141,

  MSP_UID: 160,
  MSP_BEEPER_CONFIG: 184,

  MSP_SET_PID: 202,
  MSP_SET_RC_TUNING: 204,
  MSP_EEPROM_WRITE: 250,

  // MSPv2 — Betaflight specific
  MSP2_MCU_INFO: 0x300c,
  MSP2_GYRO_SENSOR: 0x300d,
};

/** Commands that expect no reply / are fire-and-forget. */
export const NO_REPLY_COMMANDS = new Set([MSP.MSP_EEPROM_WRITE, MSP.MSP_SET_BLACKBOX_CONFIG, MSP.MSP_DATAFLASH_ERASE]);

/** MSP error reply marker: `$M!` with the offending command code. */
export const MSP_ERROR_MARKER = 0x21; // '!'

/* ------------------------------------------------------------------ *
 * API version helpers
 * ------------------------------------------------------------------ */

export const API_VERSION = {
  V1_41: '1.41.0',
  V1_42: '1.42.0',
  V1_43: '1.43.0',
  V1_44: '1.44.0',
  V1_45: '1.45.0',
  V1_46: '1.46.0',
};

/** Numeric weight for comparing dotted versions without pulling in semver. */
export function versionWeight(version) {
  const parts = String(version || '0.0.0')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function apiAtLeast(apiVersion, target) {
  return versionWeight(apiVersion) >= versionWeight(target);
}

/**
 * Betaflight firmware semantic version, e.g. "4.5.1".
 * MSP_FC_VERSION packs it as three consecutive bytes.
 */
export function formatFcVersion(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}

/**
 * Betaflight major version families that change tuning behaviour.
 * Used by the rule engine to pick sensible defaults.
 */
export function firmwareFamily(version) {
  const w = versionWeight(version);
  if (w >= versionWeight('4.5.0')) return '4.5+';
  if (w >= versionWeight('4.4.0')) return '4.4';
  if (w >= versionWeight('4.3.0')) return '4.3';
  if (w >= versionWeight('4.0.0')) return '4.0-4.2';
  return 'pre-4.0';
}

export default MSP;
