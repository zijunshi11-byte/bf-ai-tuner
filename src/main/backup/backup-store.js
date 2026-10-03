/**
 * Versioned configuration backups and the rollback package behind the
 * "one-click revert" button.
 *
 * Rules this module exists to enforce:
 *
 *   - Nothing is written to the FC before a `diff all` snapshot is on disk.
 *   - A snapshot is named for the things that make it findable later:
 *     date + board + BF version + PID loop rate + a free-text note.
 *   - Restores use `diff all` ONLY. A whole `dump` must never be pushed back
 *     at a board it did not come from, and never across a BF major version -
 *     parameter meanings and defaults move between releases, so a dump
 *     restore silently corrupts settings that the operator never touched.
 *
 * The module is deliberately free of MSP/CLI details: it takes already-fetched
 * text, so it is unit-testable without hardware.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/**
 * Parameters captured alongside `diff all`.
 *
 * `diff all` already records everything that differs from defaults, but it
 * omits values the operator changed and then changed back, and it cannot be
 * read at a glance. This list is the "what was the tune at the time" view:
 * PID, filter, RPM, notch, TPA, I-term relax, D-term and blackbox.
 */
export const BACKUP_PARAMS = [
  // PID (profile 1..3 are covered by the CLI's per-profile output)
  'p_roll', 'i_roll', 'd_roll', 'f_roll',
  'p_pitch', 'i_pitch', 'd_pitch', 'f_pitch',
  'p_yaw', 'i_yaw', 'd_yaw', 'f_yaw',
  // D-term / D_min shaping
  'd_min_roll', 'd_min_pitch', 'd_min_yaw',
  'd_min_boost_gain', 'd_min_advance',
  'd_max_roll', 'd_max_pitch', 'd_max_yaw',
  // gyro / D-term filtering
  'gyro_lpf1_static_hz', 'gyro_lpf2_static_hz',
  'dterm_lpf1_static_hz', 'dterm_lpf2_static_hz',
  'gyro_notch_hz', 'gyro_notch_cutoff',
  'dyn_notch_count', 'dyn_notch_q', 'dyn_notch_min_hz', 'dyn_notch_max_hz',
  // RPM filter + the bidirectional link it depends on
  'rpm_filter_harmonics', 'rpm_filter_q', 'rpm_filter_min_hz',
  'dshot_bidir', 'motor_poles', 'motor_pwm_protocol',
  // TPA
  'tpa_rate', 'tpa_breakpoint', 'tpa_mode',
  // I-term relax / anti-gravity
  'iterm_relax', 'iterm_relax_type', 'iterm_relax_cutoff', 'anti_gravity_gain',
  // blackbox
  'blackbox_device', 'blackbox_sample_rate', 'blackbox_mode',
];

/** Files written per backup. */
export const BACKUP_FILES = Object.freeze({
  DIFF_ALL: 'diff-all.txt',
  SETTINGS: 'settings.txt',
  PACKAGE: 'rollback-package.json',
  META: 'meta.json',
});

const STAMP_LENGTH = 15; // YYYYMMDD-HHmmss

/** Filesystem-safe token: no separators, no surprises in Finder. */
export function sanitizeToken(value, fallback = 'na') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^\w.\-+]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

/** `YYYYMMDD-HHmmss` in local time. */
export function formatStamp(at = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/**
 * Backup directory name: date + board + BF version + PID loop rate + note.
 * Everything the operator needs to pick the right snapshot months later.
 */
export function backupId({ board, bfVersion, pidHz, note, at = new Date() } = {}) {
  return [
    formatStamp(at),
    sanitizeToken(board, 'unknown-board'),
    sanitizeToken(bfVersion, 'unknown-bf'),
    pidHz ? `${sanitizeToken(pidHz)}Hz` : 'nohz',
    sanitizeToken(note, 'manual'),
  ].join('_');
}

/**
 * Parses `name = value` CLI output into a map.
 * Tolerates the range/default comment lines the CLI interleaves.
 */
export function parseSettings(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][\w.]*)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, name, value] = m;
    // First wins: the CLI repeats some names per profile.
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** Pulls the `set ...` lines out of a `diff all` dump. */
export function extractSetCommands(diffText) {
  const commands = [];
  for (const raw of String(diffText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^set\s+\w+\s*=/.test(line)) commands.push(line);
  }
  return commands;
}

/** Major BF generation, so 4.x never restores onto 2025.x/2026.x and vice versa. */
export function majorVersion(version) {
  const m = /^(\d+)/.exec(String(version ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Whether a backup may be restored onto the currently connected FC.
 *
 * Returns `{ok, reasons}` rather than throwing so the UI can explain the
 * refusal instead of just failing.
 */
export function rollbackSafety(meta, current) {
  const reasons = [];
  if (!meta) return { ok: false, reasons: ['备份元数据缺失'] };

  const metaBoard = String(meta.board ?? '').trim();
  const curBoard = String(current?.board ?? '').trim();
  if (metaBoard && curBoard && metaBoard !== curBoard) {
    reasons.push(`板型不一致：备份来自 ${metaBoard}，当前飞控是 ${curBoard}`);
  }

  const a = majorVersion(meta.bfVersion);
  const b = majorVersion(current?.bfVersion);
  if (a && b && a !== b) {
    reasons.push(`Betaflight 大版本不一致：备份来自 ${meta.bfVersion}，当前固件是 ${current.bfVersion}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/** sha256 of a string, for the manifest. */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * On-disk store. `rootDir` is injected so tests can use a temp directory.
 */
export class BackupStore {
  constructor(rootDir) {
    if (!rootDir) throw new Error('BackupStore requires a root directory');
    this.rootDir = rootDir;
  }

  #dir(id) {
    return join(this.rootDir, id);
  }

  /**
   * Writes one backup atomically-ish and returns its manifest.
   *
   * @param {object} args
   * @param {string} args.diffAll       raw `diff all` output
   * @param {string} [args.settings]    raw settings text (`get` output)
   * @param {string[]} [args.pendingDiff] CLI lines about to be written
   * @param {string} [args.previousId]  backup the pending change was based on
   * @param {object} args.connection    {board, bfVersion, pidHz}
   * @param {string} [args.note]
   */
  create({ diffAll, settings = '', pendingDiff = [], previousId = null, connection = {}, note = '', at = new Date() } = {}) {
    if (typeof diffAll !== 'string' || !diffAll.trim()) {
      throw new Error('refusing to create a backup without `diff all` output');
    }

    const id = backupId({ ...connection, note, at });
    const dir = this.#dir(id);
    mkdirSync(dir, { recursive: true });

    const meta = {
      id,
      createdAt: at.toISOString(),
      board: connection.board ?? null,
      bfVersion: connection.bfVersion ?? null,
      pidHz: connection.pidHz ?? null,
      note: note || null,
      previousId,
      // A dump restore is never offered; recorded so the intent is auditable.
      restoreKind: 'diff-all',
      sha256: { diffAll: sha256(diffAll), settings: sha256(settings) },
    };

    writeFileSync(join(dir, BACKUP_FILES.DIFF_ALL), diffAll, 'utf8');
    writeFileSync(join(dir, BACKUP_FILES.SETTINGS), settings, 'utf8');
    writeFileSync(join(dir, BACKUP_FILES.META), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    // The rollback package ties this backup to the change it precedes, so a
    // revert has both "what it was" and "what we did" in one file.
    const pkg = {
      id,
      createdAt: meta.createdAt,
      connection: { board: meta.board, bfVersion: meta.bfVersion, pidHz: meta.pidHz },
      previousId,
      pendingDiff: [...pendingDiff],
      summary: summarise(pendingDiff),
      restoreCommands: extractSetCommands(diffAll).length,
      restoreKind: 'diff-all',
    };
    writeFileSync(join(dir, BACKUP_FILES.PACKAGE), `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

    return { ok: true, id, dir, files: { ...BACKUP_FILES }, summary: pkg.summary, meta };
  }

  /** Newest first. Unreadable entries are skipped rather than throwing. */
  list() {
    if (!existsSync(this.rootDir)) return [];
    const out = [];
    for (const name of readdirSync(this.rootDir)) {
      const dir = this.#dir(name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const metaPath = join(dir, BACKUP_FILES.META);
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const pkgPath = join(dir, BACKUP_FILES.PACKAGE);
        const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null;
        out.push({
          id: meta.id ?? name,
          createdAt: meta.createdAt ?? null,
          board: meta.board ?? null,
          bfVersion: meta.bfVersion ?? null,
          pidHz: meta.pidHz ?? null,
          note: meta.note ?? null,
          path: dir,
          items: (pkg?.pendingDiff ?? []).length,
        });
      } catch {
        // A half-written backup must not break the list.
      }
    }
    out.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return out;
  }

  get(id) {
    if (!id) return null;
    const dir = this.#dir(id);
    const metaPath = join(dir, BACKUP_FILES.META);
    const diffPath = join(dir, BACKUP_FILES.DIFF_ALL);
    if (!existsSync(metaPath) || !existsSync(diffPath)) return null;
    const pkgPath = join(dir, BACKUP_FILES.PACKAGE);
    return {
      dir,
      meta: JSON.parse(readFileSync(metaPath, 'utf8')),
      diffAll: readFileSync(diffPath, 'utf8'),
      settings: existsSync(join(dir, BACKUP_FILES.SETTINGS)) ? readFileSync(join(dir, BACKUP_FILES.SETTINGS), 'utf8') : '',
      package: existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : null,
    };
  }

  latest() {
    const [first] = this.list();
    return first ? this.get(first.id) : null;
  }
}

/** Human summary of a pending CLI diff, used in the rollback package. */
export function summarise(pendingDiff = []) {
  const params = pendingDiff
    .map((line) => /^set\s+(\w+)/.exec(String(line).trim()))
    .filter(Boolean)
    .map((m) => m[1]);
  return {
    count: pendingDiff.length,
    params,
    text: params.length ? params.join(', ') : '无参数改动',
  };
}

export default { BackupStore, backupId, parseSettings, extractSetCommands, rollbackSafety, BACKUP_PARAMS };
