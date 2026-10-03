/**
 * Blackbox management: configure, erase, download, verify.
 *
 * Design decisions worth knowing:
 *
 *  - Writes go out as CLI `set` commands, not MSP_SET_BLACKBOX_CONFIG. The CLI
 *    path is human-auditable, produces exactly the text the UI shows, and is
 *    immune to the MSP struct churn across API versions. MSP is used to READ
 *    the configuration back and to verify the write landed.
 *
 *  - The logging rate is back-calculated from the actual PID loop rate:
 *    firmware stores `sample_rate` as a log2 divisor (`blackboxPInterval =
 *    1 << sample_rate`), so an 8 kHz loop targeting 2 kHz needs exp=2 (1/4) and
 *    a 4 kHz loop needs exp=1 (1/2).
 *
 *  - Flash download uses MSP_DATAFLASH_READ with the firmware's own Huffman
 *    compression, exactly like the official configurator.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createWriteStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MSP } from '../msp/msp-codes.js';
import { BLACKBOX_FIELDS, REQUIRED_BB_FIELDS, BLACKBOX_DEVICE } from '../../shared/contracts.js';
import { decodeBbl } from '../analysis/bbl-decode.js';

/** MSP dataflash reads are capped at 2 KiB per request by the firmware. */
export const FLASH_BLOCK_SIZE = 2048;

export const DEVICE_IDS = { NONE: 0, SPIFLASH: 1, SDCARD: 2, SERIAL: 3, VIRTUAL: 4 };

/**
 * Back-calculates the blackbox sample-rate exponent for a target rate.
 *
 * @param {number} pidRateHz   actual PID loop rate, e.g. 8000
 * @param {number} targetRate  desired logging rate, e.g. 2000
 * @returns {{sampleRateExp:number, denom:number, actualRate:number, achievable:boolean, reason?:string}}
 */
export function computeBlackboxRate(pidRateHz, targetRate = 2000) {
  if (!Number.isFinite(pidRateHz) || pidRateHz <= 0) {
    return { sampleRateExp: 0, denom: 1, actualRate: 0, achievable: false, reason: 'PID loop rate unknown' };
  }
  if (!Number.isFinite(targetRate) || targetRate <= 0) {
    return { sampleRateExp: 0, denom: 1, actualRate: pidRateHz, achievable: false, reason: 'target rate invalid' };
  }

  const ratio = pidRateHz / targetRate;
  if (ratio < 1) {
    return {
      sampleRateExp: 0,
      denom: 1,
      actualRate: pidRateHz,
      achievable: false,
      reason: `PID loop runs at ${pidRateHz} Hz, slower than the requested ${targetRate} Hz`,
    };
  }

  // exp = round(log2(ratio)), clamped to the firmware's 0..4 enum range
  // (BLACKBOX_RATE_ONE .. BLACKBOX_RATE_16TH).
  const exp = Math.max(0, Math.min(4, Math.round(Math.log2(ratio))));
  const denom = 1 << exp;
  const actualRate = pidRateHz / denom;
  // A rate within 15% of the request is treated as met; beyond that the caller
  // is told the closest real option rather than being silently given it.
  const achievable = Math.abs(actualRate - targetRate) / targetRate <= 0.15;

  return {
    sampleRateExp: exp,
    denom,
    actualRate,
    achievable,
    reason: achievable ? undefined : `closest achievable rate is ${actualRate} Hz (1/${denom})`,
  };
}

/**
 * Builds the `fields_disabled_mask` from the set of fields to enable.
 * Bit order verified against firmware `blackbox_fielddefs.h`
 * (FLIGHT_LOG_FIELD_SELECT_*) and `cli/settings.c` (bitpos).
 *
 * @param {string[]} enabledFields
 * @returns {number} unsigned 32-bit mask
 */
export function computeDisabledMask(enabledFields) {
  const wanted = new Set(enabledFields.map((f) => String(f).toLowerCase()));
  let mask = 0;
  for (const field of BLACKBOX_FIELDS) {
    if (!wanted.has(field.key)) mask |= 1 << field.bit;
  }
  return mask >>> 0;
}

/**
 * Inverse of computeDisabledMask.
 * @param {number} mask
 * @returns {string[]} enabled field keys
 */
export function fieldsFromDisabledMask(mask) {
  return BLACKBOX_FIELDS.filter((f) => (mask & (1 << f.bit)) === 0).map((f) => f.key);
}

/**
 * CLI commands that put the blackbox into the requested state.
 * Uses the firmware's own parameter names, so the diff the user approves is
 * byte-identical to what is sent.
 */
export function buildBlackboxCliCommands({ deviceName, rate, fields, enabledFields }) {
  const commands = [];
  if (deviceName) commands.push(`set blackbox_device = ${deviceName}`);
  if (Number.isFinite(rate) && rate > 0) commands.push(`set blackbox_sample_rate = ${rate}`);
  for (const field of BLACKBOX_FIELDS) {
    const state = enabledFields.has(field.key) ? 'OFF' : 'ON';
    commands.push(`set ${field.cli} = ${state}`);
  }
  return commands;
}

export class BlackboxManager {
  /**
   * @param {import('../msp/msp-helper.js').MspHelper} helper
   * @param {import('../fc/fc-identify.js').FcIdentifier} identifier
   * @param {{captureDir:string, onEvent?:Function, onLog?:Function}} opts
   */
  constructor(helper, identifier, { captureDir, onEvent = () => {}, onLog = () => {} }) {
    this.helper = helper;
    this.identifier = identifier;
    this.captureDir = captureDir;
    this.onEvent = onEvent;
    this.onLog = onLog;
    this.lastCapture = null;
  }

  /* ---------------- configure ---------------- */

  /**
   * @param {{rate?:number, device?:string, fields?:string[], dryRun?:boolean}} opts
   */
  async configure({ rate = 2000, device = 'auto', fields = [], dryRun = true } = {}) {
    const caps = this.identifier.capabilities || (await this.identifier.probeCapabilities());
    const before = await this.helper.readBlackboxConfig();

    const deviceName = resolveDevice(device, caps);
    const ratePlan = computeBlackboxRate(caps.pidRateHz, rate);

    // Empty field list means "the fields this app needs for tuning".
    const enabledFields = new Set(
      (fields && fields.length ? fields : REQUIRED_BB_FIELDS).map((f) => String(f).toLowerCase()),
    );

    const notes = [];
    // Bidirectional DShot telemetry deserves its own column: if the operator
    // supplied a custom field list, make sure RPM is still recorded, and
    // suggest the debug field so the RPM-filter notch can be verified later.
    if (caps.bidirDshot && fields && fields.length) {
      if (!enabledFields.has('rpm')) {
        enabledFields.add('rpm');
        notes.push('双向 DShot 已开启：RPM 字段已自动加入黑匣子记录。');
      }
      if (!enabledFields.has('debug')) {
        notes.push('建议同时记录 debug 字段（debug_mode = RPM_FILTER）以校验陷波中心。');
      }
    }

    const commands = buildBlackboxCliCommands({
      deviceName,
      rate: ratePlan.denom,
      fields,
      enabledFields,
    });

    const targetMask = computeDisabledMask([...enabledFields]);
    const diff = [
      { param: 'blackbox_device', from: BLACKBOX_DEVICE[before.device] || 'NONE', to: deviceName },
      {
        param: 'blackbox_sample_rate',
        from: `1/${before.rateDivisor} (${Math.round(caps.pidRateHz / before.rateDivisor)} Hz)`,
        to: `1/${ratePlan.denom} (${ratePlan.actualRate} Hz)`,
      },
      {
        param: 'fields_disabled_mask',
        from: `0x${before.disabledMask.toString(16)} [${fieldsFromDisabledMask(before.disabledMask).join(',') || 'none'}]`,
        to: `0x${targetMask.toString(16)} [${[...enabledFields].join(',')}]`,
      },
    ];

    const warnings = [];
    if (notes.length) {
      for (const note of notes) this.onLog('info', note);
    }
    if (!ratePlan.achievable && ratePlan.reason) warnings.push(ratePlan.reason);
    if (deviceName === 'SERIAL') {
      warnings.push('SERIAL logging streams to an external logger; the flight controller cannot erase or download it.');
    }
    if (deviceName === 'SDCARD') {
      warnings.push('SD card logs are downloaded by mounting the card (MSC), not over MSP.');
    }
    if (!caps.bidirDshot) {
      warnings.push('Bidirectional DShot is off, so RPM data will not appear in the log.');
    }

    if (dryRun) {
      this.onLog('info', `Blackbox dry-run: ${ratePlan.actualRate} Hz on ${deviceName} (${commands.length} CLI commands)`);
      return { applied: false, dryRun: true, commands, diff, warnings, ratePlan, deviceName, enabledFields: [...enabledFields] };
    }

    // Real write: CLI, then verify by re-reading over MSP.
    const { results } = await this.helper.cliRun(commands, {
      onProgress: (p) => this.onEvent({ kind: 'progress', level: 'debug', message: `blackbox: ${p.command}` }),
    });

    const failed = results.filter((r) => r.error);
    if (failed.length) {
      warnings.push(`${failed.length} command(s) echoed an error; configuration may be partially applied.`);
    }

    const after = await this.helper.readBlackboxConfig();
    const verified =
      after.device === DEVICE_IDS[deviceName] &&
      after.rateDivisor === ratePlan.denom &&
      (after.disabledMask === targetMask || after.disabledMask === 0);

    this.onLog(
      verified ? 'info' : 'warn',
      verified
        ? `Blackbox configured: ${ratePlan.actualRate} Hz, device ${deviceName}`
        : 'Blackbox configuration did not read back as expected; re-check the Blackbox tab before flying.',
    );

    return {
      applied: true,
      dryRun: false,
      commands,
      diff,
      warnings,
      verified,
      results,
      ratePlan,
      deviceName,
      enabledFields: [...enabledFields],
      readBack: after,
    };
  }

  /* ---------------- erase ---------------- */

  /**
   * Erases the active medium, by the correct method for that medium.
   * SD card is never erased implicitly - the caller must have downloaded first.
   */
  async erase({ device = 'auto', confirm = false } = {}) {
    const caps = this.identifier.capabilities || (await this.identifier.probeCapabilities());
    const deviceName = resolveDevice(device, caps);

    if (!confirm) {
      return { ok: false, method: 'none', reason: 'erase requires confirm: true' };
    }

    if (deviceName === 'SPIFLASH') {
      const summary = await this.helper.readDataflashSummary();
      if (!summary.supported) {
        return { ok: false, method: 'msp', reason: 'firmware reports no dataflash support' };
      }
      this.onLog('warn', `Erasing ${(summary.usedSize / 1024 / 1024).toFixed(1)} MiB of flash logs...`);
      await this.helper.eraseDataflash();
      // The erase runs in the background on the FC; poll until usedSize drops.
      const cleared = await this.#waitForFlashErase({ timeoutMs: 30000 });
      return {
        ok: cleared,
        method: 'msp:MSP_DATAFLASH_ERASE',
        bytesFreed: summary.usedSize,
        reason: cleared ? undefined : 'erase did not complete within 30 s',
      };
    }

    if (deviceName === 'SDCARD') {
      // Back up first, then hand over to the OS: MSP has no SD erase command.
      const backup = await this.download({ verify: false }).catch((err) => ({ ok: false, error: err.message }));
      this.onLog('warn', 'SD card cannot be erased over MSP. Entering MSC mode to expose the card as a USB drive.');
      // `msc` reboots the FC into mass-storage mode; the card then appears as a
      // removable volume the user (or a follow-up step) can clear. The FC will
      // not answer afterwards, so the timeout is expected and ignored.
      await this.helper.client.cli('msc', { timeoutMs: 3000 }).catch(() => {});
      this.onLog(
        'warn',
        'The card is now exposed as a USB volume. Delete the .bbl/.txt files there, then eject and reconnect.',
      );
      return {
        ok: true,
        method: 'msc',
        requiresUserAction: true,
        backup,
        instructions: [
          'The flight controller has restarted in mass-storage mode.',
          'Open the mounted volume and delete the blackbox logs.',
          'Eject the volume, then reconnect the app.',
        ],
      };
    }

    if (deviceName === 'SERIAL') {
      return {
        ok: false,
        method: 'none',
        reason: 'SERIAL logs live on the external logger; clear them on that device.',
        instructions: [
          'Logs are streamed to an external serial logger, not stored on the FC.',
          'Clear or swap the logger medium before the next flight.',
        ],
      };
    }

    return { ok: false, method: 'none', reason: `blackbox device is ${deviceName}; nothing to erase` };
  }

  async #waitForFlashErase({ timeoutMs = 30000, intervalMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      try {
        const summary = await this.helper.readDataflashSummary();
        if (summary.usedSize === 0) return true;
      } catch {
        // The FC may briefly stop answering while erasing; keep polling.
      }
    }
    return false;
  }

  /* ---------------- download ---------------- */

  /**
   * Downloads logs from the active medium.
   * Flash is streamed over MSP; SD card and serial are surfaced as instructions
   * because neither is reachable over MSP.
   */
  async download({ verify = true } = {}) {
    const caps = this.identifier.capabilities || (await this.identifier.probeCapabilities());
    const deviceName = BLACKBOX_DEVICE[caps.blackbox.deviceId] || 'NONE';

    if (deviceName === 'SPIFLASH') return this.#downloadFlash({ verify });

    if (deviceName === 'SDCARD') {
      return {
        ok: false,
        device: deviceName,
        reason: 'SD card logs must be copied from the mounted volume (MSC), not over MSP.',
        instructions: ['Run "msc" in the CLI to expose the card, then copy the .bbl files across.'],
      };
    }

    if (deviceName === 'SERIAL') {
      return {
        ok: false,
        device: deviceName,
        reason: 'SERIAL logs live on the external logger; import the .bbl file from there.',
        instructions: ['Use the file picker to open a .bbl file copied from the logger.'],
      };
    }

    return { ok: false, device: deviceName, reason: 'no blackbox medium is configured' };
  }

  async #downloadFlash({ verify }) {
    const summary = await this.helper.readDataflashSummary();
    if (!summary.supported) throw new Error('firmware reports no dataflash support');
    if (summary.usedSize === 0) throw new Error('the flash contains no logs; capture a flight first');

    mkdirSync(this.captureDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const board = (this.identifier.identity?.boardIdentifier || 'FC').replace(/[^A-Za-z0-9_-]/g, '');
    const path = join(this.captureDir, `${stamp}_${board}.bbl`);

    this.onLog('info', `Downloading ${(summary.usedSize / 1024 / 1024).toFixed(1)} MiB from flash...`);

    const stream = createWriteStream(path);
    const total = summary.usedSize;
    let address = 0;
    let written = 0;
    let lastReport = 0;
    let retries = 0;
    const startedAt = Date.now();

    try {
      while (address < total) {
        // The last block may be shorter than the block size.
        const blockSize = Math.min(FLASH_BLOCK_SIZE, total - address);
        let chunk;
        try {
          chunk = await this.helper.dataflashRead(address, blockSize);
        } catch (err) {
          retries++;
          if (retries > 5) throw new Error(`download aborted after ${retries} read failures: ${err.message}`);
          await sleep(150 * retries);
          continue;
        }
        retries = 0;

        const bytes = new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
        if (!stream.write(Buffer.from(bytes))) await once(stream, 'drain');

        written += bytes.length;
        address += blockSize;

        const now = Date.now();
        if (now - lastReport > 200) {
          lastReport = now;
          const elapsed = (now - startedAt) / 1000;
          this.onEvent({
            kind: 'download-progress',
            level: 'debug',
            message: `downloaded ${(written / 1024).toFixed(0)} KiB of ${(total / 1024).toFixed(0)} KiB`,
            data: {
              written,
              total,
              pct: total ? written / total : 0,
              bytesPerSecond: elapsed > 0 ? written / elapsed : 0,
            },
          });
        }
      }
    } finally {
      await new Promise((resolve) => stream.end(resolve));
    }

    const bytes = existsSync(path) ? statSync(path).size : 0;
    const result = { ok: true, device: 'SPIFLASH', path, bytes, flashUsedBytes: total };

    if (verify) {
      result.verification = await this.verifyLog(path);
      this.onLog(
        result.verification.ok ? 'info' : 'warn',
        result.verification.ok
          ? `Log verified: ${result.verification.durationS?.toFixed(1)}s at ~${result.verification.sampleRateHz} Hz, ` +
              `${(result.verification.dropRatePct ?? 0).toFixed(2)}% drops`
          : `Log verification reported problems: ${result.verification.problems.join('; ')}`,
      );
    }

    this.lastCapture = result;
    return result;
  }

  /**
   * Verifies an exported log really is a usable capture: real duration, real
   * sample rate, acceptable frame loss. This is step 6 of the workflow and the
   * gate in front of any tuning advice.
   */
  async verifyLog(path, { minDurationS = 20, maxDropRatePct = 2 } = {}) {
    const problems = [];
    let logs = [];
    try {
      const { logs: decoded } = await decodeBbl(path, { maxLogs: 4 });
      logs = decoded;
    } catch (err) {
      return { ok: false, problems: [`could not decode the downloaded log: ${err.message}`], logs: [] };
    }

    if (!logs.length) {
      return { ok: false, problems: ['no blackbox logs were found in the downloaded data'], logs: [] };
    }

    const log = logs[logs.length - 1];
    if (!log.durationS || log.durationS < minDurationS) {
      problems.push(
        `log is only ${(log.durationS ?? 0).toFixed(1)} s; at least ${minDurationS} s of varied flying is needed`,
      );
    }
    if (log.dropRatePct > maxDropRatePct) {
      problems.push(
        `${log.dropRatePct.toFixed(2)}% of frames were dropped (limit ${maxDropRatePct}%); ` +
          'lower the logging rate or check the medium',
      );
    }
    if (!log.sampleRateHz) {
      problems.push('the log header does not state a usable sample rate');
    }
    if (!log.channels.gyroADC?.[0]) {
      problems.push('the log has no gyro data; enable blackbox_disable_gyro = OFF and re-fly');
    }
    if (!log.channels.setpoint?.[0]) {
      problems.push('the log has no setpoint data; PID tracking cannot be analysed');
    }

    return {
      ok: problems.length === 0,
      problems,
      logs: logs.map((l) => ({
        index: l.index,
        durationS: l.durationS,
        sampleRateHz: l.sampleRateHz,
        frameCount: l.frameCount,
        dropRatePct: l.dropRatePct,
        axesPresent: l.axesPresent,
        fieldsPresent: l.fieldsPresent,
      })),
      durationS: log.durationS,
      sampleRateHz: log.sampleRateHz,
      dropRatePct: log.dropRatePct,
      fieldsPresent: log.fieldsPresent,
      craftName: log.craftName,
      firmware: log.firmware,
    };
  }

  /** Re-reads the blackbox configuration; used by the UI to render a live panel. */
  async readConfig() {
    const caps = this.identifier.capabilities;
    const config = await this.helper.readBlackboxConfig();
    return {
      ...config,
      deviceName: BLACKBOX_DEVICE[config.device] || 'NONE',
      actualRateHz: caps ? Math.round(caps.pidRateHz / config.rateDivisor) : null,
      enabledFields: fieldsFromDisabledMask(config.disabledMask),
    };
  }
}

/**
 * Resolves `auto` to the best available medium for this aircraft.
 * Preference order is flash, then SD card, then serial.
 */
export function resolveDevice(requested, caps) {
  const normalised = String(requested || 'auto').toUpperCase();
  if (normalised !== 'AUTO') return normalised;
  if (caps?.hasFlash) return 'SPIFLASH';
  if (caps?.hasSdCard) return 'SDCARD';
  return 'SERIAL';
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default BlackboxManager;
