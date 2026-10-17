/**
 * Preload bridge.
 *
 * CommonJS on purpose: with `sandbox: true` Electron cannot load an ESM preload
 * (and this package is `"type": "module"`), so this file is `.cjs`.
 *
 * Because a sandboxed preload cannot import the ESM contracts module, the
 * channel names are mirrored here. `test/contracts.test.js` asserts this file
 * and `src/shared/contracts.js` stay in sync, so the mirror cannot silently
 * drift.
 *
 * The renderer gets a narrow, promise-based surface and nothing else: no
 * `ipcRenderer`, no `require`, no Node globals.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const { contextBridge, ipcRenderer } = require('electron');

// Mirrors CH in src/shared/contracts.js — verified by test/contracts.test.js
const CH = {
  APP_INFO: 'app:info',
  APP_OPEN_PRIVACY_SETTINGS: 'app:open_privacy_settings',
  PORT_LIST: 'port:list',
  FC_CONNECT: 'fc:connect',
  FC_DISCONNECT: 'fc:disconnect',
  FC_GET_SETTINGS: 'fc:get_settings',
  FC_RUN_CLI: 'fc:run_cli',
  FC_IDENTIFY: 'fc:identify',
  FC_PING: 'fc:ping',
  FC_RECONNECT: 'fc:reconnect',
  FC_BIDIR: 'fc:bidir',
  FC_APPLY_BIDIR: 'fc:apply_bidir',
  FC_CAPABILITIES: 'fc:capabilities',
  FC_BACKUP: 'fc:backup',
  BB_CONFIG: 'blackbox:config',
  BB_ERASE: 'blackbox:erase',
  BB_DOWNLOAD: 'blackbox:download',
  BB_READ_CONFIG: 'blackbox:read_config',
  BBL_DECODE: 'bbl:decode',
  BBL_FFT: 'bbl:fft',
  BBL_METRICS: 'bbl:metrics',
  BBL_PICK_FILE: 'bbl:pick_file',
  BBL_FLIGHT_CARDS: 'bbl:flight_cards',
  BB_MSC_ENTER: 'blackbox:msc_enter',
  BB_MSC_STATUS: 'blackbox:msc_status',
  BB_MSC_IMPORT: 'blackbox:msc_import',
  BB_MSC_EXIT: 'blackbox:msc_exit',
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_ROLLBACK: 'backup:rollback',
  TUNE_EVALUATE: 'tune:evaluate',
  TUNE_PROPOSE: 'tune:propose',
  TUNE_APPLY: 'tune:apply',
  TUNE_PLAN: 'tune:plan',
  JOURNAL_LIST: 'journal:list',
  JOURNAL_GET: 'journal:get',
  JOURNAL_SET_PROFILE: 'journal:set_profile',
  JOURNAL_ADD_NOTE: 'journal:add_note',
  AI_GET_CONFIG: 'ai:get_config',
  AI_SET_CONFIG: 'ai:set_config',
  AI_ANALYZE: 'ai:analyze',
  AI_EXPORT_PACK: 'ai:export_pack',
  SAFETY_STATUS: 'safety:status',
  SAFETY_ACK: 'safety:ack',
  SAFETY_FORCE_TRUST: 'safety:force_trust',
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  EVENT: 'app:event',
};

/**
 * Unwraps the `{ok, result|error}` envelope the main process returns, so the
 * renderer sees plain values and real thrown Errors.
 */
function invoke(channel, args) {
  return ipcRenderer.invoke(channel, args).then((response) => {
    if (!response || typeof response !== 'object') {
      throw new Error(`malformed IPC response on ${channel}`);
    }
    if (!response.ok) {
      const detail = response.error || {};
      const error = new Error(detail.message || `IPC call ${channel} failed`);
      error.name = detail.name || 'IpcError';
      error.channel = channel;
      if (detail.stack) error.stack = detail.stack;
      throw error;
    }
    return response.result;
  });
}

const api = {
  app: {
    info: () => invoke(CH.APP_INFO),
    /** Deep-links to System Settings > Privacy & Security (full disk access). */
    openPrivacySettings: () => invoke(CH.APP_OPEN_PRIVACY_SETTINGS),
  },

  ports: {
    list: () => invoke(CH.PORT_LIST),
  },

  fc: {
    connect: (port) => invoke(CH.FC_CONNECT, { port }),
    disconnect: () => invoke(CH.FC_DISCONNECT),
    getSettings: () => invoke(CH.FC_GET_SETTINGS),
    runCli: (commands, dryRun = true) => invoke(CH.FC_RUN_CLI, { commands, dryRun }),
    identify: () => invoke(CH.FC_IDENTIFY),
    /** One MSP round trip; used by the auto-debug loop. */
    ping: () => invoke(CH.FC_PING),
    /** Close, wait 2 s, reopen, and confirm MSP answers. */
    reconnect: () => invoke(CH.FC_RECONNECT),
    /** Read-only bidirectional DShot / RPM probe with per-motor telemetry. */
    bidir: () => invoke(CH.FC_BIDIR),
    /** Scoped dry-run -> confirm -> CLI save for dshot_bidir / motor_poles / rpm_filter_*. */
    applyBidir: (opts = {}) => invoke(CH.FC_APPLY_BIDIR, opts),
    capabilities: () => invoke(CH.FC_CAPABILITIES),
    backup: () => invoke(CH.FC_BACKUP),
  },

  bb: {
    config: (opts = {}) => invoke(CH.BB_CONFIG, opts),
    erase: (opts = {}) => invoke(CH.BB_ERASE, opts),
    download: (opts = {}) => invoke(CH.BB_DOWNLOAD, opts),
    /** Read the live blackbox config. Permitted in SAFE MODE. */
    readConfig: () => invoke(CH.BB_READ_CONFIG),
    /**
     * Mass-storage mode for logs too large to pull over MSP. The FC reboots
     * and its onboard storage mounts as a USB volume; no MSP writes are
     * possible until it is ejected and power-cycled.
     */
    mscEnter: (opts = {}) => invoke(CH.BB_MSC_ENTER, opts),
    mscStatus: () => invoke(CH.BB_MSC_STATUS),
    mscImport: (opts = {}) => invoke(CH.BB_MSC_IMPORT, opts),
    mscExit: () => invoke(CH.BB_MSC_EXIT),
  },

  /** Mandatory pre-write backup and the one-click rollback behind it. */
  backup: {
    create: (opts = {}) => invoke(CH.BACKUP_CREATE, opts),
    list: () => invoke(CH.BACKUP_LIST),
    rollback: (opts = {}) => invoke(CH.BACKUP_ROLLBACK, opts),
  },

  bbl: {
    pickFile: () => invoke(CH.BBL_PICK_FILE).then((r) => (r ? r.file : null)),
    decode: (file) => invoke(CH.BBL_DECODE, { file }),
    fft: (file, axis = null) => invoke(CH.BBL_FFT, { file, axis }),
    metrics: (file) => invoke(CH.BBL_METRICS, { file }),
    /** Guided test flights + per-domain evidence needs (static data). */
    flightCards: () => invoke(CH.BBL_FLIGHT_CARDS),
  },

  tune: {
    propose: (args = {}) => invoke(CH.TUNE_PROPOSE, args),
    apply: (args = {}) => invoke(CH.TUNE_APPLY, args),
    /** Re-analyse a post-change flight and judge better / worse. */
    evaluate: (args = {}) => invoke(CH.TUNE_EVALUATE, args),
    /** Stage plan + racing scorecard of the latest propose. */
    plan: () => invoke(CH.TUNE_PLAN),
  },

  /** Per-quad tuning journal (local only). */
  journal: {
    list: () => invoke(CH.JOURNAL_LIST),
    get: (id) => invoke(CH.JOURNAL_GET, { id }),
    setProfile: (id, patch = {}) => invoke(CH.JOURNAL_SET_PROFILE, { id, patch }),
    addNote: (id, text) => invoke(CH.JOURNAL_ADD_NOTE, { id, text }),
  },

  /**
   * Optional AI agent layer. The settings form is the only place an API key is
   * entered; it is stored in userData with mode 0600 and is never echoed back.
   */
  ai: {
    getConfig: () => invoke(CH.AI_GET_CONFIG),
    setConfig: (patch = {}) => invoke(CH.AI_SET_CONFIG, patch),
    analyze: (args = {}) => invoke(CH.AI_ANALYZE, args),
    /** Save the full pack + prompt to a file for use in any other assistant. */
    exportPack: (args = {}) => invoke(CH.AI_EXPORT_PACK, args),
  },

  history: {
    list: () => invoke(CH.HISTORY_LIST),
    get: (id) => invoke(CH.HISTORY_GET, { id }),
  },

  safety: {
    status: () => invoke(CH.SAFETY_STATUS),
    ack: () => invoke(CH.SAFETY_ACK),
    /** Advanced: proceed for an unknown board. Flight-param writes stay locked. */
    forceTrust: () => invoke(CH.SAFETY_FORCE_TRUST),
  },

  /**
   * Subscribe to pushed session events.
   * @param {(event: {level:string, kind:string, message:string, ts:number, data?:any}) => void} handler
   * @returns {() => void} unsubscribe
   */
  on(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        handler(payload);
      } catch (err) {
        // A throwing listener must not take down the bridge.
        console.error('event handler failed', err);
      }
    };
    ipcRenderer.on(CH.EVENT, listener);
    return () => ipcRenderer.removeListener(CH.EVENT, listener);
  },
};

contextBridge.exposeInMainWorld('bf', api);
