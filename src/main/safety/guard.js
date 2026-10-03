/**
 * The safety boundary. Every write to the flight controller passes through here.
 *
 * Rules encoded below (from the operating brief):
 *   1. Nothing is written before a verified `dump` backup exists on disk.
 *   2. failsafe, motor direction, ESC protocol and voltage calibration are never
 *      written - not by a rule, not by a proposal, not by a manual CLI box.
 *   3. A detected hardware fault, severe vibration or desync latches the session
 *      read-only: analysis continues, tuning stops.
 *   4. At most one conservative write round per session.
 *   5. An unknown board runs in SAFE MODE: read-only for flight-behaviour
 *      parameters. Logging configuration is still permitted, because changing
 *      what gets recorded cannot change how the aircraft flies.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FORBIDDEN_PARAMS, MAX_TUNE_ROUNDS } from '../../shared/contracts.js';
import { filterDiff } from '../analysis/ai-tune.js';

/** Faults that permanently stop tuning for this session. */
export const LATCHING_FAULTS = new Set([
  'MOTOR_DESYNC',
  'SEVERE_VIBRATION',
  'GYRO_CLIPPING',
  'LOG_TRUNCATED',
]);

export class SafetyGuard {
  constructor({ maxRounds = MAX_TUNE_ROUNDS, onLog = () => {} } = {}) {
    this.maxRounds = maxRounds;
    this.onLog = onLog;

    this.readOnly = false;
    this.reasons = [];
    this.backupDone = false;
    this.backupPath = null;
    this.backupSha256 = null;
    this.roundsUsed = 0;
    this.appliedProposals = [];
    this.latchedFaults = [];
    this.acknowledged = false;
    /** Set by forceTrust(): the operator accepted an unknown board. */
    this.forcedTrust = false;
    /**
     * Non-null while flight-parameter writes are refused for a reason that
     * force-trust deliberately does NOT clear. Unknown hardware must never
     * become writable just because someone clicked through a dialog.
     */
    this.tuningLockedReason = null;
  }

  get status() {
    return {
      readOnly: this.readOnly,
      reasons: [...this.reasons],
      backupDone: this.backupDone,
      backupPath: this.backupPath,
      backupSha256: this.backupSha256,
      roundsUsed: this.roundsUsed,
      maxRounds: this.maxRounds,
      latchedFaults: [...this.latchedFaults],
      forcedTrust: this.forcedTrust,
      tuningLocked: this.tuningLockedReason,
      forbiddenParams: FORBIDDEN_PARAMS,
      canWrite: this.canWrite().ok,
    };
  }

  /* ---------------- state transitions ---------------- */

  /** Unknown board: analysis only. */
  enterSafeMode(reason) {
    if (!this.reasons.includes(reason)) this.reasons.push(reason);
    this.readOnly = true;
  }

  /** Back to a clean session state (new connection). */
  reset() {
    this.readOnly = false;
    this.reasons = [];
    this.backupDone = false;
    this.backupPath = null;
    this.backupSha256 = null;
    this.roundsUsed = 0;
    this.appliedProposals = [];
    this.latchedFaults = [];
    this.forcedTrust = false;
    this.tuningLockedReason = null;
  }

  /** Called once the mandatory dump has been written and hashed. */
  markBackup({ path, sha256 }) {
    this.backupDone = true;
    this.backupPath = path;
    this.backupSha256 = sha256;
    this.onLog('info', `Safety: backup recorded (${sha256?.slice(0, 12)}...) - writes are now unlocked`);
  }

  /**
   * Latches a set of faults from a metrics report.
   * @param {import('../../shared/contracts.js').Fault[]} faults
   */
  latchFaults(faults = []) {
    for (const fault of faults) {
      if (!LATCHING_FAULTS.has(fault.code)) continue;
      if (!this.latchedFaults.includes(fault.code)) {
        this.latchedFaults.push(fault.code);
        this.enterSafeMode(`${fault.code}: ${fault.evidence}`);
        this.onLog('error', `Safety: ${fault.code} latched - tuning disabled for this session (${fault.evidence})`);
      }
    }
  }

  /**
   * Advanced override: the operator accepts an unrecognised board and wants the
   * read/logging workflow to proceed.
   *
   * It deliberately does NOT unlock flight-parameter writes. An unknown board is
   * exactly the case where a wrong `set` command is most likely and least
   * debuggable, so tuning stays locked for the rest of the session.
   *
   * Hardware faults are not overridable at all.
   */
  forceTrust(note = null) {
    if (this.latchedFaults.length) {
      return {
        ok: false,
        reason: `hardware faults are latched (${this.latchedFaults.join(', ')}) and cannot be overridden`,
        status: this.status,
      };
    }

    this.forcedTrust = true;
    this.reasons = this.reasons.filter((r) => !r.startsWith('Unknown board'));
    this.readOnly = false;
    this.tuningLockedReason =
      note || 'unrecognised board (force-trusted): flight-parameter writes remain disabled';

    this.onLog('warn', `Safety: force-trust enabled - ${this.tuningLockedReason}`);
    return { ok: true, status: this.status };
  }

  ack() {
    this.acknowledged = true;
    // Acknowledging the warning clears only the *unknown board* reason; a
    // hardware fault is not dismissible.
    if (!this.latchedFaults.length) {
      this.reasons = this.reasons.filter((r) => !r.startsWith('Unknown board'));
      if (!this.reasons.length && !this.forcedTrust) this.readOnly = false;
    }
    return this.status;
  }

  /* ---------------- write gating ---------------- */

  /**
   * Whether *any* write is currently permitted, with the reasons when not.
   * @param {{kind?:'tune'|'logging'|'erase'}} [opts]
   */
  canWrite({ kind = 'tune' } = {}) {
    const reasons = [];

    // Logging configuration and erase are not flight-behaviour changes, so an
    // unknown board or a latched hardware fault does not block them.
    const isFlightBehaviour = kind === 'tune';

    if (isFlightBehaviour && !this.backupDone) {
      reasons.push('no verified backup has been taken yet');
    }
    if (isFlightBehaviour && this.latchedFaults.length) {
      reasons.push(`hardware faults latched: ${this.latchedFaults.join(', ')}`);
    }
    if (isFlightBehaviour && this.readOnly) {
      reasons.push(...(this.reasons.length ? this.reasons : ['session is read-only']));
    }
    if (isFlightBehaviour && this.roundsUsed >= this.maxRounds) {
      reasons.push(`already used the single permitted tuning round (${this.roundsUsed}/${this.maxRounds})`);
    }
    // Survives force-trust by design: see forceTrust().
    if (isFlightBehaviour && !this.readOnly && this.tuningLockedReason) {
      reasons.push(this.tuningLockedReason);
    }

    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Validates a proposal before it is offered as applicable.
   * @param {import('../../shared/contracts.js').TuneProposal} proposal
   */
  guardProposal(proposal) {
    const reasons = [];

    if (proposal.category === 'hardware') {
      reasons.push('hardware findings are advisory only and never written');
    }
    if (!proposal.safeToApply) {
      reasons.push(...(proposal.blockedBy?.length ? proposal.blockedBy : ['proposal marked unsafe']));
    }

    const { allowed, blocked } = filterDiff(proposal.diff || []);
    for (const b of blocked) reasons.push(`${b.param}: ${b.reason}`);

    const gate = this.canWrite({ kind: 'tune' });
    if (!gate.ok) reasons.push(...gate.reasons);

    return {
      ok: reasons.length === 0 && allowed.length > 0,
      reasons,
      writableDiff: allowed,
      blockedDiff: blocked,
    };
  }

  /**
   * Screens raw CLI text (including anything typed by hand) against the
   * immutable list. Returns the commands that may be sent and those that may not.
   *
   * @param {string[]} commands
   */
  screenCommands(commands = []) {
    const allowed = [];
    const blocked = [];

    for (const raw of commands) {
      const command = String(raw || '').trim();
      if (!command || command.startsWith('#')) continue;

      const offence = this.#offenceIn(command);
      if (offence) blocked.push({ command, reason: offence });
      else allowed.push(command);
    }

    return { allowed, blocked };
  }

  #offenceIn(command) {
    const lowered = command.toLowerCase();

    // Only `set` lines can change configuration.
    const setMatch = /^set\s+([a-z0-9_]+)\s*=/i.exec(lowered);
    if (!setMatch) {
      // Non-`set` commands are limited to a small allowlist.
      const bare = lowered.split(/\s+/)[0];
      const allowedBare = new Set(['get', 'dump', 'diff', 'status', 'version', 'save', 'exit', 'defaults', 'msc', '#']);
      return allowedBare.has(bare) ? null : `command "${bare}" is not on the allowed CLI list`;
    }

    const param = setMatch[1];
    for (const forbidden of FORBIDDEN_PARAMS) {
      if (param === forbidden || param.startsWith(forbidden)) {
        return `"${param}" is on the immutable safety list (failsafe / motor direction / ESC protocol / voltage calibration)`;
      }
    }
    return null;
  }

  /**
   * Verifies a diff against the live values it claims to change, so a proposal
   * computed from a stale read cannot silently write the wrong number.
   *
   * @param {{param:string,from:any,to:any}[]} diff
   * @param {Record<string, number|string>} liveValues
   */
  verifyAgainstLive(diff, liveValues = {}) {
    const mismatches = [];
    for (const item of diff) {
      const live = liveValues[item.param];
      if (live === undefined || live === null) continue;
      if (String(live) !== String(item.from)) {
        mismatches.push({ param: item.param, expected: item.from, live });
      }
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  /** Records that a write round happened. Enforces the one-round limit. */
  recordWrite(proposalId, commands) {
    this.roundsUsed += 1;
    this.appliedProposals.push({ proposalId, commands, at: new Date().toISOString() });
    this.onLog('warn', `Safety: tuning round ${this.roundsUsed}/${this.maxRounds} consumed - further writes blocked this session`);
    return this.status;
  }
}

export default SafetyGuard;
