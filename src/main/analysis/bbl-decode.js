/**
 * Blackbox (.bbl) log decoding — general purpose.
 *
 * Ported from the upstream Betaflight Configurator blackbox parser
 * (`src/js/blackbox/chirp_bbl_parser.js`, commit 00dcc98d) and the reference
 * viewer (`src/blackbox-viewer/flightlog_parser.js`), with the CHIRP-specific
 * filtering removed so the whole flight is decoded: gyro, setpoint, PID terms,
 * feedforward, motors, eRPM, RC, battery and debug channels.
 *
 * The frame layout, encodings, predictors and recovery heuristics are the same
 * as upstream; only the sample selection differs (upstream keeps samples inside
 * a chirp-active window, we keep every main frame).
 *
 * Dependencies (vendored, imported for their side effects):
 *   - ../../../vendor/betaflight/datastream.js  → ArrayDataStream, signExtend*
 *   - ../../../vendor/betaflight/decoders.js    → extends ArrayDataStream.prototype
 *
 * Output shape is frozen by src/shared/contracts.js (`DecodedLog`).
 *
 * Judgement calls about the format (documented because they are guesses):
 *   1. `H P interval` may be written as "1/4" or as a bare "4". Both are read
 *      as "one P-frame every 4 PID loop iterations" (same rule as the
 *      reference viewer: a bare value is the denominator).
 *   2. `throttle` falls back to `rcCommand[3]`, then `setpoint[3]`, because
 *      many logs do not carry a literal `throttle` column.
 *   3. `vbat` accepts the `vbatLatest` column, `amperage` accepts `current`.
 *   4. On `blackbox_high_resolution` logs the gyro and setpoint columns are
 *      pre-scaled by 1/10, mirroring the upstream chirp parser.
 *   5. Dropped frames: the INC predictor synthesises `loopIteration`, so a
 *      dropped frame is only visible in the stored `time` column (predictors
 *      are lossless, so `time` is exact) or in a stored `loopIteration`
 *      column. Both estimates are computed and the larger one is reported;
 *      corruption resyncs are added on top.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

import { ArrayDataStream } from '../../../vendor/betaflight/datastream.js';
// Side effect: decoders.js adds readTag2_3S32 / readTag2_3SVariable /
// readTag8_4S16_v1 / readTag8_4S16_v2 / readTag8_8SVB to ArrayDataStream.
import '../../../vendor/betaflight/decoders.js';

/* ------------------------------------------------------------------ *
 * Constants — copied from the blackbox format (FLIGHT_LOG_FIELD_*)
 * ------------------------------------------------------------------ */

const ENCODING_SIGNED_VB = 0;
const ENCODING_UNSIGNED_VB = 1;
const ENCODING_NEG_14BIT = 3;
const ENCODING_TAG8_8SVB = 6;
const ENCODING_TAG2_3S32 = 7;
const ENCODING_TAG8_4S16 = 8;
const ENCODING_NULL = 9;
const ENCODING_TAG2_3SVARIABLE = 10;

const PREDICTOR_0 = 0;
const PREDICTOR_PREVIOUS = 1;
const PREDICTOR_STRAIGHT_LINE = 2;
const PREDICTOR_AVERAGE_2 = 3;
const PREDICTOR_MINTHROTTLE = 4;
const PREDICTOR_MOTOR_0 = 5;
const PREDICTOR_INC = 6;
const PREDICTOR_1500 = 8;
const PREDICTOR_VBATREF = 9;
const PREDICTOR_LAST_MAIN_FRAME_TIME = 10;
const PREDICTOR_MINMOTOR = 11;

const FRAME_TYPE_I = 0x49; // 'I'
const FRAME_TYPE_P = 0x50; // 'P'
const FRAME_TYPE_S = 0x53; // 'S'
const FRAME_TYPE_E = 0x45; // 'E'
const FRAME_TYPE_G = 0x47; // 'G'
const FRAME_TYPE_H = 0x48; // 'H'

const EVENT_SYNC_BEEP = 0;
const EVENT_INFLIGHT_ADJ = 13;
const EVENT_LOGGING_RESUME = 14;
const EVENT_DISARM = 15;
const EVENT_FLIGHTMODE = 30;
const EVENT_LOG_END = 255;

/** The marker line that starts every log inside a .bbl file. */
const LOG_BOUNDARY = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';
const LOG_BOUNDARY_BYTES = (() => {
  const out = new Uint8Array(LOG_BOUNDARY.length);
  for (let i = 0; i < LOG_BOUNDARY.length; i++) out[i] = LOG_BOUNDARY.codePointAt(i);
  return out;
})();

const MAX_HEADER_LINES = 8192;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_RESYNC_SCAN = 4096;
const MAX_CORRUPT_FRAMES = 500;
const MAX_FRAMES = 4_000_000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError(`bbl-decode: expected a path, Buffer, Uint8Array or ArrayBuffer, got ${typeof input}`);
}

function clampIndex(value, length) {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  if (n < 0) return 0;
  if (n > length) return length;
  return n;
}

function bytesToString(data, start, end) {
  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(data[i]);
  return out;
}

/** Byte-wise search for `needle` in `data`, starting at `from`. */
function indexOfBytes(data, needle, from) {
  const last = data.length - needle.length;
  let at = from;
  while (at <= last) {
    const found = data.indexOf(needle[0], at);
    if (found === -1 || found > last) return -1;
    let j = 1;
    while (j < needle.length && data[found + j] === needle[j]) j++;
    if (j === needle.length) return found;
    at = found + 1;
  }
  return -1;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Is `at` really the start of a log header?
 *
 * A raw byte search for the product string also matches the same text stored
 * inside binary payload (a craft name echo, entropy, an erased flash block that
 * happens to hold it). A real header is (a) the start of a line, (b) terminated
 * by a newline and (c) followed by a run of `H key:value` lines containing at
 * least one structural line. Requiring all three makes a false positive on
 * binary payload practically impossible, while still accepting a log that
 * follows a truncated one without a clean `End of log` marker.
 */
function looksLikeLogHeader(data, at) {
  const lineEnd = data[at + LOG_BOUNDARY_BYTES.length];
  const atEof = at + LOG_BOUNDARY_BYTES.length >= data.length;
  if (!atEof && lineEnd !== 0x0a && lineEnd !== 0x0d && lineEnd !== 0x00) return false;

  let pos = at;
  let lines = 0;
  let structural = false;
  const limit = Math.min(data.length, at + MAX_HEADER_BYTES);
  while (pos < limit && lines < MAX_HEADER_LINES) {
    if (data[pos] !== 0x48 /* 'H' */) break;
    const nl = data.indexOf(0x0a, pos);
    if (nl === -1 || nl > limit) break;
    const line = bytesToString(data, pos, nl);
    if (lines > 0 && line[1] !== ' ') break;
    if (/^H (Data version|Field [IPSHG] name|I interval|P interval|looptime|Firmware revision|Firmware type):/.test(line)) {
      structural = true;
    }
    lines++;
    pos = nl + 1;
  }
  return lines >= 2 && structural;
}

/** `0x3f800000` → 1.0 (the header stores floats as their IEEE-754 bit pattern). */
const FLOAT_SCRATCH = new DataView(new ArrayBuffer(4));
function hexToFloat(text) {
  const m = /^0x([0-9a-fA-F]{8})$/.exec(String(text).trim());
  if (m) {
    FLOAT_SCRATCH.setUint32(0, Number.parseInt(m[1], 16), true);
    return FLOAT_SCRATCH.getFloat32(0, true);
  }
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/* ------------------------------------------------------------------ *
 * findLogBoundaries
 * ------------------------------------------------------------------ */

/**
 * Byte offsets of every "H Product:" header in the file.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} buffer
 * @returns {number[]}
 */
export function findLogBoundaries(buffer) {
  const data = asBytes(buffer);
  const boundaries = [];
  let from = 0;
  while (from <= data.length - LOG_BOUNDARY_BYTES.length) {
    const at = indexOfBytes(data, LOG_BOUNDARY_BYTES, from);
    if (at === -1) break;
    if (looksLikeLogHeader(data, at)) boundaries.push(at);
    from = at + 1;
  }
  return boundaries;
}

/* ------------------------------------------------------------------ *
 * Header parsing
 * ------------------------------------------------------------------ */

function newFrameDef() {
  return { name: [], signed: [], predictor: [], encoding: [], count: 0 };
}

function defaultSysConfig() {
  return {
    dataVersion: 2,
    looptime: 125,
    pidProcessDenom: 1,
    debugMode: -1,
    highResolution: 0,
    frameIntervalI: 32,
    frameIntervalPNum: 1,
    frameIntervalPDenom: 1,
    minthrottle: 1150,
    maxthrottle: 1850,
    vbatref: 4095,
    motorOutput: [1000, 2000],
    motorPoles: 0,
    gyroScale: null,
    firmwareType: '',
    firmwareRevision: '',
    firmwareApiVersion: '',
    craftName: '',
    fieldIndices: {},
  };
}

const INT_HEADER_KEYS = new Set([
  'Data version',
  'looptime',
  'pid_process_denom',
  'gyro_sync_denom',
  'debug_mode',
  'blackbox_high_resolution',
  'minthrottle',
  'maxthrottle',
  'vbatref',
  'motor_poles',
  'acc_1G',
  'I interval',
]);

const CSV_NUMBER_HEADERS = new Set(['rollPID', 'pitchPID', 'yawPID', 'd_max']);

/**
 * Build a map from field name to index. Both "gyroADC[0]" and the bracket-less
 * alias "gyroADC0" are registered, exactly like upstream.
 */
function buildFieldIndices(names) {
  const indices = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    indices[name] = i;
    const alias = name.replace(/\[(\d+)\]/, '$1');
    if (alias !== name) indices[alias] = i;
  }
  return indices;
}

function parseFieldDef(key, value, frameDefs) {
  const m = /^Field ([IPSHG]) (\w+)$/.exec(key);
  if (!m) return false;
  const [, frameChar, property] = m;
  const def = frameDefs[frameChar];
  if (!def) return true;
  const parts = value.split(',');
  if (property === 'name') {
    def.name = parts.map((s) => s.trim());
    def.count = def.name.length;
  } else if (property === 'signed' || property === 'predictor' || property === 'encoding') {
    def[property] = parts.map((s) => Number.parseInt(s, 10));
  }
  return true;
}

function parsePInterval(value, sysConfig) {
  const slash = value.indexOf('/');
  if (slash === -1) {
    // Bare value = denominator ("P interval:4" is "1/4").
    const denom = Number.parseInt(value, 10);
    if (Number.isFinite(denom) && denom > 0) {
      sysConfig.frameIntervalPNum = 1;
      sysConfig.frameIntervalPDenom = denom;
    }
  } else {
    const num = Number.parseInt(value.slice(0, slash), 10);
    const denom = Number.parseInt(value.slice(slash + 1), 10);
    if (Number.isFinite(num) && num > 0 && Number.isFinite(denom) && denom > 0) {
      sysConfig.frameIntervalPNum = num;
      sysConfig.frameIntervalPDenom = denom;
    }
  }
}

/**
 * Parse one header line (without the leading "H ") into `header`, `fieldDefs`
 * and `sysConfig`. Ported from upstream `parseHeaderLine` + friends.
 */
function parseHeaderLine(line, header, fieldDefs, sysConfig) {
  const colon = line.indexOf(':');
  if (colon === -1) return;
  const key = line.slice(0, colon);
  const value = line.slice(colon + 1);
  header[key] = value;

  if (parseFieldDef(key, value, fieldDefs)) return;

  if (INT_HEADER_KEYS.has(key)) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) {
      switch (key) {
        case 'Data version':
          sysConfig.dataVersion = n;
          break;
        case 'I interval':
          sysConfig.frameIntervalI = n > 0 ? n : 1;
          break;
        case 'pid_process_denom':
          sysConfig.pidProcessDenom = n > 0 ? n : 1;
          break;
        case 'blackbox_high_resolution':
          sysConfig.highResolution = n ? 1 : 0;
          break;
        case 'debug_mode':
          sysConfig.debugMode = n;
          break;
        case 'minthrottle':
          sysConfig.minthrottle = n;
          break;
        case 'maxthrottle':
          sysConfig.maxthrottle = n;
          break;
        case 'vbatref':
          sysConfig.vbatref = n;
          break;
        case 'looptime':
          sysConfig.looptime = n;
          break;
        case 'motor_poles':
          sysConfig.motorPoles = n;
          break;
        default:
          break;
      }
    }
    return;
  }

  switch (key) {
    case 'P interval':
      parsePInterval(value, sysConfig);
      return;
    case 'P ratio': {
      // Fallback only: with "I interval:256" and "P ratio:64" a P-frame is
      // logged every 4 loop iterations.
      const ratio = Number.parseInt(value, 10);
      if (sysConfig.frameIntervalPNum === 1 && sysConfig.frameIntervalPDenom === 1 && ratio > 0) {
        const loops = Math.max(1, Math.round(sysConfig.frameIntervalI / ratio));
        sysConfig.frameIntervalPNum = 1;
        sysConfig.frameIntervalPDenom = loops;
      }
      return;
    }
    case 'motorOutput': {
      const parts = value.split(',').map((s) => Number.parseInt(s, 10));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        sysConfig.motorOutput = [parts[0], parts[1]];
      }
      return;
    }
    case 'gyro_scale':
    case 'gyro.scale': {
      const scale = hexToFloat(value);
      if (scale !== null) sysConfig.gyroScale = scale;
      return;
    }
    case 'Firmware type':
      sysConfig.firmwareType = value.trim();
      return;
    case 'Firmware revision':
      sysConfig.firmwareRevision = value.trim();
      return;
    case 'Firmware API version':
      sysConfig.firmwareApiVersion = value.trim();
      return;
    case 'Craft name':
      sysConfig.craftName = value.trim();
      return;
    default:
      break;
  }

  if (CSV_NUMBER_HEADERS.has(key)) {
    const parts = value.split(',').map((s) => Number.parseFloat(s));
    if (parts.every((n) => Number.isFinite(n))) sysConfig[key] = parts;
  }
}

/**
 * Read the text header of one log.
 *
 * @returns {{header: Record<string,string>, fieldDefs: object, sysConfig: object,
 *            dataStart: number, warnings: string[]}}
 */
function readHeaderBlock(data, start, end) {
  const warnings = [];
  const header = {};
  const fieldDefs = {
    I: newFrameDef(),
    P: newFrameDef(),
    S: newFrameDef(),
    G: newFrameDef(),
    H: newFrameDef(),
  };
  const sysConfig = defaultSysConfig();

  const stream = new ArrayDataStream(data, start, end);
  let lines = 0;
  while (!stream.eof && lines < MAX_HEADER_LINES) {
    const lineStart = stream.pos;
    const ch = stream.readChar();
    if (ch !== 'H') {
      stream.pos = lineStart;
      break;
    }
    if (stream.readChar() !== ' ') {
      stream.pos = lineStart;
      break;
    }
    let line = '';
    while (!stream.eof) {
      const c = stream.readChar();
      if (c === '\n' || c === '') break;
      line += c;
    }
    if (line.endsWith('\r')) line = line.slice(0, -1);
    parseHeaderLine(line, header, fieldDefs, sysConfig);
    lines++;
  }
  if (lines >= MAX_HEADER_LINES) {
    warnings.push(`header block exceeded ${MAX_HEADER_LINES} lines; stopped parsing the header`);
  }

  // P-frames share the I-frame field names by definition of the format.
  fieldDefs.P.name = fieldDefs.I.name;
  fieldDefs.P.signed = fieldDefs.I.signed;
  fieldDefs.P.count = fieldDefs.I.count;

  sysConfig.fieldIndices = buildFieldIndices(fieldDefs.I.name);

  return { header, fieldDefs, sysConfig, dataStart: stream.pos, warnings };
}

/**
 * Parse the header of the log in `buffer[start, end)`.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} buffer
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{header: Record<string,string|number>, fieldDefs: object, sysConfig: object}}
 */
export function parseLogHeader(buffer, start = 0, end) {
  const data = asBytes(buffer);
  const s = clampIndex(start, data.length);
  const e = end === undefined ? data.length : Math.max(s, clampIndex(end, data.length));
  const { header, fieldDefs, sysConfig } = readHeaderBlock(data, s, e);
  return { header, fieldDefs, sysConfig };
}

/* ------------------------------------------------------------------ *
 * Frame parsing — ported from upstream parseFrame / readFieldValue /
 * applyPrediction / parseEventFrame / isFrameMarker / skipToNextFrame
 * ------------------------------------------------------------------ */

function signExtend14Bit(word) {
  return word & 0x2000 ? word | 0xffffc000 : word;
}

/** Fixed group size for a grouped encoding (0 = run-length group, see caller). */
function encodingGroupSize(encoding) {
  switch (encoding) {
    case ENCODING_TAG2_3S32:
    case ENCODING_TAG2_3SVARIABLE:
      return 3;
    case ENCODING_TAG8_4S16:
      return 4;
    case ENCODING_TAG8_8SVB:
      return 0;
    default:
      return 1;
  }
}

function consecutiveEncodingRun(frameDef, i, encoding) {
  let n = 0;
  while (i + n < frameDef.count && frameDef.encoding[i + n] === encoding) n++;
  return n;
}

function readFieldValue(stream, encoding, dataVersion, groupValues, groupCount) {
  switch (encoding) {
    case ENCODING_SIGNED_VB:
      return stream.readSignedVB();
    case ENCODING_UNSIGNED_VB:
      return stream.readUnsignedVB();
    case ENCODING_NEG_14BIT:
      return -signExtend14Bit(stream.readUnsignedVB());
    case ENCODING_TAG2_3S32:
      stream.readTag2_3S32(groupValues);
      return groupValues[0];
    case ENCODING_TAG2_3SVARIABLE:
      stream.readTag2_3SVariable(groupValues);
      return groupValues[0];
    case ENCODING_TAG8_4S16:
      if (dataVersion >= 2) stream.readTag8_4S16_v2(groupValues);
      else stream.readTag8_4S16_v1(groupValues);
      return groupValues[0];
    case ENCODING_TAG8_8SVB:
      stream.readTag8_8SVB(groupValues, Math.min(groupCount, 8));
      return groupValues[0];
    case ENCODING_NULL:
      return 0;
    default:
      // Unknown encoding: consume a signed VB so the stream still advances.
      return stream.readSignedVB();
  }
}

function applyPrediction(
  fieldIndex,
  predictor,
  raw,
  current,
  previous,
  previous2,
  skippedFrames,
  sysConfig,
  motor0Index,
  lastMainFrameTime,
) {
  switch (predictor) {
    case PREDICTOR_0:
      return raw;
    case PREDICTOR_PREVIOUS:
      return raw + (previous ? previous[fieldIndex] : 0);
    case PREDICTOR_STRAIGHT_LINE:
      if (previous && previous2) return raw + 2 * previous[fieldIndex] - previous2[fieldIndex];
      return raw + (previous ? previous[fieldIndex] : 0);
    case PREDICTOR_AVERAGE_2:
      if (previous && previous2) {
        // Firmware divides toward zero (C int32 division); JS >> 1 floors.
        return raw + Math.trunc((previous[fieldIndex] + previous2[fieldIndex]) / 2);
      }
      return raw + (previous ? previous[fieldIndex] : 0);
    case PREDICTOR_MINTHROTTLE:
      return raw + sysConfig.minthrottle;
    case PREDICTOR_MOTOR_0:
      return raw + (motor0Index >= 0 ? current[motor0Index] : 0);
    case PREDICTOR_INC:
      return raw + (previous ? previous[fieldIndex] + skippedFrames + 1 : skippedFrames + 1);
    case PREDICTOR_1500:
      return raw + 1500;
    case PREDICTOR_VBATREF:
      return raw + sysConfig.vbatref;
    case PREDICTOR_LAST_MAIN_FRAME_TIME:
      return raw + lastMainFrameTime;
    case PREDICTOR_MINMOTOR:
      return raw + sysConfig.motorOutput[0];
    default:
      return raw;
  }
}

const GROUP_VALUES_SCRATCH = new Array(8).fill(0);

/**
 * Decode one frame into `current`.
 *
 * @returns {boolean} false when the stream ran out of bytes mid-frame.
 */
function parseFrame(
  stream,
  frameDef,
  current,
  previous,
  previous2,
  skippedFrames,
  sysConfig,
  motor0Index,
  lastMainFrameTime,
) {
  const groupValues = GROUP_VALUES_SCRATCH;
  const count = frameDef.count;
  const posBeforeFrame = stream.pos;
  let i = 0;

  while (i < count) {
    if (stream.eof) return false;

    const predictor = frameDef.predictor[i];
    const encoding = frameDef.encoding[i];

    if (predictor === PREDICTOR_INC) {
      current[i] = (previous ? previous[i] : 0) + skippedFrames + 1;
      i++;
      continue;
    }

    let groupSize = encodingGroupSize(encoding);
    if (encoding === ENCODING_TAG8_8SVB) {
      groupSize = Math.min(consecutiveEncodingRun(frameDef, i, ENCODING_TAG8_8SVB), 8);
    }

    if (groupSize > 1) {
      const actualGroupSize = Math.min(groupSize, count - i);
      for (let g = 0; g < groupSize; g++) groupValues[g] = 0;
      readFieldValue(stream, encoding, sysConfig.dataVersion, groupValues, actualGroupSize);
      for (let g = 0; g < actualGroupSize; g++) {
        if (frameDef.predictor[i + g] === PREDICTOR_INC) {
          current[i + g] = (previous ? previous[i + g] : 0) + skippedFrames + 1;
        } else {
          current[i + g] = applyPrediction(
            i + g,
            frameDef.predictor[i + g],
            groupValues[g],
            current,
            previous,
            previous2,
            skippedFrames,
            sysConfig,
            motor0Index,
            lastMainFrameTime,
          );
        }
      }
      i += actualGroupSize;
    } else {
      const raw = readFieldValue(stream, encoding, sysConfig.dataVersion, groupValues, 1);
      current[i] = applyPrediction(
        i,
        predictor,
        raw,
        current,
        previous,
        previous2,
        skippedFrames,
        sysConfig,
        motor0Index,
        lastMainFrameTime,
      );
      i++;
    }
  }

  // A well-formed frame never consumes thousands of bytes; treat it as corrupt.
  return stream.pos - posBeforeFrame <= 2048;
}

function parseEventFrame(stream) {
  const eventType = stream.readByte();

  switch (eventType) {
    case EVENT_LOG_END: {
      const message = stream.readString(11);
      if (message !== 'End of log\0') return null;
      return { type: EVENT_LOG_END };
    }
    case EVENT_LOGGING_RESUME:
      return {
        type: EVENT_LOGGING_RESUME,
        logIteration: stream.readUnsignedVB(),
        currentTime: stream.readUnsignedVB(),
      };
    case EVENT_SYNC_BEEP:
      stream.readUnsignedVB();
      return { type: EVENT_SYNC_BEEP };
    case EVENT_INFLIGHT_ADJ: {
      const adjFunc = stream.readByte();
      if (adjFunc & 128) {
        stream.readByte();
        stream.readByte();
        stream.readByte();
        stream.readByte();
      } else {
        stream.readUnsignedVB();
      }
      return { type: EVENT_INFLIGHT_ADJ };
    }
    case EVENT_DISARM:
      stream.readUnsignedVB();
      return { type: EVENT_DISARM };
    case EVENT_FLIGHTMODE:
      stream.readUnsignedVB();
      stream.readUnsignedVB();
      return { type: EVENT_FLIGHTMODE };
    default:
      return null;
  }
}

function isFrameMarker(byte) {
  return (
    byte === FRAME_TYPE_I ||
    byte === FRAME_TYPE_P ||
    byte === FRAME_TYPE_S ||
    byte === FRAME_TYPE_E ||
    byte === FRAME_TYPE_G ||
    byte === FRAME_TYPE_H
  );
}

/** Scan forward to the next plausible frame marker (upstream recovery heuristic). */
function skipToNextFrame(stream) {
  for (let n = 0; n < MAX_RESYNC_SCAN && !stream.eof; n++) {
    const b = stream.readByte();
    if (b !== -1 && isFrameMarker(b)) {
      stream.unreadChar();
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Channel mapping
 * ------------------------------------------------------------------ */

/** Canonical grouped channels (contract: channels["gyroADC[0]"] …). */
const CHANNEL_GROUPS = [
  { key: 'gyroADC', max: 2, hiRes: true },
  { key: 'gyroUnfilt', max: 2, hiRes: true },
  { key: 'setpoint', max: 2, hiRes: true },
  { key: 'rcCommand', max: 3, hiRes: false },
  { key: 'axisP', max: 2, hiRes: false },
  { key: 'axisI', max: 2, hiRes: false },
  { key: 'axisD', max: 2, hiRes: false },
  { key: 'axisF', max: 2, hiRes: false },
  { key: 'motor', max: 7, hiRes: false },
  { key: 'eRPM', max: 7, hiRes: false },
  { key: 'debug', max: 7, hiRes: false },
];

/** Single (non-indexed) channels, with the fallback field names we accept. */
const SINGLE_CHANNELS = [
  { key: 'throttle', sources: ['throttle', 'rcCommand[3]', 'setpoint[3]'] },
  { key: 'vbat', sources: ['vbat', 'vbatLatest'] },
  { key: 'amperage', sources: ['amperage', 'current'] },
];

function resolveFieldIndex(fieldIndices, name) {
  const idx = fieldIndices[name];
  return Number.isInteger(idx) ? idx : -1;
}

/**
 * Build the list of (field index → output array) copies for one log.
 * Missing fields simply do not appear, so no channel is ever fabricated.
 *
 * `present` ends up as the header field names that were actually consumed, in
 * header order (the contract's `fieldsPresent`).
 */
function buildSamplePlan(fieldDefs, sysConfig, channels, warnings) {
  const fieldIndices = sysConfig.fieldIndices;
  const plan = [];
  const used = new Set();

  for (const group of CHANNEL_GROUPS) {
    for (let axis = 0; axis <= group.max; axis++) {
      const fieldName = `${group.key}[${axis}]`;
      const idx = resolveFieldIndex(fieldIndices, fieldName);
      if (idx < 0) continue;
      const out = [];
      channels[fieldName] = out;
      used.add(idx);
      plan.push({ idx, out, scale: group.hiRes && sysConfig.highResolution ? 0.1 : 1 });
    }
  }

  for (const single of SINGLE_CHANNELS) {
    let fieldName = null;
    let idx = -1;
    for (const source of single.sources) {
      const found = resolveFieldIndex(fieldIndices, source);
      if (found >= 0) {
        fieldName = source;
        idx = found;
        break;
      }
    }
    if (idx < 0) continue;
    const out = [];
    channels[single.key] = out;
    used.add(idx);
    if (fieldName !== single.key) {
      warnings.push(`no "${single.key}" column in this log: using "${fieldName}" as ${single.key}`);
    }
    plan.push({ idx, out, scale: 1 });
  }

  const present = fieldDefs.I.name.filter((_, index) => used.has(index));
  if (!present.length) warnings.push('no analysable fields were found in this log');
  return { plan, present };
}

/**
 * Grouped convenience view: channels.gyroADC[0] === channels["gyroADC[0]"].
 * The flat keys above are the contract; these aliases exist because the
 * blackbox manager reads `log.channels.gyroADC?.[0]`.
 */
function addGroupAliases(channels) {
  for (const group of CHANNEL_GROUPS) {
    const alias = [];
    let any = false;
    for (let axis = 0; axis <= group.max; axis++) {
      const flat = channels[`${group.key}[${axis}]`];
      if (flat) {
        alias[axis] = flat;
        any = true;
      }
    }
    if (any) channels[group.key] = alias;
  }
  return channels;
}

/* ------------------------------------------------------------------ *
 * Rate / drop estimation
 * ------------------------------------------------------------------ */

function measureSampleRateHz(timeUs) {
  if (!timeUs || timeUs.length < 3) return 0;
  const deltas = [];
  for (let i = 1; i < timeUs.length; i++) {
    const d = timeUs[i] - timeUs[i - 1];
    if (d > 0) deltas.push(d);
  }
  const med = median(deltas);
  if (!Number.isFinite(med) || med <= 0) return 0;
  return 1e6 / med;
}

/** Loop iterations between two logged P-frames (from the rate headers). */
function loopsPerFrame(sysConfig) {
  const num = sysConfig.frameIntervalPNum;
  const denom = sysConfig.frameIntervalPDenom;
  if (!Number.isFinite(num) || !Number.isFinite(denom) || num <= 0 || denom <= 0) return 0;
  return denom / num;
}

function deriveHeaderSampleRate(sysConfig) {
  const looptime = sysConfig.looptime;
  const loops = loopsPerFrame(sysConfig);
  if (!Number.isFinite(looptime) || looptime <= 0 || !Number.isFinite(loops) || loops <= 0) return 0;
  const pidRateHz = 1e6 / looptime;
  const rate = pidRateHz / loops;
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/**
 * Frames implied missing by a delta series: any step larger than 1.5x the
 * median step represents round(step / median) - 1 frames that were never
 * written. Used for both the time column and a stored loopIteration column.
 */
function estimateDroppedFromDeltas(deltas) {
  if (deltas.length < 3) return { dropped: 0, base: 0 };
  const positive = deltas.filter((d) => d > 0);
  const base = median(positive);
  if (!Number.isFinite(base) || base <= 0) return { dropped: 0, base: 0 };
  let dropped = 0;
  for (const d of deltas) {
    if (d > base * 1.5) dropped += Math.max(0, Math.round(d / base) - 1);
  }
  return { dropped, base };
}

/* ------------------------------------------------------------------ *
 * decodeLog
 * ------------------------------------------------------------------ */

/**
 * Decode one log from `buffer[start, end)`.
 *
 * Never throws for corrupt/truncated payloads: damage is skipped, counted and
 * reported through `warnings` / `droppedFrames`.
 *
 * @param {Uint8Array|Buffer|ArrayBuffer} buffer
 * @param {number} start  byte offset of the "H Product:" header
 * @param {number} end    byte offset one past the end of this log
 * @param {{index?: number, maxFrames?: number, maxCorrupt?: number}} [opts]
 * @returns {import('../../shared/contracts.js').DecodedLog}
 */
export function decodeLog(buffer, start = 0, end, opts = {}) {
  const data = asBytes(buffer);
  const logStart = clampIndex(start, data.length);
  const logEnd = end === undefined ? data.length : Math.max(logStart, clampIndex(end, data.length));
  const index = Number.isFinite(opts.index) ? Math.trunc(opts.index) : 0;
  const maxFrames = Number.isFinite(opts.maxFrames) ? Math.max(1, Math.trunc(opts.maxFrames)) : MAX_FRAMES;
  const maxCorrupt = Number.isFinite(opts.maxCorrupt) ? Math.max(1, Math.trunc(opts.maxCorrupt)) : MAX_CORRUPT_FRAMES;

  const { header, fieldDefs, sysConfig, dataStart, warnings } = readHeaderBlock(data, logStart, logEnd);

  const channels = {};
  const { plan, present } = buildSamplePlan(fieldDefs, sysConfig, channels, warnings);

  const timeIdx = resolveFieldIndex(sysConfig.fieldIndices, 'time') >= 0
    ? sysConfig.fieldIndices.time
    : resolveFieldIndex(sysConfig.fieldIndices, 'time(us)');
  const iterIdx = resolveFieldIndex(sysConfig.fieldIndices, 'loopIteration');
  const motor0Index = resolveFieldIndex(sysConfig.fieldIndices, 'motor[0]');

  const timeUs = [];
  const iterationDeltas = [];
  const timeDeltas = [];
  let skippedGapAfterEvent = false;
  let lastIteration = null;
  let frameCount = 0;
  let corruptFrames = 0;
  let resyncs = 0;
  let skippedBytes = 0;
  let truncated = false;

  const fieldCount = fieldDefs.I.count;
  const sFieldCount = fieldDefs.S.count;
  const gFieldCount = fieldDefs.G.count;
  const hFieldCount = fieldDefs.H.count;

  if (fieldCount === 0) {
    warnings.push('no I-frame field definitions in this log; nothing could be decoded');
  } else {
    const stream = new ArrayDataStream(data, dataStart, logEnd);
    let previous = null;
    let previous2 = null;
    let lastIFrame = null;
    let lastMainFrameTime = 0;
    let lastMainFrameIteration = -1;
    let sCurrent = sFieldCount ? new Int32Array(sFieldCount) : null;
    let gCurrent = gFieldCount ? new Int32Array(gFieldCount) : null;
    let hCurrent = hFieldCount ? new Int32Array(hFieldCount) : null;

    /** Number of loop iterations the rate settings skipped before the next frame. */
    const shouldHaveFrame = (frameIndex) => {
      const pNum = sysConfig.frameIntervalPNum;
      const pDenom = sysConfig.frameIntervalPDenom;
      const iInterval = Math.max(1, sysConfig.frameIntervalI);
      return ((frameIndex % iInterval) + pNum - 1) % pDenom < pNum;
    };
    const countSkippedIterations = () => {
      let count = 0;
      if (lastMainFrameIteration === -1) return 0;
      for (let f = lastMainFrameIteration + 1; !shouldHaveFrame(f); f++) {
        count++;
        if (count > 1_000_000) break;
      }
      return count;
    };

    const recordFrame = (frame) => {
      if (timeIdx >= 0) {
        const t = frame[timeIdx];
        if (Number.isFinite(t)) {
          if (timeUs.length) {
            const d = t - timeUs[timeUs.length - 1];
            if (!skippedGapAfterEvent && d > 0) timeDeltas.push(d);
          }
          timeUs.push(t);
        }
      }
      skippedGapAfterEvent = false;
      for (const entry of plan) entry.out.push(frame[entry.idx] * entry.scale);
      if (iterIdx >= 0) {
        const it = frame[iterIdx];
        if (Number.isFinite(it)) {
          if (lastIteration !== null) {
            const d = it - lastIteration;
            if (d > 0) iterationDeltas.push(d);
          }
          lastIteration = it;
        }
      }
      frameCount++;
    };

    const recover = (savedPos, reason) => {
      stream.pos = savedPos;
      const before = stream.pos;
      const found = skipToNextFrame(stream);
      const skipped = stream.pos - before;
      skippedBytes += Math.max(0, skipped);
      corruptFrames++;
      resyncs++;
      if (!found) {
        truncated = true;
        stream.pos = stream.end;
      }
      if (resyncs <= 5) warnings.push(`corrupt: ${reason} at byte ${before}; skipped ${skipped} byte(s) to resync`);
    };

    while (!stream.eof && frameCount < maxFrames && corruptFrames < maxCorrupt) {
      const frameStart = stream.pos;
      const frameType = stream.readByte();
      if (frameType === -1) break;
      // Resync scans start after the frame-type byte, so recovery always makes
      // forward progress even when the byte that failed was the type itself.
      const afterType = frameStart + 1;

      if (frameType === FRAME_TYPE_I) {
        const buf = new Int32Array(fieldCount);
        const ok = parseFrame(stream, fieldDefs.I, buf, lastIFrame, null, 0, sysConfig, motor0Index, lastMainFrameTime);
        if (!ok) {
          recover(afterType, 'truncated or unreadable I-frame');
          continue;
        }
        // Both history slots become the I-frame: the past before an I-frame is
        // not addressable, and the firmware encodes the first P-frame after an
        // I-frame against exactly that assumption.
        previous2 = buf;
        previous = buf;
        lastIFrame = buf;
        if (timeIdx >= 0) lastMainFrameTime = buf[timeIdx];
        if (iterIdx >= 0) lastMainFrameIteration = buf[iterIdx];
        recordFrame(buf);
        continue;
      }

      if (frameType === FRAME_TYPE_P) {
        if (!previous) {
          recover(afterType, 'P-frame before any I-frame');
          continue;
        }
        const buf = new Int32Array(fieldCount);
        const skipped = countSkippedIterations();
        const ok = parseFrame(
          stream,
          fieldDefs.P,
          buf,
          previous,
          previous2,
          skipped,
          sysConfig,
          motor0Index,
          lastMainFrameTime,
        );
        if (!ok) {
          recover(afterType, 'truncated or unreadable P-frame');
          continue;
        }
        previous2 = previous;
        previous = buf;
        if (timeIdx >= 0) lastMainFrameTime = buf[timeIdx];
        if (iterIdx >= 0) lastMainFrameIteration = buf[iterIdx];
        recordFrame(buf);
        continue;
      }

      if (frameType === FRAME_TYPE_S) {
        if (!sCurrent) {
          recover(afterType, 'S-frame without an S-frame definition');
          continue;
        }
        const ok = parseFrame(stream, fieldDefs.S, sCurrent, null, null, 0, sysConfig, -1, 0);
        if (!ok) recover(afterType, 'truncated or unreadable S-frame');
        continue;
      }

      if (frameType === FRAME_TYPE_G || frameType === FRAME_TYPE_H) {
        const def = frameType === FRAME_TYPE_G ? fieldDefs.G : fieldDefs.H;
        const buf = frameType === FRAME_TYPE_G ? gCurrent : hCurrent;
        if (!buf || !def.count) {
          recover(afterType, 'GPS frame without a GPS frame definition');
          continue;
        }
        const ok = parseFrame(stream, def, buf, null, null, 0, sysConfig, -1, 0);
        if (!ok) recover(afterType, 'truncated or unreadable GPS frame');
        continue;
      }

      if (frameType === FRAME_TYPE_E) {
        const event = parseEventFrame(stream);
        if (!event) {
          recover(afterType, 'unknown event frame');
          continue;
        }
        if (event.type === EVENT_LOG_END) {
          stream.pos = stream.end;
          break;
        }
        if (event.type === EVENT_LOGGING_RESUME) {
          previous = null;
          previous2 = null;
          lastIFrame = null;
          lastIteration = null;
          lastMainFrameIteration = Number.isFinite(event.logIteration) ? event.logIteration : -1;
          lastMainFrameTime = Number.isFinite(event.currentTime) ? event.currentTime : 0;
          skippedGapAfterEvent = true;
        }
        continue;
      }

      recover(afterType, `unknown frame marker 0x${frameType.toString(16)}`);
    }

    if (corruptFrames >= maxCorrupt) {
      warnings.push(`corrupt: gave up after ${corruptFrames} damaged frames at byte ${stream.pos}`);
    }

    if (truncated || (stream.eof && stream.pos < logEnd && frameCount > 0)) {
      truncated = true;
      warnings.push(
        `truncated: log ended mid-frame at byte ${stream.pos} of ${logEnd} ` +
          `(${frameCount} frame(s) decoded)`,
      );
    } else if (frameCount === 0) {
      warnings.push('no frames could be decoded from this log');
    }

    if (resyncs > 5) warnings.push(`corrupt: ${resyncs} resync(s), ${skippedBytes} byte(s) skipped in total`);
  }

  /* ---------------- sample rate ---------------- */
  const measuredRate = measureSampleRateHz(timeUs);
  const headerRate = deriveHeaderSampleRate(sysConfig);
  let sampleRateHz = 0;
  if (headerRate > 0) {
    sampleRateHz = headerRate;
    if (measuredRate > 0 && Math.abs(headerRate - measuredRate) / measuredRate > 0.25) {
      sampleRateHz = measuredRate;
      warnings.push(
        `sample rate: header implies ${headerRate.toFixed(1)} Hz but the frame timestamps measure ` +
          `${measuredRate.toFixed(1)} Hz; using the measured rate`,
      );
    }
  } else if (measuredRate > 0) {
    sampleRateHz = measuredRate;
    warnings.push(
      `sample rate: no usable "P interval"/looptime header; measured ${measuredRate.toFixed(1)} Hz from frame timestamps`,
    );
  } else {
    warnings.push('sample rate: could not be derived (no P interval header and no usable time column)');
  }

  /* ---------------- dropped frames ---------------- */
  let droppedFrames = 0;
  if (iterIdx < 0) {
    warnings.push(
      `no loopIteration field: dropped frames cannot be counted (reported 0)` +
        (resyncs ? `; ${resyncs} corrupt-frame resync(s) were needed` : ''),
    );
  } else {
    const fromIteration = estimateDroppedFromDeltas(iterationDeltas);
    const fromTime = estimateDroppedFromDeltas(timeDeltas);
    // Both estimates describe the same loss (predictors are lossless), so take
    // the larger instead of summing and double counting.
    droppedFrames = Math.max(fromIteration.dropped, fromTime.dropped) + resyncs;
    if (fromIteration.dropped !== fromTime.dropped && Math.max(fromIteration.dropped, fromTime.dropped) > 0) {
      warnings.push(
        `dropped frames: loopIteration implies ${fromIteration.dropped}, timestamps imply ${fromTime.dropped}; ` +
          `reporting the larger estimate`,
      );
    }
  }

  if (sysConfig.highResolution) {
    warnings.push('blackbox_high_resolution is set: gyro and setpoint columns were scaled by 0.1');
  }
  if (timeIdx < 0) warnings.push('no time column: duration is 0 and the sample rate falls back to the header');

  const durationS = timeUs.length > 1 ? (timeUs[timeUs.length - 1] - timeUs[0]) / 1e6 : 0;
  const axesPresent = [];
  const axisNames = ['roll', 'pitch', 'yaw'];
  for (let axis = 0; axis < 3; axis++) {
    if (channels[`gyroADC[${axis}]`] || channels[`setpoint[${axis}]`]) axesPresent.push(axisNames[axis]);
  }

  const firmware = sysConfig.firmwareRevision || sysConfig.firmwareType || 'unknown';

  addGroupAliases(channels);

  /** @type {import('../../shared/contracts.js').DecodedLog} */
  const decoded = {
    index,
    headerOffset: logStart,
    dataOffset: dataStart,
    header,
    firmware,
    sampleRateHz,
    durationS,
    frameCount,
    droppedFrames,
    dropRatePct: frameCount + droppedFrames > 0 ? (droppedFrames / (frameCount + droppedFrames)) * 100 : 0,
    axesPresent,
    fieldsPresent: present,
    timeUs,
    channels,
    warnings,
  };
  if (sysConfig.craftName) decoded.craftName = sysConfig.craftName;
  return decoded;
}

/* ------------------------------------------------------------------ *
 * decodeBbl
 * ------------------------------------------------------------------ */

/**
 * Decode a whole .bbl file (path or in-memory bytes).
 *
 * `maxLogs` keeps the *most recent* N logs, which is what a tuning workflow
 * wants from a flash dump holding dozens of flights; the skipped ones are
 * counted in `stats.skipped` and still cost only the boundary scan.
 *
 * File-system errors are thrown (the caller decides what to report); corrupt
 * log payloads never are.
 *
 * @param {string|Uint8Array|Buffer|ArrayBuffer} input
 * @param {{maxLogs?: number}} [options]
 * @returns {Promise<{logs: object[], stats: object}>}
 */
export async function decodeBbl(input, { maxLogs = 8 } = {}) {
  const startedAt = Date.now();
  let data;
  let file = null;
  if (typeof input === 'string' || input instanceof URL) {
    file = String(input);
    data = new Uint8Array(await readFile(input));
  } else {
    data = asBytes(input);
  }

  const stats = {
    file,
    bytes: data.length,
    logCount: 0,
    decoded: 0,
    failed: 0,
    skipped: 0,
    truncated: false,
    warnings: [],
    errors: [],
    elapsedMs: 0,
  };

  const boundaries = findLogBoundaries(data);
  stats.logCount = boundaries.length;

  if (!boundaries.length) {
    stats.warnings.push('no blackbox log header ("H Product:") was found in this data');
    stats.elapsedMs = Date.now() - startedAt;
    return { logs: [], stats };
  }

  const limit = Number.isFinite(maxLogs) && maxLogs > 0 ? Math.trunc(maxLogs) : boundaries.length;
  const firstKept = Math.max(0, boundaries.length - limit);
  stats.skipped = firstKept;

  const logs = [];
  for (let i = firstKept; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : data.length;
    try {
      const log = decodeLog(data, start, end, { index: i });
      logs.push(log);
      stats.decoded++;
      if (log.warnings.some((w) => /^(truncated|corrupt)/.test(w))) stats.truncated = true;
    } catch (err) {
      stats.failed++;
      stats.errors.push(`log #${i} at byte ${start}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  stats.elapsedMs = Date.now() - startedAt;
  return { logs, stats };
}

export default { decodeBbl, decodeLog, findLogBoundaries, parseLogHeader };
