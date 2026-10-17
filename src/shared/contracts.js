/**
 * Single source of truth for every boundary in the app:
 *   - IPC channel names (main <-> renderer)
 *   - data shapes exchanged across those boundaries
 *   - the agent-facing tool schema registry
 *
 * Both processes import THIS file, so a shape can never drift between them.
 * Pure data + JSDoc: no Electron, no Node, no DOM. Safe to import anywhere.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/* ------------------------------------------------------------------ *
 * 1. IPC channels
 * ------------------------------------------------------------------ */

export const CH = {
  // --- app / host ---
  APP_INFO: 'app:info',
  APP_OPEN_PRIVACY_SETTINGS: 'app:open_privacy_settings',

  // --- serial port selection ---
  PORT_LIST: 'port:list',

  // --- flight controller session ---
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

  // --- blackbox ---
  BB_CONFIG: 'blackbox:config',
  BB_ERASE: 'blackbox:erase',
  BB_DOWNLOAD: 'blackbox:download',
  BB_READ_CONFIG: 'blackbox:read_config',
  // Large onboard logs are copied from a mounted volume, not over MSP.
  BB_MSC_ENTER: 'blackbox:msc_enter',
  BB_MSC_STATUS: 'blackbox:msc_status',
  BB_MSC_IMPORT: 'blackbox:msc_import',
  BB_MSC_EXIT: 'blackbox:msc_exit',

  // --- backup (mandatory before any write) / rollback ---
  BACKUP_CREATE: 'backup:create',
  BACKUP_LIST: 'backup:list',
  BACKUP_ROLLBACK: 'backup:rollback',

  // --- re-fly evaluation: decides "better" / "worse" and can auto-roll-back ---
  TUNE_EVALUATE: 'tune:evaluate',

  // --- log analysis (offline, no FC required) ---
  BBL_DECODE: 'bbl:decode',
  BBL_FFT: 'bbl:fft',
  BBL_METRICS: 'bbl:metrics',
  BBL_PICK_FILE: 'bbl:pick_file',
  BBL_FLIGHT_CARDS: 'bbl:flight_cards',

  // --- tuning ---
  TUNE_PROPOSE: 'tune:propose',
  TUNE_APPLY: 'tune:apply',
  /** Campaign stage plan + racing scorecard of the latest tune:propose. */
  TUNE_PLAN: 'tune:plan',

  // --- per-quad tuning journal (local userData only, never the FC) ---
  JOURNAL_LIST: 'journal:list',
  JOURNAL_GET: 'journal:get',
  JOURNAL_SET_PROFILE: 'journal:set_profile',
  JOURNAL_ADD_NOTE: 'journal:add_note',

  // --- AI agent analysis (optional; needs a user-supplied OpenAI-compatible endpoint) ---
  AI_GET_CONFIG: 'ai:get_config',
  AI_SET_CONFIG: 'ai:set_config',
  AI_ANALYZE: 'ai:analyze',
  AI_EXPORT_PACK: 'ai:export_pack',

  // --- safety ---
  SAFETY_STATUS: 'safety:status',
  SAFETY_ACK: 'safety:ack',
  SAFETY_FORCE_TRUST: 'safety:force_trust',
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',

  // --- main -> renderer push ---
  EVENT: 'app:event',
};

/** Event severity, ordered. `fatal` latches read-only mode. */
export const EVENT_LEVEL = ['debug', 'info', 'warn', 'error', 'fatal'];

/** Event kinds the renderer may receive on CH.EVENT. */
export const EVENT_KIND = [
  'log',
  'progress',
  'state',
  'safety',
  'msp-trace',
  'download-progress',
];

/* ------------------------------------------------------------------ *
 * 2. Typedefs
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} PortInfo
 * @property {string} path            e.g. "/dev/tty.usbmodem21201"
 * @property {string} [manufacturer]
 * @property {string} [serialNumber]
 * @property {string} [vendorId]      hex, e.g. "0x0483"
 * @property {string} [productId]
 * @property {boolean} likelyFc       heuristic: STM32/CP210x/CH340/FTDI VID
 */

/**
 * Result of the port:list channel.
 *
 * NOTE: this is an OBJECT, not a bare array. Treating it as an array makes the
 * port dropdown silently empty while the flight controller is perfectly
 * visible to the main process.
 *
 * @typedef {object} PortListResult
 * @property {PortInfo[]} ports
 * @property {string|null} error   set when the serialport binding is unavailable
 */

/**
 * @typedef {object} FcIdentity
 * @property {string} variant            "BTFL" | "CLFL" | "INAV" | ...
 * @property {string} version            "4.5.1"
 * @property {string} apiVersion         MSP API version, "1.46.0"
 * @property {string} boardIdentifier    4-char board id, e.g. "S405"
 * @property {string} boardName          human name from MSP_BOARD_INFO
 * @property {string} targetName         build target, e.g. "STM32F405"
 * @property {string} [buildKey]
 * @property {string} [craftName]
 * @property {string} fingerprint        stable hash used as the map key
 * @property {number} confidence         0..1
 * @property {'exact'|'board'|'family'|'unknown'} matchLevel
 * @property {string[]} evidence         human-readable reasons for the verdict
 * @property {boolean} known             present in the local model map
 * @property {string} [modelHint]        resolved model note from the map
 */

/**
 * @typedef {object} Capabilities
 * @property {number} pidLooptimeUs       e.g. 125 (8k) / 250 (4k)
 * @property {number} gyroRateHz
 * @property {number} pidRateHz
 * @property {boolean} rpmFilterActive    bidirectional DShot + rpm filter enabled
 * @property {boolean} dshotActive
 * @property {boolean} [bidirDshot]
 * @property {boolean} blackboxSupported
 * @property {boolean} hasFlash
 * @property {boolean} hasSdCard
 * @property {number} flashTotalBytes
 * @property {number} flashUsedBytes
 * @property {number} sdFreeKb
 * @property {number} sdTotalKb
 * @property {{device:string, rateNum:number, rateDenom:number, sampleRateExp:number, disabledMask:number}} blackbox
 * @property {string} filterProfile
 * @property {number} gyroFilterHz
 * @property {number} dtermFilterHz
 * @property {string[]} warnings
 */

/**
 * Everything step 1 of the workflow reads off the FC before touching anything.
 *
 * @typedef {object} FcSettings
 * @property {FcIdentity} identity
 * @property {Capabilities} capabilities
 * @property {string} dump                     full `dump` text (the safety backup payload)
 * @property {string} diffAll                  `diff all` text
 * @property {string} backupPath               where the backup was persisted
 * @property {string} backupSha256
 * @property {PidProfile} pid
 * @property {FilterConfig} filter
 * @property {Record<string,string>} raw       selected CLI `get` results
 */

/**
 * @typedef {object} PidProfile
 * @property {number} profileIndex
 * @property {{P:number,I:number,D:number}[]} roll pitch yaw   index 0 = roll
 * @property {number[]} feedforward
 * @property {{P:number,I:number,D:number}} [dMax]
 * @property {number} [gyroLpf1Hz]
 * @property {number} [gyroLpf2Hz]
 * @property {number} [dtermLpf1Hz]
 * @property {number} [dtermLpf2Hz]
 * @property {number} [dtermNotchHz]
 * @property {number} [dynamicNotchCount]
 * @property {number} [dynamicNotchQ]
 * @property {number} [dynamicNotchMinHz]
 */

/**
 * @typedef {object} FilterConfig
 * @property {number} gyroLpf1Hz
 * @property {number} gyroLpf2Hz
 * @property {number} dtermLpf1Hz
 * @property {number} dtermLpf2Hz
 * @property {number} dtermNotchHz
 * @property {number} rpmFilterHarmonics
 * @property {boolean} dynamicNotchEnabled
 * @property {number} dynamicNotchQ
 * @property {number} dynamicNotchMinHz
 * @property {number} dynamicNotchMaxHz
 * @property {number} gyroNotch1Hz
 * @property {number} gyroNotch2Hz
 */

/**
 * One decoded blackbox log inside a .bbl file (a file may hold several).
 *
 * @typedef {object} DecodedLog
 * @property {number} index
 * @property {number} headerOffset
 * @property {number} dataOffset
 * @property {Record<string,string|number>} header
 * @property {string} firmware
 * @property {string} [craftName]
 * @property {number} sampleRateHz        derived from looptime + pInterval
 * @property {number} durationS
 * @property {number} frameCount
 * @property {number} droppedFrames       P-frame counter gaps + I-frame resyncs
 * @property {number} dropRatePct
 * @property {string[]} axesPresent
 * @property {string[]} fieldsPresent
 * @property {number[]} timeUs
 * @property {Record<string, number[]>} channels
 *           canonical keys: gyroADC[0..2], gyroUnfilt[0..2], setpoint[0..2],
 *           rcCommand[0..3], axisP[0..2], axisI[0..2], axisD[0..2],
 *           axisF[0..2], motor[0..7], eRPM[0..7], throttle, vbat, amperage,
 *           debug[0..7]
 * @property {string[]} warnings
 */

/**
 * @typedef {object} Spectrum
 * @property {number[]} freqs        Hz
 * @property {number[]} psd          power spectral density, linear
 * @property {number} binHz
 * @property {number} segments       Welch segments averaged
 */

/**
 * @typedef {object} SpectralPeak
 * @property {number} hz
 * @property {number} psd
 * @property {number} prominenceDb
 * @property {number} bandwidthHz
 */

/**
 * @typedef {object} StepResponse
 * @property {number} overshootPct
 * @property {number} riseTimeMs        10% -> 90%
 * @property {number} settlingTimeMs    to within +-2% of final value
 * @property {number} steadyStateErrorPct
 * @property {number} latencyMs
 * @property {number} samples           steps detected
 */

/**
 * Per-axis analysis result. This is the contract between bbl-metrics and ai-tune.
 *
 * @typedef {object} AxisMetrics
 * @property {'roll'|'pitch'|'yaw'} axis
 * @property {number} gyroRms
 * @property {number} gyroPeak
 * @property {number} noiseFloorDbfs
 * @property {Spectrum} gyroSpectrum        spectrum of gyroADC (FILTERED gyro)
 * @property {Spectrum|null} [gyroUnfiltSpectrum] spectrum of gyroUnfilt (RAW, pre-filter)
 * @property {number|null} [gyroUnfiltRms]
 * @property {SpectralPeak[]} [rawPeaks]    peaks found in the raw spectrum
 * @property {number|null} [filterAttenuationDb]
 *           dB the current filter chain removes between 80 Hz and Nyquist
 * @property {Spectrum} [dTermSpectrum]
 * @property {SpectralPeak[]} peaks
 * @property {number} motorNoisePeakHz
 * @property {number} propwashIndex       0..1, higher = worse
 * @property {number} propwashEvents
 * @property {number} dTermRms
 * @property {number} dTermToGyroRatio
 * @property {StepResponse} step        isolated one-frame steps; what the P/I/D rules read
 * @property {(StepResponse & {method:'deconvolution', delay50Ms:number, windowsTried:number,
 *             curve:{dtMs:number, t0Ms:number, values:number[]}|null})|null} [stepDeconv]
 *           Wiener-deconvolved setpoint->gyro step (includes feedforward); evidence + display only
 * @property {number} trackingGainDb
 * @property {number} trackingCoherence
 * @property {number} trackingPhaseDeg
 * @property {number} iTermWindupScore   0..1
 * @property {number} [rpmHarmonicMatch] 0..1 confidence of peaks matching eRPM harmonics
 */

/**
 * Result of the bidirectional DShot / RPM probe (fc:bidir).
 *
 * @typedef {object} BidirProbe
 * @property {string} protocol            e.g. "DSHOT600"
 * @property {boolean} bidirOn
 * @property {number|null} motorPoles
 * @property {{enabled:boolean, harmonics:number, q:number, minHz:number}} rpmFilter
 * @property {{index:number, rpm:number, erpm:number|null, hz:number|null,
 *             invalidPct:number|null, noData?:boolean}[]} telemetryPerMotor
 * @property {'battery'|'usb-only'} powerState
 * @property {'yes'|'no'|'unknown'} escSupported
 * @property {number} confidence          0..1
 * @property {string} conclusion
 * @property {string[]} evidence
 * @property {string[]} warnings
 * @property {string[]} notes
 * @property {string[]} suggestedCli      NEVER auto-written; dry-run/confirm only
 * @property {string} checkedAt
 */

/**
 * @typedef {object} Fault
 * @property {string} code     GYRO_CLIPPING | MOTOR_DESYNC | SEVERE_VIBRATION |
 *                             FRAME_DROP_HIGH | SAMPLE_RATE_MISMATCH |
 *                             NO_RPM_DATA | MOTOR_SATURATION | GYRO_ABSENT | LOG_TRUNCATED |
 *                             PROP_IMBALANCE (warn, carries `motor`) | FRAME_RESONANCE (info/warn)
 * @property {'info'|'warn'|'critical'} severity
 * @property {string} evidence  concrete numbers, never a bare claim
 * @property {boolean} blocksTuning  true => AI must refuse to propose PID changes
 */

/**
 * @typedef {object} MetricsReport
 * @property {string} file
 * @property {number} logIndex
 * @property {number} sampleRateHz
 * @property {number} durationS
 * @property {number} dropRatePct
 * @property {number} motorSaturationPct
 * @property {number} rpmAvailable
 * @property {number} rpmMin
 * @property {number} rpmMax
 * @property {Record<'roll'|'pitch'|'yaw', AxisMetrics>} axes
 * @property {Fault[]} faults
 * @property {boolean} blocksTuning
 * @property {string[]} warnings
 * @property {number} sampleQuality       0..1 composite
 * @property {{available:boolean, bandsS:number[], bandsPct:number[], highS:number, maxPct:number}} [throttleProfile]
 * @property {{domains:Record<string,{ok:boolean,label:string,have:any,need:any,axes?:object,advice:string}>,
 *             missing:string[], flights:string[]}} [evidence]
 * @property {{onceVibration:object|null, resonance:object|null}} [mechanical]
 *           per-motor 1x vibration + fixed-vs-moving resonance (analysis/mechanical.js)
 *           per-domain evidence sufficiency (analysis/evidence.js); replaces a duration gate
 */

/**
 * @typedef {object} TuneProposal
 * @property {string} id
 * @property {string} problem               "问题"
 * @property {string} evidence              "证据" - numbers + which axis/band
 * @property {string[]} cli                "CLI 建议" - exact `set x = y` lines
 * @property {string} verification          "复飞验证" - what to fly + what to expect
 * @property {number} confidence            0..1
 * @property {'pid'|'filter'|'hardware'|'evidence'|'none'} category
 *           'evidence' = advice withheld for lack of data; never carries a diff
 * @property {boolean} safeToApply
 * @property {string[]} blockedBy
 * @property {{param:string, from:number|string, to:number|string, deltaPct?:number}[]} diff
 */

/**
 * @typedef {object} ApplyResult
 * @property {boolean} applied
 * @property {boolean} dryRun
 * @property {string[]} cliSent
 * @property {{param:string, from:any, to:any}[]} diff
 * @property {string} [token]              required to confirm a real write
 * @property {string} [reason]             why a write was refused
 * @property {string} [preWriteBackupPath]
 */

/**
 * @typedef {object} SafetyStatus
 * @property {boolean} readOnly
 * @property {string[]} reasons
 * @property {boolean} backupDone
 * @property {string} [backupPath]
 * @property {number} roundsUsed          writes performed this session (max 1)
 * @property {number} maxRounds
 * @property {string[]} forbiddenParams
 * @property {boolean} forcedTrust        operator forced trust for an unknown board
 * @property {string|null} tuningLocked   non-null => flight-parameter writes refused
 */

/**
 * Link health, from the MSP client's self-healing state machine.
 * @typedef {'msp'|'recovering'|'down'} LinkState
 */

/* ------------------------------------------------------------------ *
 * 3. Constants shared by main + renderer
 * ------------------------------------------------------------------ */

/** Never auto-written. Guard blocks these even if a proposal asks. */
export const FORBIDDEN_PARAMS = [
  'failsafe_',            // prefix match
  'set failsafe',
  'motor_pwm_protocol',   // ESC protocol
  'dshot_bidir',          // covered by capability probe, not auto-written
  'yaw_motors_reversed',
  'motor_direction',
  'reverse_motor_direction',
  'vbat_scale',           // voltage calibration
  'vbat_divider',
  'current_meter_scale',
  'current_meter_offset',
  'imu_board_align',
  'board_align_roll',
  'board_align_pitch',
  'board_align_yaw',
];

/** Max one conservative write round per session (safety boundary). */
export const MAX_TUNE_ROUNDS = 1;

/** Conservative step limits. */
export const STEP_LIMITS = {
  P_PCT: 0.07,       // 5-10% window, we target 7%
  I_PCT: 0.07,
  D_ABS: 3,          // 2-3 D units
  FF_PCT: 0.10,
  FILTER_PCT: 0.10,
};

/** Blackbox device ids, verified against firmware src/main/blackbox/blackbox.h */
export const BLACKBOX_DEVICE = {
  0: 'NONE',
  1: 'SPIFLASH',
  2: 'SDCARD',
  3: 'SERIAL',
  4: 'VIRTUAL',
};

/**
 * fields_disabled_mask bit order, verified against
 * firmware src/main/blackbox/blackbox_fielddefs.h (FLIGHT_LOG_FIELD_SELECT_*)
 * and src/main/cli/settings.c (bitpos).
 */
export const BLACKBOX_FIELDS = [
  { bit: 0,  key: 'pid',        cli: 'blackbox_disable_pids' },
  { bit: 1,  key: 'rc',         cli: 'blackbox_disable_rc' },
  { bit: 2,  key: 'setpoint',   cli: 'blackbox_disable_setpoint' },
  { bit: 3,  key: 'batt',       cli: 'blackbox_disable_bat' },
  { bit: 4,  key: 'mag',        cli: 'blackbox_disable_mag' },
  { bit: 5,  key: 'alt',        cli: 'blackbox_disable_alt' },
  { bit: 6,  key: 'rssi',       cli: 'blackbox_disable_rssi' },
  { bit: 7,  key: 'gyro',       cli: 'blackbox_disable_gyro' },
  { bit: 8,  key: 'attitude',   cli: 'blackbox_disable_attitude' },
  { bit: 9,  key: 'acc',        cli: 'blackbox_disable_acc' },
  { bit: 10, key: 'debug',      cli: 'blackbox_disable_debug' },
  { bit: 11, key: 'motor',      cli: 'blackbox_disable_motors' },
  { bit: 12, key: 'gps',        cli: 'blackbox_disable_gps' },
  { bit: 13, key: 'rpm',        cli: 'blackbox_disable_rpm' },
  { bit: 14, key: 'gyrounfilt', cli: 'blackbox_disable_gyrounfilt' },
  { bit: 15, key: 'servo',      cli: 'blackbox_disable_servos' },
];

/** Fields this app always wants ON for tuning analysis. */
export const REQUIRED_BB_FIELDS = ['gyro', 'setpoint', 'pid', 'rc', 'motor', 'throttle', 'batt', 'rpm'];

/* ------------------------------------------------------------------ *
 * 4. Tool schema registry
 * ------------------------------------------------------------------ */

/**
 * The tool surface. Each entry is a JSON-schema-style descriptor plus the IPC
 * channel that implements it. `apply_tune` is the only entry that can mutate
 * the FC, and it is gated behind an explicit confirmation token.
 */
export const TOOL_SCHEMAS = {
  fc_connect: {
    channel: CH.FC_CONNECT,
    mutates: false,
    description: 'Open an MSP session over a serial port.',
    input: { type: 'object', required: ['port'], properties: { port: { type: 'string' } } },
    output: { type: 'object', properties: { ok: { type: 'boolean' }, port: { type: 'string' } } },
  },
  fc_get_settings: {
    channel: CH.FC_GET_SETTINGS,
    mutates: false,
    description: 'Read firmware/board/PID/filter/blackbox config and write a full dump backup.',
    input: { type: 'object', properties: {} },
    output: { $ref: 'FcSettings' },
  },
  fc_run_cli: {
    channel: CH.FC_RUN_CLI,
    mutates: true,
    description: 'Send CLI commands in one batch. dryRun=true validates without writing.',
    input: {
      type: 'object',
      required: ['commands'],
      properties: {
        commands: { type: 'array', items: { type: 'string' } },
        dryRun: { type: 'boolean', default: true },
      },
    },
    output: { type: 'object', properties: { lines: { type: 'array' } } },
  },
  fc_identify: {
    channel: CH.FC_IDENTIFY,
    mutates: false,
    description: 'MSP -> CLI/status -> capability fingerprint. Returns confidence and match level.',
    input: { type: 'object', properties: {} },
    output: { $ref: 'FcIdentity' },
  },
  fc_capabilities: {
    channel: CH.FC_CAPABILITIES,
    mutates: false,
    description: 'Probe loop rates, RPM filter, blackbox media and filter profile.',
    input: { type: 'object', properties: {} },
    output: { $ref: 'Capabilities' },
  },
  blackbox_config: {
    channel: CH.BB_CONFIG,
    mutates: true,
    description: 'Configure logging rate/device/fields. rate defaults to 2000 Hz, back-calculated from the PID loop.',
    input: {
      type: 'object',
      properties: {
        rate: { type: 'number', default: 2000 },
        device: { type: 'string', enum: ['auto', 'SPIFLASH', 'SDCARD', 'SERIAL'], default: 'auto' },
        fields: { type: 'array', items: { type: 'string' }, default: [] },
        dryRun: { type: 'boolean', default: true },
      },
    },
    output: { type: 'object', properties: { diff: { type: 'array' }, applied: { type: 'boolean' } } },
  },
  blackbox_erase: {
    channel: CH.BB_ERASE,
    mutates: true,
    description: 'Erase logs on the active medium. SPIFLASH via MSP, SDCARD delete, SERIAL remote purge.',
    input: { type: 'object', properties: { device: { type: 'string', default: 'auto' }, confirm: { type: 'boolean' } } },
    output: { type: 'object', properties: { ok: { type: 'boolean' }, method: { type: 'string' } } },
  },
  blackbox_download: {
    channel: CH.BB_DOWNLOAD,
    mutates: false,
    description: 'Stream the log off the FC and verify duration / drop rate / real sample rate.',
    input: { type: 'object', properties: { verify: { type: 'boolean', default: true } } },
    output: { type: 'object', properties: { path: { type: 'string' }, logs: { type: 'array' } } },
  },
  bbl_decode: {
    channel: CH.BBL_DECODE,
    mutates: false,
    description: 'Decode a .bbl file into per-log header, channels and statistics.',
    input: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } },
    output: { $ref: 'DecodedLog[]' },
  },
  bbl_fft: {
    channel: CH.BBL_FFT,
    mutates: false,
    description: 'Welch PSD per axis, with peak detection and eRPM harmonic matching.',
    input: { type: 'object', required: ['file'], properties: { file: { type: 'string' }, axis: { type: 'string' } } },
    output: { $ref: 'AxisMetrics[]' },
  },
  bbl_metrics: {
    channel: CH.BBL_METRICS,
    mutates: false,
    description: 'Full time+frequency metric report with hardware fault detection.',
    input: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } },
    output: { $ref: 'MetricsReport' },
  },
  flight_cards: {
    channel: CH.BBL_FLIGHT_CARDS,
    mutates: false,
    description: 'Guided test flights and the evidence each analysis domain needs (static, no FC).',
    input: { type: 'object', properties: {} },
    output: { type: 'object', properties: { cards: { type: 'array' }, needs: { type: 'object' } } },
  },
  propose_tune: {
    channel: CH.TUNE_PROPOSE,
    mutates: false,
    description: 'Turn metrics into problem -> evidence -> CLI -> re-fly verification proposals.',
    input: { type: 'object', properties: { metrics: { $ref: 'MetricsReport' }, currentPid: { $ref: 'PidProfile' }, currentFilter: { $ref: 'FilterConfig' } } },
    output: { $ref: 'TuneProposal[]' },
  },
  apply_tune: {
    channel: CH.TUNE_APPLY,
    mutates: true,
    description: 'Write an approved diff. Requires a confirmation token from a dry-run proposal.',
    input: {
      type: 'object',
      properties: {
        proposalId: { type: 'string' },
        diff: { type: 'array' },
        requireConfirm: { type: 'boolean', default: true },
        token: { type: 'string' },
      },
    },
    output: { $ref: 'ApplyResult' },
  },
};

export default { CH, TOOL_SCHEMAS, FORBIDDEN_PARAMS, MAX_TUNE_ROUNDS, STEP_LIMITS, BLACKBOX_DEVICE, BLACKBOX_FIELDS, REQUIRED_BB_FIELDS };
