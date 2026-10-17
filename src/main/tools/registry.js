/**
 * The tool surface.
 *
 * `TOOL_HANDLERS` maps every channel in contracts.js to a thin function over
 * the Session. Keeping this layer thin matters: it is the only place where an
 * untrusted renderer can reach the flight controller, so each handler states
 * plainly what it does and delegates all policy to Session/SafetyGuard.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CH, TOOL_SCHEMAS } from '../../shared/contracts.js';
import { EVIDENCE_NEEDS, FLIGHT_CARDS } from '../analysis/evidence.js';

/**
 * @param {import('../session.js').Session} session
 * @param {{pickFile?:Function, appInfo?:Function, onLog?:Function}} ctx
 * @returns {Record<string, Function>}
 */
export function createHandlers(session, ctx = {}) {
  const {
    pickFile = async () => null,
    saveFile = async () => null,
    appInfo = () => ({}),
    openPrivacySettings = async () => ({ opened: false }),
    onLog = () => {},
  } = ctx;

  return {
    /* ---------------- app / ports ---------------- */

    [CH.APP_INFO]: async () => appInfo(),

    [CH.APP_OPEN_PRIVACY_SETTINGS]: async () => openPrivacySettings(),

    [CH.PORT_LIST]: async () => {
      const { ports, error, troubleshooting } = await session.constructor.listPorts();
      // troubleshooting tells the operator what to check when nothing looks
      // like a flight controller (cable, drivers, Web Serial holding the port).
      return { ports, error, troubleshooting };
    },

    /* ---------------- flight controller ---------------- */

    [CH.FC_CONNECT]: async ({ port } = {}) => {
      if (!port) throw new Error('a serial port is required');
      return session.connect(port);
    },

    [CH.FC_DISCONNECT]: async () => session.disconnect(),

    [CH.FC_GET_SETTINGS]: async () => session.getSettings(),

    [CH.FC_IDENTIFY]: async () => session.identify(),

    [CH.FC_PING]: async () => session.ping(),

    [CH.FC_RECONNECT]: async () => session.reconnect(),

    [CH.FC_CAPABILITIES]: async () => session.probeCapabilities(),

    [CH.FC_BIDIR]: async () => session.probeBidirDshot(),

    [CH.FC_APPLY_BIDIR]: async (opts = {}) => session.applyBidir(opts),

    [CH.HISTORY_LIST]: async () => session.listReports(),

    [CH.HISTORY_GET]: async ({ id } = {}) => session.getReport(id),

    [CH.FC_BACKUP]: async () => session.backup(),

    [CH.FC_RUN_CLI]: async ({ commands = [], dryRun = true } = {}) =>
      session.runCli(commands, { dryRun, kind: 'manual' }),

    /* ---------------- blackbox ---------------- */

    [CH.BB_CONFIG]: async ({ rate = 2000, device = 'auto', fields = [], dryRun = true } = {}) =>
      session.blackboxConfig({ rate, device, fields, dryRun }),

    [CH.BB_ERASE]: async ({ device = 'auto', confirm = false } = {}) => session.blackboxErase({ device, confirm }),

    [CH.BB_DOWNLOAD]: async ({ verify = true } = {}) => session.blackboxDownload({ verify }),

    [CH.BB_READ_CONFIG]: async () => session.blackboxReadConfig(),

    // Large onboard logs are copied from a mounted volume, not over MSP.
    [CH.BB_MSC_ENTER]: async () => session.mscEnter(),
    [CH.BB_MSC_STATUS]: async () => session.mscStatus(),
    [CH.BB_MSC_IMPORT]: async (opts = {}) => session.mscImport(opts),
    [CH.BB_MSC_EXIT]: async () => session.mscExit(),

    /* ------------- backup (mandatory) / rollback ------------- */

    [CH.BACKUP_CREATE]: async ({ note = '', pendingDiff = [] } = {}) =>
      session.backup({ note, pendingDiff }),
    [CH.BACKUP_LIST]: async () => session.listBackups(),
    [CH.BACKUP_ROLLBACK]: async ({ id = null, requireConfirm = true, token = null } = {}) =>
      session.rollback({ id, requireConfirm, token }),

    /** Re-fly judgement; can restore the previous tuning automatically. */
    [CH.TUNE_EVALUATE]: async ({ file = null, metrics = null, autoRollback = true } = {}) =>
      session.evaluateReflight({ file, metrics, autoRollback }),

    /* ---------------- log analysis ---------------- */

    [CH.BBL_PICK_FILE]: async () => {
      const file = await pickFile();
      return { file };
    },

    [CH.BBL_DECODE]: async ({ file } = {}) => {
      if (!file) throw new Error('a .bbl file path is required');
      return session.decodeLog(file);
    },

    /**
     * Frequency-domain view. Returns the per-axis spectra and peaks from the
     * same analysis pass that bbl_metrics uses, so the two can never disagree.
     */
    [CH.BBL_FFT]: async ({ file } = {}) => {
      if (!file) throw new Error('a .bbl file path is required');
      const report = await session.computeMetrics(file);
      return {
        file,
        sampleRateHz: report.sampleRateHz,
        axes: Object.fromEntries(
          Object.entries(report.axes || {}).map(([axis, m]) => [
            axis,
            {
              gyroSpectrum: m.gyroSpectrum,
              dTermSpectrum: m.dTermSpectrum,
              peaks: m.peaks,
              motorNoisePeakHz: m.motorNoisePeakHz,
              noiseFloorDbfs: m.noiseFloorDbfs,
              rpmHarmonicMatch: m.rpmHarmonicMatch,
            },
          ]),
        ),
      };
    },

    [CH.BBL_METRICS]: async ({ file } = {}) => {
      if (!file) throw new Error('a .bbl file path is required');
      return session.computeMetrics(file);
    },

    [CH.BBL_FLIGHT_CARDS]: async () => ({ cards: FLIGHT_CARDS, needs: EVIDENCE_NEEDS }),

    /* ---------------- tuning ---------------- */

    [CH.TUNE_PROPOSE]: async ({ metrics = null, currentPid = null, currentFilter = null } = {}) =>
      session.proposeTune({ metrics, currentPid, currentFilter }),

    [CH.TUNE_APPLY]: async (args = {}) => session.applyTune(args),

    /* ---------------- AI agent (optional, read-only) ---------------- */

    /**
     * All three AI handlers are read-only with respect to the flight
     * controller: they read settings, and they POST a measurement summary to a
     * model the operator configured. Applying anything the model suggests still
     * goes through TUNE_APPLY and its two-phase token.
     */
    [CH.AI_GET_CONFIG]: async () => session.getAiConfig(),

    [CH.AI_SET_CONFIG]: async (patch = {}) => session.setAiConfig(patch),

    [CH.AI_ANALYZE]: async ({ metrics = null, file = null, level = 'standard' } = {}) =>
      session.aiAnalyze({ metrics, file, level }),

    /**
     * Write the pack + prompt to a text file, so the operator can hand the
     * complete log summary to any assistant that accepts an attachment without
     * configuring an endpoint in this app.
     */
    [CH.AI_EXPORT_PACK]: async ({ metrics = null, level = 'full' } = {}) => {
      const filePath = await saveFile({
        defaultPath: `bf-ai-pack-${level}.txt`,
        filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
      });
      if (!filePath) return { canceled: true };
      return session.exportAiPack({ metrics, level, filePath });
    },

    /* ---------------- safety ---------------- */

    /**
     * Resolves to the SafetyStatus shape documented in contracts.js, flattened,
     * with the link fields alongside. Keeping this identical to the shape that
     * ack()/forceTrust() return is what stops the UI from reading `readOnly`
     * off the wrong level and painting a false "WRITABLE".
     */
    [CH.SAFETY_STATUS]: async () => {
      const status = session.status();
      return {
        ...status.safety,
        connected: status.connected,
        port: status.port,
        linkState: status.linkState,
        linkHealthy: status.linkHealthy,
        recoveries: status.recoveries,
        hasIdentity: status.hasIdentity,
        hasSettings: status.hasSettings,
        hasMetrics: status.hasMetrics,
      };
    },

    [CH.SAFETY_ACK]: async () => session.guard.ack(),

    [CH.SAFETY_FORCE_TRUST]: async () => session.forceTrust(),
  };
}

/**
 * Wires the handlers onto Electron's ipcMain.
 * Returns a disposer so tests can tear the wiring down.
 *
 * @param {import('electron').IpcMain} ipcMain
 * @param {Record<string, Function>} handlers
 */
export function registerIpc(ipcMain, handlers) {
  const channels = Object.keys(handlers);
  for (const channel of channels) {
    ipcMain.handle(channel, async (_event, args) => {
      try {
        const result = await handlers[channel](args);
        return { ok: true, result };
      } catch (err) {
        // Errors cross the IPC boundary as data; the renderer renders them in
        // its log panel rather than losing them to an unhandled rejection.
        return { ok: false, error: { message: err.message, name: err.name, stack: err.stack } };
      }
    });
  }
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}

/** Sanity check: every declared tool schema must have a handler. */
export function missingHandlers(handlers) {
  return Object.entries(TOOL_SCHEMAS)
    .filter(([, schema]) => !handlers[schema.channel])
    .map(([name, schema]) => `${name} -> ${schema.channel}`);
}

export default { createHandlers, registerIpc, missingHandlers };
