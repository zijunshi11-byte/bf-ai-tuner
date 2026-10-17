/**
 * BF AI Tuner — renderer process operator console.
 *
 * Seven pages:
 *   0 connect -> 1 identify (identity + backup + capabilities) ->
 *   2 bidirectional DShot/RPM -> 3 blackbox 2k (config + download) ->
 *   4 capture -> 5 AI analysis (metrics + FFT + proposals) -> 6 history
 *
 * Every boundary (channel names, PortInfo / FcIdentity / Capabilities /
 * FcSettings / DecodedLog / MetricsReport / Fault / TuneProposal / ApplyResult /
 * BidirProbe / SafetyStatus shapes, the blackbox field tables and the event
 * envelope) is owned by src/shared/contracts.js. This module imports that file
 * when the document protocol allows it and otherwise falls back to
 * LOCAL_CONTRACT, a verbatim mirror of the same constants. No field is
 * invented here.
 *
 * Untrusted strings are only ever written as text nodes; nothing is built with
 * innerHTML. Every promise rejection lands in the on-screen log panel. Nothing
 * is written to the flight controller without a deliberate click, every
 * mutation path defaults to dry-run, and every real write is routed through a
 * confirm-with-diff dialog that cannot be armed until its diff table is
 * rendered.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* ================================================================== *
 * 1. Tiny DOM helpers
 * ================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** camelCase -> kebab-case, for CSSStyleDeclaration.setProperty. */
function kebab(key) {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Append nodes / strings / nested arrays; null, undefined, false are skipped. */
function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(parent, child);
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

/**
 * Replace every child of `parent`.
 *
 * `Element.replaceChildren` stringifies `null` arguments, so passing a
 * conditional node straight in rendered the literal text "null" - the status
 * bar showed "nullnullnull" because three of its six slots were empty. Filter
 * the arguments the same way append() does before handing them over.
 */
function setChildren(parent, children) {
  const flat = [];
  const push = (value) => {
    if (Array.isArray(value)) value.forEach(push);
    else if (value === null || value === undefined || value === false || value === true) return;
    else flat.push(value);
  };
  push(children);
  parent.replaceChildren(...flat);
  return parent;
}

function setClass(node, value) {
  const flat = [];
  const push = (v) => {
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'string' && v.length > 0) flat.push(v);
  };
  push(value);
  node.className = flat.join(' ');
}

function setStyle(node, style) {
  for (const [key, value] of Object.entries(style || {})) {
    if (value === null || value === undefined) continue;
    node.style.setProperty(kebab(key), String(value));
  }
}

/**
 * Minimal element builder.
 * props: class (string|array), text, style, data, attrs, on, value, checked,
 * disabled; anything else becomes an attribute.
 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    switch (key) {
      case 'class':
        setClass(node, value);
        break;
      case 'text':
        node.textContent = String(value);
        break;
      case 'style':
        setStyle(node, value);
        break;
      case 'data':
        for (const [k, v] of Object.entries(value)) {
          if (v !== undefined && v !== null) node.dataset[k] = String(v);
        }
        break;
      case 'on':
        for (const [type, handler] of Object.entries(value)) node.addEventListener(type, handler);
        break;
      case 'attrs':
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined || v === null || v === false) continue;
          node.setAttribute(k, v === true ? '' : String(v));
        }
        break;
      case 'value':
        node.value = String(value);
        break;
      case 'checked':
        node.checked = Boolean(value);
        break;
      case 'disabled':
        node.disabled = Boolean(value);
        break;
      default:
        node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

/* ================================================================== *
 * 2. Contract mirror (fallback for the file:// module graph)
 * ================================================================== */

const LOCAL_CONTRACT = {
  BLACKBOX_DEVICE: { 0: 'NONE', 1: 'SPIFLASH', 2: 'SDCARD', 3: 'SERIAL', 4: 'VIRTUAL' },
  BLACKBOX_FIELDS: [
    { bit: 0, key: 'pid', cli: 'blackbox_disable_pids' },
    { bit: 1, key: 'rc', cli: 'blackbox_disable_rc' },
    { bit: 2, key: 'setpoint', cli: 'blackbox_disable_setpoint' },
    { bit: 3, key: 'batt', cli: 'blackbox_disable_bat' },
    { bit: 4, key: 'mag', cli: 'blackbox_disable_mag' },
    { bit: 5, key: 'alt', cli: 'blackbox_disable_alt' },
    { bit: 6, key: 'rssi', cli: 'blackbox_disable_rssi' },
    { bit: 7, key: 'gyro', cli: 'blackbox_disable_gyro' },
    { bit: 8, key: 'attitude', cli: 'blackbox_disable_attitude' },
    { bit: 9, key: 'acc', cli: 'blackbox_disable_acc' },
    { bit: 10, key: 'debug', cli: 'blackbox_disable_debug' },
    { bit: 11, key: 'motor', cli: 'blackbox_disable_motors' },
    { bit: 12, key: 'gps', cli: 'blackbox_disable_gps' },
    { bit: 13, key: 'rpm', cli: 'blackbox_disable_rpm' },
    { bit: 14, key: 'gyrounfilt', cli: 'blackbox_disable_gyrounfilt' },
    { bit: 15, key: 'servo', cli: 'blackbox_disable_servos' },
  ],
  REQUIRED_BB_FIELDS: ['gyro', 'setpoint', 'pid', 'rc', 'motor', 'throttle', 'batt', 'rpm'],
  FORBIDDEN_PARAMS: [
    'failsafe_',
    'set failsafe',
    'motor_pwm_protocol',
    'dshot_bidir',
    'yaw_motors_reversed',
    'motor_direction',
    'reverse_motor_direction',
    'vbat_scale',
    'vbat_divider',
    'current_meter_scale',
    'current_meter_offset',
    'imu_board_align',
    'board_align_roll',
    'board_align_pitch',
    'board_align_yaw',
  ],
  MAX_TUNE_ROUNDS: 1,
};

const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'];
const LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
const KINDS = ['log', 'progress', 'state', 'safety', 'msp-trace', 'download-progress'];

const LOG_MAX = 500;
const REQUESTED_BB_RATE_DEFAULT = 2000;
const SAMPLE_RATE_TOLERANCE = 0.05; // +-5% against the requested rate
const DROP_RATE_WARN_PCT = 1;
const DROP_RATE_FAIL_PCT = 5;
const MSP_BAUD = 115200;

/** Bidir RPM sparkline history window (samples kept per motor). */
const BIDIR_HISTORY_MAX = 60;
const SPARK_W = 140;
const SPARK_H = 36;

/** FFT spectrum plot: decimate any spectrum to at most this many points. */
const FFT_MAX_POINTS = 2000;
const FFT_W = 480;
const FFT_H = 160;
const FFT_AXES = ['roll', 'pitch', 'yaw'];

/** The scoped bidir write path is the ONLY path for these parameters. */
const BIDIR_PARAM_RE = /^set\s+(dshot_bidir|motor_poles|rpm_filter_(harmonics|q|min_hz))\s*=/i;

const FIELD_LABEL = {
  pid: 'PID 项',
  rc: 'RC 指令',
  setpoint: 'Setpoint',
  batt: '电池电压/电流',
  mag: '磁力计',
  alt: '气压高度',
  rssi: 'RSSI',
  gyro: '陀螺仪',
  attitude: '姿态',
  acc: '加速度',
  debug: 'Debug 通道',
  motor: '电机输出',
  gps: 'GPS',
  rpm: '转速 eRPM',
  gyrounfilt: '未滤波陀螺仪',
  servo: '舵机',
  throttle: '油门',
};

const DEVICE_LABEL = {
  auto: '自动 / auto',
  SPIFLASH: 'SPI Flash',
  SDCARD: 'SD 卡 / SDCARD',
  SERIAL: '串口 / SERIAL',
};

const MATCH_LEVEL_TONE = { exact: 'ok', board: 'info', family: 'warn', unknown: 'crit' };
const CATEGORY_LABEL = { pid: 'PID', filter: '滤波器 / filter', hardware: '硬件 / hardware', evidence: '证据不足 / evidence', none: '无需改动 / none' };
const CATEGORY_TONE = { pid: 'info', filter: 'info', hardware: 'warn', evidence: 'warn', none: 'idle' };

/* ================================================================== *
 * 3. State
 * ================================================================== */

const state = {
  /** 'auto' | 'light' | 'dark' - see applyTheme(). */
  theme: 'auto',
  contract: LOCAL_CONTRACT,
  contractSource: 'local mirror',
  step: 0,
  done: new Set(),
  ports: [],
  port: null,
  connected: false,
  connecting: false,
  identity: null,
  capabilities: null,
  settings: null,
  pid: null,
  filter: null,
  safety: {
    readOnly: true, // unknown safety state is treated as read-only
    reasons: ['尚未读取安全状态 / safety status not read yet'],
    backupDone: false,
    backupPath: null,
    roundsUsed: 0,
    maxRounds: LOCAL_CONTRACT.MAX_TUNE_ROUNDS,
    forbiddenParams: [],
    /** Set once the operator force-trusted an unrecognised board. */
    forcedTrust: false,
    /** Non-null => flight-parameter writes stay refused even after force-trust. */
    tuningLocked: null,
  },
  /** Link health as reported by the MSP client (session status + ping/reconnect). */
  link: { linkState: 'down', linkHealthy: false, recoveries: 0, latencyMs: null, checkedAt: 0 },
  /** AI auto-debug loop: never more than one at a time. */
  autoDebug: {
    on: false,
    running: false,
    finished: false,
    iteration: 0,
    stable: 0,
    phase: 'idle',
    latencyMs: null,
    lastOutcome: '',
    timerId: null,
  },  /** Advanced manual CLI box (dry-run by default; real writes are gated + confirmed). */
  cli: { text: '', result: null },
  /** Inline confirm state for the force-trust override. */
  trust: { confirm: false, error: '' },
  /** Serial-port table sorting + optional auto-refresh. */
  portsSort: { key: 'device', dir: 1 },
  portsAuto: { on: false, timerId: null },
  /** Bidirectional DShot/RPM page. */
  bidir: {
    probe: null,
    busy: false,
    /** motorIndex -> { rpm:[...], erpm:[...], hz:[...], invalidPct:[...] } (last 60). */
    history: {},
    /** Two-phase applyBidir pending state: {commands, token, diff, blocked, reason, result}. */
    apply: null,
  },
  bb: {
    rate: REQUESTED_BB_RATE_DEFAULT,
    device: 'auto',
    fields: new Set(LOCAL_CONTRACT.REQUIRED_BB_FIELDS),
    fieldsInit: false,
    fieldsSource: '默认必需字段',
    dryRun: true,
    eraseText: '',
    lastDiff: null,
    lastApplied: null,
    lastMethod: null,
    lastPlan: null,
    lastWarnings: [],
    /** Live bf.bb.readConfig() result (permitted in SAFE MODE). */
    live: null,
    /** One-shot media auto-detect on first entry to the blackbox page. */
    liveAutoTried: false,
  },
  /**
   * Mass-storage (MSC) reading of onboard flash logs that are too large for MSP.
   * While the FC is in mass-storage mode there is no MSP link at all, so every
   * mutating control in the UI is gated off (see safetyInfo()).
   */
  msc: {
    /** bf.bb.mscStatus() result: {inMsc, volumes:[{name, path, files:[…]}]}. */
    status: null,
    busy: false,
    /** One-shot status probe on first entry to the blackbox page. */
    tried: false,
    /** `${volumePath}\u0000${fileName}` keys of the .bbl files ticked for import. */
    selected: new Set(),
    /** bf.bb.mscImport() receipts of the last import run. */
    lastImport: null,
    /** Last message returned by enter/exit, shown verbatim. */
    message: '',
  },
  /** Mandatory backup + one-click rollback (bf.backup.*). */
  backup: {
    /** bf.backup.list() -> backups[] (newest first as returned by the main process). */
    list: [],
    loading: false,
    /** One-shot list load per connection; a failed load does not retry on repaint. */
    loaded: false,
    /** Optional operator note for the next bf.backup.create(). */
    note: '',
    /** bf.backup.rollback() result of the last successful rollback. */
    lastRollback: null,
  },
  /** Post-change re-fly evaluation (bf.tune.evaluate). */
  evaluate: { busy: false, result: null, error: '' },
  /** True while an offline analysis pass is in flight (drives the state bar). */
  analysis: { busy: false },
  /**
   * 「一键准备」chain: runs every read-only pre-flight check in order so the
   * operator does not have to walk three separate pages to reach the same
   * state. Each entry is { label, state: 'ok'|'fail'|'skip', detail }.
   */
  prepare: { busy: false, current: null, results: [] },
  /**
   * Optional AI agent layer. `config` never holds the API key - the main
   * process only reports whether one is stored (`hasApiKey`). `level` picks how
   * much of the log is serialised into the pack (compact / standard / full).
   */
  ai: { config: null, loading: false, busy: false, result: null, error: null, showSettings: false, level: 'standard', exportResult: null },
  capture: {
    running: false,
    startedAt: 0,
    baseMs: 0,
    elapsedMs: 0,
    intervalId: null,
    single: false,
    checked: new Set(),
  },
  /** Guided test flights + evidence needs, fetched once from bbl:flight_cards. */
  flight: { cards: null, needs: null, loading: false, error: null },
  download: { busy: false, progress: null, message: '', path: null, logs: [] },
  file: null,
  metrics: null,
  proposals: [],
  apply: {},
  applied: new Set(),
  focusConfirm: null,
  /** FFT spectrum (bf.bbl.fft result) + selected axis. */
  fft: { data: null, axis: 'roll' },
  /** History page. */
  history: { reports: [], loading: false, openId: null, report: null },
  /** Campaign plan + scorecard from tune:plan after the latest propose. */
  plan: null,
  /** Per-quad tuning journal (History page). */
  journal: { quads: [], loading: false, loaded: false, selected: null, doc: null, draft: {}, note: '' },
  historySort: { key: 'savedAt', dir: -1 },
  /** The currently open confirm-with-diff dialog, if any. */
  confirmDialog: null,
  log: { count: 0, filter: 'all', follow: true },
  unsubscribe: null,
};

const refs = {
  rateNote: null,
  fieldWarn: null,
  downloadBar: null,
  downloadMsg: null,
};

/* ================================================================== *
 * 4. Formatting
 * ================================================================== */

function str(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtNum(v, digits = 2) {
  const n = num(v);
  return n === null ? '—' : n.toFixed(digits);
}

function fmtInt(v) {
  const n = num(v);
  return n === null ? '—' : String(Math.round(n));
}

function fmtPct(v, digits = 1) {
  const n = num(v);
  return n === null ? '—' : `${n.toFixed(digits)}%`;
}

/** 0..1 ratio -> "42.0%" */
function fmtRatio(v, digits = 1) {
  const n = num(v);
  return n === null ? '—' : `${(n * 100).toFixed(digits)}%`;
}

function fmtBytes(v) {
  const n = num(v);
  if (n === null || n <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(i === 0 ? 0 : x < 10 ? 2 : 1)} ${units[i]}`;
}

function fmtKb(v) {
  const n = num(v);
  return n === null ? '—' : fmtBytes(n * 1024);
}

function fmtHz(v) {
  const n = num(v);
  if (n === null || n <= 0) return '—';
  // Spectral bins land on values like 472.65625 Hz; one decimal is already
  // finer than any bin, and the long tail wrapped metric rows onto two lines.
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 2)} kHz` : `${Number.isInteger(n) ? n : n.toFixed(1)} Hz`;
}

function fmtHzShort(v) {
  const n = num(v);
  if (n === null || n <= 0) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : `${n}`;
}

function fmtMs(v) {
  const n = num(v);
  if (n === null) return '—';
  return `${n.toFixed(Math.abs(n) < 10 ? 2 : 1)} ms`;
}

function fmtSeconds(v) {
  const n = num(v);
  if (n === null) return '—';
  return n >= 60 ? `${Math.floor(n / 60)}m ${(n % 60).toFixed(1)}s` : `${n.toFixed(2)} s`;
}

function fmtDuration(ms) {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function fmtClock(ts) {
  const n = num(ts);
  if (n === null) return '--:--:--';
  try {
    return new Date(n).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '--:--:--';
  }
}

function fmtDateTime(v) {
  if (v === null || v === undefined || v === '') return '—';
  try {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(v);
  }
}

function fmtVal(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  return String(v);
}

function clamp01(v) {
  const n = num(v);
  if (n === null) return 0;
  return Math.min(1, Math.max(0, n));
}

function errMessage(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function confidenceTone(c) {
  const n = clamp01(c);
  return n >= 0.85 ? 'ok' : n >= 0.6 ? 'warn' : 'crit';
}

function qualityTone(q) {
  const n = clamp01(q);
  return n >= 0.75 ? 'ok' : n >= 0.45 ? 'warn' : 'crit';
}

function qualityLabel(q) {
  const n = clamp01(q);
  if (n >= 0.85) return '优秀 / excellent';
  if (n >= 0.7) return '良好 / good';
  if (n >= 0.45) return '一般 / fair';
  return '差 / poor';
}

function severityTone(sev) {
  return sev === 'critical' ? 'crit' : sev === 'warn' ? 'warn' : 'info';
}

function contractFields() {
  const list = state.contract?.BLACKBOX_FIELDS;
  return Array.isArray(list) && list.length ? list : LOCAL_CONTRACT.BLACKBOX_FIELDS;
}

function contractRequired() {
  const list = state.contract?.REQUIRED_BB_FIELDS;
  return Array.isArray(list) && list.length ? list : LOCAL_CONTRACT.REQUIRED_BB_FIELDS;
}

function contractForbidden() {
  const list = state.contract?.FORBIDDEN_PARAMS;
  return Array.isArray(list) ? list : LOCAL_CONTRACT.FORBIDDEN_PARAMS;
}

/** 'throttle' is in REQUIRED_BB_FIELDS but has no disable bit: always logged. */
function toggleableFields() {
  return contractFields().filter((f) => typeof f?.key === 'string');
}

/* ================================================================== *
 * 5. Event log panel
 * ================================================================== */

function normalizeEvent(raw) {
  const src = raw && typeof raw === 'object' ? raw : { message: String(raw) };
  return {
    level: LEVELS.includes(src.level) ? src.level : 'info',
    kind: KINDS.includes(src.kind) ? src.kind : 'log',
    message: src.message === undefined || src.message === null ? '' : String(src.message),
    ts: num(src.ts) ?? Date.now(),
    data: src.data,
  };
}

function infoEntry(message, kind = 'log', data) {
  return { level: 'info', kind, message, ts: Date.now(), data };
}

function warnEntry(message, data) {
  return { level: 'warn', kind: 'log', message, ts: Date.now(), data };
}

function errorEntry(message, data) {
  return { level: 'error', kind: 'log', message, ts: Date.now(), data };
}

function appendLog(rawEntry) {
  const entry = normalizeEvent(rawEntry);
  const list = $('#log-list');
  if (!list) return entry;

  const dataText = entry.data === undefined ? '' : safeJson(entry.data);
  const line = el('li', { class: ['log-line', `lvl-${entry.level}`], data: { level: entry.level } }, [
    el('span', { class: 'log-time', text: fmtClock(entry.ts) }),
    el('span', { class: 'log-kind', text: entry.kind }),
    el('span', { class: 'log-msg', text: entry.message || '(无消息)' }),
    dataText ? el('span', { class: 'log-data', text: dataText }) : null,
  ]);

  list.append(line);
  while (list.childElementCount > LOG_MAX) list.firstElementChild?.remove();
  state.log.count = list.childElementCount;
  applyLogFilterTo(line);
  updateLogCount();
  if (!state.log.follow) return entry;

  const body = $('#log-body');
  if (body && !body.hidden) body.scrollTop = body.scrollHeight;
  if ((entry.level === 'error' || entry.level === 'fatal') && body?.hidden) setLogOpen(true);
  return entry;
}

function safeJson(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (typeof text !== 'string') return '';
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return '';
  }
}

function setLogOpen(open) {
  const toggle = $('#log-toggle');
  const body = $('#log-body');
  if (!toggle || !body) return;
  toggle.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  if (open) body.scrollTop = body.scrollHeight;
}

function updateLogCount() {
  const node = $('#log-count');
  if (node) node.textContent = String(state.log.count);
}

function applyLogFilterTo(line) {
  if (state.log.filter === 'all') {
    line.hidden = false;
    return;
  }
  const min = LEVEL_ORDER[state.log.filter] ?? 0;
  line.hidden = (LEVEL_ORDER[line.dataset.level] ?? 1) < min;
}

function applyLogFilter() {
  for (const line of $$('#log-list .log-line')) applyLogFilterTo(line);
}

/* ================================================================== *
 * 6. Errors + promise plumbing
 * ================================================================== */

/** Run a promise-returning operation; never throws, always logs the failure. */
async function run(label, fn) {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    appendLog(errorEntry(`${label} 失败：${errMessage(err)}`));
    return { ok: false, error: err };
  }
}

/** Wire a click handler with double-submit protection and a last-resort catch. */
function action(node, label, handler) {
  node.addEventListener('click', () => {
    if (node.disabled || node.dataset.busy === '1') return;
    node.dataset.busy = '1';
    refreshGuards();
    Promise.resolve()
      .then(handler)
      .catch((err) => appendLog(errorEntry(`${label} 失败：${errMessage(err)}`)))
      .finally(() => {
        node.dataset.busy = '0';
        refreshGuards();
      });
  });
  return node;
}

/* ================================================================== *
 * 7. Write guards (read-only / SAFE MODE / tuning lock)
 * ================================================================== */

let guards = [];

function guard(node, predicate) {
  guards.push({ node, predicate });
  return node;
}

function isReadOnly() {
  return Boolean(state.safety.readOnly);
}

/**
 * True while the flight controller is in mass-storage (MSC) mode.
 *
 * The FC has rebooted as a USB disk: the MSP link is gone, so no write of any
 * kind can land until the volume is ejected and the board is power-cycled.
 * Read from bf.bb.mscStatus() only - never inferred from a timeout.
 */
function mscActive() {
  return Boolean(state.msc && state.msc.status && state.msc.status.inMsc);
}

/**
 * Single source of truth for what the interface may write.
 *
 * The safety boundary has two levels, so there are two gates:
 *
 *   - `logging` - blackbox configuration writes, blackbox erase and manual CLI
 *     writes. These reach the flight controller but cannot change how it flies,
 *     and the main-process guard classifies them as non-flight-behaviour. They
 *     are blocked while the session is read-only or while the board is unknown
 *     and not force-trusted. A force-trusted unknown board may configure
 *     logging again ("writable for logging").
 *   - `tuning` - flight-parameter writes (tune.apply, manual CLI real writes).
 *     Blocked by everything the logging gate blocks plus `tuningLocked`, the
 *     latch that forceTrust() deliberately does not clear.
 *
 * Mass-storage mode blocks both gates: while `bf.bb.mscStatus()` reports
 * `inMsc`, every mutating control is disabled and says why, because there is no
 * MSP session to write through until the volume is ejected and the FC is
 * power-cycled.
 */
function safetyInfo() {
  const s = state.safety;
  const reasons = (Array.isArray(s.reasons) ? s.reasons : []).filter(Boolean).map(String);
  const unknownBoard = Boolean(state.identity && state.identity.known === false);
  const forcedTrust = Boolean(s.forcedTrust);
  const readOnly = isReadOnly();
  const tuningLockedReason = s.tuningLocked ? String(s.tuningLocked) : null;
  const inMsc = mscActive();
  const mscReason = 'MSC 大容量模式：飞控已作为 USB 存储设备重启，MSP 写入不可用；请先「弹出并退出」并重新上电 / mass-storage mode: MSP writes unavailable until eject + power-cycle';

  const loggingReasons = [];
  if (readOnly) loggingReasons.push(...(reasons.length ? reasons : ['主进程已把本会话锁定为只读 / session is read-only']));
  if (unknownBoard && !forcedTrust) loggingReasons.push('SAFE MODE：机型未识别（known = false），禁止写入飞控 / unknown board');
  if (inMsc) loggingReasons.push(mscReason);

  const tuningReasons = [...loggingReasons];
  if (tuningLockedReason) tuningReasons.push(tuningLockedReason);

  const loggingBlocked = loggingReasons.length > 0;
  const tuningBlocked = loggingBlocked || Boolean(tuningLockedReason);

  return {
    readOnly,
    reasons,
    unknownBoard,
    forcedTrust,
    tuningLockedReason,
    /** Mass-storage mode is active: no MSP writes at all. */
    mscActive: inMsc,
    mscReason,
    loggingBlocked,
    tuningBlocked,
    loggingReasons,
    tuningReasons,
    /** The persistent SAFE MODE banner stays up while any lock is active. */
    bannerVisible: loggingBlocked || Boolean(tuningLockedReason),
  };
}

/** Gate a control: 'logging' for record-side writes, 'tuning' for flight parameters. */
function gateInfo(gate) {
  const info = safetyInfo();
  const tuning = gate !== 'logging';
  const blocked = tuning ? info.tuningBlocked : info.loggingBlocked;
  const reasons = tuning ? info.tuningReasons : info.loggingReasons;
  return { blocked, reason: blocked ? reasons.join('；') || '本会话已锁定写入' : '' };
}

/** Legacy shape used across the step renderers: what is locked, and why. */
function writesBlocked() {
  const info = safetyInfo();
  return {
    blocked: info.tuningBlocked,
    reason: info.tuningBlocked ? info.tuningReasons.join('；') || '本会话已锁定写入' : '',
  };
}

/** True when the board is unknown (or read-only for that reason) and not yet trusted. */
function unknownBoardReason() {
  const reasons = Array.isArray(state.safety.reasons) ? state.safety.reasons : [];
  return reasons.map(String).find((r) => /unknown board|未识别/i.test(r)) || null;
}

function canForceTrust() {
  if (state.safety.forcedTrust) return false;
  if (state.identity && state.identity.known === false) return true;
  return Boolean(unknownBoardReason());
}

function refreshGuards() {
  guards = guards.filter((g) => g.node.isConnected);
  for (const g of guards) {
    let allowed = true;
    try {
      allowed = Boolean(g.predicate());
    } catch {
      allowed = false;
    }
    g.node.disabled = g.node.dataset.busy === '1' || !allowed;
  }
  for (const node of $$('[data-mutating="1"]')) {
    const lock = gateInfo(node.dataset.gate);
    node.classList.toggle('is-locked', lock.blocked);
    if (lock.blocked) {
      // Remember the real tooltip once, so unlocking cannot leave the lock
      // reason (or a stale empty title) stuck on an enabled control.
      if (node.dataset.locked !== '1') {
        node.dataset.locked = '1';
        node.dataset.unlockedTitle = node.title || '';
      }
      node.disabled = true;
      node.title = lock.reason;
    } else if (node.dataset.locked === '1') {
      delete node.dataset.locked;
      node.title = node.dataset.unlockedTitle || node.dataset.title || '';
      delete node.dataset.unlockedTitle;
    }
  }
}

/* ================================================================== *
 * 8. Small UI atoms
 * ================================================================== */

function button(label, opts = {}) {
  const gate = opts.gate === 'logging' ? 'logging' : 'tuning';
  const node = el('button', {
    class: ['btn', opts.variant ? `btn-${opts.variant}` : '', opts.size === 'sm' ? 'btn-sm' : ''],
    type: 'button',
    text: label,
    attrs: opts.attrs,
    on: opts.on,
    data: opts.mutating ? { mutating: '1', gate, title: opts.title || '' } : undefined,
    disabled: opts.disabled ?? true,
  });
  if (opts.title) node.title = opts.title;
  const predicate = typeof opts.enabled === 'function' ? opts.enabled : () => opts.enabled !== false;
  guard(node, () => predicate() && !(opts.mutating && gateInfo(gate).blocked));
  return node;
}

function chip(text, tone = 'idle', title) {
  const node = el('span', { class: ['chip', tone !== 'idle' ? `chip-${tone}` : ''], text });
  if (title) node.title = title;
  return node;
}

function badge(text, tone = 'idle') {
  return el('span', { class: ['badge', tone !== 'idle' ? `badge-${tone}` : ''], text });
}

function pill(text, tone = 'idle', withDot = true) {
  return el('span', { class: ['pill', `pill-${tone}`] }, [
    withDot ? el('span', { class: 'dot' }) : null,
    el('span', { text }),
  ]);
}

/** Aviation-style LED status light. */
function statusLight(tone, label) {
  return el('span', { class: ['status-light', `sl-${tone}`], attrs: { role: 'img', 'aria-label': label || tone } });
}

function boolText(value, onText = '是 / yes', offText = '否 / no') {
  const on = Boolean(value);
  return el('span', { class: on ? 'hint ok' : 'hint warn', text: `${on ? '✓' : '✗'} ${on ? onText : offText}` });
}

function meter(ratio, opts = {}) {
  const pct = Math.round(clamp01(ratio) * 100);
  const tone = opts.tone || qualityTone(ratio);
  const bar = el(
    'div',
    {
      class: ['meter', `meter-${tone}`],
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(pct),
        'aria-label': opts.label || '进度',
      },
    },
    [el('div', { class: 'meter-fill', style: { width: `${pct}%` } })],
  );
  if (opts.showPct === false) return bar;
  return el('div', { class: 'meter-row' }, [bar, el('span', { class: 'meter-val mono-num', text: `${pct}%` })]);
}

function kv(label, value, opts = {}) {
  const valueNode = value instanceof Node ? value : el('span', { class: opts.mono === false ? '' : 'mono-num', text: str(value) });
  const node = el('div', { class: ['kv', opts.class] }, [
    el('span', { class: 'kv-k', text: label }),
    el('span', { class: ['kv-v', opts.tone ? `tone-${opts.tone}` : ''], style: opts.wrap === false ? { overflowWrap: 'normal', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } : undefined }, [valueNode]),
  ]);
  node.title = value instanceof Node ? '' : str(value);
  return node;
}

function kvGrid(rows) {
  return el('div', { class: 'kv-grid' }, rows.filter(Boolean));
}

function card(title, body, opts = {}) {
  const head = el('div', { class: 'card-head' }, [
    el('h3', { class: 'card-title' }, [typeof title === 'string' ? el('span', { text: title }) : title, ...(opts.badges || [])]),
    opts.actions && opts.actions.length ? el('div', { class: 'card-actions' }, opts.actions) : null,
  ]);
  return el('section', { class: ['card', opts.class], attrs: opts.id ? { id: opts.id } : undefined }, [
    head,
    el('div', { class: 'card-body' }, body),
  ]);
}

function banner(tone, title, body) {
  return el('div', { class: ['banner', `banner-${tone}`], attrs: { role: tone === 'crit' ? 'alert' : 'status' } }, [
    el('div', { class: 'banner-title', text: title }),
    ...(Array.isArray(body) ? body : body ? [body] : []),
  ]);
}

function para(text, cls = 'prose') {
  return el('p', { class: cls, text: str(text) });
}

function table(headers, rows) {
  return el('table', { class: 'tbl' }, [
    el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { class: typeof h === 'object' ? h.class : '', text: typeof h === 'object' ? h.text : h })))]),
    el(
      'tbody',
      {},
      rows.map((cells) =>
        el(
          'tr',
          {},
          cells.map((cell) => {
            const isObj = cell && typeof cell === 'object' && !(cell instanceof Node);
            return el('td', { class: isObj ? cell.class : '' }, [isObj ? (cell.node ?? str(cell.text)) : cell]);
          }),
        ),
      ),
    ),
  ]);
}

function codeBlock(lines) {
  const list = Array.isArray(lines) ? lines : lines === undefined || lines === null ? [] : [lines];
  if (!list.length) return el('p', { class: 'hint', text: '（无 CLI 改动）' });
  return el('code', { class: 'code' }, list.map((line) => el('span', { class: 'code-line', text: str(line) })));
}

/** Renders ApplyResult.diff / TuneProposal.diff as a before/after table. */
function diffTable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return el('p', { class: 'hint', text: '（无差异 / no diff）' });
  return table(
    ['参数 / param', '当前 / from', '建议 / to', '变化 / delta'],
    list.map((r) => [
      { class: 'mono-num', text: str(r?.param) },
      { class: 'mono-num', text: r?.from === undefined || r?.from === null ? '—' : fmtVal(r.from) },
      { class: 'mono-num', text: r?.to === undefined || r?.to === null ? '—' : fmtVal(r.to) },
      { class: 'mono-num', text: r?.deltaPct === undefined || r?.deltaPct === null ? '—' : fmtPct(r.deltaPct) },
    ]),
  );
}

function evidenceList(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return el('p', { class: 'hint', text: '（无证据条目）' });
  return el('ul', { class: 'evidence' }, list.map((item) => el('li', { text: str(item) })));
}

/**
 * The persistent SAFE MODE / read-only banner.
 *
 * It has to answer three questions without the operator digging: what is
 * locked, why, and what still works. It is rendered at the top of every step
 * panel while a lock is active, so no panel can look writable by accident.
 */
function lockBanner() {
  const info = safetyInfo();
  const lock = writesBlocked();
  const title = info.mscActive
    ? 'MSC 大容量模式 / MASS STORAGE · 写入不可用 / WRITES UNAVAILABLE'
    : info.readOnly
      ? '安全模式 / SAFE MODE · 只读 / READ-ONLY'
      : '安全模式 / SAFE MODE · 调参锁定 / TUNING LOCKED';

  const body = [
    el('div', { class: 'row' }, [
      info.mscActive ? badge('MSC 大容量 / mass-storage', 'warn') : null,
      badge(info.readOnly ? '只读 / READ-ONLY' : '仅记录可写 / LOGGING WRITABLE', info.readOnly ? 'crit' : 'warn'),
      info.tuningLockedReason ? badge('调参锁定 / TUNING LOCKED', 'crit') : null,
      info.unknownBoard && !info.forcedTrust ? badge('未知机型 / unknown board', 'crit') : null,
      info.forcedTrust ? badge('强制信任 / forced trust', 'warn') : null,
    ]),
    info.mscActive
      ? para('飞控已重启为 USB 大容量存储设备：MSP 链路不可用，本界面不会向飞控写入任何参数。请在挂载出来的卷上导入日志，然后「弹出并退出」并给飞控重新上电。')
      : para(
          info.readOnly
            ? '主进程已把本会话锁定为只读：界面不会向飞控写入任何参数，只保留读取与离线分析。'
            : '记录类写入已放行，但飞控飞行参数（PID / 滤波器）写入仍被锁定。',
        ),
    info.tuningLockedReason
      ? el('p', { class: 'hint crit', text: `调参锁定原因 / tuningLocked: ${info.tuningLockedReason}` })
      : null,
    info.reasons.length
      ? el('div', { class: 'chips' }, info.reasons.map((r) => chip(str(r), 'crit')))
      : null,
    el('ul', { class: 'evidence gate-list' }, [
      el('li', { text: '已禁用 / disabled：黑匣子配置写入、黑匣子擦除、手动 CLI 真实写入、tune.apply 写入、双向DShot/RPM 写入。' }),
      el('li', { text: '仍然可用 / still enabled：读取设置与 dump 备份、读取黑匣子配置、双向DShot/RPM 检测（只读）、.bbl 离线分析、tune.propose 建议生成。' }),
      el('li', { text: `飞控参数写入 / flight-parameter writes：${lock.blocked ? `已锁定（${lock.reason}）` : '当前允许，但仍需显式确认。'}` }),
    ]),
  ];

  if (canForceTrust()) body.push(forceTrustArea());

  return banner(info.mscActive ? 'warn' : info.readOnly ? 'crit' : 'warn', title, body);
}

/** Inline (never window.confirm) confirmation for the force-trust override. */
function forceTrustArea() {
  if (state.trust.confirm) {
    const confirmBtn = button('确认强制信任 / Confirm force trust', { variant: 'danger', size: 'sm' });
    action(confirmBtn, '强制信任并退出安全模式', async () => {
      const res = await run('强制信任', () => window.bf.safety.forceTrust());
      if (!res.ok) return;
      const out = res.value && typeof res.value === 'object' ? res.value : {};
      if (out.ok === false) {
        state.trust.error = str(out.reason);
        state.trust.confirm = false;
        appendLog(warnEntry(`强制信任被拒绝 / force trust refused：${state.trust.error}`, 'safety'));
        if (out.status) applySafetyPayload(out.status);
        renderAllSteps();
        return;
      }
      state.trust.error = '';
      state.trust.confirm = false;
      appendLog(warnEntry('已强制信任未知机型：记录/日志写入可用，飞控参数写入仍然锁定', 'safety'));
      await refreshSafety();
    });
    const cancelBtn = button('取消 / Cancel', { variant: 'ghost', size: 'sm' });
    action(cancelBtn, '取消强制信任', async () => {
      state.trust.confirm = false;
      renderAllSteps();
    });
    return el('div', { class: ['force-trust', 'banner', 'banner-warn'] }, [
      el('div', { class: 'banner-title', text: '确认强制信任？/ Confirm force trust' }),
      para('这会把「未知机型」的只读锁降级为「调参锁定」：黑匣子 / 日志配置重新可写，但 PID、滤波器等飞行参数写入仍然被禁止，直到安全边界另行放行。'),
      para('仅在你确认该机型与当前操作安全时使用。硬件故障锁存（电机失步、剧烈震动、陀螺削波、日志截断）无法被覆盖。'),
      state.trust.error ? el('p', { class: 'hint crit', text: `上次被拒绝 / refused：${state.trust.error}` }) : null,
      el('div', { class: 'row' }, [confirmBtn, cancelBtn]),
    ]);
  }

  const btn = button('强制信任并退出安全模式 / Force trust & leave SAFE MODE', { variant: 'danger', size: 'sm' });
  action(btn, '强制信任并退出安全模式', async () => {
    state.trust.confirm = true;
    renderAllSteps();
  });
  return el('div', { class: 'row force-trust' }, [
    btn,
    el('span', { class: 'hint warn', text: '高级覆盖 / advanced override：只解除「未知机型」只读；飞行参数写入保持锁定。' }),
    // A refused force-trust (latched hardware fault) must stay readable.
    state.trust.error ? el('span', { class: 'hint crit', text: `上次被拒绝 / refused：${state.trust.error}` }) : null,
  ]);
}

/* ================================================================== *
 * 9. Generic sortable table + confirm-with-diff dialog
 * ================================================================== */

/**
 * Generic sortable table used by the port list and the report history.
 *
 * opts: {
 *   columns: [{key, label, numeric?, render?(row), value?(row)}],
 *   rows: data[], getKey?(row), sort: {key, dir} (persistent, mutated in place),
 *   selected?(row) -> bool, onRowClick?(row), emptyText?
 * }
 */
function sortableTable(opts) {
  const columns = Array.isArray(opts.columns) ? opts.columns : [];
  const sort = opts.sort && typeof opts.sort === 'object' ? opts.sort : { key: null, dir: 1 };
  if (!sort.key || !columns.some((c) => c.key === sort.key)) {
    const first = columns[0];
    if (first) {
      sort.key = first.key;
      sort.dir = first.defaultDir ?? (first.numeric ? -1 : 1);
    }
  }

  const wrapper = el('div', { class: 'sortable-wrap' });
  const tbl = el('table', { class: ['tbl', opts.onRowClick ? 'tbl-click' : ''] });
  const thead = el('thead');
  const tbody = el('tbody');
  tbl.append(thead, tbody);

  const valueOf = (row, col) => (typeof col.value === 'function' ? col.value(row) : row?.[col.key]);

  const paintHead = () => {
    setChildren(thead, [
      el('tr', {}, columns.map((col) => {
        const active = sort.key === col.key;
        const btn = el('button', {
          class: ['th-sort', col.numeric ? 'num' : ''],
          type: 'button',
          attrs: {
            scope: 'col',
            'aria-sort': active ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined,
          },
        }, [
          el('span', { text: col.label }),
          el('span', { class: 'th-arrow mono-num', text: active ? (sort.dir > 0 ? '▲' : '▼') : '', attrs: { 'aria-hidden': 'true' } }),
        ]);
        btn.addEventListener('click', () => {
          if (sort.key === col.key) sort.dir = -sort.dir;
          else {
            sort.key = col.key;
            sort.dir = col.defaultDir ?? (col.numeric ? -1 : 1);
          }
          paintHead();
          paintBody();
        });
        return el('th', {}, [btn]);
      })),
    ]);
  };

  const paintBody = () => {
    const rows = Array.isArray(opts.rows) ? [...opts.rows] : [];
    const col = columns.find((c) => c.key === sort.key) || columns[0];
    if (col) {
      rows.sort((a, b) => {
        const av = valueOf(a, col);
        const bv = valueOf(b, col);
        const an = num(av);
        const bn = num(bv);
        if (an !== null && bn !== null) return (an - bn) * sort.dir;
        if (av === null || av === undefined || av === '') return 1;
        if (bv === null || bv === undefined || bv === '') return -1;
        return String(av).localeCompare(String(bv), 'zh-CN', { numeric: true, sensitivity: 'base' }) * sort.dir;
      });
    }
    if (!rows.length) {
      setChildren(tbody, [
        el('tr', {}, [el('td', { class: 'hint', attrs: { colspan: String(columns.length) }, text: opts.emptyText || '（空）' })]),
      ]);
      return;
    }
    setChildren(tbody, rows.map((row) => {
      const key = opts.getKey ? String(opts.getKey(row) ?? '') : '';
      const tr = el('tr', {
        class: [opts.onRowClick ? 'is-selectable' : '', opts.selected && opts.selected(row) ? 'is-selected' : ''],
        data: opts.getKey ? { key } : undefined,
      });
      if (opts.onRowClick) {
        tr.setAttribute('tabindex', '0');
        tr.addEventListener('click', () => opts.onRowClick(row));
        tr.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            opts.onRowClick(row);
          }
        });
      }
      for (const col of columns) {
        const cell = typeof col.render === 'function' ? col.render(row) : row?.[col.key];
        tr.append(el('td', { class: col.numeric ? 'num' : '' }, [cell]));
      }
      return tr;
    }));
  };

  paintHead();
  paintBody();
  wrapper.append(tbl);
  return wrapper;
}

/**
 * Confirm-with-diff dialog: the single confirmation surface for every real
 * flight-controller write (bb.config real write, bb.erase, manual CLI real
 * write, tune.apply phase 2, applyBidir phase 2).
 *
 * The confirm button starts disabled and is only armed in a microtask after
 * the modal (including its diff table) has actually been rendered into the
 * document. onConfirm resolves -> close; rejects -> the error stays in the
 * dialog and it remains open.
 */
function confirmDiffDialog(opts = {}) {
  const diff = Array.isArray(opts.diff) ? opts.diff : [];
  const errLine = el('p', { class: 'hint crit', hidden: true, attrs: { 'aria-live': 'polite' } });

  const confirmBtn = el('button', { class: ['btn', 'btn-danger'], type: 'button', text: opts.confirmLabel || '确认写入 / Confirm write', disabled: true });
  const cancelBtn = el('button', { class: ['btn', 'btn-ghost'], type: 'button', text: '取消 / Cancel' });

  const modalBody = [
    opts.note ? el('p', { class: 'modal-body', attrs: { id: 'confirm-dialog-body' }, text: opts.note }) : null,
    opts.body || diff.length
      ? el('div', { class: 'modal-diff' }, [opts.body ? opts.body : null, diff.length ? diffTable(diff) : null])
      : null,
    opts.warning ? el('p', { class: 'hint warn', text: opts.warning }) : null,
    errLine,
    el('div', { class: 'modal-actions' }, [cancelBtn, confirmBtn]),
  ];

  const modal = el('div', {
    class: ['modal', 'modal-confirm'],
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'confirm-dialog-title' },
  }, [
    el('h2', { class: 'modal-title', attrs: { id: 'confirm-dialog-title' }, text: opts.title || '确认写入 / Confirm write' }),
    ...modalBody,
  ]);

  const backdrop = el('div', { class: 'modal-backdrop', attrs: { id: 'confirm-dialog' } }, [modal]);

  let closed = false;
  let busy = false;

  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    if (state.confirmDialog === dialog) state.confirmDialog = null;
  }

  function onKey(ev) {
    if (ev.key === 'Escape') close();
  }

  const dialog = {
    backdrop,
    modal,
    confirmBtn,
    rendered: { done: false },
    close,
    get isOpen() {
      return !closed;
    },
  };
  state.confirmDialog = dialog;

  confirmBtn.addEventListener('click', () => {
    if (confirmBtn.disabled || busy) return;
    busy = true;
    errLine.hidden = true;
    Promise.resolve()
      .then(() => (typeof opts.onConfirm === 'function' ? opts.onConfirm() : null))
      .then(() => close())
      .catch((err) => {
        errLine.textContent = `写入失败 / write failed：${errMessage(err)}`;
        errLine.hidden = false;
        appendLog(errorEntry(`确认写入失败：${errMessage(err)}`));
      })
      .finally(() => {
        busy = false;
      });
  });

  cancelBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);

  document.body.append(backdrop);

  // The confirm button must not arm until the diff table has actually been
  // rendered into the document.
  queueMicrotask(() => {
    if (closed) return;
    dialog.rendered.done = true;
    confirmBtn.disabled = false;
    confirmBtn.focus();
  });

  return dialog;
}

/* ================================================================== *
 * 10. Safety status bar
 * ================================================================== */

let safetyPending = false;
let safetyQueued = false;

/**
 * Adopt a safety payload without rendering.
 *
 * `bf.safety.status()` resolves to the *session* status - safety nested under
 * `.safety`, link health at the top level - while `safety.ack()` and
 * `safety.forceTrust()` resolve to the guard status directly. Accept both, so a
 * read-only latch can never be read as `undefined` and painted as writable.
 */
function applySafetyPayload(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const s = src.safety && typeof src.safety === 'object' ? src.safety : src;
  if (
    typeof s.readOnly === 'boolean' ||
    Array.isArray(s.reasons) ||
    typeof s.forcedTrust === 'boolean' ||
    s.tuningLocked !== undefined
  ) {
    state.safety = {
      readOnly: typeof s.readOnly === 'boolean' ? s.readOnly : state.safety.readOnly,
      reasons: Array.isArray(s.reasons) ? s.reasons.map(String) : state.safety.reasons,
      backupDone: typeof s.backupDone === 'boolean' ? s.backupDone : state.safety.backupDone,
      backupPath: s.backupPath === undefined ? state.safety.backupPath : s.backupPath ?? null,
      roundsUsed: num(s.roundsUsed) ?? state.safety.roundsUsed,
      maxRounds: num(s.maxRounds) ?? state.safety.maxRounds,
      forbiddenParams: Array.isArray(s.forbiddenParams) ? s.forbiddenParams.map(String) : state.safety.forbiddenParams,
      forcedTrust: typeof s.forcedTrust === 'boolean' ? s.forcedTrust : state.safety.forcedTrust,
      tuningLocked: s.tuningLocked === undefined ? state.safety.tuningLocked : s.tuningLocked ? String(s.tuningLocked) : null,
    };
  }
  if (typeof src.linkState === 'string' || typeof src.linkHealthy === 'boolean' || num(src.recoveries) !== null) {
    state.link = {
      ...state.link,
      linkState: typeof src.linkState === 'string' ? src.linkState : state.link.linkState,
      linkHealthy: typeof src.linkHealthy === 'boolean' ? src.linkHealthy : state.link.linkHealthy,
      recoveries: num(src.recoveries) ?? state.link.recoveries,
    };
  }
}

/** Re-read the authoritative safety state, then repaint every panel and the bar. */
async function refreshSafety() {
  if (safetyPending) {
    safetyQueued = true; // coalesce, but never lose a request
    return;
  }
  safetyPending = true;
  try {
    do {
      safetyQueued = false;
      const res = await run('读取安全状态', () => window.bf.safety.status());
      if (!res.ok) return;
      applySafetyPayload(res.value);
      applyConnectionFlag(res.value?.connected);
      state.link.checkedAt = Date.now();
      renderAllSteps();
    } while (safetyQueued);
  } finally {
    safetyPending = false;
  }
}

function ackButton() {
  const btn = button('确认安全提示 / Acknowledge', { variant: 'ghost', size: 'sm' });
  action(btn, '确认安全提示', async () => {
    const res = await run('确认安全提示', () => window.bf.safety.ack());
    if (res.ok) applySafetyPayload(res.value);
    appendLog(infoEntry('已确认安全提示', 'safety'));
    await refreshSafety();
  });
  return btn;
}

const LINK_LABEL = { msp: '链路 MSP 正常 / link ok', recovering: '链路恢复中 / recovering', down: '链路断开 / link down' };

function linkChip() {
  const l = state.link;
  const tone = l.linkState === 'msp' ? 'ok' : l.linkState === 'recovering' ? 'warn' : 'crit';
  const bits = [LINK_LABEL[l.linkState] || `链路 ${str(l.linkState)}`];
  if (num(l.latencyMs) !== null) bits.push(`${fmtInt(l.latencyMs)} ms`);
  if (num(l.recoveries) > 0) bits.push(`恢复 ${fmtInt(l.recoveries)} 次`);
  const node = chip(bits.join(' · '), tone, state.link.checkedAt ? `最近检查：${fmtClock(state.link.checkedAt)}` : '尚未探测链路 / link not probed yet');
  node.setAttribute('id', 'sb-link');
  return node;
}

/** Connect-page status light tone: green only when MSP is up AND connected. */
function linkLightTone() {
  if (state.link.linkState === 'msp' && state.connected) return 'ok';
  if (state.link.linkState === 'recovering') return 'warn';
  return 'crit';
}

function autoDebugLabel() {
  const a = state.autoDebug;
  if (a.running) return `AI 自动调试 #${a.iteration} 运行中 / running`;
  if (a.finished) return 'AI 自动调试 已稳定 ✓ / link stable';
  return 'AI 自动调试循环 / Auto-debug loop';
}

function autoDebugTone() {
  const a = state.autoDebug;
  if (a.running) return a.phase === 'reconnecting' || a.phase === 'retrying' ? 'warn' : 'info';
  if (a.finished) return 'ok';
  return 'idle';
}

/** Status-bar copy of the auto-debug toggle (the connect-page card has the labelled one). */
function autoDebugChip() {
  const node = el('button', {
    class: ['chip', 'chip-btn', `chip-${autoDebugTone()}`],
    type: 'button',
    text: autoDebugLabel(),
    attrs: { id: 'sb-autodebug', 'aria-pressed': String(state.autoDebug.on) },
  });
  node.title = state.autoDebug.lastOutcome || 'AI 自动调试循环：点击开启 / 关闭';
  node.addEventListener('click', () => toggleAutoDebugLoop('状态栏开关'));
  return node;
}

function renderStatusBar() {
  paintStateBar(); // the session state bar sits above the panels and tracks the same state
  const host = $('#sb-safety');
  if (!host) return;
  const s = state.safety;
  const info = safetyInfo();
  const roundsFull = s.maxRounds > 0 && s.roundsUsed >= s.maxRounds;
  const pillText = info.readOnly
    ? '只读 / READ-ONLY'
    : info.tuningLockedReason
      ? '仅记录可写 / LOGGING ONLY'
      : '可写 / WRITABLE';
  const pillTone = info.readOnly ? 'crit' : info.tuningLockedReason ? 'warn' : 'ok';

  setChildren(host, [
    pill(pillText, pillTone),
    chip(`备份 ${s.backupDone ? '已完成' : '未完成'}`, s.backupDone ? 'ok' : 'warn', s.backupPath ? `备份路径：${s.backupPath}` : '尚未生成完整 dump 备份（写入前置条件）'),
    chip(`写入轮次 ${fmtInt(s.roundsUsed)} / ${fmtInt(s.maxRounds)}`, roundsFull ? 'warn' : 'idle', '每会话最多写入一次（MAX_TUNE_ROUNDS）'),
    chip(`禁止参数 ${s.forbiddenParams.length}`, s.forbiddenParams.length ? 'info' : 'idle', s.forbiddenParams.join('\n')),
    linkChip(),
    autoDebugChip(),
    info.tuningLockedReason ? chip('调参锁定 / TUNING LOCKED', 'crit', info.tuningLockedReason) : null,
    info.forcedTrust ? chip('强制信任 / forced trust', 'warn', '未知机型已被操作员强制信任；飞行参数写入仍然锁定') : null,
    s.reasons.length
      ? el('span', { class: 'sb-reasons' }, [el('span', { class: 'sb-k', text: '原因 / reasons:' }), ...s.reasons.map((r) => chip(str(r), 'crit'))])
      : null,
    !info.readOnly && info.loggingBlocked ? chip(info.loggingReasons.join('；'), 'warn') : null,
    info.readOnly ? ackButton() : null,
  ]);

  const foot = $('#rail-foot');
  if (foot) {
    foot.textContent = info.readOnly
      ? `只读：${info.loggingReasons.join('；') || '会话已锁定写入'}`
      : info.tuningLockedReason
        ? `调参锁定：${info.tuningLockedReason}`
        : 'dry-run 为默认；任何写入都需要显式确认。';
  }
  refreshGuards(); // the ack + auto-debug buttons are created here and must be enabled immediately
  paintAutoDebug();
}

/* ---------------- session state bar (top of the main content area) ---------------- */

/**
 * One state-bar slot: a status light (aviation LED), its bilingual label and the
 * observed value. `idle` is the honest "not known yet" rendering - a slot is
 * only ever green when the underlying state actually says so.
 */
function statebarStep(label, en, tone, value, title) {
  const node = el('span', { class: ['statebar-step', tone === 'idle' ? 'is-idle' : ''], data: { key: en } }, [
    statusLight(tone, `${label} / ${en}`),
    el('span', { class: 'statebar-k', text: `${label} / ${en}` }),
    el('span', { class: 'statebar-v mono-num', text: str(value) }),
  ]);
  if (title) node.title = title;
  return node;
}

/** Blackbox sample rate as last observed live (bf.bb.readConfig) or from capabilities. */
function observedBbRate() {
  const live = num(state.bb.live?.actualRateHz);
  if (live !== null) return live;
  const caps = state.capabilities;
  const bb = caps?.blackbox && typeof caps.blackbox === 'object' ? caps.blackbox : null;
  const loop = loopRateHz(caps);
  const n = num(bb?.rateNum);
  const d = num(bb?.rateDenom);
  if (loop !== null && n !== null && d) return (loop * n) / d;
  return null;
}

/** Latest applied proposal id, used as the baseline for bf.tune.evaluate(). */
function lastAppliedProposalId() {
  const ids = [...state.applied];
  return ids.length ? ids[ids.length - 1] : null;
}

/**
 * The session state bar: eleven ordered slots a pilot can scan in one look.
 *
 * Every slot is driven by state the renderer already holds; a slot whose source
 * has not been read yet stays idle rather than guessing a value.
 */
function paintStateBar() {
  const host = $('#statebar');
  if (!host) return;

  const id = state.identity;
  const caps = state.capabilities;
  const probe = state.bidir.probe;
  const msc = state.msc.status;
  const rollback = state.evaluate.result?.rolledBack ? '已回退 / rolled back' : null;
  const appliedCount = state.applied.size;
  const appliedAny = appliedCount > 0;
  const lastRollback = state.backup.lastRollback;

  // 1) link
  const linkTone = !state.connected ? 'idle' : state.link.linkState === 'recovering' ? 'warn' : 'ok';
  const linkValue = state.connected ? state.port || 'connected' : '未连接 / off';

  // 2) model
  const modelTone = id ? (id.known ? 'ok' : 'crit') : 'idle';
  const modelValue = id ? id.boardName || id.variant || id.targetName || '—' : '未识别 / unknown';

  // 3) main loop
  const loop = loopRateHz(caps);
  const loopTone = caps ? (loop !== null ? 'ok' : 'idle') : 'idle';

  // 4) bidirectional DShot: live probe first, capability snapshot second
  const bidirKnown = typeof probe?.bidirOn === 'boolean' ? probe.bidirOn : typeof caps?.bidirDshot === 'boolean' ? caps.bidirDshot : null;
  const bidirTone = bidirKnown === null ? 'idle' : bidirKnown ? 'ok' : 'warn';

  // 5) RPM filter / rpm telemetry
  const rpmKnown = typeof caps?.rpmFilterActive === 'boolean' ? caps.rpmFilterActive : probe ? Boolean(probe?.rpmFilter) : null;
  const rpmTone = rpmKnown === null ? 'idle' : rpmKnown ? 'ok' : 'warn';

  // 6) blackbox 2k: only a read rate can turn this slot green
  const bbRate = observedBbRate();
  const bbTone = bbRate === null ? 'idle' : Math.abs(bbRate - REQUESTED_BB_RATE_DEFAULT) / REQUESTED_BB_RATE_DEFAULT <= SAMPLE_RATE_TOLERANCE ? 'ok' : 'warn';

  // 7) backup
  const backupTone = state.safety.backupDone ? 'ok' : state.connected ? 'warn' : 'idle';

  // 8) fly now: a write landed and this flight has not been evaluated yet
  const flyTone = appliedAny && !state.evaluate.result ? 'warn' : 'idle';

  // 9) log read: metrics are in hand (offline analysis needs no connection)
  const logTone = state.metrics ? 'ok' : state.file ? 'warn' : 'idle';

  // 10) analysing
  const busyTone = state.analysis.busy ? 'warn' : 'idle';

  // 11) written / rolled back
  const writeTone = appliedAny ? 'ok' : lastRollback || rollback ? 'warn' : 'idle';

  setChildren(host, [
    statebarStep('已连接', 'Link', linkTone, linkValue, LINK_LABEL[state.link.linkState] || str(state.link.linkState)),
    statebarStep('型号', 'Model', modelTone, modelValue, id ? `matchLevel: ${str(id.matchLevel)} · 置信度 ${fmtRatio(clamp01(id.confidence))}` : '尚未识别飞控 / not identified yet'),
    statebarStep('主循环', 'Loop', loopTone, loop === null ? '—' : fmtHz(loop), '来自能力探测 bf.fc.capabilities() / pidLooptimeUs'),
    statebarStep('双向DShot', 'Bidir', bidirTone, bidirKnown === null ? '—' : bidirKnown ? 'ON' : 'OFF', 'bf.fc.bidir() 检测或能力探测结果'),
    statebarStep('RPM', 'RPM', rpmTone, rpmKnown === null ? '—' : rpmKnown ? 'ON' : 'OFF', 'RPM 滤波 / 遥测状态'),
    statebarStep('黑匣子2k', 'Blackbox', bbTone, bbRate === null ? '—' : fmtHz(bbRate), `目标 ${REQUESTED_BB_RATE_DEFAULT} Hz，容差 ±${(SAMPLE_RATE_TOLERANCE * 100).toFixed(0)}%`),
    statebarStep('已备份', 'Backup', backupTone, state.safety.backupDone ? '已完成 / yes' : '未完成 / no', state.safety.backupPath ? `备份路径：${state.safety.backupPath}` : '写入前置条件：完整 dump 备份'),
    statebarStep('请飞行', 'Fly', flyTone, appliedAny ? '待复飞 / re-fly' : '—', '已写入调参：复飞后再做评估 / fly the change, then evaluate'),
    statebarStep('已读日志', 'Log', logTone, state.metrics ? '已分析 / analysed' : state.file ? '已选择 / picked' : '—', str(state.file)),
    statebarStep('分析中', 'Analysing', busyTone, state.analysis.busy ? '运行中 / running' : '—', '离线分析 bbl.metrics / bbl.fft'),
    statebarStep(
      '已写参或已回退',
      'Written',
      writeTone,
      appliedAny ? `已写参 ×${fmtInt(appliedCount)}` : lastRollback || rollback ? '已回退 / rolled back' : '—',
      lastRollback?.reportPath ? `回退报告：${lastRollback.reportPath}` : '本会话是否已写入或回退过调参',
    ),
  ]);
  if (msc) host.classList.toggle('is-msc', Boolean(msc.inMsc));
}

function showOpProgress(message, ratio) {
  const wrap = $('#sb-op');
  const msg = $('#sb-op-msg');
  const fill = $('#sb-op-fill');
  const bar = fill?.parentElement;
  if (!wrap || !msg || !fill || !bar) return;
  if (message === null) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  msg.textContent = message;
  const known = ratio !== null && ratio !== undefined;
  fill.style.setProperty('width', known ? `${(clamp01(ratio) * 100).toFixed(1)}%` : '40%');
  bar.setAttribute('aria-valuenow', known ? String(Math.round(clamp01(ratio) * 100)) : '0');
  bar.classList.toggle('meter-warn', !known);
}

/* ================================================================== *
 * 11. Pushed events
 * ================================================================== */

function handleEvent(raw) {
  const evt = appendLog(raw);
  switch (evt.kind) {
    case 'download-progress':
      applyDownloadProgress(evt);
      break;
    case 'progress':
      showOpProgress(evt.message || '进行中…', progressRatio(evt.data));
      break;
    case 'safety':
      // Push the payload straight into the UI, then confirm against the main
      // process. Waiting for the round trip alone used to leave the bar stale.
      applySafetyPayload(evt.data);
      renderAllSteps();
      refreshSafety();
      break;
    case 'state':
      applyStateEvent(evt.data);
      break;
    default:
      break;
  }
  if (evt.level === 'fatal') refreshSafety();
}

/** Progress payload keys differ per emitter; read defensively, never invent. */
function progressRatio(data) {
  if (!data || typeof data !== 'object') return null;
  const pairs = [
    [data.received, data.total],
    [data.bytes, data.totalBytes],
    [data.loaded, data.total],
    [data.done, data.total],
  ];
  for (const [a, b] of pairs) {
    const x = num(a);
    const y = num(b);
    if (x !== null && y !== null && y > 0) return Math.min(1, x / y);
  }
  const p = num(data.pct ?? data.percent ?? data.progress);
  if (p !== null) return Math.min(1, p > 1 ? p / 100 : p);
  return null;
}

function applyDownloadProgress(evt) {
  const ratio = progressRatio(evt.data);
  state.download.progress = ratio;
  state.download.message = evt.message || state.download.message;
  const bar = refs.downloadBar;
  const fill = bar ? $('.meter-fill', bar) : null;
  if (bar && fill && bar.isConnected) {
    fill.style.setProperty('width', ratio === null ? '40%' : `${(clamp01(ratio) * 100).toFixed(1)}%`);
    bar.setAttribute('aria-valuenow', ratio === null ? '0' : String(Math.round(clamp01(ratio) * 100)));
  }
  const msg = refs.downloadMsg;
  if (msg && msg.isConnected) msg.textContent = evt.message || '下载中…';
  showOpProgress(evt.message || '下载日志…', ratio);
}

/** Adopt the connection flag, tearing down connection-scoped state on loss. */
function applyConnectionFlag(connected) {
  if (typeof connected !== 'boolean' || connected === state.connected) return false;
  state.connected = connected;
  if (connected) {
    state.done.add(0);
  } else {
    resetConnectionScopedState();
    stopAutoDebugLoop('飞控已断开 / disconnected');
  }
  return true;
}

/**
 * `state` events carry the whole session snapshot: connection, safety, identity
 * and capabilities. Every one of those changes what the step panels may do, so
 * the panels and the status bar are rebuilt together.
 */
function applyStateEvent(data) {
  if (!data || typeof data !== 'object') return;
  let needsRender = applyConnectionFlag(data.connected);
  if (typeof data.port === 'string' && data.port) state.port = data.port;
  if (data.identity && typeof data.identity === 'object') {
    state.identity = data.identity;
    needsRender = true;
  }
  if (data.safety && typeof data.safety === 'object') {
    applySafetyPayload(data.safety);
    needsRender = true;
  }
  if (!state.connected) state.link = { ...state.link, linkState: 'down', linkHealthy: false, latencyMs: null };
  if (needsRender) renderAllSteps();
}

function subscribeEvents() {
  try {
    const off = window.bf.on(handleEvent);
    if (typeof off === 'function') state.unsubscribe = off;
  } catch (err) {
    appendLog(errorEntry(`订阅事件失败：${errMessage(err)}`));
  }
}

/* ================================================================== *
 * 12. Steps: navigation
 * ================================================================== */

const STEPS = [
  { id: 'connect', render: renderConnect, canEnter: () => true },
  { id: 'analysis', render: renderAnalysis, canEnter: () => true },
  { id: 'history', render: renderHistory, canEnter: () => true },
];

function goStep(index) {
  if (!window.bf) return;
  const step = STEPS[index];
  if (!step) return;
  if (!step.canEnter()) {
    appendLog(warnEntry(`无法进入「${index + 1}」：需要先连接飞控`));
    return;
  }
  showStep(index);
}

function showStep(index) {
  state.step = index;
  for (let i = 0; i < STEPS.length; i += 1) {
    const panel = $(`#panel-${i}`);
    if (panel) panel.hidden = i !== index;
  }
  // The history page loads its list on entry (once per entry, coalesced).
  if (index === 2) {
    loadHistoryList();
    loadJournalList();
  }
  renderStep(index);
  const title = $(`#step-title-${index}`);
  if (title) title.focus({ preventScroll: true });
}

/** Repaint one panel body (plus its SAFE MODE banner and step navigation). */
function renderStepBody(index) {
  const body = $(`#body-${index}`);
  const step = STEPS[index];
  if (!body || !step) return;
  setChildren(body, []);
  if (safetyInfo().bannerVisible) body.append(lockBanner());
  step.render(body);
  body.append(panelNav(index));
}

/**
 * Repaint every step panel, the rail and the status bar.
 *
 * Used whenever the safety state changes: a lock added while step 6 is open
 * must also lock the buttons that step 4 will show a moment later, and the bar
 * must never disagree with the panel below it.
 */
function renderAllSteps() {
  for (let i = 0; i < STEPS.length; i += 1) renderStepBody(i);
  refreshGuards();
  updateRail();
  renderStatusBar();
}

function renderStep(index) {
  renderStepBody(index);
  refreshGuards();
  updateRail();
  renderStatusBar(); // the safety bar depends on identity too (SAFE MODE), not only on safety.status()
  const title = $(`#step-title-${index}`);
  if (title) title.focus({ preventScroll: true });
  if (state.focusConfirm) {
    const wanted = state.focusConfirm;
    state.focusConfirm = null;
    const node = $$('[data-confirm]').find((n) => n.dataset.confirm === wanted);
    if (node) node.focus();
  }
}

function panelNav(index) {
  const prev = button('← 上一步 / Prev', { variant: 'ghost', enabled: () => index > 0 });
  action(prev, '上一步', async () => showStep(index - 1));
  const next = STEPS[index + 1];
  const nextBtn = button('下一步 / Next →', { variant: 'primary', enabled: () => Boolean(next) && next.canEnter() });
  if (next && !next.canEnter()) nextBtn.title = '需要先连接飞控 / connect first';
  action(nextBtn, '下一步', async () => {
    if (!next) return;
    if (!next.canEnter()) {
      appendLog(warnEntry('需要先连接飞控才能继续 / connect the FC first'));
      return;
    }
    showStep(index + 1);
  });
  return el('div', { class: 'steps-nav' }, [prev, nextBtn]);
}

function updateRail() {
  for (const btn of $$('.rail .step')) {
    const index = Number(btn.dataset.step);
    const step = STEPS[index];
    if (!step) continue;
    const locked = !step.canEnter();
    btn.disabled = locked || !window.bf;
    btn.classList.toggle('is-current', index === state.step);
    btn.classList.toggle('is-done', state.done.has(index));
    btn.classList.toggle('is-locked', locked);
    if (index === state.step) btn.setAttribute('aria-current', 'step');
    else btn.removeAttribute('aria-current');
    const mark = $('.step-mark', btn);
    if (mark) mark.textContent = state.done.has(index) ? '✓' : index === state.step ? '●' : locked ? '○' : '·';
  }
}

/* ================================================================== *
 * 13. Page 0 — connect
 * ================================================================== */

function portsTable() {
  const columns = [
    {
      key: 'device',
      label: '设备 / device',
      render: (p) => el('span', { class: 'mono-num', text: String(p?.preferredPath || p?.path || '') }),
      value: (p) => String(p?.preferredPath || p?.path || ''),
    },
    { key: 'manufacturer', label: '制造商 / manufacturer', render: (p) => str(p?.manufacturer), value: (p) => String(p?.manufacturer || '') },
    { key: 'serialNumber', label: '序列号 / SN', render: (p) => str(p?.serialNumber), value: (p) => String(p?.serialNumber || '') },
    {
      key: 'vidpid',
      label: 'VID:PID',
      render: (p) => (p?.vendorId || p?.productId ? el('span', { class: 'mono-num', text: `${p?.vendorId || '?'}:${p?.productId || '?'}` }) : '—'),
      value: (p) => String(p?.vendorId || ''),
    },
    {
      key: 'likelyFc',
      label: '疑似飞控 / likely FC',
      numeric: true,
      render: (p) => (p?.likelyFc ? badge('★ 是 / yes', 'ok') : badge('—', 'idle')),
      value: (p) => (p?.likelyFc ? 1 : 0),
    },
  ];
  return sortableTable({
    columns,
    rows: state.ports,
    getKey: (p) => String(p?.preferredPath || p?.path || ''),
    sort: state.portsSort,
    selected: (p) => String(p?.preferredPath || p?.path || '') === String(state.port),
    onRowClick: (p) => {
      state.port = String(p?.preferredPath || p?.path || '');
      appendLog(infoEntry(`已选择串口 ${state.port}`, 'state'));
      renderStep(state.step);
    },
    emptyText: '未发现串口 — 点击刷新 / no port found',
  });
}

async function loadPorts() {
  const res = await run('列出串口', () => window.bf.ports.list());

  // ports.list() resolves to { ports, error } - NOT a bare array. Requiring an
  // array here silently produced an empty dropdown even when the main process
  // had found ports, so accept both shapes and surface the error field.
  const payload = res.ok ? res.value : null;
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.ports) ? payload.ports : [];

  state.ports = list;
  // Match the dropdown behaviour of the previous UI: preselect the first
  // likely FC (else the first port) until the operator picks one explicitly.
  if (!state.port && list.length) {
    const likely = list.find((p) => p?.likelyFc) || list[0];
    state.port = String(likely?.preferredPath || likely?.path || '');
  }
  const fcCount = list.filter((p) => p?.likelyFc).length;
  if (res.ok) appendLog(infoEntry(`发现 ${list.length} 个串口，其中 ${fcCount} 个疑似飞控`, 'state'));
  if (payload && payload.error) appendLog(warnEntry(`串口枚举失败：${payload.error}`));
  renderStep(state.step);
}

function setPortsAutoRefresh(on) {
  state.portsAuto.on = Boolean(on);
  if (state.portsAuto.timerId !== null) {
    window.clearInterval(state.portsAuto.timerId);
    state.portsAuto.timerId = null;
  }
  if (state.portsAuto.on) {
    state.portsAuto.timerId = window.setInterval(() => {
      if (state.portsAuto.on) loadPorts();
    }, 5000);
  }
}

function resetConnectionScopedState() {
  state.identity = null;
  state.capabilities = null;
  state.settings = null;
  state.pid = null;
  state.filter = null;
  state.metrics = null;
  state.proposals = [];
  state.apply = {};
  state.download = { busy: false, progress: null, message: '', path: null, logs: [] };
  state.done.clear();
  state.capture.elapsedMs = 0;
  state.bb.fieldsInit = false;
  state.bb.lastDiff = null;
  state.bb.armed = false;
  state.bb.liveAutoTried = false;
  state.bidir = { probe: null, busy: false, history: {}, apply: null };
  state.fft.data = null;
  // MSC / backup / evaluation are connection-scoped too: a volume mounted by the
  // previous session (or a backup list) must not be shown as if it were current.
  state.msc = { status: null, busy: false, tried: false, selected: new Set(), lastImport: null, message: '' };
  state.backup = { list: [], loading: false, loaded: false, note: '', lastRollback: null };
  state.evaluate = { busy: false, result: null, error: '' };
  state.analysis.busy = false;
}

function renderConnect(body) {
  const fcCount = state.ports.filter((p) => p?.likelyFc).length;

  const refreshBtn = button('刷新端口 / Refresh', { variant: 'ghost' });
  action(refreshBtn, '刷新端口', loadPorts);

  const autoBox = el('input', { type: 'checkbox', id: 'ports-auto', checked: state.portsAuto.on });
  autoBox.addEventListener('change', () => setPortsAutoRefresh(autoBox.checked));

  const connectBtn = button(state.connected ? '重新连接' : '连接 / Connect', {
    variant: 'primary',
    enabled: () => !state.connected,
  });
  action(connectBtn, '连接飞控', async () => {
    const port = state.port;
    if (!port) throw new Error('请先选择串口');
    state.connecting = true;
    showOpProgress(`连接 ${port} …`, null);
    const res = await run(`连接 ${port}`, () => window.bf.fc.connect(port));
    showOpProgress(null);
    state.connecting = false;
    if (!res.ok) {
      renderStep(state.step);
      return;
    }
    state.connected = true;
    state.port = port;
    state.done.add(0);
    appendLog(infoEntry(`已连接 ${port}，自动执行飞控准备…`, 'state'));
    await refreshSafety();
    renderStep(state.step);
    // Auto-run the read-only pre-flight chain (identify → settings+backup →
    // bidir probe → blackbox read) the moment the link is up. This replaces the
    // old "walk three pages and press six buttons" flow with "plug in and wait".
    runPrepareAll();
  });

  const disconnectBtn = button('断开 / Disconnect', { variant: 'ghost', enabled: () => state.connected });
  action(disconnectBtn, '断开飞控', async () => {
    const res = await run('断开连接', () => window.bf.fc.disconnect());
    if (!res.ok) return;
    state.connected = false;
    resetConnectionScopedState();
    stopAutoDebugLoop('操作员断开连接 / disconnected');
    appendLog(infoEntry('已断开连接，下游数据已清空', 'state'));
    await refreshSafety();
    renderStep(state.step);
  });

  const linkTone = linkLightTone();
  const statusPill = pill(
    state.connecting ? '连接中 / connecting' : state.connected ? `已连接 ${state.port ?? ''}` : '未连接 / disconnected',
    state.connecting ? 'warn' : state.connected ? 'ok' : 'idle',
  );

  body.append(
    card(
      '串口 / Serial port',
      [
        portsTable(),
        el('p', {
          class: 'hint',
          text: `${state.ports.length} 个端口，${fcCount} 个疑似飞控（STM32 / CP210x / CH340 / FTDI）· 设备列显示 macOS 首选路径 /dev/cu.*（preferredPath）`,
        }),
        el('div', { class: 'row' }, [
          refreshBtn,
          autoBox,
          el('label', { for: 'ports-auto', text: '自动刷新（5 s）/ auto-refresh' }),
          connectBtn,
          disconnectBtn,
        ]),
        el('div', { class: 'row' }, [
          el('span', { class: 'hint', text: '连接状态 / status:' }),
          statusLight(linkTone, LINK_LABEL[state.link.linkState] || str(state.link.linkState)),
          statusPill,
        ]),
        kvGrid([
          kv('波特率 / baud', MSP_BAUD),
          kv('链路 / link', LINK_LABEL[state.link.linkState] || str(state.link.linkState)),
          kv(
            '识别置信度 / identity confidence',
            state.identity ? el('span', { class: 'mono-num', text: fmtRatio(clamp01(state.identity.confidence)) }) : '尚未识别',
          ),
        ]),
        el('p', {
          class: 'hint',
          text: '本步骤只读：不会写入任何参数。连接成功后会自动识别飞控、读取设置并备份、检测双向 DShot、读取黑匣子配置。',
        }),
      ],
      { badges: [badge('只读 / read-only', 'ok'), badge('115200', 'info')] },
    ),
  );

  // Once linked, the connect page carries the whole pre-flight status: the
  // auto-run summary plus the read-only detail cards (identity / bidir /
  // blackbox / 2 kHz write / rollback).
  if (state.connected) {
    // One-shot MSC status probe on link (read-only, works in SAFE MODE).
    if (!state.msc.tried) {
      state.msc.tried = true;
      refreshMscStatus({ silent: true });
    }
    body.append(autoPrepareCard());
    renderPrepareCards(body);
  }

  body.append(autoDebugCard(), card('主机环境 / Host', [el('div', { class: 'kv-grid', id: 'host-info' }, [el('p', { class: 'hint', text: '读取中…' })])]));
  loadHostInfo();
}

function autoDebugCard() {
  const box = el('input', { type: 'checkbox', id: 'auto-debug', checked: state.autoDebug.on });
  box.addEventListener('change', () => toggleAutoDebugLoop(box.checked ? '连接页开关开启' : '连接页开关关闭'));
  const stopBtn = el('button', { class: ['btn', 'btn-ghost', 'btn-sm'], type: 'button', text: '停止循环 / Stop', attrs: { id: 'auto-debug-stop' } });
  stopBtn.addEventListener('click', () => stopAutoDebugLoop('操作员手动停止 / stopped by operator'));
  return card(
    'AI 自动调试循环 / Auto-debug loop',
    [
      el('div', { class: 'row' }, [
        box,
        el('label', { for: 'auto-debug', text: 'AI 自动调试循环 / Auto-debug loop' }),
        stopBtn,
      ]),
      el('p', { class: 'hint', attrs: { id: 'auto-debug-hint' }, text: autoDebugHint() }),
      el('ul', { class: 'evidence' }, [
        el('li', { text: '每轮先 ping（一次 MSP 往返）；失败则 bf.fc.reconnect()（主进程关闭串口、等待 2 s、重新打开），随后最多 3 次 ping 重试。' }),
        el('li', { text: 'MSP 恢复后读取黑匣子配置（bf.bb.readConfig，SAFE MODE 下同样允许），记录设备、实际采样率与启用字段。' }),
        el('li', { text: '连续 3 次 ping 成功即判定「通信已稳定 / link stable」并停止循环；每轮的尝试号、结果与延迟都会写入事件日志。' }),
        el('li', { text: '断开连接、关闭开关或关闭窗口都会立即停止循环；同一时间只允许一个循环运行。' }),
      ]),
    ],
    { badges: [badge('自动诊断 / diagnostics', 'info')] },
  );
}

async function loadHostInfo() {
  const host = $('#host-info');
  const res = await run('读取应用信息', () => window.bf.app.info());
  const info = res.ok && res.value && typeof res.value === 'object' ? res.value : null;
  if (host && host.isConnected) {
    setChildren(host, [
      info
        ? kvGrid([
            kv('版本 / version', info.version),
            kv('平台 / platform', `${str(info.platform)} / ${str(info.arch)}`),
            kv('Electron', info.electron),
            kv('upstream commit', info.upstreamCommit),
          ])
        : el('p', { class: 'hint warn', text: '应用信息不可用' }),
    ]);
  }
  const chipNode = $('#app-info');
  if (chipNode && info) {
    chipNode.textContent = `v${str(info.version)} · ${str(info.platform)}/${str(info.arch)}`;
    chipNode.title = `Electron ${str(info.electron)} · upstream ${str(info.upstreamCommit)}`;
  }
}

/* ================================================================== *
 * 14. Page 1 — prepare (identify + backup + bidir + blackbox)
 * ================================================================== */

/**
 * Reusable pre-flight steps.
 *
 * Each returns `{ ok, detail }` and applies the same state updates whichever
 * entry point calls it, so the one-click chain and the individual buttons can
 * never drift apart.
 */

async function doIdentify() {
  const res = await run('识别飞控', () => window.bf.fc.identify());
  if (!res.ok) return { ok: false, detail: '识别失败 / identify failed' };
  state.identity = res.value && typeof res.value === 'object' ? res.value : null;
  state.done.add(0);
  const id = state.identity;
  appendLog(infoEntry(`识别完成：${str(id?.boardName)} (${str(id?.variant)} ${str(id?.version)})`, 'state'));
  return { ok: true, detail: `${str(id?.boardName)} · ${str(id?.variant)} ${str(id?.version)}` };
}

async function doReadSettings() {
  const res = await run('读取设置并备份', () => window.bf.fc.getSettings());
  if (!res.ok) return { ok: false, detail: '读取/备份失败 / read failed' };
  const value = res.value && typeof res.value === 'object' ? res.value : {};
  state.settings = value;
  if (value.identity) state.identity = value.identity;
  if (value.capabilities) state.capabilities = value.capabilities;
  state.pid = value.pid ?? null;
  state.filter = value.filter ?? null;
  state.done.add(0);
  appendLog(infoEntry(`设置已读取，备份写入 ${str(value.backupPath)}`, 'state'));
  await refreshSafety();
  return { ok: true, detail: `备份 ${str(value.backupPath)}` };
}

async function doBidirProbe() {
  const res = await run('双向DShot/RPM 检测', () => window.bf.fc.bidir());
  if (!res.ok) return { ok: false, detail: '检测失败 / probe failed' };
  state.bidir.probe = res.value && typeof res.value === 'object' ? res.value : null;
  state.bidir.apply = null;
  recordBidirProbe(state.bidir.probe);
  state.done.add(0);
  const probe = state.bidir.probe;
  appendLog(infoEntry(`双向DShot 检测：${str(probe?.protocol)} · ${str(probe?.conclusion)}`, 'state'));
  return { ok: true, detail: `${str(probe?.protocol)} · ${str(probe?.conclusion)}` };
}

async function doBbReadConfig() {
  const res = await run('读取黑匣子配置', () => window.bf.bb.readConfig());
  if (!res.ok) return { ok: false, detail: '读取失败 / read failed' };
  state.bb.live = res.value && typeof res.value === 'object' ? res.value : null;
  state.done.add(0);
  return { ok: true, detail: describeBbConfig(state.bb.live) };
}

/**
 * 「一键准备」— run every READ-ONLY pre-flight check in one go.
 *
 * This is the whole point of collapsing three pages into one: the operator
 * plugs in the FC and presses one button instead of walking identify → bidir →
 * blackbox and pressing six. Nothing here writes to the flight controller, so
 * it runs in any safety mode; the 2 kHz logging write stays a separate,
 * explicitly confirmed action.
 */
async function runPrepareAll() {
  if (!state.connected || state.prepare.busy) return;
  state.prepare.busy = true;
  state.prepare.results = [];
  const chain = [
    { label: '识别飞控 / identify', fn: doIdentify },
    { label: '读取设置 + 备份 / settings + backup', fn: doReadSettings },
    { label: '双向DShot / bidir probe', fn: doBidirProbe },
    { label: '黑匣子配置 / blackbox read', fn: doBbReadConfig },
  ];
  for (const step of chain) {
    state.prepare.current = step.label;
    showOpProgress(`自动准备 / ${step.label} …`, null);
    renderStep(state.step);
    let out;
    try {
      out = await step.fn();
    } catch (err) {
      out = { ok: false, detail: errMessage(err) };
    }
    state.prepare.results.push({ label: step.label, state: out?.ok ? 'ok' : 'fail', detail: str(out?.detail) });
  }
  showOpProgress(null);
  state.prepare.current = null;
  state.prepare.busy = false;
  const failed = state.prepare.results.filter((r) => r.state === 'fail').length;
  appendLog(
    failed
      ? warnEntry(`自动准备完成：${state.prepare.results.length - failed} 项成功、${failed} 项失败`)
      : infoEntry(`自动准备完成：${state.prepare.results.length} 项全部成功`, 'state'),
  );
  renderStep(state.step);
}

/** Auto-run status: what the connect-triggered chain did, plus a re-run link. */
function autoPrepareCard() {
  const r = state.prepare;
  const rerun = button(r.busy ? '准备中… / running' : '重新准备 / Re-run', {
    variant: 'ghost',
    enabled: () => state.connected && !r.busy,
  });
  action(rerun, '重新准备', runPrepareAll);

  const parts = [
    el('p', {
      class: 'prose',
      text: '连接后自动执行：识别 → 读取设置并备份 → 双向 DShot 检测 → 黑匣子配置读取。全部只读，任何模式下都可用；2k 采样率的写入仍需你单独确认。',
    }),
    el('div', { class: 'row' }, [
      rerun,
      r.busy && r.current ? chip(`进行中：${r.current}`, 'info') : null,
      !r.busy && r.results.length ? chip(`${r.results.filter((x) => x.state === 'ok').length}/${r.results.length} 成功`, 'ok') : null,
      !r.busy && !r.results.length && !state.connected ? chip('连接后自动运行 / runs on connect', 'idle') : null,
    ]),
  ];
  if (r.results.length) {
    parts.push(
      el('ol', { class: 'checklist' }, r.results.map((x) =>
        el('li', { class: x.state === 'ok' ? 'is-checked' : '' }, [
          el('span', { text: `${x.state === 'ok' ? '✓' : '✗'} ${x.label}` }),
          el('span', { class: 'man-hint', text: ` — ${x.detail}` }),
        ]),
      )),
    );
  }
  return card('自动准备 / Auto prepare', parts, {
    badges: [badge('只读 / read-only', 'ok')],
  });
}

/** Read-only status cards shown on the connect page once the FC is linked. */
function renderPrepareCards(body) {
  // One-shot load of the stored backup list, so the rollback control can name
  // its target before the operator presses it.
  if (state.connected && !state.backup.loaded && !state.backup.loading) loadBackupList();

  body.append(
    identityCard(),
    backupCard(),
    fcBackupCard(),
    capabilitiesCard(),
    ...bidirCards(),
    ...blackboxConfigCards(),
  );
}

/** 双向 DShot/RPM result cards (probe runs automatically on connect). */
function bidirCards() {
  const probe = state.bidir.probe;
  const verifyBtn = button(probe ? '重新检测 / Re-probe' : '检测 / Probe', {
    variant: 'ghost',
    enabled: () => state.connected,
  });
  action(verifyBtn, '双向DShot/RPM 检测', async () => {
    state.bidir.busy = true;
    renderStep(state.step);
    await doBidirProbe();
    state.bidir.busy = false;
    renderStep(state.step);
  });

  const parts = [
    card(
      '双向DShot/RPM 检测 / Bidir DShot & RPM probe',
      [
        el('p', {
          class: 'hint',
          text: '只读探测：读取电机协议、dshot_bidir、motor_poles、rpm_filter_* 与每电机遥测（MSP + CLI dshot_telemetry_info）。建议修复只生成、绝不自动写入。',
        }),
        el('div', { class: 'row' }, [
          verifyBtn,
          state.bidir.busy ? chip('检测中 / probing…', 'info') : null,
          probe ? chip(`上次检测 ${fmtClock(num(probe.checkedAt) ?? Date.now())}`, 'idle') : null,
        ]),
      ],
      { badges: [badge('只读探测 / read-only', 'ok')] },
    ),
  ];

  if (state.bidir.busy) {
    parts.push(banner('info', '检测中 / probing…', [para('正在读取 MSP 遥测与 CLI 状态，可能需要几秒…')]));
  }
  if (probe) {
    parts.push(bidirSummaryCard(probe), bidirTelemetryCard(probe), bidirApplyCard(probe));
  } else {
    parts.push(card('结果 / Result', [el('p', { class: 'hint', text: '点击「检测」读取双向DShot/RPM 状态：电机协议、遥测、电机极数与建议修复。' })]));
  }
  return parts;
}

/** Blackbox medium / 2 kHz config / erase / MSC cards (download moved to analyze). */
function blackboxConfigCards() {
  return [
    blackboxMediaCard(),
    ...blackboxConfigCard(),
    blackboxLiveCard(),
    mscCard(),
    blackboxEraseCard(),
    manualCliCard(),
  ];
}

function identityCard() {
  const id = state.identity;

  if (!id) {
    return card('识别 / Identify', [el('p', { class: 'hint', text: '尚未识别。连接后会自动读取 MSP 指纹。' })]);
  }

  const confidence = clamp01(id.confidence);
  const parts = [
    kvGrid([
      kv('固件 / variant', id.variant),
      kv('版本 / version', id.version),
      kv('MSP API', id.apiVersion),
      kv('板卡 ID / boardIdentifier', id.boardIdentifier),
      kv('板卡名称 / boardName', id.boardName),
      kv('编译目标 / targetName', id.targetName),
      id.buildKey ? kv('buildKey', id.buildKey) : null,
      id.craftName ? kv('机型名 / craftName', id.craftName) : null,
      kv('指纹 / fingerprint', id.fingerprint),
      id.modelHint ? kv('模型提示 / modelHint', id.modelHint) : null,
    ]),
    el('div', { class: 'row' }, [
      badge(`matchLevel: ${str(id.matchLevel)}`, MATCH_LEVEL_TONE[id.matchLevel] || 'idle'),
      badge(id.known ? '已知机型 / known' : '未知机型 / unknown', id.known ? 'ok' : 'crit'),
    ]),
    el('div', {}, [
      el('span', { class: 'field-label', text: `置信度 / confidence ${fmtRatio(confidence)}` }),
      meter(confidence, { label: '识别置信度', tone: confidenceTone(confidence), showPct: true }),
    ]),
    el('div', {}, [el('span', { class: 'field-label', text: '证据 / evidence' }), evidenceList(id.evidence)]),
  ];
  if (id.known === false) {
    parts.unshift(
      banner('crit', '安全模式 / SAFE MODE', [
        para('该飞控不在本地机型表中（known = false）。界面进入只读：不提供任何危险参数写入，只允许读取与离线分析。'),
        para('This board is not in the local model map. The UI stays read-only: no dangerous parameter writes, reads and offline analysis only.'),
        canForceTrust()
          ? para('如需继续记录 / 备份流程，可使用页面顶部的「强制信任并退出安全模式」高级按钮；飞行参数写入仍会被调参锁定。')
          : para('本会话已强制信任：记录类写入可用，飞行参数写入仍然锁定。'),
      ]),
    );
  }
  return card('识别 / Identify', parts, {
    badges: [badge(`置信度 ${fmtRatio(confidence)}`, confidenceTone(confidence)), badge(str(id.matchLevel), MATCH_LEVEL_TONE[id.matchLevel] || 'idle')],
  });
}

function backupCard() {
  const s = state.settings;

  // Settings are read + backed up automatically on connect; the only manual
  // action left is an explicit re-backup of the dump without re-reading.
  const backupBtn = button('仅重新备份 dump / Backup', { variant: 'ghost' });
  action(backupBtn, '重新备份', async () => {
    const res = await run('重新备份 dump', () => window.bf.fc.backup());
    if (!res.ok) return;
    const value = res.value && typeof res.value === 'object' ? res.value : {};
    appendLog(infoEntry(`备份完成：${str(value.path ?? value.backupPath ?? value)}`, 'state'));
    await refreshSafety();
    renderStep(state.step);
  });

  const rows = s
    ? [
        kv('备份路径 / backupPath', s.backupPath),
        kv('SHA-256', s.backupSha256),
        kv('dump 长度', `${fmtInt(String(s.dump ?? '').length)} 字符`),
        kv('diff all 长度', `${fmtInt(String(s.diffAll ?? '').length)} 字符`),
      ]
    : [el('p', { class: 'hint', text: '尚未生成备份。连接后读取设置会自动写入完整 dump 备份（安全边界要求）。' })];

  return card(
    '备份 / Backup',
    [
      ...rows,
      el('p', {
        class: 'hint ok',
        text: '只读 / read-only：读取设置只发送 dump / diff 等读取命令，并把备份写到本地；它从不改写飞控参数，因此即使 SAFE MODE 也保持可用（没有备份，任何写入的前置条件都无法满足）。',
      }),
    ],
    {
      actions: [backupBtn],
      badges: [s ? badge('已备份 / backed up', 'ok') : badge('未备份 / no backup', 'warn'), badge('只读 / read-only', 'ok')],
    },
  );
}

/* ---------------- mandatory backup + one-click rollback (bf.backup.*) ---------------- */

/** Newest entry of the backup list; the main process returns newest-first. */
function latestBackup() {
  const list = Array.isArray(state.backup.list) ? state.backup.list : [];
  if (!list.length) return null;
  let best = null;
  let bestTs = -Infinity;
  for (const b of list) {
    const ts = Date.parse(String(b?.createdAt ?? ''));
    if (Number.isFinite(ts) && ts > bestTs) {
      bestTs = ts;
      best = b;
    }
  }
  return best || list[0];
}

/** Compact one-line label for a backup row: id + board + BF version. */
function backupLabel(b) {
  const parts = [str(b?.id), str(b?.board), str(b?.bfVersion)].filter((p) => p && p !== '—');
  return parts.join(' · ') || '—';
}

/** Backup payload sizes differ per entry shape; report what is actually there. */
function backupItemCount(b) {
  const items = b?.items;
  if (Array.isArray(items)) return `${items.length} 项 / items`;
  // BackupStore.list() reports the pending-diff line count as a plain number.
  if (num(items) !== null) return `${fmtInt(items)} 项 / items`;
  if (items && typeof items === 'object') return `${Object.keys(items).length} 项 / items`;
  return '—';
}

function backupItemChips(b) {
  const items = b?.items;
  if (Array.isArray(items) && items.length && items.every((it) => typeof it === 'string')) {
    return el('div', { class: 'chips' }, items.map((it) => chip(str(it), 'info')));
  }
  return null;
}

async function loadBackupList() {
  if (!window.bf || state.backup.loading) return;
  state.backup.loading = true;
  // Claim the one-shot auto-load before awaiting: a failed list must not be
  // retried by every repaint (the refresh button is the deliberate retry).
  state.backup.loaded = true;
  const res = await run('读取备份列表', () => window.bf.backup.list());
  state.backup.loading = false;
  if (!res.ok) return;
  const value = res.value;
  // backup.list() resolves to {backups:[...]}; accept a bare array too, the way
  // ports.list() is accepted, so a shape change cannot silently empty the card.
  const list = Array.isArray(value) ? value : Array.isArray(value?.backups) ? value.backups : [];
  state.backup.list = list;
  appendLog(infoEntry(`备份列表：${state.backup.list.length} 份`, 'state'));
  renderStep(state.step);
}

async function createFullBackup() {
  const note = String(state.backup.note || '').trim();
  state.backup.busy = true;
  showOpProgress('创建完整备份 / backup.create …', null);
  const res = await run('创建完整备份', () => window.bf.backup.create({ note }));
  showOpProgress(null);
  state.backup.busy = false;
  if (!res.ok) {
    renderStep(state.step);
    return;
  }
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (out.ok === false) {
    appendLog(warnEntry(`创建备份被拒绝 / refused：${str(out.reason ?? out.message)}`, 'safety'));
    renderStep(state.step);
    return;
  }
  const files = out.files && typeof out.files === 'object' ? out.files : null;
  appendLog(
    infoEntry(
      `备份已创建：${str(out.id)} → ${str(out.dir)}${files ? ` · ${Object.keys(files).length} 个文件（${Object.keys(files).join(', ')}）` : ''}${
        out.summary === undefined ? '' : ` · ${safeJson(out.summary)}`
      }`,
      'state',
    ),
  );
  state.backup.note = '';
  state.backup.loaded = true;
  await refreshSafety(); // backupDone / backupPath may have just changed
  await loadBackupList();
  renderStep(state.step);
}

/**
 * Roll a backup back through the shared confirm-with-diff dialog.
 *
 * The write is two-phase like every other FC write in this app: the confirm
 * dialog arms only after it is rendered, then bf.backup.rollback() is called
 * with `requireConfirm: true`. If the guard answers with a single-use `token`
 * instead of applying immediately, that token is spent in a second call.
 * Nothing is written before the operator confirms.
 */
async function rollbackBackup(backup) {
  const id = str(backup?.id);
  if (id === '—') {
    appendLog(warnEntry('没有可回退的备份 / nothing to roll back to'));
    return;
  }

  confirmDiffDialog({
    title: `确认回退 / Confirm rollback · ${id}`,
    note: '回退会把该备份中的完整配置重新写入飞控，并逐项校验写入结果。回退本身也是一次真实写入，写入前会再生成一份备份。',
    body: el('div', {}, [
      kvGrid([
        kv('备份 / backup', id),
        kv('创建时间 / createdAt', fmtDateTime(backup?.createdAt)),
        kv('板卡 / board', backup?.board),
        kv('BF 版本 / bfVersion', backup?.bfVersion),
        kv('PID 频率 / pidHz', backup?.pidHz === undefined ? '—' : fmtHz(backup.pidHz)),
        kv('备注 / note', backup?.note),
        kv('路径 / path', backup?.path, { wrap: false }),
        kv('内容 / items', backupItemCount(backup)),
      ]),
      backupItemChips(backup),
      el('p', { class: 'hint warn', text: '回退会覆盖当前调参。回退后请重新识别飞控，并重新采集一次日志做复飞评估。' }),
    ]),
    warning: '这是不可撤销的写入：飞控将恢复到该备份时的参数状态。',
    confirmLabel: '确认回退 / Confirm rollback',
    danger: true,
    onConfirm: async () => {
      const first = await run(`回退预览 ${id}`, () => window.bf.backup.rollback({ id, requireConfirm: true }));
      if (!first.ok) throw first.error;
      let out = first.value && typeof first.value === 'object' ? first.value : {};
      const token = typeof out.token === 'string' && out.token ? out.token : null;
      if (out.applied !== true && token) {
        const second = await run(`回退写入 ${id}`, () => window.bf.backup.rollback({ id, requireConfirm: true, token }));
        if (!second.ok) throw second.error;
        out = second.value && typeof second.value === 'object' ? second.value : {};
      }
      if (out.applied === false || out.ok === false) throw new Error(str(out.reason ?? out.message) || '回退未生效');
      if (out.applied !== true && out.ok !== true) throw new Error(str(out.reason ?? out.message) || '回退未被确认（缺少 applied / token）');
      state.backup.lastRollback = out;
      appendLog(
        warnEntry(
          `已回退到备份 ${id}${out.verified === undefined ? '' : ` · verified=${str(out.verified)}`}${out.reportPath ? ` · 报告 ${out.reportPath}` : ''}`,
          'safety',
        ),
      );
      state.evaluate.result = null; // the flight is no longer comparable to a tuning we just discarded
      await refreshSafety();
      await loadBackupList();
      renderStep(state.step);
    },
  });
}

/** Resolve the newest backup (loading the list once if needed) and roll it back. */
async function rollbackLatestBackup() {
  if (!state.backup.loaded && !state.backup.loading) await loadBackupList();
  const latest = latestBackup();
  if (!latest) {
    appendLog(warnEntry('没有可回退的备份：请先「创建备份」/ no backup available'));
    renderStep(state.step);
    return;
  }
  await rollbackBackup(latest);
}

function backupHistoryTable() {
  const list = Array.isArray(state.backup.list) ? state.backup.list : [];
  const newest = latestBackup();
  if (!list.length) {
    return el('p', { class: 'hint', text: '暂无备份记录。点击「创建备份」生成完整备份（diff all / settings / package / meta）。' });
  }
  const rows = list.map((b) => {
    const rollbackBtn = button('回退 / Roll back', { variant: 'danger', size: 'sm', mutating: true, gate: 'tuning' });
    rollbackBtn.title = `回退到 ${backupLabel(b)}`;
    action(rollbackBtn, `回退备份 ${str(b?.id)}`, async () => rollbackBackup(b));
    return [
      { class: 'mono-num', text: fmtDateTime(b?.createdAt) },
      { class: 'mono-num', text: str(b?.board) },
      { class: 'mono-num', text: str(b?.bfVersion) },
      { class: 'mono-num num', text: b?.pidHz === undefined ? '—' : fmtHz(b.pidHz) },
      { text: str(b?.note) },
      { text: backupItemCount(b) },
      { node: el('div', { class: 'row' }, [String(b?.id) === String(newest?.id) ? badge('最新 / latest', 'info') : null, rollbackBtn]) },
    ];
  });
  return table(
    [
      { text: '创建时间 / createdAt' },
      { text: '板卡 / board' },
      { text: 'BF 版本' },
      { text: 'PID 频率', class: 'num' },
      { text: '备注 / note' },
      { text: '内容 / items' },
      { text: '操作 / action' },
    ],
    rows,
  );
}

function fcBackupCard() {
  const s = state.safety;
  const latest = latestBackup();
  const noteInput = el('input', {
    class: 'input',
    id: 'backup-note',
    type: 'text',
    placeholder: '备注（可选）/ note (optional)',
    value: state.backup.note,
    attrs: { autocomplete: 'off', spellcheck: 'false' },
  });
  noteInput.addEventListener('input', () => {
    state.backup.note = noteInput.value;
  });

  const createBtn = button(state.backup.busy ? '备份中…' : '创建备份 / Create backup', {
    variant: 'primary',
    enabled: () => state.connected && !state.backup.busy,
  });
  action(createBtn, '创建备份', createFullBackup);

  const refreshBtn = button('刷新列表 / Refresh', { variant: 'ghost', size: 'sm' });
  action(refreshBtn, '刷新备份列表', async () => {
    await loadBackupList();
    renderStep(state.step);
  });

  // The prominent recovery control. Rollback is a real FC write, so it goes
  // through confirmDiffDialog() and is gated as a tuning write.
  const rollbackBtn = button('一键回退上一版 / Roll back latest', { variant: 'danger', mutating: true, gate: 'tuning' });
  rollbackBtn.title = latest ? `回退到 ${backupLabel(latest)}` : '尚无备份可回退';
  action(rollbackBtn, '一键回退上一版', rollbackLatestBackup);

  const last = state.backup.lastRollback;

  return card(
    '备份 / 回退 · Backup / Rollback',
    [
      kvGrid([
        kv('本次连接备份 / connection backup', s.backupDone ? badge('已完成 / done', 'ok') : badge('未完成 / none', 'warn')),
        kv('备份路径 / backupPath', s.backupPath, { wrap: false }),
        kv('历史备份 / stored backups', fmtInt(state.backup.list.length)),
        kv('最新备份 / latest', latest ? backupLabel(latest) : '无 / none'),
      ]),
      el('div', { class: 'row' }, [
        el('label', { class: 'field-label', for: 'backup-note', text: '备注 / note' }),
        noteInput,
        createBtn,
        refreshBtn,
      ]),
      el('p', {
        class: 'hint',
        text: '创建备份只读取飞控（完整 dump / diff all / settings / package / meta 与写前元数据），不写入任何参数，因此在 SAFE MODE 下同样可用。',
      }),
      backupHistoryTable(),
      el('div', { class: 'banner banner-warn' }, [
        el('div', { class: 'banner-title', text: '一键回退 / One-click rollback' }),
        para('把最新一份备份完整写回飞控并逐项校验。回退前会弹出确认对话框（与其他飞控写入同一套确认流程），回退完成后在此显示报告路径。'),
        el('div', { class: 'row' }, [rollbackBtn, el('span', { class: 'hint', text: latest ? `目标：${backupLabel(latest)}` : '尚无可回退的备份。' })]),
      ]),
      last
        ? banner('ok', '已回退 / Rolled back', [
            kvGrid([
              kv('applied', str(last.applied)),
              kv('verified', str(last.verified)),
              kv('报告 / reportPath', last.reportPath, { wrap: false }),
            ]),
          ])
        : null,
    ],
    {
      badges: [
        latest ? badge(`${state.backup.list.length} 份备份 / backups`, 'info') : badge('无备份 / no backup', 'warn'),
        badge('写入前必备 / required before writes', 'warn'),
      ],
    },
  );
}

function loopRateHz(caps) {
  const pid = num(caps?.pidRateHz);
  if (pid) return pid;
  const us = num(caps?.pidLooptimeUs);
  return us ? Math.round(1e6 / us) : null;
}

function clampExp(exp) {
  const n = num(exp);
  if (n === null) return 0;
  return Math.min(20, Math.max(0, Math.round(n)));
}

function flashRow(caps) {
  const total = num(caps?.flashTotalBytes) ?? 0;
  const used = num(caps?.flashUsedBytes) ?? 0;
  if (!caps?.hasFlash && total <= 0) return el('p', { class: 'hint', text: '无 SPI Flash' });
  const ratio = total > 0 ? used / total : 0;
  return el('div', {}, [
    el('span', { class: 'hint', text: `${fmtBytes(used)} / ${fmtBytes(total)}（${fmtRatio(ratio)}）` }),
    meter(ratio, { label: 'Flash 使用率', tone: ratio > 0.9 ? 'crit' : ratio > 0.7 ? 'warn' : 'ok' }),
  ]);
}

function sdRow(caps) {
  const total = num(caps?.sdTotalKb) ?? 0;
  const free = num(caps?.sdFreeKb) ?? 0;
  if (!caps?.hasSdCard && total <= 0) return el('p', { class: 'hint', text: '无 SD 卡' });
  const usedRatio = total > 0 ? (total - free) / total : 0;
  return el('div', {}, [
    el('span', { class: 'hint', text: `剩余 ${fmtKb(free)} / ${fmtKb(total)}` }),
    meter(usedRatio, { label: 'SD 卡使用率', tone: usedRatio > 0.9 ? 'crit' : usedRatio > 0.7 ? 'warn' : 'ok' }),
  ]);
}

function capabilityRows(caps) {
  const rate = loopRateHz(caps);
  const bb = caps?.blackbox && typeof caps.blackbox === 'object' ? caps.blackbox : null;
  const num_ = num(bb?.rateNum);
  const den = num(bb?.rateDenom);
  const bbRate = rate && num_ !== null && den ? (rate * num_) / den : null;
  return [
    ['PID 循环 / pidLooptimeUs', `${fmtInt(caps?.pidLooptimeUs)} µs · ${fmtHz(rate)}`],
    ['陀螺仪采样率 / gyroRateHz', fmtHz(caps?.gyroRateHz)],
    ['PID 频率 / pidRateHz', fmtHz(caps?.pidRateHz)],
    ['RPM 滤波器 / rpmFilterActive', boolText(caps?.rpmFilterActive)],
    ['DShot / dshotActive', boolText(caps?.dshotActive)],
    caps?.bidirDshot === undefined ? null : ['双向 DShot / bidirDshot', boolText(caps?.bidirDshot)],
    ['黑匣子支持 / blackboxSupported', boolText(caps?.blackboxSupported)],
    ['黑匣子设备 / device', str(bb?.device)],
    ['日志分频 / rateNum:rateDenom', bb ? `${fmtInt(bb.rateNum)} / ${fmtInt(bb.rateDenom)}${bbRate ? `  ≈ ${fmtHz(bbRate)}` : ''}` : '—'],
    ['采样率指数 / sampleRateExp', bb ? `${fmtInt(bb.sampleRateExp)} (1/${2 ** clampExp(bb.sampleRateExp)})` : '—'],
    ['禁用掩码 / disabledMask', bb ? `0x${(Number(bb.disabledMask) >>> 0).toString(16)}` : '—'],
    ['滤波配置 / filterProfile', str(caps?.filterProfile)],
    ['陀螺仪滤波 / gyroFilterHz', fmtHz(caps?.gyroFilterHz)],
    ['D 项滤波 / dtermFilterHz', fmtHz(caps?.dtermFilterHz)],
  ].filter(Boolean);
}

function capabilitiesCard() {
  const caps = state.capabilities;

  if (!caps) {
    return card('能力 / Capabilities', [el('p', { class: 'hint', text: '尚未探测。连接后会自动读取循环频率、RPM 滤波、黑匣子介质与滤波配置。' })]);
  }

  const warnings = Array.isArray(caps.warnings) ? caps.warnings : [];
  return card(
    '能力 / Capabilities',
    [
      table(['项目 / item', '值 / value'], capabilityRows(caps).map(([k, v]) => [{ text: k }, v instanceof Node ? { node: v } : { class: 'mono-num', text: v }])),
      el('div', {}, [el('span', { class: 'field-label', text: 'SPI Flash 使用 / flash' }), flashRow(caps)]),
      el('div', {}, [el('span', { class: 'field-label', text: 'SD 卡 / sdcard' }), sdRow(caps)]),
      warnings.length
        ? el('div', {}, [el('span', { class: 'field-label', text: `警告 / warnings (${warnings.length})` }), el('div', { class: 'chips' }, warnings.map((w) => chip(str(w), 'warn')))])
        : el('p', { class: 'hint ok', text: '无警告 / no warnings' }),
    ],
    { badges: [badge(`${fmtHzShort(loopRateHz(caps))} loop`, 'info')] },
  );
}

/* ================================================================== *
 * 15. Bidirectional DShot & RPM (cards reused by the prepare page)
 * ================================================================== */

function recordBidirProbe(probe) {
  const motors = Array.isArray(probe?.telemetryPerMotor) ? probe.telemetryPerMotor : [];
  for (const m of motors) {
    const idx = num(m?.index);
    if (idx === null) continue;
    const slot = state.bidir.history[idx] || (state.bidir.history[idx] = { rpm: [], erpm: [], hz: [], invalidPct: [] });
    const push = (arr, v) => {
      arr.push(v === null || v === undefined ? null : v);
      while (arr.length > BIDIR_HISTORY_MAX) arr.shift();
    };
    push(slot.rpm, m?.rpm);
    push(slot.erpm, m?.erpm);
    push(slot.hz, m?.hz);
    push(slot.invalidPct, m?.invalidPct);
  }
}

/**
 * Resolved theme colours for canvas drawing.
 *
 * Canvas cannot use CSS custom properties, so this is the single bridge: every
 * colour is read from styles.css at draw time and the literals below are only
 * fallbacks for the case where the stylesheet has not applied yet. Keeping the
 * palette in one place is what stops the charts from drifting to an old accent
 * when the theme changes.
 */
function themeColors() {
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const get = (name, fallback) => {
    const value = cs ? String(cs.getPropertyValue(name) || '').trim() : '';
    return value || fallback;
  };
  return {
    bg: get('--bg', '#15181c'),
    bg1: get('--bg-1', '#1b1f24'),
    bg2: get('--bg-2', '#22262c'),
    line: get('--line', '#2f343c'),
    fgDim: get('--fg-dim', '#a9b0b8'),
    fgMute: get('--fg-mute', '#7d858e'),
    accent: get('--accent', '#ffbb00'),
    ok: get('--ok', '#adf042'),
    warn: get('--warn', '#ff8800'),
    crit: get('--crit', '#e24761'),
  };
}

/** Lightweight canvas sparkline (~140x36 px), no libraries. */
function drawSparkline(canvas, samples) {
  if (!canvas) return;
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const C = themeColors();
  canvas.width = SPARK_W;
  canvas.height = SPARK_H;
  ctx.fillStyle = C.bg1;
  ctx.fillRect(0, 0, SPARK_W, SPARK_H);
  const vals = (Array.isArray(samples) ? samples : []).map((v) => num(v)).filter((v) => v !== null);
  if (!vals.length) {
    ctx.fillStyle = C.fgMute;
    ctx.font = '10px monospace';
    ctx.fillText('—', 6, SPARK_H / 2 + 3);
    return;
  }
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1e-6) {
    hi += 1;
    lo -= 1;
  }
  const x = (i) => (vals.length === 1 ? SPARK_W / 2 : (i / (vals.length - 1)) * (SPARK_W - 4) + 2);
  const y = (v) => SPARK_H - 3 - ((v - lo) / (hi - lo)) * (SPARK_H - 8);
  ctx.beginPath();
  for (let i = 0; i < vals.length; i += 1) {
    if (i === 0) ctx.moveTo(x(i), y(vals[i]));
    else ctx.lineTo(x(i), y(vals[i]));
  }
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 1.25;
  ctx.stroke();
  // Last sample marker.
  ctx.fillStyle = C.warn;
  ctx.beginPath();
  ctx.arc(x(vals.length - 1), y(vals[vals.length - 1]), 2, 0, Math.PI * 2);
  ctx.fill();
}

function sparkCell(m) {
  const idx = num(m?.index);
  const samples = idx === null ? [] : state.bidir.history[idx]?.rpm || [];
  const canvas = el('canvas', {
    class: 'spark',
    attrs: { width: String(SPARK_W), height: String(SPARK_H), 'aria-label': `电机 ${idx === null ? '?' : idx} RPM 趋势` },
  });
  drawSparkline(canvas, samples);
  return el('div', { class: 'spark-cell' }, [canvas, el('span', { class: 'hint', text: `${samples.length}/${BIDIR_HISTORY_MAX} 次` })]);
}

/** Current (pre-write) values for the scoped bidir whitelist parameters. */
function bidirParamCurrent(probe) {
  return {
    dshot_bidir: probe?.bidirOn === true ? 'ON' : probe?.bidirOn === false ? 'OFF' : '—',
    motor_poles: probe?.motorPoles === null || probe?.motorPoles === undefined ? '—' : fmtInt(probe.motorPoles),
    rpm_filter_harmonics: num(probe?.rpmFilter?.harmonics) ?? '—',
    rpm_filter_q: num(probe?.rpmFilter?.q) ?? '—',
    rpm_filter_min_hz: num(probe?.rpmFilter?.minHz) ?? '—',
  };
}

function bidirSummaryCard(probe) {
  const esc = probe?.escSupported;
  const escTone = esc === 'yes' ? 'ok' : esc === 'no' ? 'crit' : 'warn';
  const escLabel = esc === 'yes' ? '支持 / yes' : esc === 'no' ? '不支持 / no' : '未知 / unknown';
  const power = probe?.powerState;
  const confidence = clamp01(probe?.confidence);
  const warnings = Array.isArray(probe?.warnings) ? probe.warnings : [];
  const notes = Array.isArray(probe?.notes) ? probe.notes : [];
  const evidence = Array.isArray(probe?.evidence) ? probe.evidence : [];
  const polesWarn = warnings.some((w) => /poles|极/i.test(String(w)));

  const parts = [
    kvGrid([
      kv('协议 / protocol', str(probe?.protocol)),
      kv('双向 DShot / bidirOn', boolText(probe?.bidirOn, 'ON', 'OFF')),
      el('div', { class: 'kv' }, [
        el('span', { class: 'kv-k', text: '电机极数 / motorPoles' }),
        el('span', { class: 'kv-v' }, [
          el('span', { class: ['mono-num', polesWarn ? 'tone-warn' : ''], text: str(probe?.motorPoles) }),
          polesWarn ? el('span', { class: 'hint warn', text: ' ⚠ 见警告' }) : null,
        ]),
      ]),
      el('div', { class: 'kv' }, [
        el('span', { class: 'kv-k', text: 'RPM 滤波 / rpmFilter' }),
        el('span', { class: 'kv-v' }, [
          el('span', {
            class: 'mono-num',
            text: `harmonics ${fmtInt(probe?.rpmFilter?.harmonics)} · q ${fmtNum(probe?.rpmFilter?.q)} · minHz ${fmtHz(probe?.rpmFilter?.minHz)}`,
          }),
        ]),
      ]),
      kv(
        '供电 / powerState',
        badge(power === 'battery' ? '电池供电 / battery' : power === 'usb-only' ? '仅 USB / usb-only' : str(power), power === 'battery' ? 'ok' : 'warn'),
      ),
      kv('电调支持 / escSupported', badge(escLabel, escTone)),
      kv('检测时间 / checkedAt', fmtDateTime(probe?.checkedAt)),
    ]),
    el('div', {}, [
      el('span', { class: 'field-label', text: `置信度 / confidence ${fmtRatio(confidence)}` }),
      meter(confidence, { label: '双向DShot 检测置信度', tone: confidenceTone(confidence), showPct: true }),
    ]),
    banner(esc === 'no' ? 'crit' : confidenceTone(confidence), '结论 / conclusion', [para(probe?.conclusion)]),
    el('div', {}, [el('span', { class: 'field-label', text: `证据 / evidence (${evidence.length})` }), evidenceList(evidence)]),
    warnings.length
      ? el('div', {}, [el('span', { class: 'field-label', text: `警告 / warnings (${warnings.length})` }), el('div', { class: 'chips' }, warnings.map((w) => chip(str(w), 'warn')))])
      : null,
    notes.length
      ? el('div', {}, [el('span', { class: 'field-label', text: `备注 / notes (${notes.length})` }), evidenceList(notes)])
      : null,
  ];

  if (power === 'usb-only') {
    parts.push(
      el('div', { class: 'bidir-power-block', attrs: { role: 'status' } }, [
        el('div', { class: 'banner-title', text: '仅 USB 供电，未做动力验证 / USB power only — no power validation' }),
        para('当前飞控由 USB 供电（未检测到锂电池电压），遥测结果不代表真实动力状态。'),
        el('ul', { class: 'evidence' }, [
          el('li', { text: '接上锂电池后，在 Betaflight Motors 页或直接手拨电机，再点击「检测」重新验证。' }),
          el('li', { text: '手拨电机时必须拆除螺旋桨；禁止在装桨状态下带电测试。' }),
        ]),
      ]),
    );
  }

  return card('检测结果 / Probe result', parts, {
    badges: [
      badge(probe?.bidirOn ? 'bidir ON' : 'bidir OFF', probe?.bidirOn ? 'ok' : 'warn'),
      badge(escLabel, escTone),
      badge(`置信度 ${fmtRatio(confidence)}`, confidenceTone(confidence)),
    ],
  });
}

function bidirTelemetryCard(probe) {
  const motors = Array.isArray(probe?.telemetryPerMotor) ? probe.telemetryPerMotor : [];
  if (!motors.length) {
    return card('每电机遥测 / Per-motor telemetry', [el('p', { class: 'hint', text: '本次探测没有返回电机遥测数据。接锂电后在 Motors 页手拨电机再验证。' })]);
  }
  const rows = motors.map((m) => {
    const invalid = num(m?.invalidPct);
    const bad = invalid !== null && invalid >= 1;
    return [
      { class: 'mono-num', text: `#${fmtInt(m?.index)}` },
      { class: 'mono-num', text: fmtInt(m?.rpm) },
      { class: 'mono-num', text: fmtInt(m?.erpm) },
      { class: 'mono-num', text: fmtHz(m?.hz) },
      {
        node: el('span', { class: ['mono-num', bad ? 'tone-warn' : ''] }, [
          el('span', { text: invalid === null ? '—' : fmtPct(invalid, 2) }),
          bad ? el('span', { class: 'hint warn', text: ' ⚠' }) : null,
        ]),
      },
      { node: m?.noData ? badge('NO DATA', 'warn') : badge('OK', 'ok') },
      { node: sparkCell(m) },
    ];
  });
  return card(
    '每电机遥测 / Per-motor telemetry',
    [
      el('p', { class: 'hint', text: 'RPM 趋势为最近 60 次检测的记录（本次 + 历史）。invalidPct ≥ 1% 以琥珀色标出。' }),
      table(['电机 / motor', 'RPM', 'eRPM', 'Hz', 'invalidPct', '数据', 'RPM 趋势 (60)'], rows),
    ],
    { badges: [badge(`${motors.length} 电机 / motors`, 'info')] },
  );
}

/** Phase 1: dry-run -> token + diff. Opens the confirm-with-diff dialog. */
async function bidirApplyPhase1() {
  const probe = state.bidir.probe;
  const commands = Array.isArray(probe?.suggestedCli) ? probe.suggestedCli : [];
  if (!commands.length) return;
  const res = await run('双向DShot/RPM dry-run', () => window.bf.fc.applyBidir({ commands, requireConfirm: true }));
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  state.bidir.apply = {
    commands,
    token: typeof out.token === 'string' && out.token ? out.token : null,
    wouldSend: Array.isArray(out.wouldSend) ? out.wouldSend : [],
    diff: Array.isArray(out.diff) ? out.diff : [],
    blocked: Array.isArray(out.blocked) ? out.blocked : [],
    reason: out.reason === undefined || out.reason === null ? null : String(out.reason),
    result: null,
  };
  renderStep(state.step);

  const pending = state.bidir.apply;
  if (!pending.token) {
    appendLog(warnEntry(`双向DShot dry-run 被拒绝：${pending.reason || '未获得确认令牌'}`, 'safety'));
    return;
  }
  appendLog(infoEntry(`双向DShot dry-run 完成：${pending.diff.length} 项差异，等待确认`, 'safety'));
  confirmDiffDialog({
    title: '确认写入双向DShot/RPM 设置',
    note: 'dshot_bidir / motor_poles / rpm_filter_* 属于危险项；本 dry-run → 确认流程是唯一的写入路径。',
    diff: pending.diff.map((d) => ({ param: d?.param, from: bidirParamCurrent(probe)[d?.param] ?? '—', to: d?.to })),
    danger: true,
    onConfirm: () => bidirApplyPhase2(),
  });
}

/** Phase 2: the real write, only with the token from phase 1. */
async function bidirApplyPhase2() {
  const pending = state.bidir.apply;
  if (!pending || !pending.token) throw new Error('确认令牌缺失、过期或不匹配，请重新 dry-run');
  const res = await run('写入双向DShot/RPM 设置', () =>
    window.bf.fc.applyBidir({ commands: pending.commands, requireConfirm: true, token: pending.token }),
  );
  if (!res.ok) throw res.error;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (!out.applied) throw new Error(str(out.reason) || '飞控拒绝了本次写入');
  pending.result = out;
  pending.token = null;
  appendLog(infoEntry(`已写入双向DShot/RPM 设置：${Array.isArray(out.cliSent) ? out.cliSent.length : 0} 条 CLI`, 'safety'));
  await refreshSafety();
  renderStep(state.step);
}

function bidirApplyCard(probe) {
  const cli = Array.isArray(probe?.suggestedCli) ? probe.suggestedCli : [];
  const pending = state.bidir.apply;
  const parts = [];

  if (!cli.length) {
    parts.push(el('p', { class: 'hint ok', text: '无需改动 / no suggested fixes。' }));
  } else {
    parts.push(
      el('div', {}, [
        el('span', { class: 'field-label', text: `建议 CLI / suggestedCli (${cli.length})（不会自动写入）` }),
        codeBlock(cli),
      ]),
    );

    if (pending?.result?.applied) {
      parts.push(el('p', { class: 'hint ok', text: '已写入飞控。请重新点击「检测」验证遥测是否恢复。' }));
      if (Array.isArray(pending.result.cliSent) && pending.result.cliSent.length) {
        parts.push(el('div', {}, [el('span', { class: 'field-label', text: '已下发 / cliSent' }), codeBlock(pending.result.cliSent)]));
      }
    } else {
      const applyBtn = button('应用（dry-run 确认）/ Apply', {
        variant: 'primary',
        mutating: true,
        gate: 'logging',
        enabled: () => state.connected,
      });
      action(applyBtn, '双向DShot dry-run', bidirApplyPhase1);
      parts.push(
        el('div', { class: 'row' }, [
          applyBtn,
          el('span', { class: 'hint', text: '第一步只做 dry-run 并生成 diff 与确认令牌；第二步在确认对话框中真实写入（含 save）。' }),
        ]),
      );

      if (pending) {
        if (!pending.token) {
          parts.push(banner('crit', 'dry-run 被拒绝 / refused', [para(str(pending.reason) || '未获得确认令牌')]));
        } else {
          const confirmBtn = button('确认写入 / Confirm write', { variant: 'danger', mutating: true, gate: 'logging' });
          guard(confirmBtn, () => Boolean(pending.token));
          action(confirmBtn, '确认写入双向DShot/RPM', async () => {
            confirmDiffDialog({
              title: '确认写入双向DShot/RPM 设置',
              note: 'dshot_bidir / motor_poles / rpm_filter_* 属于危险项；本 dry-run → 确认流程是唯一的写入路径。',
              diff: pending.diff.map((d) => ({ param: d?.param, from: bidirParamCurrent(probe)[d?.param] ?? '—', to: d?.to })),
              danger: true,
              onConfirm: () => bidirApplyPhase2(),
            });
          });
          const cancelBtn = button('取消 / Cancel', { variant: 'ghost' });
          action(cancelBtn, '取消双向DShot写入', async () => {
            state.bidir.apply = null;
            renderStep(state.step);
          });
          parts.push(
            el('div', { class: 'banner banner-warn' }, [
              el('div', { class: 'banner-title', text: '等待确认 / awaiting confirmation' }),
              para('以下 before / after 差异将写入飞控（含 save）。'),
              diffTable(pending.diff.map((d) => ({ param: d?.param, from: bidirParamCurrent(probe)[d?.param] ?? '—', to: d?.to }))),
              el('div', { class: 'row' }, [confirmBtn, cancelBtn]),
            ]),
          );
        }
      }
      if (Array.isArray(pending?.blocked) && pending.blocked.length) {
        parts.push(
          el('div', {}, [
            el('span', { class: 'field-label', text: `被拒绝命令 / blocked (${pending.blocked.length})` }),
            el('ul', { class: 'evidence' }, pending.blocked.map((b) => el('li', { text: `${str(b?.command)} — ${str(b?.reason)}` }))),
          ]),
        );
      }
    }
  }

  return card('建议修复 / Suggested fixes', parts, {
    badges: [badge('唯一写入路径 / scoped write path', 'warn')],
  });
}

/* ================================================================== *
 * 16. Blackbox 2k (cards reused by the prepare page; download lives in analyze)
 * ================================================================== */

function ensureBbFields() {
  if (state.bb.fieldsInit) return;
  const mask = num(state.capabilities?.blackbox?.disabledMask);
  if (mask !== null) {
    state.bb.fields = new Set(toggleableFields().filter((f) => (mask & (1 << f.bit)) === 0).map((f) => f.key));
    state.bb.fieldsSource = `飞控掩码 / disabledMask 0x${(mask >>> 0).toString(16)}`;
  } else {
    state.bb.fields = new Set(contractRequired());
    state.bb.fieldsSource = '默认必需字段 / REQUIRED_BB_FIELDS';
  }
  state.bb.fieldsInit = true;
}

function bidirOnHint() {
  if (state.bidir.probe?.bidirOn === true || state.capabilities?.bidirDshot === true) {
    return el('p', { class: 'hint', text: '双向 DShot 已开启：RPM 字段已包含在必需字段中；建议同时记录 debug 字段（debug_mode = RPM_FILTER）以校验陷波中心。' });
  }
  return null;
}

function bbDivisorNote() {
  const rate = num(state.bb.rate) ?? REQUESTED_BB_RATE_DEFAULT;
  const loop = loopRateHz(state.capabilities);
  if (!loop) return '未知循环频率：完成第 2 步「一键准备」的能力探测后可计算分频。';
  if (rate <= 0) return '请输入有效采样率。';
  const divisor = loop / rate;
  if (divisor < 1) return `${fmtHzShort(loop)} loop 低于请求的 ${fmtInt(rate)} Hz，飞控无法达到该采样率。`;
  const rounded = Math.round(divisor);
  if (Math.abs(divisor - rounded) < 1e-6) return `${fmtHzShort(loop)} loop -> 1/${rounded}`;
  return `${fmtHzShort(loop)} loop -> 1/${divisor.toFixed(2)}（非整数分频，固件会取整）`;
}

function requiredMissing() {
  const fields = state.bb.fields;
  return contractRequired().filter((key) => key !== 'throttle' && !fields.has(key));
}

function updateFieldSummary() {
  const warn = refs.fieldWarn;
  if (!warn || !warn.isConnected) return;
  const missing = requiredMissing();
  warn.hidden = missing.length === 0;
  warn.textContent = missing.length ? `必需字段未勾选：${missing.join('、')}` : '';
  for (const cell of $$('.field-cell[data-key]')) {
    const key = cell.dataset.key;
    cell.classList.toggle('is-missing', contractRequired().includes(key) && !state.bb.fields.has(key));
  }
}

function bbFieldGrid() {
  ensureBbFields();
  const grid = el('div', { class: 'field-grid', attrs: { role: 'group', 'aria-label': '黑匣子记录字段 / blackbox fields' } });
  for (const field of toggleableFields()) {
    const id = `bbf-${field.key}`;
    const required = contractRequired().includes(field.key);
    const box = el('input', { type: 'checkbox', id, checked: state.bb.fields.has(field.key) });
    box.addEventListener('change', () => {
      if (box.checked) state.bb.fields.add(field.key);
      else state.bb.fields.delete(field.key);
      updateFieldSummary();
    });
    grid.append(
      el('div', { class: ['field-cell', required ? 'is-required' : ''], data: { key: field.key } }, [
        box,
        el('label', { for: id }, [
          el('span', { class: 'field-name', text: `${FIELD_LABEL[field.key] || field.key}${required ? ' *' : ''}` }),
          el('span', { class: 'field-cli', text: field.cli }),
        ]),
      ]),
    );
  }
  const throttle = el('input', { type: 'checkbox', id: 'bbf-throttle', checked: true, disabled: true });
  grid.append(
    el('div', { class: 'field-cell', data: { key: 'throttle' } }, [
      throttle,
      el('label', { for: 'bbf-throttle' }, [
        el('span', { class: 'field-name', text: `${FIELD_LABEL.throttle} *` }),
        el('span', { class: 'field-cli', text: '始终记录 / 无 disable 位' }),
      ]),
    ]),
  );
  return grid;
}

/**
 * Blackbox config submit.
 *
 * mode 'dry'  -> pure dry-run, no dialog.
 * mode 'write' -> dry-run first (never writes), then the confirm-with-diff
 * dialog gates the real bf.bb.config({dryRun:false}) call.
 */
async function submitBbConfig(mode) {
  const payload = {
    rate: num(state.bb.rate) ?? REQUESTED_BB_RATE_DEFAULT,
    device: state.bb.device,
    fields: toggleableFields()
      .filter((f) => state.bb.fields.has(f.key))
      .map((f) => f.key),
  };
  showOpProgress('提交黑匣子配置…', null);
  const res = await run('黑匣子配置（试运行）', () => window.bf.bb.config({ ...payload, dryRun: true }));
  showOpProgress(null);
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  const diff = Array.isArray(out.diff) ? out.diff : [];
  state.bb.lastDiff = diff;
  state.bb.lastApplied = false;
  state.bb.lastPlan = out.ratePlan && typeof out.ratePlan === 'object' ? out.ratePlan : null;
  state.bb.lastWarnings = Array.isArray(out.warnings) ? out.warnings : [];
  state.done.add(0);

  if (mode === 'dry') {
    appendLog(infoEntry(`试运行完成：${diff.length} 项差异（未写入飞控）`, 'state'));
    await refreshSafety();
    renderStep(state.step);
    return;
  }
  if (!diff.length) {
    appendLog(warnEntry('试运行无差异，无需写入 / no diff to write'));
    await refreshSafety();
    renderStep(state.step);
    return;
  }
  appendLog(warnEntry(`已生成 ${diff.length} 项差异，等待确认写入`, 'safety'));
  confirmDiffDialog({
    title: '确认写入黑匣子配置',
    note: '以下 CLI 差异将真实写入飞控并保存。写入前请确认 dump 备份已生成（安全边界要求）。',
    diff,
    danger: true,
    onConfirm: async () => {
      showOpProgress('写入黑匣子配置…', null);
      const w = await run('黑匣子配置（真实写入）', () => window.bf.bb.config({ ...payload, dryRun: false }));
      showOpProgress(null);
      if (!w.ok) throw w.error;
      const wout = w.value && typeof w.value === 'object' ? w.value : {};
      state.bb.lastDiff = Array.isArray(wout.diff) ? wout.diff : diff;
      state.bb.lastApplied = Boolean(wout.applied);
      if (wout.ratePlan) state.bb.lastPlan = wout.ratePlan;
      appendLog(
        infoEntry(
          `已写入配置：${state.bb.lastDiff.length} 项差异${
            wout.verified === true ? '（读回校验通过 / verified）' : wout.verified === false ? '（读回校验未通过 / NOT verified）' : ''
          }`,
          'state',
        ),
      );
      await refreshSafety();
      renderStep(state.step);
    },
  });
}

function blackboxConfigCard() {
  ensureBbFields();
  const rateInput = el('input', {
    class: 'input mono-num',
    id: 'bb-rate',
    type: 'number',
    min: 100,
    max: 32000,
    step: 100,
    value: state.bb.rate,
  });
  rateInput.addEventListener('input', () => {
    state.bb.rate = num(rateInput.value) ?? 0;
    if (refs.rateNote && refs.rateNote.isConnected) refs.rateNote.textContent = bbDivisorNote();
  });

  const deviceSelect = el('select', { class: 'input', id: 'bb-device' });
  for (const value of ['auto', 'SPIFLASH', 'SDCARD', 'SERIAL']) {
    const opt = el('option', { value, text: `${DEVICE_LABEL[value] || value}` });
    if (state.bb.device === value) opt.selected = true;
    deviceSelect.append(opt);
  }
  deviceSelect.addEventListener('change', () => {
    state.bb.device = deviceSelect.value;
  });

  const dryBox = el('input', { type: 'checkbox', id: 'bb-dryrun', checked: state.bb.dryRun });
  const submitBtn = button(state.bb.dryRun ? '生成配置预览（试运行）' : '写入配置（真实写入）', {
    variant: state.bb.dryRun ? 'primary' : 'danger',
    // A real write is gated; the dry-run preview is analysis and stays usable
    // even in SAFE MODE.
    mutating: !state.bb.dryRun,
    gate: 'logging',
    enabled: () => state.bb.dryRun || !gateInfo('logging').blocked,
  });
  const submitHint = el('span', { class: 'hint' });

  const paintSubmit = () => {
    submitBtn.textContent = state.bb.dryRun ? '生成配置预览（试运行）' : '写入配置（真实写入）';
    submitHint.textContent = state.bb.dryRun
      ? '试运行：只计算将下发与将被写入的差异，不触碰飞控。'
      : '真实写入：先试运行生成 diff，再在确认对话框中二次确认。';
    submitHint.className = state.bb.dryRun ? 'hint' : 'hint warn';
    // The lock styling must follow the checkbox, not the state at build time.
    if (state.bb.dryRun) {
      delete submitBtn.dataset.mutating;
    } else {
      submitBtn.dataset.mutating = '1';
      submitBtn.dataset.gate = 'logging';
    }
  };
  paintSubmit();

  dryBox.addEventListener('change', () => {
    state.bb.dryRun = dryBox.checked;
    paintSubmit();
    refreshGuards();
  });

  action(submitBtn, '黑匣子配置', async () => submitBbConfig(state.bb.dryRun ? 'dry' : 'write'));

  refs.rateNote = el('span', { class: 'hint mono-num', text: bbDivisorNote() });
  refs.fieldWarn = el('span', { class: 'hint warn', hidden: true });

  const planNote = state.bb.lastPlan
    ? el('p', {
        class: 'hint',
        text: `上次试运行分频：1/${fmtInt(state.bb.lastPlan.denom)}（实际 ${fmtHz(state.bb.lastPlan.actualRate)}）`,
      })
    : null;

  const diffCard = state.bb.lastDiff
    ? card('差异预览 / diff', [
        el('p', {
          class: state.bb.lastApplied ? 'hint ok' : 'hint',
          text: state.bb.lastApplied ? '已写入飞控 / applied' : '尚未写入（试运行结果）/ not applied yet',
        }),
        state.bb.lastWarnings.length
          ? el('div', { class: 'chips' }, state.bb.lastWarnings.map((w) => chip(str(w), 'warn')))
          : null,
        diffTable(state.bb.lastDiff),
      ])
    : card('差异预览 / diff', [el('p', { class: 'hint', text: '运行一次配置后在此显示 before / after 差异。' })]);

  return [
    card(
      '配置 / Config',
      [
        el('div', { class: 'row' }, [
          el('div', {}, [
            el('label', { class: 'field-label', for: 'bb-rate', text: '采样率 / rate (Hz)' }),
            rateInput,
          ]),
          el('div', {}, [
            el('label', { class: 'field-label', for: 'bb-device', text: '介质 / device' }),
            deviceSelect,
          ]),
          el('div', {}, [el('span', { class: 'field-label', text: '分频 / divisor' }), refs.rateNote]),
        ]),
        planNote,
        el('div', {}, [
          el('span', { class: 'field-label', text: `记录字段 / fields（来源：${state.bb.fieldsSource}）` }),
          bbFieldGrid(),
          refs.fieldWarn,
          bidirOnHint(),
          el('p', { class: 'hint', text: '带 * 的字段是调参分析必需项；油门通道没有 disable 位，始终记录。' }),
        ]),
        el('div', { class: 'row' }, [
          dryBox,
          el('label', { for: 'bb-dryrun', text: 'dry-run 试运行（默认开启，不写入飞控）' }),
        ]),
        el('div', { class: 'row' }, [
          submitBtn,
          button('恢复必需字段 / Restore required', {
            variant: 'ghost',
            on: {
              click: () => {
                for (const key of contractRequired()) state.bb.fields.add(key);
                renderStep(state.step);
                appendLog(infoEntry('已按 REQUIRED_BB_FIELDS 勾选必需字段'));
              },
            },
          }),
          submitHint,
        ]),
      ],
      { badges: [badge(state.bb.dryRun ? 'dry-run 开启' : '真实写入模式', state.bb.dryRun ? 'ok' : 'crit')] },
    ),
    diffCard,
  ];
}

function blackboxMediaCard() {
  const caps = state.capabilities?.blackbox && typeof state.capabilities.blackbox === 'object' ? state.capabilities.blackbox : null;
  const live = state.bb.live;
  const capsDevice = str(caps?.device);
  const liveDevice = live && live.deviceName ? str(live.deviceName) : null;
  const mismatch = Boolean(liveDevice && capsDevice !== '—' && liveDevice !== capsDevice);
  return card(
    '介质自动检测 / Media auto-detect',
    [
      el('div', { class: 'row' }, [
        chip(`能力探测 / capabilities: ${capsDevice}`, 'info'),
        chip(`实时读取 / live: ${liveDevice || '尚未读取'}`, liveDevice ? 'ok' : 'warn'),
        mismatch ? chip('两处介质不一致 / mismatch', 'crit') : null,
      ]),
      el('p', { class: 'hint', text: '进入本页时自动读取一次实时配置（bf.bb.readConfig，SAFE MODE 下同样允许）；能力探测来自第 2 步。' }),
    ],
    { badges: [badge('自动检测 / auto', 'info')] },
  );
}

function blackboxEraseCard() {
  const input = el('input', {
    class: 'input mono',
    id: 'erase-confirm',
    type: 'text',
    placeholder: '输入 ERASE 以确认',
    value: state.bb.eraseText,
    attrs: { autocomplete: 'off', spellcheck: 'false' },
  });
  const eraseBtn = button('擦除日志 / Erase logs', { variant: 'danger', mutating: true, gate: 'logging' });
  guard(eraseBtn, () => state.bb.eraseText.trim() === 'ERASE');

  input.addEventListener('input', () => {
    state.bb.eraseText = input.value;
    refreshGuards();
  });

  action(eraseBtn, '擦除黑匣子日志', async () => {
    confirmDiffDialog({
      title: '确认擦除黑匣子日志',
      note: '擦除会永久删除飞控上已有的日志，且不可撤销。擦除前请确认日志已下载并备份。',
      diff: [{ param: 'blackbox erase', from: '—', to: str(state.bb.device) }],
      danger: true,
      onConfirm: async () => {
        const res = await run('擦除日志', () => window.bf.bb.erase({ device: state.bb.device, confirm: true }));
        if (!res.ok) throw res.error;
        const out = res.value && typeof res.value === 'object' ? res.value : {};
        if (out.ok === false) throw new Error(str(out.reason) || '擦除被拒绝');
        state.bb.lastMethod = out.method ?? null;
        state.bb.eraseText = '';
        appendLog(infoEntry(`擦除完成：ok=true method=${str(out.method)}`, 'state'));
        renderStep(state.step);
      },
    });
  });

  return card(
    '擦除 / Erase',
    [
      el('p', { class: 'hint warn', text: '擦除会永久删除飞控上已有的日志。擦除前请确认日志已下载并备份。' }),
      el('div', { class: 'row' }, [
        el('label', { class: 'field-label', for: 'erase-confirm', text: '键入 ERASE 以解锁擦除按钮' }),
        input,
        eraseBtn,
      ]),
      state.bb.lastMethod ? el('p', { class: 'hint', text: `上次擦除方式 / method: ${str(state.bb.lastMethod)}` }) : null,
    ],
    { badges: [badge('不可撤销 / irreversible', 'crit')] },
  );
}

/**
 * Live blackbox configuration (bf.bb.readConfig). Reading never writes, so this
 * control stays enabled in SAFE MODE; the auto-debug loop feeds the same panel.
 */
function blackboxLiveCard() {
  const live = state.bb.live;
  const readBtn = button(live ? '重新读取配置 / Re-read' : '读取黑匣子配置 / Read config', {
    variant: live ? 'ghost' : 'primary',
    enabled: () => state.connected,
  });
  action(readBtn, '读取黑匣子配置', async () => {
    const res = await run('读取黑匣子配置', () => window.bf.bb.readConfig());
    if (!res.ok) return;
    state.bb.live = res.value && typeof res.value === 'object' ? res.value : null;
    appendLog(infoEntry(`黑匣子配置：${describeBbConfig(state.bb.live)}`, 'state'));
    renderStep(state.step);
  });
  return card(
    '实时配置 / Live blackbox config',
    [el('div', { class: 'kv-grid', attrs: { id: 'bb-live-body' } }, [blackboxLiveBody(live)]), el('p', { class: 'hint', text: '读取操作在任何安全模式下都可用（bf.bb.readConfig）。' })],
    { actions: [readBtn], badges: [badge('只读 / read-only', 'ok')] },
  );
}

function blackboxLiveBody(live) {
  if (!live) return el('p', { class: 'hint', text: '尚未读取。点击「读取黑匣子配置」通过 MSP 读取实时配置。' });
  if (live.supported === false) return el('p', { class: 'hint warn', text: '飞控未报告黑匣子配置支持 / blackbox config not supported.' });
  const fields = Array.isArray(live.enabledFields) ? live.enabledFields : [];
  return kvGrid([
    kv('介质 / device', `${str(live.deviceName)} (${fmtInt(live.device)})`),
    kv('实际采样率 / actualRateHz', fmtHz(live.actualRateHz)),
    kv('分频 / rateNum:rateDenom', `${fmtInt(live.rateNum)} : ${fmtInt(live.rateDenom)}`),
    kv('采样率指数 / sampleRateExp', `${fmtInt(live.sampleRateExp)} (1/${2 ** clampExp(live.sampleRateExp)})`),
    kv('禁用掩码 / disabledMask', `0x${(Number(live.disabledMask) >>> 0).toString(16)}`),
    el('div', { class: 'kv' }, [
      el('span', { class: 'kv-k', text: `启用字段 / enabledFields (${fields.length})` }),
      el('span', { class: 'kv-v' }, [
        el('span', { class: 'chips' }, fields.length ? fields.map((f) => chip(FIELD_LABEL[f] || str(f), 'ok')) : [el('span', { class: 'hint warn', text: '无启用字段' })]),
      ]),
    ]),
  ]);
}

function describeBbConfig(live) {
  if (!live || typeof live !== 'object') return '不可用 / unavailable';
  const fields = Array.isArray(live.enabledFields) ? live.enabledFields : [];
  return `${str(live.deviceName)} · ${fmtHz(live.actualRateHz)} · ${fields.length} 个字段（${fields.join(', ') || '无'}）`;
}

/** Repaint the live config panel in place (used by the auto-debug loop). */
function paintBlackboxLive() {
  const host = $('#bb-live-body');
  if (!host || !host.isConnected) return;
  setChildren(host, [blackboxLiveBody(state.bb.live)]);
}

/**
 * Advanced manual CLI box.
 *
 * Dry-run is the default and always available; the real write path is gated by
 * the tuning lock and confirmed through the confirm-with-diff dialog. Commands
 * targeting the scoped bidir whitelist are refused here: the ONLY path that
 * writes dshot_bidir / motor_poles / rpm_filter_* is page 2's applyBidir flow.
 */
function manualCliCard() {
  const area = el('textarea', {
    class: 'input mono cli-input',
    id: 'cli-input',
    rows: 4,
    attrs: { spellcheck: 'false', placeholder: '每行一条 CLI 命令，例如：\nget blackbox_device\ndiff all' },
  });
  area.value = state.cli.text;
  area.addEventListener('input', () => {
    state.cli.text = area.value;
  });

  const commands = () =>
    state.cli.text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

  const dryBtn = button('试运行 / Dry-run', { variant: 'primary', enabled: () => state.connected && commands().length > 0 });
  action(dryBtn, 'CLI 试运行', async () => {
    const sent = commands();
    const bidirHits = sent.filter((c) => BIDIR_PARAM_RE.test(c));
    if (bidirHits.length) {
      throw new Error(`dshot_bidir / motor_poles / rpm_filter_* 只能通过第 2 步「双向DShot/RPM」专用流程写入：${bidirHits.join(' ; ')}`);
    }
    const res = await run('CLI 试运行', () => window.bf.fc.runCli(sent, true));
    state.cli.result = { dryRun: true, value: res.ok ? res.value : null, error: res.ok ? null : 'IPC 调用失败' };
    renderStep(state.step);
  });

  const sendBtn = button('真实写入 / Send (write)', {
    variant: 'danger',
    mutating: true,
    gate: 'tuning',
    enabled: () => state.connected && commands().length > 0,
  });
  action(sendBtn, 'CLI 真实写入', async () => {
    const sent = commands();
    const bidirHits = sent.filter((c) => BIDIR_PARAM_RE.test(c));
    if (bidirHits.length) {
      appendLog(warnEntry(`拒绝写入：${bidirHits.join(' ; ')} 必须走双向DShot/RPM 专用确认流程`, 'safety'));
      throw new Error(`dshot_bidir / motor_poles / rpm_filter_* 只能通过第 2 步「双向DShot/RPM」专用流程写入：${bidirHits.join(' ; ')}`);
    }
    confirmDiffDialog({
      title: '确认手动 CLI 真实写入',
      note: '以下命令将真实发送到飞控。主进程会逐条筛查禁止参数（failsafe / 电机方向 / ESC 协议 / 电压校准），禁止项永远被拒绝。',
      body: codeBlock(sent),
      danger: true,
      onConfirm: async () => {
        const res = await run('CLI 真实写入', () => window.bf.fc.runCli(sent, false));
        state.cli.result = { dryRun: false, value: res.ok ? res.value : null, error: res.ok ? null : 'IPC 调用失败' };
        if (!res.ok) throw res.error;
        const out = res.value && typeof res.value === 'object' ? res.value : {};
        if (out.ok === false) throw new Error(str(out.reason) || '写入被拒绝');
        appendLog(warnEntry(`手动 CLI 真实写入：${sent.length} 条命令，结果 ok`, 'safety'));
        renderStep(state.step);
      },
    });
  });

  const resultBlock = state.cli.result ? cliResultBlock(state.cli.result) : null;

  return card(
    '高级：手动 CLI / Advanced: manual CLI',
    [
      el('p', { class: 'hint warn', text: '手动 CLI 只用于诊断。主进程会逐条筛查：禁止参数（failsafe / 电机方向 / ESC 协议 / 电压校准）永远被拒绝；dshot_bidir / motor_poles / rpm_filter_* 在本机被拒绝，必须走第 2 步「双向DShot/RPM」专用流程。' }),
      el('label', { class: 'field-label', for: 'cli-input', text: '命令 / commands（每行一条）' }),
      area,
      el('div', { class: 'row' }, [dryBtn, el('span', { class: 'hint', text: 'dry-run 只返回将发送的命令，不触碰飞控。' })]),
      el('div', { class: 'row' }, [sendBtn, el('span', { class: 'hint', text: '真实写入：在确认对话框中二次确认后才会发送。' })]),
      resultBlock,
    ],
    { badges: [badge('dry-run 默认 / safe by default', 'ok'), badge('高风险 / advanced', 'crit')] },
  );
}

function cliResultBlock(result) {
  const value = result.value && typeof result.value === 'object' ? result.value : {};
  const wouldSend = Array.isArray(value.wouldSend) ? value.wouldSend : [];
  const blocked = Array.isArray(value.blocked) ? value.blocked : [];
  const lines = Array.isArray(value.lines) ? value.lines : [];
  const parts = [
    el('p', {
      class: value.ok === false ? 'hint crit' : 'hint ok',
      text: `${result.dryRun ? '试运行 / dry-run' : '真实写入 / written'}：ok=${str(value.ok)}${value.reason ? ` · reason=${str(value.reason)}` : ''}`,
    }),
  ];
  if (wouldSend.length) {
    parts.push(el('div', {}, [el('span', { class: 'field-label', text: `将发送 / wouldSend (${wouldSend.length})` }), codeBlock(wouldSend)]));
  }
  if (blocked.length) {
    parts.push(
      el('div', {}, [
        el('span', { class: 'field-label', text: `被拒绝 / blocked (${blocked.length})` }),
        el(
          'ul',
          { class: 'evidence' },
          blocked.map((b) => el('li', { text: `${str(b?.command)} — ${str(b?.reason)}` })),
        ),
      ]),
    );
  }
  if (lines.length) {
    const text = lines.map((l) => (typeof l === 'string' ? l : safeJson(l)));
    parts.push(el('div', {}, [el('span', { class: 'field-label', text: `回显 / lines (${lines.length})` }), codeBlock(text)]));
  }
  return el('div', { class: 'cli-result' }, parts);
}

/* ---------------- download + verification (merged into this page) ---------------- */

async function startDownload() {
  state.download.busy = true;
  state.download.progress = null;
  state.download.message = '开始下载…';
  renderStep(state.step);
  showOpProgress('下载黑匣子日志…', null);
  const res = await run('下载黑匣子日志', () => window.bf.bb.download({ verify: true }));
  state.download.busy = false;
  showOpProgress(null);
  if (!res.ok) {
    renderStep(state.step);
    return;
  }
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  state.download.path = out.path ?? null;
  state.download.logs = Array.isArray(out.logs) ? out.logs : [];
  if (state.download.path) state.file = state.download.path;
  state.done.add(1);
  appendLog(infoEntry(`下载完成：${str(state.download.path)}（${state.download.logs.length} 个日志段）`, 'state'));
  renderStep(state.step);
}

function verificationRows(log, requested) {
  const rows = [];
  const duration = num(log?.durationS);
  const dropRate = num(log?.dropRatePct);
  const rate = num(log?.sampleRateHz);
  rows.push({
    label: '时长 / duration',
    value: duration === null ? '—' : fmtSeconds(duration),
    // No duration requirement: this is reported for information only.
    verdict: duration === null ? 'warn' : 'ok',
    note: '供参考，无最短时长要求',
  });
  rows.push({
    label: '丢帧率 / drop rate',
    value: dropRate === null ? '—' : fmtPct(dropRate, 2),
    verdict: dropRate === null ? 'warn' : dropRate <= DROP_RATE_WARN_PCT ? 'ok' : dropRate <= DROP_RATE_FAIL_PCT ? 'warn' : 'crit',
    note: `丢帧 ${fmtInt(log?.droppedFrames)} / 共 ${fmtInt(log?.frameCount)} 帧`,
  });
  const delta = rate === null ? null : (rate - requested) / requested;
  rows.push({
    label: '实际采样率 / sample rate',
    value: rate === null ? '—' : fmtHz(rate),
    verdict: delta === null ? 'warn' : Math.abs(delta) <= SAMPLE_RATE_TOLERANCE ? 'ok' : 'crit',
    note: `请求 ${fmtInt(requested)} Hz，容差 ±${(SAMPLE_RATE_TOLERANCE * 100).toFixed(0)}%（偏差 ${delta === null ? '—' : fmtPct(delta * 100, 2)}）`,
  });
  return rows;
}

function worstVerdict(rows) {
  if (rows.some((r) => r.verdict === 'crit')) return 'crit';
  if (rows.some((r) => r.verdict === 'warn')) return 'warn';
  return 'ok';
}

function downloadVerifyCard() {
  const logs = state.download.logs;
  if (!logs.length) {
    return card('校验 / Verification', [el('p', { class: 'hint', text: '下载完成后在此显示时长、丢帧率与实际采样率校验结果。' })]);
  }
  const last = logs[logs.length - 1];
  const requested = num(state.bb.rate) ?? REQUESTED_BB_RATE_DEFAULT;
  const rows = verificationRows(last, requested);
  const verdict = worstVerdict(rows);
  const verdictText = verdict === 'ok' ? '校验通过 / pass' : verdict === 'warn' ? '部分指标需要注意 / warnings' : '校验未通过 / fail';
  const logRows = logs.map((l, i) => [
    { class: 'mono-num', text: `#${fmtInt(l?.index ?? i)}` },
    { class: 'mono-num', text: l?.durationS === undefined ? '—' : fmtSeconds(l.durationS) },
    { class: 'mono-num', text: fmtInt(l?.frameCount) },
    { class: 'mono-num', text: fmtPct(l?.dropRatePct, 2) },
    { class: 'mono-num', text: fmtHz(l?.sampleRateHz) },
    { class: 'mono-num', text: Array.isArray(l?.axesPresent) ? l.axesPresent.join(', ') : '—' },
  ]);
  return card(
    '校验 / Verification',
    [
      banner(verdict, verdictText, [para(`文件 / file: ${str(state.download.path)}`)]),
      table(
        [
          { text: '校验项 / check' },
          { text: '实测 / value', class: 'num' },
          { text: '判定 / verdict' },
          { text: '基准 / reference', class: 'num' },
        ],
        rows.map((r) => [
          { text: r.label },
          { class: 'mono-num num', text: r.value },
          badge(r.verdict === 'ok' ? 'PASS' : r.verdict === 'warn' ? 'WARN' : 'FAIL', r.verdict),
          { class: 'mono-num num', text: r.note },
        ]),
      ),
      el('div', {}, [el('span', { class: 'field-label', text: '日志段 / logs' }), table(['#', '时长', '帧数', '丢帧率', '采样率', '轴'], logRows)]),
    ],
    { badges: [badge(verdict === 'ok' ? 'PASS' : verdict.toUpperCase(), verdict)] },
  );
}

function downloadCard() {
  const busy = state.download.busy;
  const bar = el(
    'div',
    {
      class: ['meter', state.download.progress === null ? 'meter-warn' : 'meter-ok'],
      attrs: {
        role: 'progressbar',
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': state.download.progress === null ? '0' : String(Math.round(clamp01(state.download.progress) * 100)),
        'aria-label': '下载进度',
      },
    },
    [
      el('div', {
        class: 'meter-fill',
        style: { width: state.download.progress === null ? (busy ? '40%' : '0%') : `${(clamp01(state.download.progress) * 100).toFixed(1)}%` },
      }),
    ],
  );
  refs.downloadBar = bar;
  const msg = el('span', { class: 'hint', text: state.download.message || (busy ? '下载中…' : '等待开始 / idle') });
  refs.downloadMsg = msg;

  const downloadBtn = button(busy ? '下载中…' : '下载日志 / Download', {
    variant: 'primary',
    enabled: () => state.connected && !busy,
  });
  action(downloadBtn, '下载日志', startDownload);

  // Download and analysis now share one page, so this is no longer a "go to the
  // analysis page" button: it chains straight into the analysis pass.
  const analyseBtn = button('下载并分析 / Download & analyse', {
    variant: 'ghost',
    enabled: () => state.connected && !busy,
  });
  action(analyseBtn, '下载并分析', async () => {
    if (!state.download.path) await startDownload();
    if (state.download.path) await runMetrics();
  });

  return card(
    '下载 / Download',
    [
      el('p', { class: 'hint', text: '通过 MSP 流式读取黑匣子数据；进度来自 download-progress 事件。「下载并分析」= 下载 + 运行分析，一步到位。' }),
      el('div', { class: 'row' }, [downloadBtn, analyseBtn]),
      bar,
      msg,
    ],
    { badges: [badge(state.download.path ? '已下载 / downloaded' : '未下载 / idle', state.download.path ? 'ok' : 'idle')] },
  );
}

/* ---------------- mass storage (MSC) reading of oversized logs ---------------- */

const MSC_FILE_RE = /\.bbl$/i;

/** bf.bb.mscStatus() payload, or null when it has not been read yet. */
function mscStatus() {
  return state.msc.status && typeof state.msc.status === 'object' ? state.msc.status : null;
}

function mscVolumes() {
  const volumes = mscStatus()?.volumes;
  return Array.isArray(volumes) ? volumes : [];
}

/** Stable selection key for one file on one mounted volume. */
function mscKey(volumePath, name) {
  return `${String(volumePath)}\u0000${String(name)}`;
}

/** Every .bbl file currently visible on a mounted volume. */
function mscBblFiles() {
  const out = [];
  for (const volume of mscVolumes()) {
    const volumePath = String(volume?.path || '');
    const files = Array.isArray(volume?.files) ? volume.files : [];
    for (const file of files) {
      const name = String(file?.name || '');
      if (!name || !MSC_FILE_RE.test(name)) continue;
      out.push({ volume, volumePath, file, name, key: mscKey(volumePath, name) });
    }
  }
  return out;
}

function mscSelectedFiles() {
  const chosen = state.msc.selected;
  return mscBblFiles().filter((entry) => chosen.has(entry.key));
}

/** Re-read the mounted volumes; silently coalesces a concurrent call. */
async function refreshMscStatus(opts = {}) {
  if (state.msc.busy) return null;
  state.msc.busy = true;
  const res = await run('读取 MSC 状态', () => window.bf.bb.mscStatus());
  state.msc.busy = false;
  if (!res.ok) return null;
  const value = res.value && typeof res.value === 'object' ? res.value : {};
  state.msc.status = { inMsc: Boolean(value.inMsc), volumes: Array.isArray(value.volumes) ? value.volumes : [] };
  // Drop ticks for files that are no longer mounted.
  const live = new Set(mscBblFiles().map((entry) => entry.key));
  for (const key of [...state.msc.selected]) if (!live.has(key)) state.msc.selected.delete(key);
  if (!opts.silent) {
    const files = mscBblFiles().length;
    appendLog(
      infoEntry(
        `MSC 状态：${state.msc.status.inMsc ? '已进入大容量模式' : '未进入'} · ${state.msc.status.volumes.length} 个卷 · ${files} 个 .bbl`,
        'state',
      ),
    );
  }
  renderStep(state.step);
  return state.msc.status;
}

async function mscEnter() {
  const res = await run('进入 MSC', () => window.bf.bb.mscEnter());
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  state.msc.message = hasText(out.message) ? String(out.message) : hasText(out.volumeHint) ? String(out.volumeHint) : '';
  if (out.ok === false) {
    appendLog(warnEntry(`进入 MSC 被拒绝 / refused：${str(out.message ?? out.reason)}`, 'safety'));
  } else {
    state.msc.selected.clear();
    state.msc.lastImport = null;
    appendLog(
      warnEntry(
        `已请求进入 MSC 大容量模式${hasText(out.message) ? `：${out.message}` : ''}${hasText(out.volumeHint) ? ` · 卷提示 / volumeHint：${out.volumeHint}` : ''}`,
        'safety',
      ),
    );
  }
  state.msc.tried = true;
  await refreshMscStatus({ silent: true });
}

async function mscImportSelected() {
  const picked = mscSelectedFiles();
  if (!picked.length) {
    appendLog(warnEntry('未勾选任何 .bbl 日志 / nothing selected'));
    renderStep(state.step);
    return;
  }
  const byVolume = new Map();
  for (const entry of picked) {
    if (!byVolume.has(entry.volumePath)) byVolume.set(entry.volumePath, []);
    byVolume.get(entry.volumePath).push(entry.name);
  }

  const imported = [];
  for (const [volumePath, files] of byVolume) {
    // One call per mounted volume: bf.bb.mscImport() takes a single volumePath.
    const res = await run(`导入 MSC 日志 ${volumePath}`, () => window.bf.bb.mscImport({ volumePath, files }));
    if (!res.ok) continue;
    const out = res.value && typeof res.value === 'object' ? res.value : {};
    if (out.ok === false) {
      appendLog(warnEntry(`导入被拒绝 / refused：${str(out.reason ?? out.message)}`, 'safety'));
      continue;
    }
    if (Array.isArray(out.imported)) imported.push(...out.imported);
    // A per-file copy failure still reports ok=true; never hide those entries.
    const failed = Array.isArray(out.failed) ? out.failed : [];
    if (failed.length) {
      appendLog(warnEntry(`有 ${failed.length} 个文件未能导入 / not imported：${failed.map((f) => `${str(f?.name)}（${str(f?.reason)}）`).join('；')}`));
    }
  }

  if (imported.length) {
    const bytes = imported.reduce((sum, entry) => sum + (num(entry?.bytes) ?? 0), 0);
    state.msc.lastImport = { imported };
    appendLog(infoEntry(`已导入 ${imported.length} 个日志文件，共 ${fmtBytes(bytes)}`, 'state'));
    state.msc.selected.clear();
  } else {
    appendLog(warnEntry('本次导入没有文件落地 / nothing imported'));
  }
  await refreshMscStatus({ silent: true });
}

async function mscExit() {
  const res = await run('弹出并退出 MSC', () => window.bf.bb.mscExit());
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  state.msc.message = hasText(out.message) ? String(out.message) : '';
  if (out.ok === false) {
    appendLog(warnEntry(`弹出并退出被拒绝 / refused：${str(out.message ?? out.reason)}`, 'safety'));
  } else {
    appendLog(infoEntry(`已弹出并退出 MSC：${str(out.message)}。请给飞控重新上电以恢复 MSP 会话。`, 'safety'));
  }
  await refreshMscStatus({ silent: true });
}

function mscFileTable(files) {
  const rows = files.map((entry, i) => {
    const id = `msc-file-${i}`;
    const box = el('input', { type: 'checkbox', id, checked: state.msc.selected.has(entry.key) });
    box.addEventListener('change', () => {
      if (box.checked) state.msc.selected.add(entry.key);
      else state.msc.selected.delete(entry.key);
      refreshGuards(); // the import button is enabled by the tick set
    });
    return [
      { node: el('div', { class: 'row' }, [box, el('label', { class: 'mono-num', for: id, text: entry.name, title: str(entry.file?.path) })]) },
      { class: 'mono-num num', text: fmtBytes(entry.file?.size) },
      { class: 'mono-num', text: fmtDateTime(entry.file?.mtime) },
    ];
  });
  return table(
    [{ text: '日志文件 / .bbl file' }, { text: '大小 / size', class: 'num' }, { text: '修改时间 / mtime' }],
    rows,
  );
}

/**
 * "大容量读取 (MSC)": onboard flash logs too large for MSP are read by
 * rebooting the FC into mass-storage mode, then importing from the mounted
 * volume. While the FC is in that mode there is no MSP link at all, so every
 * write control in the app is disabled (see safetyInfo()) until eject +
 * power-cycle.
 */
function mscCard() {
  const status = mscStatus();
  const inMsc = mscActive();
  const volumes = mscVolumes();
  const files = mscBblFiles();
  const selected = mscSelectedFiles();

  const enterBtn = button(inMsc ? 'MSC 已进入 / In MSC' : '进入 MSC / Enter MSC', {
    variant: 'primary',
    enabled: () => state.connected && !mscActive() && !state.msc.busy,
  });
  enterBtn.title = state.connected ? '飞控将重启为 USB 大容量存储设备' : '需要先连接飞控 / connect first';
  action(enterBtn, '进入 MSC', mscEnter);

  const refreshBtn = button('刷新卷 / Refresh volumes', { variant: 'ghost', enabled: () => !state.msc.busy });
  action(refreshBtn, '刷新 MSC 卷', async () => {
    await refreshMscStatus();
  });

  const importBtn = button(`导入选中日志 / Import selected${selected.length ? ` (${selected.length})` : ''}`, {
    variant: 'primary',
    enabled: () => mscSelectedFiles().length > 0,
  });
  action(importBtn, '导入选中日志', mscImportSelected);

  const exitBtn = button('弹出并退出 / Eject & exit', { variant: 'danger', enabled: () => mscActive() && !state.msc.busy });
  exitBtn.title = mscActive() ? '卸载卷并把飞控切回正常 MSP 模式' : '仅在 MSC 模式可用';
  action(exitBtn, '弹出并退出 MSC', mscExit);

  const parts = [
    el('p', {
      class: 'prose',
      text: '板载 Flash 上的日志常常超过 MSP 的读取能力：把飞控重启成 USB 大容量存储（MSC）模式后，日志会作为一个卷挂载到 macOS 桌面，直接按文件复制即可，速度快且不受 MSP 带宽限制。',
    }),
    el('ul', { class: 'evidence' }, [
      el('li', { text: '1 · 点击「进入 MSC / Enter MSC」：飞控重启为 USB 存储设备，MSP 会话中断。' }),
      el('li', { text: '2 · 卷会出现在 macOS 桌面（通常名为 BLACKBOX / BF-BBL 等）；点「刷新卷 / Refresh volumes」让本界面列出其中的 .bbl。' }),
      el('li', { text: '3 · 勾选要导入的日志，点「导入选中日志 / Import selected」复制到本地日志目录；导入的是文件副本，不会删除飞控上的日志。' }),
      el('li', { text: '4 · 完成后点「弹出并退出 / Eject & exit」，再给飞控断电重新上电（或拔插 USB），回到正常 MSP 模式。' }),
    ]),
    inMsc
      ? banner('crit', 'MSC 大容量模式：MSP 写入不可用 / MSP writes unavailable', [
          para('飞控当前是 USB 存储设备，不是 MSP 目标：PID / 滤波器 / 黑匣子配置等一切写入都无法进行，相关按钮已全部禁用。'),
          para('请在卷上完成日志导入，然后「弹出并退出」并重新上电；写入能力会在 MSP 会话恢复后自动回到之前的安全状态。'),
        ])
      : null,
    el('div', { class: 'row' }, [enterBtn, refreshBtn, importBtn, exitBtn]),
    state.msc.message ? el('p', { class: 'hint', text: `飞控消息 / message：${state.msc.message}` }) : null,
    status
      ? kvGrid([
          kv('模式 / mode', inMsc ? badge('MSC 大容量 / mass-storage', 'warn') : badge('正常 MSP / normal', 'ok')),
          kv('卷数量 / volumes', fmtInt(volumes.length)),
          kv('检测到 .bbl / files', fmtInt(files.length)),
          kv('已勾选 / selected', fmtInt(selected.length)),
        ])
      : el('p', { class: 'hint', text: '尚未读取 MSC 状态。点击「刷新卷 / Refresh volumes」检测是否已有卷挂载（读取操作，任何安全模式下都可用）。' }),
    volumes.length
      ? el(
          'div',
          { class: 'msc-vols' },
          volumes.map((volume) => {
            const listed = files.filter((entry) => entry.volume === volume);
            const total = Array.isArray(volume?.files) ? volume.files.length : listed.length;
            const other = total - listed.length;
            return el('div', { class: 'msc-vol' }, [
              el('div', { class: 'msc-vol-head' }, [
                el('span', { class: 'mono-num', text: str(volume?.name) }),
                el('span', { class: 'hint mono-num', text: str(volume?.path) }),
                chip(`${listed.length} 个 .bbl / logs`, 'info'),
                // The volume may hold other log types too; say so instead of
                // letting the count disagree with the table below it.
                other > 0 ? chip(`另有 ${other} 个非 .bbl 文件未列出 / hidden`, 'idle') : null,
              ]),
              listed.length ? mscFileTable(listed) : el('p', { class: 'hint', text: '该卷上没有 .bbl 文件 / no .bbl on this volume' }),
            ]);
          }),
        )
      : el('p', { class: 'hint', text: inMsc ? '尚未检测到卷：请在 macOS 桌面确认卷已挂载，然后点击「刷新卷」。' : '未检测到 MSC 卷（当前不是大容量模式）。' }),
    state.msc.lastImport
      ? el('div', {}, [
          el('span', { class: 'field-label', text: `上次导入 / last import (${state.msc.lastImport.imported.length})` }),
          table(
            ['来源 / from', '落地 / to', '大小 / bytes'],
            state.msc.lastImport.imported.map((entry) => [
              { class: 'mono-num', text: str(entry?.from) },
              { class: 'mono-num', text: str(entry?.to) },
              { class: 'mono-num num', text: fmtBytes(entry?.bytes) },
            ]),
          ),
        ])
      : null,
  ];

  return card('大容量读取 (MSC) / Mass storage', parts, {
    badges: [
      inMsc ? badge('MSC 模式 / in MSC', 'warn') : badge('未进入 MSC / not in MSC', 'idle'),
      badge('读取 + 本地导入 / read + local import', 'ok'),
    ],
  });
}

/* ================================================================== *
 * 17. Flight guidance (folded into the analyze page - it has no actions)
 * ================================================================== */

/**
 * Guided test flights, fetched once from the main process (bbl:flight_cards)
 * so the renderer never carries its own copy of the evidence thresholds.
 */
async function loadFlightCards() {
  if (state.flight.loading || state.flight.cards) return;
  state.flight.loading = true;
  const res = await run('读取试飞科目', () => window.bf.bbl.flightCards());
  state.flight.loading = false;
  if (!res.ok) {
    state.flight.error = str(res.error) || '读取失败';
    return;
  }
  const value = res.value && typeof res.value === 'object' ? res.value : {};
  state.flight.cards = Array.isArray(value.cards) ? value.cards : [];
  state.flight.needs = value.needs && typeof value.needs === 'object' ? value.needs : null;
  if (state.step !== undefined) renderStep(state.step);
}

/** One test-flight card: title, goal, steps; a tick box remembers it was flown. */
function flightCardEl(c, { needed = false } = {}) {
  const id = `flight-${str(c?.id)}`;
  const box = el('input', { type: 'checkbox', id, checked: state.capture.checked.has(c?.id) });
  box.addEventListener('change', () => {
    if (box.checked) state.capture.checked.add(c.id);
    else state.capture.checked.delete(c.id);
    box.closest('.flight-card')?.classList.toggle('is-checked', box.checked);
  });
  const steps = Array.isArray(c?.steps) ? c.steps : [];
  return el('div', { class: ['flight-card', needed ? 'is-needed' : '', state.capture.checked.has(c?.id) ? 'is-checked' : ''] }, [
    el('div', { class: 'flight-card-head' }, [
      box,
      el('label', { for: id, class: 'flight-card-title', text: str(c?.title) }),
      needed ? badge('需要补飞', 'warn') : c?.optional ? badge('可选', 'idle') : null,
    ]),
    el('p', { class: 'hint', text: str(c?.goal) }),
    el('ol', { class: 'flight-steps' }, steps.map((t) => el('li', { text: str(t) }))),
  ]);
}

/**
 * How to fly. There is no timer: each analysis domain needs specific evidence
 * (stick inputs, throttle chops, high-throttle time, raw gyro) and the
 * evidence checklist after an analysis says which of these cards to fly.
 */
function flightGuidanceCard() {
  if (!state.flight.cards && !state.flight.loading && !state.flight.error) loadFlightCards();
  const cards = Array.isArray(state.flight.cards) ? state.flight.cards : [];
  const needed = new Set(Array.isArray(state.metrics?.evidence?.flights) ? state.metrics.evidence.flights : []);
  const core = cards.filter((c) => !c?.optional);
  const optional = cards.filter((c) => c?.optional);
  return card(
    '试飞科目 / Test flights',
    [
      el('p', {
        class: 'prose',
        text: '不限飞行时长。每类分析需要特定的数据（打杆、收油门、高油门、原始陀螺），数据够了就能出结论；分析后的「证据清单」会标出还要补飞哪一项。',
      }),
      cards.length
        ? el('div', { class: 'flight-cards' }, [...core, ...optional].map((c) => flightCardEl(c, { needed: needed.has(c?.id) })))
        : el('p', { class: 'hint', text: state.flight.error ? `试飞科目读取失败：${state.flight.error}` : '正在读取试飞科目…' }),
      el('ul', { class: 'evidence' }, [
        el('li', { text: '不要在室内或有人靠近时解锁；螺旋桨按当地安全规范安装。落地后先上锁再断开电池。' }),
      ]),
    ],
    { badges: [badge(needed.size ? `需补飞 ${needed.size} 项` : '按需飞行 / evidence-driven', needed.size ? 'warn' : 'info')] },
  );
}

/* ---------------- evidence checklist ---------------- */

const EVIDENCE_ORDER = ['logging', 'steps', 'tracking', 'propwash', 'noise', 'noiseOpen', 'rpm'];
const AXIS_ZH = { roll: '横滚', pitch: '俯仰', yaw: '偏航' };

/** What the log holds for one domain, in one short line. */
function evidenceHaveText(key, d) {
  if (d?.axes && typeof d.axes === 'object') {
    return ['roll', 'pitch', 'yaw']
      .filter((a) => d.axes[a])
      .map((a) => `${AXIS_ZH[a]} ${key === 'tracking' ? fmtNum(d.axes[a].have, 2) : fmtInt(d.axes[a].have)}/${key === 'tracking' ? fmtNum(d.axes[a].need, 2) : fmtInt(d.axes[a].need)}`)
      .join(' · ');
  }
  if (key === 'logging') return `${fmtHz(d?.have?.sampleRateHz)} · gyroUnfilt ${d?.have?.gyroUnfilt ? '有' : '无'}`;
  if (key === 'rpm') return d?.have ? 'eRPM 有' : 'eRPM 无';
  if (key === 'noiseOpen') return `${fmtNum(d?.have, 1)} s / 需 ${fmtNum(d?.need, 1)} s`;
  if (key === 'propwash') return `${fmtInt(d?.have)} 段 / 需 ${fmtInt(d?.need)}`;
  if (key === 'noise') return `${fmtInt(d?.have)} 段平均 / 需 ${fmtInt(d?.need)}`;
  return str(d?.have);
}

function evidenceCard(metrics) {
  const ev = metrics?.evidence;
  if (!ev || typeof ev !== 'object' || !ev.domains || typeof ev.domains !== 'object') return null;
  const keys = EVIDENCE_ORDER.filter((k) => ev.domains[k]);
  const missing = keys.filter((k) => !ev.domains[k].ok);
  const rows = keys.map((k) => {
    const d = ev.domains[k];
    return el('div', { class: ['evidence-row', d.ok ? 'is-ok' : 'is-short'] }, [
      badge(d.ok ? '足够' : '不足', d.ok ? 'ok' : 'warn'),
      el('span', { class: 'evidence-label', text: str(d.label) }),
      el('span', { class: 'evidence-have mono-num', text: evidenceHaveText(k, d) }),
      d.ok || !d.advice ? null : el('span', { class: 'evidence-advice hint', text: str(d.advice) }),
    ]);
  });
  const tp = metrics?.throttleProfile;
  return card(
    '证据清单 / Evidence',
    [
      el('p', {
        class: 'prose',
        text: '每类建议只在它所需的数据足够时给出；不足的领域本轮不改参数，只告诉你补飞什么。放宽任何滤波都要求日志里有足够的高油门数据。',
      }),
      el('div', { class: 'evidence-grid' }, rows),
      tp?.available
        ? el('p', {
            class: 'hint',
            text: `油门分布（0–25/25–50/50–75/75–100%）：${(tp.bandsS || []).map((v) => `${fmtNum(v, 1)} s`).join(' / ')}，最高 ${fmtInt(tp.maxPct)}%。`,
          })
        : el('p', { class: 'hint', text: '无法识别油门通道的刻度，按「没有高油门数据」处理。' }),
    ],
    { badges: [badge(missing.length ? `${keys.length - missing.length}/${keys.length} 足够` : '全部足够', missing.length ? 'warn' : 'ok')] },
  );
}

/* ---------------- mechanical health ---------------- */

function mechanicalCard(metrics) {
  const mech = metrics?.mechanical;
  if (!mech || typeof mech !== 'object') return null;
  const once = mech.onceVibration;
  const reso = mech.resonance;
  const parts = [
    el('p', {
      class: 'prose',
      text: '这些是改参数解决不了的问题：先修机械，再调 PID/滤波。单个电机的一阶（每转一次）振动偏大通常是桨不平衡/桨损或弯轴；在各个转速档都不动的峰是机架/机臂/飞塔共振，随转速移动的峰是电机噪声。',
    }),
  ];

  if (once?.available) {
    const motors = Array.isArray(once.motors) ? once.motors : [];
    const outlierIndex = once.outlier ? once.outlier.index : -1;
    parts.push(el('span', { class: 'field-label', text: '单电机一阶振动 / per-motor 1x' }));
    parts.push(
      el('div', { class: 'motor-grid' }, motors.map((m) =>
        el('div', { class: ['motor-cell', m.index === outlierIndex ? 'is-outlier' : ''] }, [
          el('span', { class: 'motor-name', text: `M${fmtInt(m.index + 1)}` }),
          el('span', { class: 'mono-num', text: m.amplitudeDps === null || m.amplitudeDps === undefined ? '—' : `${fmtNum(m.amplitudeDps, 2)} °/s` }),
          el('span', { class: 'hint', text: num(m.ratioToOthers) === null ? `${fmtInt(m.windows)} 窗` : `×${fmtNum(m.ratioToOthers, 2)} · SNR ${fmtNum(m.snr, 1)} · ${fmtHz(m.meanHz)}` }),
        ]),
      )),
    );
    parts.push(
      once.outlier
        ? banner('warn', `M${once.outlier.index + 1} 一阶振动偏大`, [para(`是其他电机中位数的 ×${fmtNum(once.outlier.ratioToOthers, 2)}（阈值 ×1.8）。落地后检查该电机的桨（缺口、变形、装反）与电机轴，换桨后复飞对比。`)])
        : el('p', { class: 'hint', text: '没有单个电机明显偏大（阈值：其他电机中位数的 ×1.8 且信噪比 ≥ 2.5）。' }),
    );
  } else {
    parts.push(el('p', { class: 'hint', text: `单电机一阶振动：无法评估 — ${str(once?.reason) || '数据不足'}` }));
  }

  if (reso?.available) {
    const unit = reso.speedUnit === 'hz' ? '电机转速' : '油门';
    const fmtSpeed = (v) => (reso.speedUnit === 'hz' ? fmtHz(v) : fmtPct((num(v) ?? 0) * 100, 0));
    parts.push(el('span', { class: 'field-label', text: `共振分类（按${unit}分 ${fmtInt(reso.bands?.length)} 档）/ resonance` }));
    parts.push(
      el('ul', { class: 'evidence' }, (reso.bands || []).map((b) =>
        el('li', { text: `${unit} ${fmtSpeed(b.speed)}：原始陀螺峰 ${(b.peakHz || []).map((h) => `${h} Hz`).join('、') || '无'}` }),
      )),
    );
    const fixed = reso.resonances || [];
    const moving = reso.tracking || [];
    parts.push(
      el('div', { class: 'chips' }, [
        ...fixed.map((r) => chip(`固定 ${r.hz} Hz · ${fmtNum(r.prominenceDb, 1)} dB${r.survivesFilter ? ' · 滤波后仍残留' : ''}`, r.survivesFilter ? 'warn' : 'idle')),
        ...moving.map((t) => chip(`随转速移动 ${t.hz} Hz`, 'info')),
      ]),
    );
    if (!fixed.length && !moving.length) parts.push(el('p', { class: 'hint', text: '没有足够显著、可分类的峰。' }));
  } else {
    parts.push(el('p', { class: 'hint', text: `共振分类：无法评估 — ${str(reso?.reason) || '数据不足'}` }));
  }

  const flagged = Boolean(once?.outlier) || (reso?.resonances || []).some((r) => r.survivesFilter);
  return card('机械健康 / Mechanical', parts, { badges: [badge(flagged ? '需检查' : '未见异常', flagged ? 'warn' : 'ok')] });
}

/* ---------------- campaign plan + racing scorecard ---------------- */

const STAGE_LABEL = { logging: '记录设置', mechanical: '机械', filters: '滤波', pd: 'P/D 平衡', feel: '手感' };
const STAGE_STATUS = {
  ok: ['完成', 'ok'],
  action: ['有建议', 'info'],
  check: ['需检查', 'warn'],
  'needs-data': ['需补飞', 'warn'],
  blocked: ['阻断', 'crit'],
};
const GRADE_TONE = { ok: 'ok', warn: 'warn', crit: 'crit', na: 'idle' };
const GRADE_TEXT = { ok: '好', warn: '一般', crit: '差', na: '无数据' };

function campaignCard(plan) {
  if (!plan || !Array.isArray(plan.stages)) return null;
  const steps = plan.stages.map((s, i) => {
    const [label, tone] = STAGE_STATUS[s.status] || [str(s.status), 'idle'];
    return el('div', { class: ['stage', plan.current === s.id ? 'is-current' : '', `stage-${s.status}`] }, [
      el('div', { class: 'stage-head' }, [
        el('span', { class: 'stage-index mono-num', text: String(i + 1) }),
        el('span', { class: 'stage-title', text: str(s.title) }),
        badge(label, tone),
      ]),
      el('p', { class: 'hint', text: str(s.goal) }),
      s.actions?.length ? el('p', { class: 'hint', text: `建议：${s.actions.join('、')}` }) : null,
      s.withheld?.length ? el('p', { class: 'hint', text: `证据不足暂缓：${s.withheld.join('、')}` }) : null,
      (s.issues || []).length ? el('p', { class: 'hint', text: `问题：${s.issues.map((x) => str(x.code)).join('、')}` }) : null,
    ]);
  });
  return card(
    '调参路线 / Campaign',
    [
      el('p', { class: 'prose', text: str(plan.summary) }),
      el('div', { class: 'stages' }, steps),
      el('p', { class: 'hint', text: '顺序：记录设置 → 机械 → 滤波 → P/D 平衡 → 手感（FF/I/TPA）。前一阶段没处理好时，后一阶段测到的数字不可信。本路线只做提示，写入仍走原来的安全流程，每次会话最多一轮。' }),
    ],
    { badges: [badge(plan.current ? `当前：${STAGE_LABEL[plan.current] || plan.current}` : '无需改动', plan.current ? 'info' : 'ok')] },
  );
}

function kpiValueText(k) {
  if (k?.value === null || k?.value === undefined) return '—';
  return `${fmtNum(k.value, k.unit ? 1 : 3)}${k.unit ? ` ${k.unit}` : ''}`;
}

function scorecardCard(scorecard) {
  const kpis = Array.isArray(scorecard?.kpis) ? scorecard.kpis : [];
  if (!kpis.length) return null;
  return card(
    '竞速成绩单 / Racing scorecard',
    [
      el('p', { class: 'prose', text: '用来在多次飞行之间对比的几个关键数字。评级是五寸竞速的参考区间，不会直接触发任何参数修改。' }),
      el('div', { class: 'kpi-grid' }, kpis.map((k) =>
        el('div', { class: ['kpi', `kpi-${k.grade}`] }, [
          el('span', { class: 'kpi-label', text: str(k.label) }),
          el('span', { class: 'kpi-value mono-num', text: kpiValueText(k) }),
          badge(GRADE_TEXT[k.grade] || str(k.grade), GRADE_TONE[k.grade] || 'idle'),
          el('span', { class: 'hint', text: str(k.source) }),
        ]),
      )),
    ],
    {},
  );
}

/* ---------------- per-quad journal (History page) ---------------- */

async function loadJournalList() {
  if (state.journal.loading) return;
  state.journal.loading = true;
  const res = await run('读取机体档案', () => window.bf.journal.list());
  state.journal.loading = false;
  state.journal.loaded = true;
  if (res.ok) {
    const value = res.value && typeof res.value === 'object' ? res.value : {};
    state.journal.quads = Array.isArray(value.quads) ? value.quads : [];
    if (!state.journal.selected && state.journal.quads.length) state.journal.selected = state.journal.quads[0].id;
    if (state.journal.selected) await loadJournalQuad(state.journal.selected, { render: false });
  }
  renderStep(state.step);
}

async function loadJournalQuad(id, { render = true } = {}) {
  const res = await run('读取机体时间线', () => window.bf.journal.get(id));
  if (res.ok && res.value?.quad) {
    state.journal.selected = id;
    state.journal.doc = res.value.quad;
    state.journal.draft = { ...(res.value.quad.profile || {}) };
  }
  if (render) renderStep(state.step);
}

async function saveJournalProfile() {
  const id = state.journal.selected;
  if (!id) return;
  const res = await run('保存机体资料', () => window.bf.journal.setProfile(id, state.journal.draft));
  if (res.ok) appendLog(infoEntry(`机体资料已保存：${id}`));
  await loadJournalQuad(id);
}

async function addJournalNote() {
  const id = state.journal.selected;
  const text = String(state.journal.note || '').trim();
  if (!id || !text) return;
  const res = await run('添加笔记', () => window.bf.journal.addNote(id, text));
  if (res.ok) state.journal.note = '';
  await loadJournalQuad(id);
}

const PROFILE_INPUTS = [
  ['name', '名称', 'text'],
  ['frame', '机架', 'text'],
  ['props', '桨', 'text'],
  ['motors', '电机', 'text'],
  ['motorKv', 'KV', 'number'],
  ['cells', '电池 S 数', 'number'],
  ['weightG', '起飞重量 g', 'number'],
];

function journalEntryText(e) {
  if (e.kind === 'analysis') {
    const k = Object.fromEntries((e.scorecard?.kpis || []).map((x) => [x.key, x]));
    return `分析 · 阶段 ${STAGE_LABEL[e.stage] || '无需改动'} · 延迟 ${kpiValueText(k.delayMs)} · 超调 ${kpiValueText(k.overshootPct)} · 洗桨 ${kpiValueText(k.propwash)}` +
      (e.missing?.length ? ` · 证据不足 ${e.missing.length} 项` : '');
  }
  if (e.kind === 'apply') return `写入 · ${(e.diff || []).map((d) => `${d.param} ${d.from}→${d.to}`).join('，')}`;
  if (e.kind === 'evaluate') {
    const moved = (e.scorecardDelta || []).filter((d) => d.direction === 'better' || d.direction === 'worse');
    return `复飞评估 · ${str(e.verdict)}${e.rolledBack ? ' · 已自动回退' : ''}` +
      (moved.length ? ` · ${moved.map((d) => `${d.label}${d.direction === 'better' ? '↑' : '↓'}`).join('，')}` : '');
  }
  if (e.kind === 'note') return `笔记 · ${str(e.text)}`;
  return str(e.kind);
}

function journalCard() {
  const j = state.journal;
  if (!j.loaded && !j.loading) loadJournalList();
  if (!j.quads.length) {
    return card('机体档案 / Journal', [el('p', { class: 'hint', text: '还没有记录。每次在分析步骤生成建议都会按机体（craft name / 飞控板）自动建档并记一条。' })]);
  }
  const select = el('select', { class: 'input', id: 'journal-quad' }, j.quads.map((q) =>
    el('option', { value: q.id, text: `${hasText(q.profile?.name) ? str(q.profile.name) : q.id}（${fmtInt(q.entries)} 条）`, selected: q.id === j.selected }),
  ));
  select.addEventListener('change', () => loadJournalQuad(select.value));

  const doc = j.doc;
  const inputs = PROFILE_INPUTS.map(([key, label, type]) => {
    const input = el('input', { class: 'input', type, value: j.draft[key] ?? '', placeholder: label, attrs: { autocomplete: 'off', 'aria-label': label } });
    input.addEventListener('input', () => {
      j.draft[key] = type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
    });
    return el('label', { class: 'journal-field' }, [el('span', { class: 'field-label', text: label }), input]);
  });
  const saveBtn = button('保存资料 / Save', { variant: 'ghost', size: 'sm' });
  action(saveBtn, '保存机体资料', saveJournalProfile);

  const entries = Array.isArray(doc?.entries) ? doc.entries : [];
  const analyses = entries.filter((e) => e.kind === 'analysis').slice(-8);
  const trendKeys = ['delayMs', 'overshootPct', 'propwash', 'dTermRatio', 'noiseAttenuationDb', 'filterDelayMs'];
  const trend = analyses.length
    ? el('table', { class: 'kpi-trend' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: '时间' }),
          ...trendKeys.map((key) => el('th', { text: (analyses[0].scorecard?.kpis || []).find((k) => k.key === key)?.label || key })),
        ])]),
        el('tbody', {}, analyses.map((e) => {
          const k = Object.fromEntries((e.scorecard?.kpis || []).map((x) => [x.key, x]));
          return el('tr', {}, [
            el('td', { text: fmtDateTime(e.at) }),
            ...trendKeys.map((key) => el('td', { class: ['mono-num', k[key] ? `tone-${GRADE_TONE[k[key].grade]}` : ''], text: kpiValueText(k[key]) })),
          ]);
        })),
      ])
    : el('p', { class: 'hint', text: '还没有分析记录。' });

  const noteInput = el('input', { class: 'input', type: 'text', value: j.note, placeholder: '笔记：换桨、换电机、摔机…', attrs: { autocomplete: 'off' } });
  noteInput.addEventListener('input', () => {
    j.note = noteInput.value;
  });
  const noteBtn = button('添加笔记 / Add', { variant: 'ghost', size: 'sm' });
  action(noteBtn, '添加笔记', addJournalNote);

  const timeline = el('ol', { class: 'journal-timeline' }, entries.slice(-30).reverse().map((e) =>
    el('li', { class: `journal-${str(e.kind)}` }, [
      el('span', { class: 'hint mono-num', text: fmtDateTime(e.at) }),
      el('span', { text: journalEntryText(e) }),
    ]),
  ));

  return card(
    '机体档案 / Journal',
    [
      el('div', { class: 'row' }, [select, el('span', { class: 'hint', text: [doc?.board, doc?.firmware].filter(Boolean).join(' · ') })]),
      el('div', { class: 'journal-profile' }, inputs),
      el('div', { class: 'row' }, [saveBtn]),
      el('span', { class: 'field-label', text: '成绩单趋势（最近 8 次分析）/ KPI trend' }),
      trend,
      el('span', { class: 'field-label', text: '时间线 / timeline' }),
      el('div', { class: 'row' }, [noteInput, noteBtn]),
      timeline,
    ],
    { badges: [badge(`${fmtInt(j.quads.length)} 台`, 'info')] },
  );
}

/* ---------------- deconvolved step response plot ---------------- */

const STEP_W = 480;
const STEP_H = 180;

/** Overlay the three axes' deconvolved step responses (time in ms, unity line). */
function drawStepPlot(canvas, axes) {
  if (!canvas) return;
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const C = themeColors();
  canvas.width = STEP_W;
  canvas.height = STEP_H;
  const pad = { l: 34, r: 10, t: 10, b: 22 };
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, STEP_W, STEP_H);
  ctx.font = '9px ui-monospace, Menlo, monospace';

  const series = [
    ['roll', C.accent],
    ['pitch', C.ok],
    ['yaw', C.fgDim],
  ]
    .map(([name, color]) => ({ name, color, curve: axes?.[name]?.stepDeconv?.curve }))
    .filter((s) => s.curve && Array.isArray(s.curve.values) && s.curve.values.length > 1);
  if (!series.length) {
    ctx.fillStyle = C.fgMute;
    ctx.fillText('无打杆数据 / no stick input', 12, STEP_H / 2);
    return;
  }
  let tMin = 0;
  let tMax = 0;
  let yMax = 1.2;
  for (const s of series) {
    const t0 = num(s.curve.t0Ms) ?? 0;
    const dt = num(s.curve.dtMs) ?? 1;
    tMin = Math.min(tMin, t0);
    tMax = Math.max(tMax, t0 + dt * (s.curve.values.length - 1));
    for (const v of s.curve.values) yMax = Math.max(yMax, num(v) ?? 0);
  }
  yMax = Math.min(2, Math.ceil(yMax * 10) / 10);
  const yMin = -0.1;
  const X = (t) => pad.l + ((t - tMin) / Math.max(1e-6, tMax - tMin)) * (STEP_W - pad.l - pad.r);
  const Y = (v) => pad.t + ((yMax - v) / (yMax - yMin)) * (STEP_H - pad.t - pad.b);

  ctx.strokeStyle = C.line;
  ctx.fillStyle = C.fgDim;
  for (let t = 0; t <= tMax; t += 100) {
    ctx.beginPath();
    ctx.moveTo(X(t), pad.t);
    ctx.lineTo(X(t), STEP_H - pad.b);
    ctx.stroke();
    ctx.fillText(`${t} ms`, X(t) + 2, STEP_H - 8);
  }
  for (const v of [0, 0.5, 1]) {
    ctx.strokeStyle = v === 1 ? C.fgMute : C.line;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(v));
    ctx.lineTo(STEP_W - pad.r, Y(v));
    ctx.stroke();
    ctx.fillText(v.toFixed(1), 6, Y(v) + 3);
  }
  for (const s of series) {
    const t0 = num(s.curve.t0Ms) ?? 0;
    const dt = num(s.curve.dtMs) ?? 1;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    s.curve.values.forEach((v, i) => {
      const x = X(t0 + i * dt);
      const y = Y(num(v) ?? 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

function stepResponseCard(metrics) {
  const axes = metrics?.axes && typeof metrics.axes === 'object' ? metrics.axes : {};
  const rows = ['roll', 'pitch', 'yaw']
    .filter((a) => axes[a]?.stepDeconv)
    .map((a) => {
      const sd = axes[a].stepDeconv;
      return metricRow(
        `${AXIS_ZH[a]} / ${a}`,
        sd.samples
          ? `超调 ${fmtPct(sd.overshootPct)} · 50% 延迟 ${fmtMs(sd.delay50Ms)} · 上升 ${fmtMs(sd.riseTimeMs)} · ${fmtInt(sd.samples)} 段打杆`
          : '打杆不足，未估计',
      );
    });
  if (!rows.length) return null;
  const canvas = el('canvas', {
    class: 'step-canvas',
    attrs: { id: 'step-canvas', width: String(STEP_W), height: String(STEP_H), 'aria-label': '阶跃响应 roll/pitch/yaw' },
  });
  return card(
    '阶跃响应 / Step response',
    [
      el('p', {
        class: 'prose',
        text: '用 PIDtoolbox 的反卷积方法，从整段飞行的所有打杆中估计 setpoint→gyro 阶跃响应（黄=横滚，绿=俯仰，灰=偏航）。曲线包含前馈作用，所以这里的超调是你手上感到的超调，不能单独作为降 P 的依据。',
      }),
      canvas,
      ...rows,
    ],
    { badges: [badge('仅展示 / display only', 'info')] },
  );
}

function paintStepPlot() {
  const canvas = $('#step-canvas');
  if (!canvas || !canvas.isConnected) return;
  drawStepPlot(canvas, state.metrics?.axes);
}

/* ================================================================== *
 * 18. Page 2 — AI analysis (download + metrics + FFT + proposals)
 * ================================================================== */

async function pickLogFile() {
  const res = await run('选择日志文件', () => window.bf.bbl.pickFile());
  if (!res.ok) return;
  const value = res.value;
  const file = typeof value === 'string' ? value : value && typeof value.path === 'string' ? value.path : null;
  if (!file) {
    appendLog(infoEntry('已取消文件选择'));
    return;
  }
  state.file = file;
  state.metrics = null;
  state.proposals = [];
  state.apply = {};
  state.fft.data = null;
  appendLog(infoEntry(`已选择日志：${file}`));
  renderStep(state.step);
}

async function runMetrics() {
  if (!state.file) return;
  state.analysis.busy = true;
  paintStateBar();
  showOpProgress('分析日志 / bbl.metrics …', null);
  const res = await run('分析日志', () => window.bf.bbl.metrics(state.file));
  showOpProgress(null);
  if (!res.ok) {
    state.analysis.busy = false;
    renderStep(state.step);
    return;
  }
  state.metrics = res.value && typeof res.value === 'object' ? res.value : null;
  state.proposals = [];
  state.apply = {};
  state.done.add(1);
  const faults = Array.isArray(state.metrics?.faults) ? state.metrics.faults.length : 0;
  appendLog(infoEntry(`分析完成：采样质量 ${fmtRatio(state.metrics?.sampleQuality)}，${faults} 个故障条目`, 'state'));

  // Frequency-domain view: same analysis pass, per-axis Welch PSD.
  const fftRes = await run('FFT 频谱分析', () => window.bf.bbl.fft(state.file));
  state.fft.data = fftRes.ok && fftRes.value && typeof fftRes.value === 'object' ? fftRes.value : null;
  state.fft.axis = 'roll';
  if (state.fft.data) appendLog(infoEntry('FFT 频谱就绪（roll / pitch / yaw）', 'state'));
  state.analysis.busy = false;
  renderStep(state.step);
}

async function proposeTunes() {
  if (!state.metrics) return;
  const payload = { metrics: state.metrics };
  if (state.pid) payload.currentPid = state.pid;
  if (state.filter) payload.currentFilter = state.filter;
  showOpProgress('生成调参建议 / tune.propose …', null);
  const res = await run('生成调参建议', () => window.bf.tune.propose(payload));
  showOpProgress(null);
  if (!res.ok) return;
  state.proposals = Array.isArray(res.value) ? res.value : [];
  state.apply = {};
  appendLog(infoEntry(`生成 ${state.proposals.length} 条建议`, 'state'));
  const planRes = await run('读取调参路线', () => window.bf.tune.plan());
  state.plan = planRes.ok && planRes.value && typeof planRes.value === 'object' ? planRes.value : null;
  if (state.plan?.plan?.summary) appendLog(infoEntry(state.plan.plan.summary, 'state'));
  state.journal.loaded = false; // the propose just wrote a journal entry
  renderStep(state.step);
}

/** tune.apply phase 1: dry-run -> token + diff, then the confirm dialog. */
async function beginApply(p) {
  const diff = Array.isArray(p?.diff) ? p.diff : [];
  const res = await run(`试运行建议 ${str(p?.id)}`, () =>
    window.bf.tune.apply({ proposalId: p.id, diff, requireConfirm: true }),
  );
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (out.reason) appendLog(warnEntry(`写入被拒绝：${str(out.reason)}`, 'safety'));
  state.apply[p.id] = {
    diff: Array.isArray(out.diff) && out.diff.length ? out.diff : diff,
    token: typeof out.token === 'string' ? out.token : null,
    cliSent: Array.isArray(out.cliSent) ? out.cliSent : [],
  };
  state.focusConfirm = p.id;
  appendLog(infoEntry(`已生成写入预览 ${str(p?.id)}（${state.apply[p.id].diff.length} 项），等待第二次确认`, 'safety'));
  renderStep(state.step);
  if (!state.apply[p.id].token) {
    appendLog(warnEntry(`未获得确认令牌 token，写入被拒绝：${str(out.reason) || 'dry-run 被拒绝'}`, 'safety'));
    return;
  }
  confirmDiffDialog({
    title: `确认写入建议 ${str(p?.id)}`,
    note: '以下 diff 将真实写入飞控。这是本会话受安全边界限制的写入轮次。',
    diff: state.apply[p.id].diff,
    danger: true,
    onConfirm: () => confirmApply(p),
  });
}

/** tune.apply phase 2: the real write with the phase-1 token. */
async function confirmApply(p) {
  const store = state.apply[p.id];
  if (!store || !store.token) throw new Error('缺少确认令牌 token，已拒绝写入');
  const res = await run(`写入建议 ${str(p.id)}`, () =>
    window.bf.tune.apply({ proposalId: p.id, diff: store.diff, requireConfirm: false, token: store.token }),
  );
  if (!res.ok) throw res.error;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (!out.applied) throw new Error(str(out.reason) || '飞控拒绝了本次写入');
  delete state.apply[p.id];
  state.applied.add(p.id);
  appendLog(
    infoEntry(`已写入 ${Array.isArray(out.cliSent) ? out.cliSent.length : 0} 条 CLI${out.preWriteBackupPath ? `，写前备份 ${out.preWriteBackupPath}` : ''}`, 'safety'),
  );
  await refreshSafety();
  renderStep(state.step);
}

function cancelApply(p) {
  delete state.apply[p.id];
  appendLog(infoEntry(`已取消写入 ${str(p.id)}`));
  renderStep(state.step);
}

function faultList(metrics) {
  const faults = Array.isArray(metrics?.faults) ? metrics.faults : [];
  if (!faults.length) return el('p', { class: 'hint ok', text: '未发现硬件故障 / no faults' });
  return el(
    'div',
    { class: 'faults' },
    faults.map((f) =>
      el('div', { class: ['fault', `fault-${severityTone(f?.severity) === 'info' ? 'info' : severityTone(f?.severity) === 'warn' ? 'warn' : 'crit'}`] }, [
        el('div', { class: 'fault-head' }, [
          badge(str(f?.severity), severityTone(f?.severity)),
          el('span', { class: 'fault-code', text: str(f?.code) }),
          f?.blocksTuning ? badge('阻断调参 / blocksTuning', 'crit') : null,
        ]),
        el('p', { class: 'prose', text: str(f?.evidence) }),
      ]),
    ),
  );
}

function topPeak(axis) {
  const peaks = Array.isArray(axis?.peaks) ? [...axis.peaks] : [];
  if (!peaks.length) return null;
  peaks.sort((a, b) => (num(b?.psd) ?? 0) - (num(a?.psd) ?? 0));
  return peaks[0];
}

function metricRow(label, value, tone) {
  return el('div', { class: 'metric' }, [
    el('span', { class: 'metric-k', text: label }),
    el('span', { class: ['metric-v', tone ? `tone-${tone}` : ''], text: value }),
  ]);
}

function overshootTone(v) {
  const n = num(v);
  if (n === null) return null;
  return n <= 10 ? 'ok' : n <= 25 ? 'warn' : 'crit';
}

function settlingTone(v) {
  const n = num(v);
  if (n === null) return null;
  return n <= 40 ? 'ok' : n <= 90 ? 'warn' : 'crit';
}

function propwashTone(v) {
  const n = num(v);
  if (n === null) return null;
  return n <= 0.3 ? 'ok' : n <= 0.6 ? 'warn' : 'crit';
}

function axisCard(name, axis) {
  const peak = topPeak(axis);
  const step = axis?.step && typeof axis.step === 'object' ? axis.step : {};
  const body = [
    metricRow('超调 / overshoot', fmtPct(step.overshootPct), overshootTone(step.overshootPct)),
    metricRow('稳定时间 / settling', fmtMs(step.settlingTimeMs), settlingTone(step.settlingTimeMs)),
    metricRow('Propwash 指数', `${fmtNum(axis?.propwashIndex, 3)}${num(axis?.propwashEvents) === null ? '' : ` (${fmtInt(axis?.propwashEvents)} 次)`}`, propwashTone(axis?.propwashIndex)),
    metricRow('D 项比值 / D:gyro', fmtNum(axis?.dTermToGyroRatio, 3)),
    metricRow('主频谱峰 / top peak', peak ? `${fmtHz(peak.hz)} @ ${fmtNum(peak.prominenceDb, 1)} dB` : '—'),
  ];
  if (peak) {
    body.push(metricRow('峰带宽 / bandwidth', fmtHz(peak.bandwidthHz)));
  }
  body.push(metricRow('电机噪声峰 / motor peak', fmtHz(axis?.motorNoisePeakHz)));
  body.push(metricRow('阶跃样本 / samples', fmtInt(step.samples)));
  if (num(axis?.rpmHarmonicMatch) !== null) {
    body.push(metricRow('RPM 谐波匹配', fmtRatio(axis.rpmHarmonicMatch), clamp01(axis.rpmHarmonicMatch) >= 0.5 ? 'ok' : 'warn'));
  }
  return el('div', { class: 'axis-card' }, [
    el('div', { class: 'axis-head' }, [
      el('span', { class: 'axis-name', text: name }),
      chip(`噪声底 ${fmtNum(axis?.noiseFloorDbfs, 1)} dBFS`, 'idle'),
    ]),
    ...body,
  ]);
}

function metricsReportCard(metrics) {
  const faults = Array.isArray(metrics?.faults) ? metrics.faults : [];
  const blockers = faults.filter((f) => f?.blocksTuning);
  const warnings = Array.isArray(metrics?.warnings) ? metrics.warnings : [];
  const axes = metrics?.axes && typeof metrics.axes === 'object' ? metrics.axes : {};
  const quality = clamp01(metrics?.sampleQuality);

  const parts = [
    banner(blockers.length ? 'crit' : qualityTone(quality) === 'ok' ? 'ok' : 'warn', blockers.length ? '硬性阻断 / HARD STOP' : '样本质量 / sample quality', [
      el('div', {}, [
        el('span', { class: 'field-label', text: `质量评分 ${fmtRatio(quality)} · ${qualityLabel(quality)}` }),
        meter(quality, { label: '样本质量', tone: qualityTone(quality) }),
      ]),
      blockers.length
        ? para(`存在阻断调参的故障：${blockers.map((f) => str(f?.code)).join('、')}。必须先修复硬件问题，任何 PID 建议都不可信。`)
        : null,
    ]),
    kvGrid([
      kv('文件 / file', metrics?.file),
      kv('日志段 / logIndex', metrics?.logIndex),
      kv('采样率 / sampleRateHz', fmtHz(metrics?.sampleRateHz)),
      kv('时长 / durationS', metrics?.durationS === undefined ? '—' : fmtSeconds(metrics.durationS)),
      kv('丢帧率 / dropRatePct', fmtPct(metrics?.dropRatePct, 2)),
      kv('电机饱和 / motorSaturationPct', fmtPct(metrics?.motorSaturationPct)),
      kv('RPM 数据 / rpmAvailable', boolText(metrics?.rpmAvailable)),
      kv('RPM 范围', `${fmtInt(metrics?.rpmMin)} – ${fmtInt(metrics?.rpmMax)}`),
    ]),
    el('div', {}, [el('span', { class: 'field-label', text: `故障 / faults (${faults.length})` }), faultList(metrics)]),
    warnings.length
      ? el('div', {}, [el('span', { class: 'field-label', text: '警告 / warnings' }), el('div', { class: 'chips' }, warnings.map((w) => chip(str(w), 'warn')))])
      : null,
  ];

  const axisNames = ['roll', 'pitch', 'yaw'];
  const present = axisNames.filter((n) => axes[n]);
  if (present.length) {
    parts.push(el('div', { class: 'axis-grid' }, present.map((n) => axisCard(n, axes[n]))));
  }

  return card('分析报告 / MetricsReport', parts, {
    badges: [
      badge(blockers.length ? 'HARD STOP' : 'tuning allowed', blockers.length ? 'crit' : 'ok'),
      badge(`质量 ${fmtRatio(quality)}`, qualityTone(quality)),
    ],
  });
}

/* ---------------- post-change re-fly evaluation (bf.tune.evaluate) ---------------- */

const VERDICT_LABEL = { better: '更好 / better', worse: '更差 / worse', unchanged: '无变化 / unchanged' };
const VERDICT_TONE = { better: 'ok', worse: 'crit', unchanged: 'idle' };

/**
 * Signed delta for the evaluation table.
 *
 * compare-runs.js reports `delta` as a percentage change (pctChange), so the
 * unit is part of the value; a non-numeric delta is shown verbatim.
 */
function fmtDelta(v) {
  const n = num(v);
  if (n === null) return str(v);
  const rounded = Number(n.toFixed(4));
  return `${rounded > 0 ? '+' : ''}${String(rounded)}%`;
}

async function evaluateReflight() {
  if (state.evaluate.busy) return;
  state.evaluate.busy = true;
  state.evaluate.error = '';
  state.analysis.busy = true;
  paintStateBar();
  showOpProgress('复飞评估 / tune.evaluate …', null);
  const baselineId = lastAppliedProposalId();
  const payload = baselineId ? { baselineId } : {};
  const res = await run('复飞评估', () => window.bf.tune.evaluate(payload));
  showOpProgress(null);
  state.evaluate.busy = false;
  state.analysis.busy = false;
  if (!res.ok) {
    state.evaluate.error = 'IPC 调用失败';
    renderStep(state.step);
    return;
  }
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  state.evaluate.result = out;
  const reasons = Array.isArray(out.reasons) ? out.reasons : [];
  const worse = reasons.filter((r) => r?.worse).length;
  appendLog(
    infoEntry(`复飞评估：${VERDICT_LABEL[out.verdict] || str(out.verdict)}（${reasons.length} 项指标，${worse} 项变差）${out.rolledBack ? ' · 已自动回退' : ''}`, 'state'),
  );
  renderStep(state.step);
}

function evaluationResultBlock(r) {
  const reasons = Array.isArray(r?.reasons) ? r.reasons : [];
  const verdict = typeof r?.verdict === 'string' ? r.verdict : null;
  const rollback = r?.rollback && typeof r.rollback === 'object' ? r.rollback : null;

  const rows = reasons.map((reason) => {
    const worse = Boolean(reason?.worse);
    const better = Boolean(reason?.better);
    const cls = worse ? 'tone-crit' : better ? 'tone-ok' : '';
    const verdictCell = worse
      ? badge('变差 / worse', 'crit')
      : better
        ? badge('改善 / better', 'ok')
        : badge('容差内 / within tol', 'idle');
    return [
      { class: `mono-num ${cls}`, text: str(reason?.metric) },
      { class: `mono-num ${cls}`, text: fmtVal(reason?.before) },
      { class: `mono-num ${cls}`, text: fmtVal(reason?.after) },
      { class: `mono-num ${cls}`, text: fmtDelta(reason?.delta) },
      { node: verdictCell },
    ];
  });

  return el('div', { class: 'eval-result' }, [
    el('div', { class: 'row' }, [
      badge(VERDICT_LABEL[verdict] || str(verdict), VERDICT_TONE[verdict] || 'idle'),
      r?.rolledBack ? badge('已自动回退 / rolled back', 'warn') : null,
      el('span', { class: 'hint', text: `${reasons.length} 项指标 / metrics` }),
    ]),
    reasons.length
      ? table(
          [
            { text: '指标 / metric' },
            { text: '改动前 / before', class: 'num' },
            { text: '本次 / after', class: 'num' },
            { text: '差值 / delta', class: 'num' },
            { text: '判定 / verdict' },
          ],
          rows,
        )
      : el('p', { class: 'hint', text: '评估未返回逐项指标 / no per-metric reasons returned.' }),
    r?.rolledBack
      ? banner('warn', '已自动恢复上一版调参 / previous tuning restored automatically', [
          para('本次复飞判定为「更差」，应用已自动把上一版调参写回飞控，避免继续用一组变差的参数飞行。'),
          el('ul', { class: 'evidence' }, [
            el('li', { text: `回退原因 / reason：${str(rollback?.reason ?? rollback?.message) === '—' ? '（未提供 / not provided）' : str(rollback?.reason ?? rollback?.message)}` }),
            rollback?.reportPath ? el('li', { text: `回退报告 / reportPath：${str(rollback.reportPath)}` }) : null,
            rollback && !rollback.reason && !rollback.message && !rollback.reportPath ? el('li', { text: `回退详情 / rollback：${safeJson(rollback)}` }) : null,
          ]),
        ])
      : null,
    r?.rolledBack === false && verdict === 'worse'
      ? el('p', { class: 'hint warn', text: '判定为变差，但未自动回退；请手动执行「一键回退上一版」并检查飞控状态。' })
      : null,
  ]);
}

function evaluationCard() {
  const r = state.evaluate.result;
  const evaluateBtn = button(state.evaluate.busy ? '评估中…' : '评估本次复飞 / Evaluate this flight', {
    variant: 'primary',
    enabled: () => !state.evaluate.busy,
  });
  action(evaluateBtn, '复飞评估', evaluateReflight);

  const rollbackBtn = button('一键回退上一版 / Roll back latest', { variant: 'danger', mutating: true, gate: 'tuning' });
  action(rollbackBtn, '一键回退上一版', rollbackLatestBackup);

  const baseline = lastAppliedProposalId();

  return card(
    '复飞评估 / Re-fly evaluation',
    [
      el('p', {
        class: 'prose',
        text: '把本次飞行与「上一次真正写入飞控的调参」逐项对比：改动前的最后一次分析（baseline）对本次日志，给出更好 / 更差 / 无变化的结论与逐项指标。',
      }),
      el('ul', { class: 'evidence' }, [
        el('li', { text: '评估依据是同一组指标（超调、稳定时间、propwash、噪声底等）在改动前后的取值，不做主观推测。' }),
        el('li', { text: '只有「已写入」的调参才会成为基线；没有写入过就不存在可比对象 / evaluation needs a written change.' }),
        el('li', { text: '如果结论是「更差」，应用会在允许时自动回退上一版，并在这里说明原因。' }),
      ]),
      kvGrid([
        kv('基线建议 / baselineId', baseline || '未写入过建议 / none'),
        kv('本次日志 / file', state.file, { wrap: false }),
        kv('指标状态 / metrics', state.metrics ? '已分析 / analysed' : '尚未分析 / not analysed'),
      ]),
      el('div', { class: 'row' }, [evaluateBtn, rollbackBtn]),
      state.evaluate.error ? el('p', { class: 'hint crit', text: `上次评估失败：${state.evaluate.error}` }) : null,
      r ? evaluationResultBlock(r) : el('p', { class: 'hint', text: '尚未评估。写入调参并复飞一次后，点击「评估本次复飞」。' }),
    ],
    {
      badges: [
        r ? badge(VERDICT_LABEL[r.verdict] || str(r.verdict), VERDICT_TONE[r.verdict] || 'idle') : badge('未评估 / not evaluated', 'idle'),
        state.evaluate.busy ? badge('运行中 / running', 'warn') : null,
      ],
    },
  );
}

/* ---------------- conclusion cards (six required parts) ---------------- */

/** One labelled conclusion section: 中文 title + English subtitle. */
function propSection(zh, en, body) {
  return el('section', { class: 'prop-section' }, [
    el('h4', { class: 'prop-sec-title' }, [el('span', { text: zh }), el('span', { class: 'prop-sec-en', text: en })]),
    body,
  ]);
}

/** True when a field is present and non-empty (never invent text for it). */
function hasText(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/**
 * Copy-to-clipboard control for a CLI block. Clipboard access is best effort:
 * if the API is unavailable the block is selected instead so the operator can
 * copy it by hand - both paths are offline.
 */
function copyCliButton(lines, codeNode) {
  const btn = button('复制 / Copy', { variant: 'ghost', size: 'sm' });
  action(btn, '复制 CLI', async () => {
    const text = (Array.isArray(lines) ? lines : []).join('\n');
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('剪贴板 API 不可用 / clipboard unavailable');
      await navigator.clipboard.writeText(text);
      appendLog(infoEntry(`已复制 ${lines.length} 条 CLI 到剪贴板`, 'state'));
    } catch (err) {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(codeNode);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        /* selection is a convenience only */
      }
      appendLog(warnEntry(`复制失败：${errMessage(err)}；已选中 CLI 文本，请手动复制（⌘C）`));
    }
  });
  return btn;
}

/**
 * ③ 改什么: what each parameter is now, what it becomes, then the CLI lines.
 *
 * The table comes first on purpose. "set d_yaw = 3" alone makes the operator
 * reverse-engineer what changed; the table states it directly as
 * "d_yaw: 0 -> 3" so the change is readable without knowing the current tune.
 */
function cliConclusionSection(cliLines, diffRows) {
  const rows = Array.isArray(diffRows) ? diffRows : [];
  const code = codeBlock(cliLines);
  const head = el('div', { class: 'code-head' }, [
    el('span', { class: 'field-label', text: `CLI（${cliLines.length} 行，不自动写入）/ commands` }),
    cliLines.length ? copyCliButton(cliLines, code) : null,
  ]);

  const body = [];
  if (rows.length) {
    body.push(
      el('p', {
        class: 'hint',
        text: '直接改动如下：每一行是「参数：现在是 → 改成」。',
      }),
      diffTable(rows),
    );
  }
  if (cliLines.length) body.push(el('div', { class: 'code-wrap' }, [head, code]));
  return propSection('改什么', 'CLI change', el('div', {}, body));
}

function proposalCard(p, index, opts = {}) {
  const id = str(p?.id);
  const safe = Boolean(p?.safeToApply);
  const applied = state.applied.has(id);
  const store = state.apply[id];
  const blockedBy = Array.isArray(p?.blockedBy) ? p.blockedBy : [];
  const confidence = clamp01(p?.confidence);

  const cliLines = (Array.isArray(p?.cli) ? p.cli : []).map((line) => str(line));
  const diffRows = Array.isArray(p?.diff) ? p.diff : [];
  // A conclusion with no CLI lines and no diff is informational: it must never
  // look like it is about to write something.
  const informational = cliLines.length === 0 && diffRows.length === 0;

  // ④ 为什么 falls back to the existing verification text when `why` is absent;
  // ⑥ 不写会怎样 is only rendered when the proposal actually carries it.
  const whyText = hasText(p?.why) ? str(p.why) : hasText(p?.verification) ? str(p.verification) : null;
  const notAppliedText = hasText(p?.ifNotApplied) ? str(p.ifNotApplied) : null;

  const sections = [
    hasText(p?.stageNote) ? el('p', { class: 'hint stage-note', text: str(p.stageNote) }) : null,
    propSection('哪里不对', 'Problem', para(p?.problem)),
    propSection('证据', 'Evidence', para(p?.evidence, 'prose mono')),
    cliConclusionSection(cliLines, diffRows),
    whyText ? propSection('为什么', 'Why', para(whyText)) : null,
    propSection('飞什么动作验证', 'Re-fly verification', para(p?.verification)),
    notAppliedText ? propSection('不写会怎样', 'If not applied', para(notAppliedText)) : null,
  ].filter(Boolean);

  const applyArea = el('div', { class: 'row' });
  if (informational) {
    applyArea.append(
      el('p', { class: 'hint ok', text: '仅结论 / informational：本条没有 CLI 改动、也没有 diff，不会写入飞控。' }),
    );
  } else if (opts.readOnly) {
    const archivedBtn = button('已存档（只读）/ archived', { variant: 'ghost', enabled: () => false });
    archivedBtn.title = '历史报告中的建议只读，不会写入飞控。';
    applyArea.append(archivedBtn, el('span', { class: 'hint', text: '历史报告只读：如需应用请回到分析步骤重新生成。' }));
  } else if (applied) {
    applyArea.append(el('p', { class: 'hint ok', text: '已写入飞控。请按「飞什么动作验证」段落复飞，然后重新采集分析。' }));
  } else if (store) {
    const confirmBtn = button('确认写入 / Confirm write', { variant: 'danger', mutating: true, attrs: { 'data-confirm': id } });
    guard(confirmBtn, () => Boolean(store.token));
    action(confirmBtn, `写入建议 ${id}`, async () => {
      confirmDiffDialog({
        title: `确认写入建议 ${id}`,
        note: '以下 diff 将真实写入飞控。这是本会话受安全边界限制的写入轮次。',
        diff: store.diff,
        danger: true,
        onConfirm: () => confirmApply(p),
      });
    });
    const cancelBtn = button('取消 / Cancel', { variant: 'ghost' });
    action(cancelBtn, '取消写入', async () => cancelApply(p));
    applyArea.append(
      el('div', { class: 'banner banner-warn' }, [
        el('div', { class: 'banner-title', text: '第二步：确认写入（非试运行）/ Confirm write' }),
        para('以下 diff 将真实写入飞控。点击确认后在对话框中进行最终写入。'),
        store.token ? null : el('p', { class: 'hint warn', text: '未获得确认令牌 token，写入被拒绝。' }),
        diffTable(store.diff),
        el('div', { class: 'row' }, [confirmBtn, cancelBtn]),
      ]),
    );
  } else {
    const applyBtn = button('应用（先试运行）/ Apply', { variant: 'primary', mutating: true, enabled: () => safe });
    if (!safe) applyBtn.title = blockedBy.length ? `blockedBy: ${blockedBy.join('；')}` : '提案未标记 safeToApply';
    action(applyBtn, `试运行建议 ${id}`, async () => beginApply(p));
    applyArea.append(applyBtn);
    if (!safe) applyArea.append(el('span', { class: 'hint warn', text: `不可写入：${blockedBy.length ? blockedBy.join('；') : 'safeToApply = false'}` }));
  }

  const forbidden = contractForbidden();
  const cliText = cliLines.join('\n');
  const hits = forbidden.filter((f) => cliText.includes(f));
  if (hits.length && !opts.readOnly) {
    applyArea.prepend(el('p', { class: 'hint warn', text: `注意：CLI 触及禁止参数（${hits.join('、')}），主进程守卫会拒绝写入。` }));
  }

  return card(
    [el('span', { class: 'mono-num', text: id }), el('span', { class: 'hint', text: `#${index + 1}` })],
    [
      el('div', { class: 'row' }, [
        badge(CATEGORY_LABEL[p?.category] || str(p?.category), CATEGORY_TONE[p?.category] || 'idle'),
        p?.stage ? badge(`阶段：${STAGE_LABEL[p.stage] || str(p.stage)}`, 'idle') : null,
        safe ? badge('safeToApply', 'ok') : badge('safeToApply = false', 'crit'),
        informational ? badge('仅结论 / 不写入', 'info') : null,
        applied ? badge('已写入 / applied', 'info') : null,
        opts.readOnly ? badge('历史 / archived', 'info') : null,
        ...blockedBy.map((b) => chip(str(b), 'warn')),
      ]),
      ...sections,
      diffRows.length ? diffTable(diffRows) : null,
      applyArea,
    ],
    {
      class: ['proposal', informational ? 'proposal-info' : ''],
      actions: [
        el('div', { class: 'confidence' }, [
          el('span', { class: 'hint', text: '置信度 / confidence' }),
          meter(confidence, { label: '建议置信度', tone: confidenceTone(confidence), showPct: true }),
        ]),
      ],
    },
  );
}

function proposalsCard() {
  if (!state.proposals.length) {
    return card('建议 / Proposals', [el('p', { class: 'hint', text: '运行分析后点击「生成建议」；每条建议按固定顺序包含：哪里不对 → 证据 → 改什么（CLI）→ 为什么 → 飞什么动作验证 → 不写会怎样。' })]);
  }
  return el('div', { class: 'proposals' }, state.proposals.map((p, i) => proposalCard(p, i)));
}

/* ---------------- FFT spectrum canvas ---------------- */

/** Peak-preserving decimation: bucket-wise max so peaks survive downsizing. */
function decimateSpectrum(freqs, psd, maxPoints = FFT_MAX_POINTS) {
  const f = Array.isArray(freqs) ? freqs : [];
  const p = Array.isArray(psd) ? psd : [];
  const n = Math.min(f.length, p.length);
  if (n <= maxPoints) return { freqs: f.slice(0, n), psd: p.slice(0, n) };
  const bucket = Math.ceil(n / maxPoints);
  const outF = [];
  const outP = [];
  for (let i = 0; i < n; i += bucket) {
    let best = i;
    let bestV = -Infinity;
    const end = Math.min(n, i + bucket);
    for (let j = i; j < end; j += 1) {
      const v = num(p[j]) ?? 0;
      if (v > bestV) {
        bestV = v;
        best = j;
      }
    }
    outF.push(f[best]);
    outP.push(p[best]);
  }
  return { freqs: outF, psd: outP };
}

/** Draw the Welch PSD (log-x, dBFS) with peak markers; no chart library. */
function drawFft(canvas, axis) {
  if (!canvas) return;
  const ctx = canvas.getContext ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const C = themeColors();
  canvas.width = FFT_W;
  canvas.height = FFT_H;

  const gyro = axis?.gyroSpectrum && typeof axis.gyroSpectrum === 'object' ? axis.gyroSpectrum : {};
  const dec = decimateSpectrum(gyro.freqs, gyro.psd);
  if (window.__BF_UI_TEST__) {
    window.__bfUiTest.lastFftDraw = {
      axis: state.fft.axis,
      sourcePoints: (Array.isArray(gyro.freqs) ? gyro.freqs : []).length,
      drawnPoints: dec.freqs.length,
    };
  }

  const W = FFT_W;
  const H = FFT_H;
  const pad = { l: 44, r: 10, t: 12, b: 22 };

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const dbOf = (psd) => 10 * Math.log10(Math.max(num(psd) ?? 0, 1e-30));
  const pts = [];
  let maxDb = -Infinity;
  let minDb = Infinity;
  for (let i = 0; i < dec.freqs.length; i += 1) {
    const f = num(dec.freqs[i]);
    const p = num(dec.psd[i]);
    if (f === null || p === null || f <= 0) continue;
    const d = dbOf(p);
    if (d > maxDb) maxDb = d;
    if (d < minDb) minDb = d;
    pts.push({ f, d });
  }

  ctx.font = '9px ui-monospace, Menlo, monospace';
  if (!pts.length) {
    ctx.fillStyle = C.fgMute;
    ctx.fillText('无频谱数据 / no spectrum data', 12, H / 2);
    return;
  }

  const noiseFloor = num(axis?.noiseFloorDbfs);
  const fmin = Math.max(1, pts[0].f);
  const fmax = Math.max(fmin * 10, pts[pts.length - 1].f);
  const yMin = Math.min(minDb, noiseFloor !== null ? noiseFloor - 8 : minDb);
  const yMax = maxDb + 6;
  const span = Math.max(1e-6, yMax - yMin);
  const X = (f) => pad.l + ((Math.log10(f) - Math.log10(fmin)) / (Math.log10(fmax) - Math.log10(fmin))) * (W - pad.l - pad.r);
  const Y = (d) => pad.t + ((yMax - d) / span) * (H - pad.t - pad.b);

  // Grid + decade ticks on the x axis.
  ctx.fillStyle = C.fgDim;
  for (let f = 10; f <= fmax; f *= 10) {
    const x = X(f);
    if (x < pad.l) continue;
    ctx.strokeStyle = C.line;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, H - pad.b);
    ctx.stroke();
    ctx.fillStyle = C.fgDim;
    ctx.fillText(fmtHzShort(f), x - 7, H - 8);
  }
  // Y axis labels (mono).
  const yTicks = [yMax, (yMax + yMin) / 2, yMin];
  for (const d of yTicks) {
    ctx.fillStyle = C.fgMute;
    ctx.fillText(`${Math.round(d)}`, 4, Y(d) + 3);
    ctx.strokeStyle = C.bg2;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(d));
    ctx.lineTo(W - pad.r, Y(d));
    ctx.stroke();
  }
  // Noise floor reference line.
  if (noiseFloor !== null) {
    ctx.strokeStyle = C.crit;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(noiseFloor));
    ctx.lineTo(W - pad.r, Y(noiseFloor));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // PSD line.
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 1) {
    const x = X(pts[i].f);
    const y = Y(pts[i].d);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Peak markers.
  const peaks = Array.isArray(axis?.peaks) ? axis.peaks : [];
  let markerCount = 0;
  for (const pk of peaks) {
    const hz = num(pk?.hz);
    if (hz === null || hz < fmin || hz > fmax || markerCount >= 12) continue;
    const x = X(hz);
    const top = Y(yMax - (span * 0.03));
    ctx.fillStyle = C.warn;
    ctx.beginPath();
    ctx.moveTo(x - 4, top + 9);
    ctx.lineTo(x + 4, top + 9);
    ctx.lineTo(x, top + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = C.warn;
    ctx.fillText(`${fmtHzShort(hz)}${num(pk?.prominenceDb) !== null ? `·${fmtNum(pk.prominenceDb, 0)}dB` : ''}`, Math.min(W - 46, Math.max(pad.l - 8, x - 14)), top + 20);
    markerCount += 1;
  }
}

function fftCard() {
  const data = state.fft.data;
  const axes = data?.axes && typeof data.axes === 'object' ? data.axes : {};
  const axis = state.fft.axis;
  const current = axes[axis] || null;

  const buttons = FFT_AXES.map((n) => {
    const b = el('button', {
      class: ['btn', 'btn-sm', 'fft-axis-btn', state.fft.axis === n ? 'btn-primary' : 'btn-ghost'],
      type: 'button',
      text: n.toUpperCase(),
      attrs: { 'aria-pressed': String(state.fft.axis === n) },
    });
    b.addEventListener('click', () => {
      state.fft.axis = n;
      paintFft();
    });
    return b;
  });

  const canvas = el('canvas', {
    class: 'fft-canvas',
    attrs: { id: 'fft-canvas', width: String(FFT_W), height: String(FFT_H), 'aria-label': `FFT 频谱 ${axis}` },
  });

  const info = current
    ? kvGrid([
        kv('噪声底 / noiseFloorDbfs', `${fmtNum(current.noiseFloorDbfs, 1)} dBFS`),
        kv('电机噪声峰 / motorNoisePeakHz', fmtHz(current.motorNoisePeakHz)),
        kv('RPM 谐波匹配 / rpmHarmonicMatch', current.rpmHarmonicMatch === undefined ? '—' : fmtRatio(current.rpmHarmonicMatch)),
      ])
    : null;

  return card(
    'FFT 频谱 / Spectrum',
    [
      el('div', { class: 'fft-tools' }, [el('span', { class: 'hint', text: '轴 / axis:' }), ...buttons]),
      canvas,
      el('div', { class: 'fft-legend' }, [
        el('span', {}, [el('span', { class: 'sw sw-accent' }), 'gyro PSD（dBFS，log-x）']),
        el('span', {}, [el('span', { class: 'sw sw-warn' }), '峰值 / peaks']),
        el('span', { class: 'mono-num', text: `≤ ${FFT_MAX_POINTS} 点 / pts` }),
      ]),
      current
        ? info
        : el('p', { class: 'hint', text: data ? `轴「${axis}」暂无频谱数据。` : '运行分析（bbl.metrics）后自动调用 bbl.fft 生成频谱。' }),
    ],
    { badges: [badge(axis.toUpperCase(), 'info'), data ? badge(`${fmtHz(data.sampleRateHz)} fs`, 'ok') : badge('未运行 / not run', 'idle')] },
  );
}

function paintFft() {
  const canvas = $('#fft-canvas');
  if (!canvas || !canvas.isConnected) return;
  const axes = state.fft.data?.axes || {};
  const axis = axes[state.fft.axis] || null;
  for (const btn of $$('.fft-axis-btn')) {
    const name = String(btn.textContent || '').toLowerCase();
    const active = name === state.fft.axis;
    setClass(btn, ['btn', 'btn-sm', 'fft-axis-btn', active ? 'btn-primary' : 'btn-ghost']);
    btn.setAttribute('aria-pressed', String(active));
  }
  canvas.setAttribute('aria-label', `FFT 频谱 ${state.fft.axis}`);
  if (axis) {
    drawFft(canvas, axis);
  } else {
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (ctx) {
      const C = themeColors();
      canvas.width = FFT_W;
      canvas.height = FFT_H;
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, FFT_W, FFT_H);
      ctx.fillStyle = C.fgMute;
      ctx.fillText('无频谱数据 / no spectrum data', 12, FFT_H / 2);
    }
  }
}

function renderAnalysis(body) {
  const metrics = state.metrics;
  const fileLabel = state.file ? state.file : '尚未选择日志文件';
  const pickBtn = button('选择 .bbl 文件 / Pick', { variant: 'ghost' });
  action(pickBtn, '选择日志文件', pickLogFile);
  const metricsBtn = button(metrics ? '重新分析 / Re-run' : '运行分析 / Run metrics', {
    variant: metrics ? 'ghost' : 'primary',
    enabled: () => Boolean(state.file),
  });
  action(metricsBtn, '运行分析', runMetrics);

  const blockers = metrics && (metrics.blocksTuning === true || (Array.isArray(metrics.faults) && metrics.faults.some((f) => f?.blocksTuning)));
  const proposeBtn = button(blockers ? '仍然生成建议（仅硬件类）/ Propose anyway' : '生成建议 / Propose', {
    variant: 'primary',
    enabled: () => Boolean(metrics),
  });
  action(proposeBtn, '生成建议', proposeTunes);

  const parts = [
    // Downloading the log is the first thing an operator does after a flight, so
    // it lives here instead of on a separate blackbox page.
    downloadCard(),
    downloadVerifyCard(),
    card(
      '日志来源 / Source',
      [
        kv('文件 / file', fileLabel, { wrap: false }),
        el('div', { class: 'row' }, [pickBtn, metricsBtn, proposeBtn]),
        el('p', { class: 'hint', text: '离线分析不需要飞控连接；也可以直接选择已下载的 .bbl 文件。' }),
        el('p', {
          class: 'hint',
          text: '不限飞行时长：分析后的「证据清单」会说明数据是否足够，以及还需要补飞哪个科目。',
        }),
      ],
      { badges: [badge(state.file ? 'ready' : 'no file', state.file ? 'ok' : 'idle')] },
    ),
  ];

  if (metrics) {
    parts.push(metricsReportCard(metrics));
    const evidence = evidenceCard(metrics);
    if (evidence) parts.push(evidence);
    const mechanical = mechanicalCard(metrics);
    if (mechanical) parts.push(mechanical);
    const scorecard = scorecardCard(state.plan?.scorecard || metrics.scorecard);
    if (scorecard) parts.push(scorecard);
    if (blockers) {
      parts.push(
        banner('crit', '硬性阻断 / HARD STOP', [
          para('报告中存在 blocksTuning 故障。建议仅作参考，禁止据此写入 PID/滤波器参数；请先修复硬件问题（电机、桨、减震、电源）。'),
        ]),
      );
    }
    parts.push(evaluationCard());
    const campaign = campaignCard(state.plan?.plan);
    if (campaign) parts.push(campaign);
    parts.push(proposalsCard());
  } else {
    parts.push(card('建议 / Proposals', [el('p', { class: 'hint', text: '尚未运行分析。' })]));
  }
  // The optional AI agent sits right after the rule proposals: same evidence,
  // a second opinion, still advisory.
  parts.push(...aiAgentCard());
  // The re-fly evaluation stands on its own: it is shown before and after an
  // analysis pass, so an operator can judge a flight without re-running metrics.
  if (!metrics) parts.push(evaluationCard());
  // FFT spectrum follows the metrics report (offline, no libraries).
  parts.push(fftCard());
  if (metrics) {
    const stepCard = stepResponseCard(metrics);
    if (stepCard) parts.push(stepCard);
  }
  // How to fly, folded in here: it used to be its own page with no action on it.
  parts.push(flightGuidanceCard());

  body.append(...parts.filter(Boolean));
  paintFft();
  paintStepPlot();
}

/* ================================================================== *
 * 18b. AI agent layer (optional; advisory only)
 * ================================================================== */

/** Load the stored AI settings once per session (never returns the API key). */
async function loadAiConfig() {
  if (state.ai.loading) return;
  state.ai.loading = true;
  const res = await run('读取 AI 设置', () => window.bf.ai.getConfig());
  state.ai.loading = false;
  if (!res.ok) {
    renderStep(state.step);
    return;
  }
  state.ai.config = res.value && typeof res.value === 'object' ? res.value : null;
  renderStep(state.step);
}

async function saveAiConfig(patch) {
  const res = await run('保存 AI 设置', () => window.bf.ai.setConfig(patch));
  if (!res.ok) return;
  state.ai.config = res.value && typeof res.value === 'object' ? res.value : null;
  appendLog(infoEntry(`AI 设置已保存：${str(state.ai.config?.model)} @ ${str(state.ai.config?.baseUrl)}`));
  renderStep(state.step);
}

/**
 * Send the measured report to the configured model and render its review.
 *
 * Only the derived measurements travel (see buildEvidencePack); the .bbl itself
 * never leaves the machine.
 */
async function runAiReview() {
  if (!state.metrics || state.ai.busy) return;
  state.ai.busy = true;
  state.ai.error = null;
  showOpProgress('AI 智能体分析 / ai.analyze …', null);
  const res = await run('AI 智能体分析', () =>
    window.bf.ai.analyze({ metrics: state.metrics, file: state.file, level: state.ai.level }),
  );
  showOpProgress(null);
  state.ai.busy = false;
  if (!res.ok) {
    state.ai.error = errMessage(res.error);
    renderStep(state.step);
    return;
  }
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (out.ok === false) {
    state.ai.error = str(out.error) || 'AI 返回无法解析';
    state.ai.result = out;
  } else {
    state.ai.result = out;
    state.ai.error = null;
    appendLog(
      infoEntry(
        `AI 评审完成：${(out.proposals || []).length} 条建议（${str(out.model)}，${str(out.packLevel)} 档 ${fmtInt(Math.round((out.packChars || 0) / 1024))} KB，${fmtInt(out.elapsedMs)} ms）`,
        'state',
      ),
    );
  }
  renderStep(state.step);
}

/** Save the pack + prompt to a file, so any assistant can receive the whole log. */
async function exportAiPack() {
  const res = await run('导出 AI 分析包', () => window.bf.ai.exportPack({ metrics: state.metrics, level: state.ai.level }));
  if (!res.ok) return;
  const out = res.value && typeof res.value === 'object' ? res.value : {};
  if (out.canceled) {
    appendLog(infoEntry('已取消导出'));
    return;
  }
  state.ai.exportResult = out;
  appendLog(infoEntry(`分析包已导出：${str(out.path)}（${str(out.level)} 档，${fmtInt(Math.round((out.chars || 0) / 1024))} KB）`, 'state'));
  renderStep(state.step);
}

/** Provider + key form. The key is write-only: it is never rendered back. */
function aiSettingsForm() {
  const cfg = state.ai.config || {};
  const baseUrl = el('input', { class: 'input mono-num', id: 'ai-base-url', type: 'text', value: str(cfg.baseUrl) });
  const model = el('input', { class: 'input mono-num', id: 'ai-model', type: 'text', value: str(cfg.model) });
  const apiKey = el('input', { class: 'input mono-num', id: 'ai-api-key', type: 'password', placeholder: cfg.hasApiKey ? '已保存，留空表示不修改' : '粘贴你的 API key' });

  const enableBox = el('input', { type: 'checkbox', id: 'ai-enabled', checked: Boolean(cfg.enabled) });

  const saveBtn = button('保存设置 / Save', { variant: 'primary' });
  action(saveBtn, '保存 AI 设置', async () => {
    await saveAiConfig({
      enabled: enableBox.checked,
      baseUrl: baseUrl.value,
      model: model.value,
      apiKey: apiKey.value,
    });
    apiKey.value = '';
  });

  return el('div', {}, [
    el('div', { class: 'row' }, [
      enableBox,
      el('label', { for: 'ai-enabled', text: '启用 AI 分析 / enable AI' }),
      cfg.hasApiKey ? chip('已配置密钥 / key stored', 'ok') : chip('未配置密钥 / no key', 'warn'),
    ]),
    el('div', { class: 'kv-grid' }, [
      el('div', {}, [el('span', { class: 'field-label', text: '接口地址 / baseUrl' }), baseUrl]),
      el('div', {}, [el('span', { class: 'field-label', text: '模型 / model' }), model]),
      el('div', {}, [el('span', { class: 'field-label', text: 'API key（只写不读 / write-only）' }), apiKey]),
    ]),
    el('p', {
      class: 'hint',
      text: '兼容 OpenAI /chat/completions 的服务都可用：DeepSeek（https://api.deepseek.com/v1 + deepseek-chat）、Kimi（https://api.moonshot.cn/v1 + kimi-k2.6）、本地 Ollama（http://127.0.0.1:11434/v1 + 任意模型）。密钥存在本机 userData/ai-config.json（权限 0600），不会写进备份、报告或日志。',
    }),
    el('div', { class: 'row' }, [saveBtn]),
  ]);
}

/** Render one AI suggestion in the same six-part order as a rule proposal. */
function aiSuggestionCard(s, index) {
  const p = proposalCard(s, index, { ai: true });
  return p;
}

function aiAgentCard() {
  if (!state.ai.config && !state.ai.loading) {
    // Lazy one-shot read on first render of the analysis page.
    loadAiConfig();
  }
  const cfg = state.ai.config;
  const r = state.ai.result;
  const enabled = Boolean(cfg?.enabled);
  const ready = enabled && Boolean(cfg?.hasApiKey);

  const runBtn = button(state.ai.busy ? '分析中… / running' : 'AI 智能体分析 / Ask the agent', {
    variant: ready ? 'primary' : 'ghost',
    enabled: () => ready && Boolean(state.metrics) && !state.ai.busy,
  });
  action(runBtn, 'AI 智能体分析', runAiReview);

  const settingsBtn = button(state.ai.showSettings ? '收起设置 / Hide settings' : '设置 / Settings', { variant: 'ghost' });
  action(settingsBtn, '切换 AI 设置', async () => {
    state.ai.showSettings = !state.ai.showSettings;
    renderStep(state.step);
  });

  // Detail level: how much of the log actually travels with the request.
  const levelSel = el('select', { class: 'input input-sm', id: 'ai-level' }, [
    el('option', { value: 'compact', text: '紧凑 / compact（~9 KB，仅派生指标）', selected: state.ai.level === 'compact' }),
    el('option', { value: 'standard', text: '标准 / standard（~120 KB，含时间序列）', selected: state.ai.level === 'standard' }),
    el('option', { value: 'full', text: '完整 / full（~600 KB，需大上下文模型）', selected: state.ai.level === 'full' }),
  ]);
  levelSel.addEventListener('change', () => {
    state.ai.level = levelSel.value;
    state.ai.exportResult = null;
    renderStep(state.step);
  });

  const exportBtn = button('导出分析包 / Export pack', {
    variant: 'ghost',
    enabled: () => Boolean(state.metrics),
  });
  action(exportBtn, '导出 AI 分析包', exportAiPack);

  const parts = [
    el('p', {
      class: 'prose',
      text: '规则引擎负责测量（频谱、阶跃、洗桨指数、RPM 谐波，全部本地离线），大模型负责推理并写出建议。原始 .bbl 不会离开本机；下面是「发给模型的内容有多少」。',
    }),
    el('div', { class: 'row' }, [
      el('span', { class: 'field-label', text: '数据完整度 / detail' }),
      levelSel,
      runBtn,
      settingsBtn,
      exportBtn,
    ]),
    el('ul', { class: 'evidence' }, [
      el('li', { text: '紧凑：只有派生测量值，最省 token，适合快速复核。' }),
      el('li', { text: '标准：完整黑匣子 header + 全部通道统计 + 全部峰值 + 降采样频谱 + 分段统计 + 全程时间序列包络。' }),
      el('li', { text: '完整：在标准之上把时间序列的采样密度提高数倍，让模型看清抖动/掉速出现的具体时刻；需要 128K 上下文的模型。' }),
      el('li', { text: '导出分析包：把同一份内容写成 .txt，可直接粘贴或作为附件交给任意大模型（不受本 app 端点限制）。' }),
    ]),
    el('div', { class: 'row' }, [
      cfg ? chip(`${str(cfg.model)} @ ${str(cfg.baseUrl)}`, enabled ? 'ok' : 'idle') : chip('读取设置中…', 'idle'),
      ready ? null : chip(enabled ? '缺少 API key' : 'AI 未启用', 'warn'),
      state.metrics ? null : chip('先运行分析 / run metrics first', 'warn'),
      r?.packChars ? chip(`上次发送 ${fmtInt(Math.round(r.packChars / 1024))} KB`, 'idle') : null,
      r?.usage ? chip(`tokens ${fmtInt(r.usage.total_tokens)}`, 'idle') : null,
    ]),
  ];

  if (state.ai.exportResult) {
    parts.push(
      el('p', {
        class: 'hint ok',
        text: `已导出：${str(state.ai.exportResult.path)}（${str(state.ai.exportResult.level)} 档，${fmtInt(Math.round((state.ai.exportResult.chars || 0) / 1024))} KB）`,
      }),
    );
  }

  // First-run help: an unconfigured agent shows its form immediately instead of
  // hiding the only control behind a "settings" toggle.
  if (state.ai.showSettings || !cfg || !ready) parts.push(aiSettingsForm());

  if (state.ai.error) {
    parts.push(banner('warn', 'AI 分析未完成 / AI call failed', [para(state.ai.error), r?.raw ? codeBlock([str(r.raw)]) : null].filter(Boolean)));
  }

  if (r?.ok) {
    if (r.verdict) {
      parts.push(el('div', {}, [el('span', { class: 'field-label', text: '总评 / verdict' }), para(r.verdict, 'prose')]));
    }
    if (r.notes) {
      parts.push(el('div', {}, [el('span', { class: 'field-label', text: '其他观察 / notes' }), para(r.notes, 'prose')]));
    }
  }

  const cardNode = card('AI 智能体分析 / AI agent', parts, {
    badges: ready ? [badge('已启用 / enabled', 'ok'), badge('仅建议 / advisory only', 'warn')] : [badge('未启用 / disabled', 'idle')],
  });

  const out = [cardNode];
  if (r?.ok && Array.isArray(r.proposals) && r.proposals.length) {
    out.push(el('div', { class: 'proposals' }, r.proposals.map((s, i) => aiSuggestionCard(s, i))));
  } else if (r?.ok) {
    out.push(card('AI 建议 / AI suggestions', [el('p', { class: 'hint', text: '模型没有给出可执行的参数改动（可能因为数据不足，或存在 blocksTuning 故障）。' })]));
  }
  return out;
}



/* ================================================================== *
 * 19. Page 3 — history
 * ================================================================== */

async function loadHistoryList() {
  if (state.history.loading) return;
  state.history.loading = true;
  const res = await run('读取报告列表', () => window.bf.history.list());
  state.history.loading = false;
  if (!res.ok) {
    renderStep(state.step);
    return;
  }
  const value = res.value && typeof res.value === 'object' ? res.value : {};
  state.history.reports = Array.isArray(value.reports) ? value.reports : [];
  appendLog(infoEntry(`历史报告：${state.history.reports.length} 份`, 'state'));
  renderStep(state.step);
}

function historyTable() {
  const columns = [
    {
      key: 'savedAt',
      label: '保存时间 / savedAt',
      render: (r) => el('span', { class: 'mono-num', text: fmtDateTime(r?.savedAt) }),
      value: (r) => String(r?.savedAt || ''),
    },
    {
      key: 'file',
      label: '文件 / file',
      render: (r) => el('span', { class: 'mono-num', text: str(r?.file) }),
      value: (r) => String(r?.file || ''),
    },
    {
      key: 'durationS',
      label: '时长 / duration',
      numeric: true,
      defaultDir: -1,
      render: (r) => el('span', { class: 'mono-num', text: r?.summary?.durationS === undefined ? '—' : fmtSeconds(r.summary.durationS) }),
      value: (r) => num(r?.summary?.durationS),
    },
    {
      key: 'sampleRateHz',
      label: '采样率 / rate',
      numeric: true,
      defaultDir: -1,
      render: (r) => el('span', { class: 'mono-num', text: fmtHz(r?.summary?.sampleRateHz) }),
      value: (r) => num(r?.summary?.sampleRateHz),
    },
    {
      key: 'sampleQuality',
      label: '质量 / quality',
      numeric: true,
      defaultDir: -1,
      render: (r) =>
        r?.summary?.sampleQuality === undefined || r?.summary?.sampleQuality === null
          ? '—'
          : el('span', { class: ['mono-num', qualityTone(clamp01(r.summary.sampleQuality)) === 'ok' ? 'tone-ok' : qualityTone(clamp01(r.summary.sampleQuality)) === 'warn' ? 'tone-warn' : 'tone-crit'], text: fmtRatio(r.summary.sampleQuality) }),
      value: (r) => num(r?.summary?.sampleQuality),
    },
    {
      key: 'faults',
      label: '故障 / faults',
      numeric: true,
      defaultDir: -1,
      render: (r) => {
        const f = Array.isArray(r?.summary?.faults) ? r.summary.faults : [];
        return f.length ? badge(String(f.length), 'crit') : badge('0', 'ok');
      },
      value: (r) => (Array.isArray(r?.summary?.faults) ? r.summary.faults : []).length,
    },
    {
      key: 'proposalCount',
      label: '建议 / proposals',
      numeric: true,
      defaultDir: -1,
      render: (r) => el('span', { class: 'mono-num', text: fmtInt(r?.summary?.proposalCount) }),
      value: (r) => num(r?.summary?.proposalCount),
    },
  ];
  return sortableTable({
    columns,
    rows: state.history.reports,
    getKey: (r) => String(r?.id || ''),
    sort: state.historySort,
    selected: (r) => String(r?.id) === String(state.history.openId),
    onRowClick: (r) => openReport(r?.id),
    emptyText: '暂无历史报告 — 运行一次分析后自动保存。',
  });
}

async function openReport(id) {
  if (!id) return;
  state.history.openId = String(id);
  renderStep(state.step);
  const res = await run('读取历史报告', () => window.bf.history.get(id));
  if (!res.ok) return;
  const report = res.value && typeof res.value === 'object' ? res.value.report : null;
  state.history.report = report || null;
  appendLog(infoEntry(`已打开报告 ${str(report?.id)}`, 'state'));
  renderStep(state.step);
}

function historyDetailCard(report) {
  const s = report?.summary && typeof report.summary === 'object' ? report.summary : {};
  const faults = Array.isArray(s.faults) ? s.faults : [];
  const proposals = Array.isArray(report?.proposals) ? report.proposals : [];

  const parts = [
    card(
      '摘要 / Summary',
      [
        kvGrid([
          kv('报告 ID / id', report?.id),
          kv('保存时间 / savedAt', fmtDateTime(report?.savedAt)),
          kv('文件 / file', report?.file, { wrap: false }),
          kv('时长 / durationS', s.durationS === undefined ? '—' : fmtSeconds(s.durationS)),
          kv('采样率 / sampleRateHz', fmtHz(s.sampleRateHz)),
          kv('丢帧率 / dropRatePct', fmtPct(s.dropRatePct, 2)),
          kv('建议数 / proposalCount', fmtInt(s.proposalCount)),
        ]),
        el('div', {}, [
          el('span', { class: 'field-label', text: '样本质量 / sampleQuality' }),
          meter(clamp01(s.sampleQuality), { label: '样本质量', tone: qualityTone(clamp01(s.sampleQuality)), showPct: true }),
        ]),
        el('div', { class: 'row' }, [
          badge(s.blocksTuning ? 'blocksTuning' : 'tuning allowed', s.blocksTuning ? 'crit' : 'ok'),
          faults.length ? badge(`故障 ${faults.length}`, 'crit') : badge('无故障 / no faults', 'ok'),
        ]),
        faults.length ? el('div', { class: 'chips' }, faults.map((f) => chip(str(f), 'crit'))) : null,
      ],
      { badges: [badge('历史存档 / archived', 'info')] },
    ),
  ];

  if (report?.metrics && typeof report.metrics === 'object') {
    parts.push(metricsReportCard(report.metrics));
  }
  if (proposals.length) {
    parts.push(
      el('div', { class: 'hist-report' }, [
        el('div', { class: 'row' }, [el('span', { class: 'field-label', text: `已保存建议 / Saved proposals (${proposals.length})` })]),
        ...proposals.map((p, i) => proposalCard(p, i, { readOnly: true })),
      ]),
    );
  } else {
    parts.push(card('已保存建议 / Saved proposals', [el('p', { class: 'hint', text: '该报告没有保存建议。' })]));
  }

  return el('div', { class: 'hist-report' }, parts);
}

function renderHistory(body) {
  const refreshBtn = button('刷新列表 / Refresh', { variant: 'ghost' });
  action(refreshBtn, '刷新历史报告', loadHistoryList);

  body.append(
    card(
      '报告列表 / Reports',
      [
        historyTable(),
        el('p', { class: 'hint', text: '点击一行打开报告详情（只读）。报告由分析步骤自动保存，表头可点击排序。' }),
      ],
      { actions: [refreshBtn], badges: [badge(`${state.history.reports.length} 份 / reports`, 'info')] },
    ),
  );

  body.append(journalCard());

  if (state.history.report) {
    body.append(historyDetailCard(state.history.report));
  } else {
    body.append(card('报告详情 / Report detail', [el('p', { class: 'hint', text: '点击列表中的一行查看摘要、指标与已保存建议。' })]));
  }
}

/* ================================================================== *
 * 20. AI auto-debug loop
 * ================================================================== */

const AUTO_DEBUG_INTERVAL_MS = 2000; // never spin: at most one iteration every ~2 s
const AUTO_DEBUG_RETRY_DELAY_MS = 700; // small delay between ping retries
const AUTO_DEBUG_PING_RETRIES = 3; // retries after a reconnect attempt
const AUTO_DEBUG_STABLE_PINGS = 3; // consecutive successes => link stable
const AUTO_DEBUG_MAX_ITERATIONS = 40; // runaway guard: stop instead of looping forever

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function autoDebugHint() {
  const a = state.autoDebug;
  const base = `每 ${AUTO_DEBUG_INTERVAL_MS / 1000} s 一轮；连续 ${AUTO_DEBUG_STABLE_PINGS} 次 ping 成功即判定「通信已稳定 / link stable」并自动停止（最多 ${AUTO_DEBUG_MAX_ITERATIONS} 轮）。`;
  if (a.running) {
    return `运行中：第 ${a.iteration} 轮 · ${a.phase}${a.latencyMs === null ? '' : ` · ${fmtInt(a.latencyMs)} ms`}。${base}`;
  }
  if (a.finished) return `已完成：${a.lastOutcome || '通信已稳定 / link stable'}。${base}`;
  return base;
}

/** Repaint every auto-debug affordance without rebuilding a panel. */
function paintAutoDebug() {
  const a = state.autoDebug;
  const chipNode = $('#sb-autodebug');
  if (chipNode && chipNode.isConnected) {
    chipNode.textContent = autoDebugLabel();
    setClass(chipNode, ['chip', 'chip-btn', `chip-${autoDebugTone()}`]);
    chipNode.setAttribute('aria-pressed', String(a.on));
    chipNode.title = a.lastOutcome || 'AI 自动调试循环：点击开启 / 关闭';
  }
  const box = $('#auto-debug');
  if (box && box.isConnected) box.checked = a.on;
  const hint = $('#auto-debug-hint');
  if (hint && hint.isConnected) hint.textContent = autoDebugHint();
  const stopBtn = $('#auto-debug-stop');
  if (stopBtn && stopBtn.isConnected) stopBtn.disabled = !a.on;
}

function toggleAutoDebugLoop(reason) {
  if (state.autoDebug.running) stopAutoDebugLoop(`${reason} / 关闭`);
  else startAutoDebugLoop(reason);
}

function startAutoDebugLoop(reason) {
  const a = state.autoDebug;
  if (a.running) {
    appendLog(warnEntry('自动调试循环已在运行，忽略重复启动 / loop already running'));
    paintAutoDebug();
    return;
  }
  if (a.timerId !== null) {
    window.clearTimeout(a.timerId);
    a.timerId = null;
  }
  a.on = true;
  a.running = true;
  a.finished = false;
  a.iteration = 0;
  a.stable = 0;
  a.latencyMs = null;
  a.phase = 'starting';
  a.lastOutcome = '';
  appendLog(
    infoEntry(
      `[自动调试] 循环已启动 / loop started（${reason}）：每 ${AUTO_DEBUG_INTERVAL_MS / 1000} s 一轮，连续 ${AUTO_DEBUG_STABLE_PINGS} 次 ping 成功判定稳定`,
      'state',
    ),
  );
  paintAutoDebug();
  kickAutoDebug();
}

function stopAutoDebugLoop(reason, opts = {}) {
  const a = state.autoDebug;
  const wasActive = a.running || a.on || a.timerId !== null;
  if (a.timerId !== null) {
    window.clearTimeout(a.timerId);
    a.timerId = null;
  }
  a.running = false;
  a.on = false;
  a.phase = opts.finished ? 'stable' : 'idle';
  if (opts.finished) a.finished = true;
  if (wasActive) a.lastOutcome = reason;
  // `silent` only suppresses the log line (teardown must not write new entries);
  // the toggle is always repainted so it can never claim to be running.
  if (wasActive && !opts.silent) appendLog(infoEntry(`[自动调试] 循环已停止 / loop stopped：${reason}`, 'state'));
  paintAutoDebug();
}

function kickAutoDebug() {
  autoDebugIteration().catch((err) => {
    appendLog(errorEntry(`[自动调试] 循环内部错误 / internal error：${errMessage(err)}`));
    stopAutoDebugLoop('内部错误 / internal error');
  });
}

function scheduleAutoDebugNext() {
  const a = state.autoDebug;
  if (!a.running) return;
  if (a.timerId !== null) window.clearTimeout(a.timerId);
  a.timerId = window.setTimeout(() => {
    a.timerId = null;
    kickAutoDebug();
  }, AUTO_DEBUG_INTERVAL_MS);
  paintAutoDebug();
}

/** Up to AUTO_DEBUG_PING_RETRIES pings with a small delay between attempts. */
async function autoDebugRetryPing(n) {
  const a = state.autoDebug;
  for (let i = 1; i <= AUTO_DEBUG_PING_RETRIES; i += 1) {
    if (!a.running) return null;
    await sleep(AUTO_DEBUG_RETRY_DELAY_MS);
    if (!a.running) return null;
    a.phase = 'retrying';
    paintAutoDebug();
    try {
      const res = await window.bf.fc.ping();
      appendLog(infoEntry(`[自动调试 #${n}] ping 重试 ${i}/${AUTO_DEBUG_PING_RETRIES} ok · 延迟 ${fmtInt(res?.latencyMs)} ms`, 'state'));
      return res;
    } catch (err) {
      appendLog(warnEntry(`[自动调试 #${n}] ping 重试 ${i}/${AUTO_DEBUG_PING_RETRIES} 失败 / failed：${errMessage(err)}`, 'state'));
    }
  }
  return null;
}

/**
 * One loop iteration:
 *   ping -> (reconnect -> up to 3 ping retries) -> readConfig -> stability check.
 * Every await is guarded; the next iteration is scheduled, never spun.
 */
async function autoDebugIteration() {
  const a = state.autoDebug;
  if (!a.running) return;
  if (a.iteration >= AUTO_DEBUG_MAX_ITERATIONS) {
    appendLog(warnEntry(`[自动调试] 已达最大轮数 ${AUTO_DEBUG_MAX_ITERATIONS}，停止循环 / max iterations reached`, 'state'));
    stopAutoDebugLoop('达到最大轮数 / max iterations');
    return;
  }
  a.iteration += 1;
  const n = a.iteration;
  appendLog(infoEntry(`[自动调试 #${n}] 开始：ping 飞控 / ping the FC`, 'state'));

  let ping = null;
  if (!state.connected) {
    appendLog(warnEntry(`[自动调试 #${n}] 当前未连接 / not connected`, 'state'));
  } else {
    try {
      ping = await window.bf.fc.ping();
      appendLog(
        infoEntry(
          `[自动调试 #${n}] ping ok · 延迟 ${fmtInt(ping?.latencyMs)} ms · MSP ${str(ping?.mspProtocolVersion)} / API ${str(ping?.apiVersion)}`,
          'state',
        ),
      );
    } catch (err) {
      ping = null;
      appendLog(warnEntry(`[自动调试 #${n}] ping 失败 / ping failed：${errMessage(err)}`, 'state'));
    }
  }

  if (!ping || ping.ok !== true) {
    if (!a.running) return;
    a.phase = 'reconnecting';
    a.stable = 0;
    state.link = { ...state.link, linkHealthy: false, latencyMs: null };
    paintAutoDebug();
    appendLog(warnEntry(`[自动调试 #${n}] 调用 bf.fc.reconnect()（关闭串口 → 等待 2 s → 重新打开）`, 'state'));
    try {
      const rec = await window.bf.fc.reconnect();
      appendLog(
        infoEntry(
          `[自动调试 #${n}] 重连返回 ok=${str(rec?.ok)} · linkState=${str(rec?.linkState)} · recoveries=${fmtInt(rec?.recoveries)}`,
          'state',
        ),
      );
      if (rec && typeof rec.linkState === 'string') {
        state.link = {
          ...state.link,
          linkState: rec.linkState,
          linkHealthy: rec.linkState === 'msp',
          recoveries: num(rec.recoveries) ?? state.link.recoveries,
        };
      }
    } catch (err) {
      appendLog(errorEntry(`[自动调试 #${n}] 重连失败 / reconnect failed：${errMessage(err)}`));
      stopAutoDebugLoop('重连失败 / reconnect failed — 请先在第 1 步手动连接串口');
      return;
    }
    ping = await autoDebugRetryPing(n);
  }

  if (!a.running) return;

  if (!ping) {
    a.stable = 0;
    a.phase = 'idle';
    state.link = { ...state.link, linkHealthy: false, latencyMs: null };
    appendLog(warnEntry(`[自动调试 #${n}] 链路仍不可用 / link still down（${AUTO_DEBUG_PING_RETRIES} 次 ping 重试均失败）`, 'state'));
    scheduleAutoDebugNext();
    return;
  }

  a.latencyMs = num(ping.latencyMs);
  state.link = { ...state.link, linkState: 'msp', linkHealthy: true, latencyMs: a.latencyMs, checkedAt: Date.now() };

  // Blackbox configuration is read-only and permitted in SAFE MODE.
  try {
    const cfg = await window.bf.bb.readConfig();
    state.bb.live = cfg && typeof cfg === 'object' ? cfg : null;
    appendLog(infoEntry(`[自动调试 #${n}] 黑匣子配置 / blackbox config：${describeBbConfig(state.bb.live)}`, 'state'));
    paintBlackboxLive();
  } catch (err) {
    appendLog(warnEntry(`[自动调试 #${n}] 读取黑匣子配置失败 / readConfig failed：${errMessage(err)}`, 'state'));
  }

  if (!a.running) return;

  a.stable += 1;
  if (a.stable >= AUTO_DEBUG_STABLE_PINGS) {
    appendLog(infoEntry(`通信已稳定 / link stable：连续 ${a.stable} 次 ping 成功，循环停止`, 'state'));
    stopAutoDebugLoop(`通信已稳定 / link stable（连续 ${a.stable} 次成功）`, { finished: true });
    return;
  }

  a.phase = 'pinging';
  appendLog(infoEntry(`[自动调试 #${n}] 稳定计数 / stable ${a.stable}/${AUTO_DEBUG_STABLE_PINGS}`, 'state'));
  scheduleAutoDebugNext();
}

/* ================================================================== *
 * 21. Boot
 * ================================================================== */

async function loadContract() {
  try {
    const mod = await import('../shared/contracts.js');
    state.contractSource = '../shared/contracts.js';
    return {
      BLACKBOX_FIELDS: Array.isArray(mod.BLACKBOX_FIELDS) ? mod.BLACKBOX_FIELDS : LOCAL_CONTRACT.BLACKBOX_FIELDS,
      REQUIRED_BB_FIELDS: Array.isArray(mod.REQUIRED_BB_FIELDS) ? mod.REQUIRED_BB_FIELDS : LOCAL_CONTRACT.REQUIRED_BB_FIELDS,
      BLACKBOX_DEVICE: mod.BLACKBOX_DEVICE || LOCAL_CONTRACT.BLACKBOX_DEVICE,
      FORBIDDEN_PARAMS: Array.isArray(mod.FORBIDDEN_PARAMS) ? mod.FORBIDDEN_PARAMS : LOCAL_CONTRACT.FORBIDDEN_PARAMS,
      MAX_TUNE_ROUNDS: num(mod.MAX_TUNE_ROUNDS) ?? LOCAL_CONTRACT.MAX_TUNE_ROUNDS,
    };
  } catch (err) {
    appendLog(warnEntry(`未能加载 ../shared/contracts.js（${errMessage(err)}），使用内置镜像常量`));
    state.contractSource = 'local mirror';
    return LOCAL_CONTRACT;
  }
}

function fatalNoPreload() {
  appendLog({ level: 'fatal', kind: 'log', message: 'window.bf 不存在：preload 未加载，界面只读。', ts: Date.now() });
  const chipNode = $('#preload-state');
  if (chipNode) chipNode.hidden = false;
  const body = $('#body-0');
  if (body) {
    setChildren(body, [
      banner('crit', 'preload 未加载 / preload missing', [
        para('window.bf 不可用。请通过 Electron 启动应用，由 contextBridge 预加载脚本注入 window.bf。'),
      ]),
    ]);
  }
  updateRail();
  renderStatusBar();
}

function wireStaticUI() {
  for (const btn of $$('.rail .step')) {
    btn.addEventListener('click', () => goStep(Number(btn.dataset.step)));
  }

  // Wired exactly once: this runs from boot(), not from a repaint, so the
  // listener cannot accumulate.
  const themeBtn = $('#theme-toggle');
  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
  const toggle = $('#log-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => setLogOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  }
  const clear = $('#log-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      const list = $('#log-list');
      if (list) setChildren(list, []);
      state.log.count = 0;
      updateLogCount();
    });
  }
  const filter = $('#log-filter');
  if (filter) {
    filter.addEventListener('change', () => {
      state.log.filter = filter.value;
      applyLogFilter();
    });
  }
  const follow = $('#log-follow');
  if (follow) {
    follow.addEventListener('change', () => {
      state.log.follow = follow.checked;
    });
  }
  window.addEventListener('unhandledrejection', (event) => {
    appendLog(errorEntry(`未处理的 Promise 拒绝：${errMessage(event.reason)}`));
  });
  window.addEventListener('error', (event) => {
    appendLog(errorEntry(`脚本错误：${event.message}`));
  });
  // The loop must never outlive the document: no logs, no timers, no IPC.
  window.addEventListener('beforeunload', () => {
    stopAutoDebugLoop('窗口关闭 / window unloading', { silent: true });
  });
}

/* ------------------------------------------------------------------ *
 * First-run permission guidance
 * ------------------------------------------------------------------ */

const FIRST_RUN_KEY = 'bf-ai-tuner.firstRunNoticeSeen';

/* ------------------------------------------------------------------ *
 * Theme (light / dark), following the Betaflight Configurator palette
 *
 * The palette itself lives entirely in styles.css as custom properties, so the
 * only job here is choosing which set applies and repainting the canvases,
 * which read CSS variables at draw time and therefore cannot follow on their own.
 * ------------------------------------------------------------------ */

const THEME_KEY = 'bf.theme';
const THEME_MODES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: '自动 / Auto', light: '浅色 / Light', dark: '深色 / Dark' };
const THEME_ICON = { auto: '◐', light: '☀︎', dark: '☾' };

/** Resolves a mode to a concrete theme; "auto" follows the OS setting. */
function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  const prefersLight =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: light)').matches;
  return prefersLight ? 'light' : 'dark';
}

function readThemeMode() {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    if (THEME_MODES.includes(saved)) return saved;
  } catch {
    // Private browsing or storage disabled - fall back to following the OS.
  }
  return 'auto';
}

/**
 * Applies a theme and repaints what CSS cannot reach.
 *
 * Canvas charts resolve their colours from the CSS variables when they draw, so
 * a theme change has to redraw them: re-rendering the current step rebuilds the
 * per-motor sparklines, and the FFT canvas is painted separately.
 */
function applyTheme(mode, { repaint = true } = {}) {
  const wanted = THEME_MODES.includes(mode) ? mode : 'auto';
  const resolved = resolveTheme(wanted);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themeMode = wanted;
  // Match native form controls / scrollbars to the chosen appearance.
  root.style.colorScheme = resolved;

  state.theme = wanted;
  const label = $('#theme-label');
  if (label) label.textContent = THEME_LABEL[wanted];
  const icon = $('#theme-icon');
  if (icon) icon.textContent = THEME_ICON[wanted];
  const btn = $('#theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(resolved === 'light'));
    btn.title = `当前：${THEME_LABEL[wanted]}（${resolved === 'light' ? '浅色' : '深色'}）/ click to cycle`;
  }

  try {
    window.localStorage.setItem(THEME_KEY, wanted);
  } catch {
    // Persistence is a nicety; the theme still applies for this session.
  }

  if (repaint) {
    paintFft();
    renderStep(state.step);
  }
  return resolved;
}

/** Cycles auto -> light -> dark -> auto. */
function toggleTheme() {
  const current = THEME_MODES.includes(state.theme) ? state.theme : 'auto';
  const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length];
  applyTheme(next);
  appendLog(infoEntry(`主题切换：${THEME_LABEL[next]}`, 'state'));
}

/**
 * macOS raises no serial-port consent prompt for an unsigned build - there is no
 * Developer ID to attribute it to - and a freshly copied app has no privacy
 * record at all, so `SerialPort.list()` simply returns nothing. Explain that
 * once, with the exact path macOS needs, rather than leaving the operator
 * staring at an empty port dropdown.
 */
function maybeShowFirstRunNotice() {
  const backdrop = $('#first-run');
  if (!backdrop) return;

  let alreadySeen = false;
  try {
    alreadySeen = window.localStorage.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    // Storage unavailable: showing the notice again is the safer failure.
    alreadySeen = false;
  }
  if (alreadySeen) return;

  const dismissButton = $('#first-run-dismiss');
  const openSettingsButton = $('#first-run-open-settings');

  function onKeyDown(event) {
    if (event.key === 'Escape') close();
  }

  function close() {
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKeyDown);
    try {
      window.localStorage.setItem(FIRST_RUN_KEY, '1');
    } catch {
      /* ignore */
    }
    appendLog(infoEntry('已确认串口权限指引', 'state'));
  }

  dismissButton?.addEventListener('click', close);

  openSettingsButton?.addEventListener('click', async () => {
    try {
      const result = await window.bf.app.openPrivacySettings();
      appendLog(
        infoEntry(
          result && result.opened
            ? '已打开 系统设置 > 隐私与安全性，请在「完全磁盘访问」中添加 BF-AITuner'
            : '无法自动打开系统设置，请手动前往 系统设置 > 隐私与安全性 > 完全磁盘访问',
          'state',
        ),
      );
    } catch (err) {
      appendLog(warnEntry(`打开系统设置失败：${err.message}`));
    }
  });

  // Clicking the backdrop also resolves it; the buttons are the documented path.
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown);

  backdrop.hidden = false;
  dismissButton?.focus();
}

async function boot() {
  wireStaticUI();
  // Apply before anything renders so there is no flash of the wrong theme.
  applyTheme(readThemeMode(), { repaint: false });
  if (typeof window.matchMedia === 'function') {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if ((state.theme ?? 'auto') === 'auto') applyTheme('auto');
    });
  }
  if (!window.bf) {
    fatalNoPreload();
    return;
  }
  state.contract = await loadContract();
  if (!state.bb.fields.size) state.bb.fields = new Set(contractRequired());
  if (!state.safety.maxRounds) state.safety.maxRounds = num(state.contract.MAX_TUNE_ROUNDS) ?? 1;
  appendLog(infoEntry(`契约常量来源：${state.contractSource}`, 'state'));
  subscribeEvents();
  updateRail();
  renderStatusBar();
  await refreshSafety();
  await loadPorts();
  showStep(0);
  if (state.connected) state.done.add(0);
  maybeShowFirstRunNotice();
}

/* ------------------------------------------------------------------ *
 * Test-only introspection hook (never set in production builds).
 * The throwaway DOM harness in /tmp uses this to assert internal state
 * without reaching into module scope.
 * ------------------------------------------------------------------ */
if (window.__BF_UI_TEST__) {
  window.__bfUiTest = {
    state,
    STEPS,
    gateInfo,
    safetyInfo,
    writesBlocked,
    applySafetyPayload,
    renderAllSteps,
    showStep,
    renderStatusBar,
    refreshGuards,
    decimateSpectrum,
    drawFft,
    drawStepPlot,
    evidenceCard,
    mechanicalCard,
    campaignCard,
    scorecardCard,
    journalCard,
    stepResponseCard,
    flightGuidanceCard,
    drawSparkline,
    recordBidirProbe,
    confirmDiffDialog,
    sortableTable,
    FFT_MAX_POINTS,
    BIDIR_HISTORY_MAX,
    applyTheme,
    resolveTheme,
    toggleTheme,
    THEME_MODES,
  };
}

boot();
