/**
 * MSP domain layer: turns raw MSP replies into typed values.
 *
 * Parsing rules were derived from betaflight-configurator `src/js/msp/MSPHelper.js`
 * (upstream commit 00dcc98d) and verified byte-for-byte against firmware
 * `src/main/msp/msp.c`. Each parser is a pure function of the payload so it can
 * be unit-tested without a flight controller.
 *
 * PID and filter values are deliberately read over CLI rather than MSP binary
 * structs: those structs gain and lose fields on almost every MSP API bump,
 * whereas `get <param>` is stable. MSP is used for identification,
 * capabilities, blackbox config and log download, where it is the only option.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MSP, API_VERSION, apiAtLeast } from './msp-codes.js';
import { ByteWriter, ByteReader } from './msp-codec.js';
import huffmanDecodeBuf from '../../../vendor/betaflight/huffman.js';
import { defaultHuffmanTree, defaultHuffmanLenIndex } from '../../../vendor/betaflight/default_huffman_tree.js';

/* ------------------------------------------------------------------ *
 * Pure payload parsers
 * ------------------------------------------------------------------ */

/**
 * MSP_API_VERSION -> { mspProtocolVersion, apiVersion }
 * Firmware: u8 protocol, u8 apiMajor, u8 apiMinor  (msp.c: case MSP_API_VERSION)
 */
export function parseApiVersion(payload) {
  const r = new ByteReader(payload);
  const mspProtocolVersion = r.u8();
  const major = r.u8();
  const minor = r.u8();
  return { mspProtocolVersion, apiVersion: `${major}.${minor}.0` };
}

/** MSP_FC_VARIANT -> 4 ASCII chars, e.g. "BTFL". */
export function parseFcVariant(payload) {
  const r = new ByteReader(payload);
  let out = '';
  for (let i = 0; i < 4; i++) out += String.fromCharCode(r.u8());
  return out;
}

/** Longest plausible length-prefixed string in a board-info payload. */
const MAX_PSTRING = 64;

/**
 * Reads a board/version string that may be either PString or C string.
 *
 * Firmware changed encoding mid-4.x: `MSP_BOARD_INFO` now writes targetName,
 * boardName and manufacturerId with `sbufWritePString` (a u8 length followed by
 * that many chars - see firmware src/main/msp/msp.c, "Target name with explicit
 * length"), and `MSP_FC_VERSION` appends the display version the same way.
 * Older firmware writes a NUL-terminated string.
 *
 * The two are distinguishable without knowing the API cutoff: a C string starts
 * with a printable character, and every real target/board/manufacturer name
 * starts with a letter (>= 0x41), which is above any plausible length. So a
 * first byte in 1..64 whose payload is entirely printable is a PString; anything
 * else is read as a C string.
 */
export function readBoardString(reader) {
  const start = reader.pos;
  const length = reader.u8();

  if (length > 0 && length <= MAX_PSTRING) {
    const chars = [];
    let printable = true;
    for (let i = 0; i < length; i++) {
      const b = reader.u8();
      chars.push(b);
      if (b < 0x20 || b > 0x7e) printable = false;
    }
    if (printable) return String.fromCharCode(...chars);
  }

  reader.pos = start;
  return reader.str();
}

/**
 * MSP_FC_VERSION -> "4.5.1".
 * Legacy encoding is 3 bytes; newer firmware (major >= 10) writes a u16 pad
 * followed by a NUL-terminated string.
 */
export function parseFcVersion(payload) {
  const r = new ByteReader(payload);
  const a = r.u8();
  const b = r.u8();
  const c = r.u8();

  // Newer firmware (calendar versioning) appends the display version as a
  // PString: u8 year-since-2000, u8 month, u8 patch, then e.g. "2025.12.2".
  // Older firmware sends exactly three bytes, so remaining === 0 there.
  if (r.remaining > 0) {
    const text = readBoardString(r);
    if (text) return text;
  }

  return `${a}.${b}.${c}`;
}

/** MSP_BUILD_INFO -> { buildInfo, gitRevision, buildOptions? } */
export function parseBuildInfo(payload) {
  const r = new ByteReader(payload);
  let date = '';
  for (let i = 0; i < 11; i++) date += String.fromCharCode(r.u8());
  let time = '';
  for (let i = 0; i < 8; i++) time += String.fromCharCode(r.u8());
  let gitRevision = '';
  for (let i = 0; i < 7; i++) gitRevision += String.fromCharCode(r.u8());

  const out = { buildInfo: `${date} ${time}`, gitRevision, buildOptions: [] };
  // Build options were added in API 1.46, as u16 codes terminated by 0.
  while (r.remaining >= 2) {
    const option = r.u16();
    if (option === 0) break;
    out.buildOptions.push(option);
  }
  return out;
}

/**
 * MSP_BOARD_INFO.
 * Firmware layout (msp.c: case MSP_BOARD_INFO):
 *   4 bytes boardIdentifier, u16 hardwareRevision, u8 boardType,
 *   u8 targetCapabilities, str targetName, str boardName, str manufacturerId,
 *   SIGNATURE_LENGTH bytes signature, u8 mcuTypeId,
 *   [>=1.42] u8 configurationState,
 *   [>=1.43] u16 sampleRateHz, u32 configurationProblems
 *
 * The signature length is derived from the payload length instead of hardcoded,
 * so this keeps working if the build system ever changes SIGNATURE_LENGTH.
 */
export function parseBoardInfo(payload, apiVersion = API_VERSION.V1_46) {
  const r = new ByteReader(payload);
  let boardIdentifier = '';
  for (let i = 0; i < 4; i++) boardIdentifier += String.fromCharCode(r.u8());

  const hardwareRevision = r.u16();
  const boardType = r.u8();
  const targetCapabilities = r.u8();
  // Length-prefixed on modern firmware, NUL-terminated on older builds.
  const targetName = readBoardString(r);
  const boardName = readBoardString(r);
  const manufacturerId = readBoardString(r);

  // Work out how many trailing bytes are *not* signature. Every addition here
  // shifts sampleRateHz, so they must all be counted (firmware msp.c).
  let trailing = 1; // mcuTypeId
  if (apiAtLeast(apiVersion, API_VERSION.V1_42)) trailing += 1; // configurationState
  if (apiAtLeast(apiVersion, API_VERSION.V1_43)) trailing += 6; // sampleRateHz(u16) + configurationProblems(u32)
  if (apiAtLeast(apiVersion, API_VERSION.V1_44)) trailing += 2; // spiDeviceCount + i2cDeviceCount

  const signatureLength = Math.max(0, r.remaining - trailing);
  const signature = [];
  for (let i = 0; i < signatureLength; i++) signature.push(r.u8());

  const mcuTypeId = r.u8();
  const configurationState = apiAtLeast(apiVersion, API_VERSION.V1_42) ? r.u8() : 0;
  const sampleRateHz = apiAtLeast(apiVersion, API_VERSION.V1_43) ? r.u16() : 0;
  const configurationProblems = apiAtLeast(apiVersion, API_VERSION.V1_43) ? r.u32() : 0;
  const spiDeviceCount = apiAtLeast(apiVersion, API_VERSION.V1_44) ? r.u8() : 0;
  const i2cDeviceCount = apiAtLeast(apiVersion, API_VERSION.V1_44) ? r.u8() : 0;

  return {
    boardIdentifier,
    hardwareRevision,
    boardType,
    targetCapabilities,
    targetName,
    boardName,
    manufacturerId,
    signature,
    mcuTypeId,
    configurationState,
    sampleRateHz,
    configurationProblems,
    spiDeviceCount,
    i2cDeviceCount,
    // Target capability bits (firmware msp.c).
    hasVcp: (targetCapabilities & (1 << 0)) !== 0,
    hasSoftSerial: (targetCapabilities & (1 << 1)) !== 0,
    hasFlashBootloader: (targetCapabilities & (1 << 3)) !== 0,
    supportsRxBind: (targetCapabilities & (1 << 6)) !== 0,
  };
}

/**
 * MSP_BLACKBOX_CONFIG.
 * Firmware layout (msp.c: case MSP_BLACKBOX_CONFIG):
 *   u8 supported, u8 device, u8 rateNum (unused), u8 rateDenom,
 *   u16 pRatio, u8 sampleRate, [>=1.45] u32 fields_disabled_mask
 */
export function parseBlackboxConfig(payload, apiVersion = API_VERSION.V1_46) {
  const r = new ByteReader(payload);
  const supported = (r.u8() & 1) !== 0;
  const device = r.u8();
  const rateNum = r.u8();
  const rateDenom = r.u8();
  const pRatio = r.u16();
  const sampleRateExp = r.u8();
  const disabledMask = apiAtLeast(apiVersion, API_VERSION.V1_45) ? r.u32() : 0;

  return {
    supported,
    device,
    rateNum,
    rateDenom,
    pRatio,
    sampleRateExp,
    // blackboxPInterval = 1 << sample_rate (firmware blackbox.c)
    rateDivisor: 1 << sampleRateExp,
    disabledMask,
  };
}

/**
 * MSP_DATAFLASH_SUMMARY.
 * u8 flags (bit0 ready, bit1 supported), u32 sectors, u32 totalSize, u32 usedSize
 */
export function parseDataflashSummary(payload) {
  if (!payload || payload.length < 13) {
    return { ready: false, supported: false, sectors: 0, totalSize: 0, usedSize: 0 };
  }
  const r = new ByteReader(payload);
  const flags = r.u8();
  return {
    ready: (flags & 1) !== 0,
    supported: (flags & 2) !== 0,
    sectors: r.u32(),
    totalSize: r.u32(),
    usedSize: r.u32(),
  };
}

/** MSP_SDCARD_SUMMARY. u8 flags(bit0 supported), u8 state, u8 fsError, u32 freeKB, u32 totalKB */
export function parseSdCardSummary(payload) {
  if (!payload || payload.length < 11) {
    return { supported: false, state: 0, filesystemLastError: 0, freeSizeKB: 0, totalSizeKB: 0 };
  }
  const r = new ByteReader(payload);
  const flags = r.u8();
  return {
    supported: (flags & 0x01) !== 0,
    state: r.u8(),
    filesystemLastError: r.u8(),
    freeSizeKB: r.u32(),
    totalSizeKB: r.u32(),
  };
}

/** MSP_ADVANCED_CONFIG (partial). u8 gyroSyncDenom(legacy), u8 pidProcessDenom, ... */
export function parseAdvancedConfig(payload) {
  const r = new ByteReader(payload);
  const gyroSyncDenom = r.u8();
  const pidProcessDenom = r.u8();
  const useContinuousUpdate = r.u8();
  const motorProtocol = r.u8();
  const motorPwmRate = r.u16();
  const motorIdle = r.u16();
  return { gyroSyncDenom, pidProcessDenom, useContinuousUpdate, motorProtocol, motorPwmRate, motorIdle };
}

/* ------------------------------------------------------------------ *
 * Client wrapper
 * ------------------------------------------------------------------ */

export class MspHelper {
  /**
   * @param {import('./msp-client.js').MspClient} client
   */
  constructor(client, { onLog = () => {} } = {}) {
    this.client = client;
    this.onLog = onLog;
    this.apiVersion = API_VERSION.V1_46;
  }

  /* ---------------- identification ---------------- */

  async readApiVersion() {
    const res = await this.client.request(MSP.MSP_API_VERSION);
    const parsed = parseApiVersion(res.raw);
    this.apiVersion = parsed.apiVersion;
    return parsed;
  }

  async readFcVariant() {
    const res = await this.client.request(MSP.MSP_FC_VARIANT);
    return parseFcVariant(res.raw);
  }

  async readFcVersion() {
    const res = await this.client.request(MSP.MSP_FC_VERSION);
    return parseFcVersion(res.raw);
  }

  async readBoardInfo() {
    const res = await this.client.request(MSP.MSP_BOARD_INFO);
    return parseBoardInfo(res.raw, this.apiVersion);
  }

  async readBuildInfo() {
    try {
      const res = await this.client.request(MSP.MSP_BUILD_INFO);
      return parseBuildInfo(res.raw);
    } catch {
      return { buildInfo: '', gitRevision: '', buildOptions: [] };
    }
  }

  /** MSP_NAME is deprecated in MSP 1.45+; absence is normal, not an error. */
  async readName() {
    try {
      const res = await this.client.request(MSP.MSP_NAME, null, { retries: 0, timeoutMs: 900 });
      return new ByteReader(res.raw).restAsString().trim();
    } catch {
      return '';
    }
  }

  /* ---------------- capabilities ---------------- */

  async readAdvancedConfig() {
    const res = await this.client.request(MSP.MSP_ADVANCED_CONFIG);
    return parseAdvancedConfig(res.raw);
  }

  async readBlackboxConfig() {
    const res = await this.client.request(MSP.MSP_BLACKBOX_CONFIG);
    return parseBlackboxConfig(res.raw, this.apiVersion);
  }

  /**
   * Writes the blackbox configuration.
   *
   * `sampleRateExp` is the log2 divisor of the PID loop rate, matching firmware
   * `blackboxConfig()->sample_rate`, where the actual rate is loopRate >> exp.
   * Newer firmware takes sample_rate directly; older firmware derives it from
   * pRatio, so both are sent.
   */
  async writeBlackboxConfig({ device, rateDenom, sampleRateExp, pRatio = 0, disabledMask = null }) {
    const w = new ByteWriter();
    w.u8(device);
    w.u8(1); // rateNum: unused by firmware, always 1
    w.u8(rateDenom);
    w.u16(pRatio);
    // API 1.44 added sample_rate to the request.
    w.u8(sampleRateExp);
    if (disabledMask !== null && apiAtLeast(this.apiVersion, API_VERSION.V1_45)) {
      w.u32(disabledMask);
    }
    return this.client.requestOptional(MSP.MSP_SET_BLACKBOX_CONFIG, w.toUint8Array(), { retries: 0 });
  }

  async readDataflashSummary() {
    const res = await this.client.request(MSP.MSP_DATAFLASH_SUMMARY);
    return parseDataflashSummary(res.raw);
  }

  async readSdCardSummary() {
    try {
      const res = await this.client.request(MSP.MSP_SDCARD_SUMMARY, null, { retries: 0, timeoutMs: 1000 });
      return parseSdCardSummary(res.raw);
    } catch {
      return { supported: false, state: 0, filesystemLastError: 0, freeSizeKB: 0, totalSizeKB: 0 };
    }
  }

  async eraseDataflash() {
    return this.client.requestOptional(MSP.MSP_DATAFLASH_ERASE, null, { retries: 0, timeoutMs: 8000 });
  }

  /**
   * Reads one block from the dataflash, transparently decompressing.
   *
   * Request:  u32 address, u16 blockSize, u8 allowCompression
   * Response: u32 address, u16 dataSize, u8 compressionType,
   *           [type 1: u16 uncompressedCharCount, then Huffman data]
   *
   * Mirrors MspHelper.prototype.dataflashRead in the official configurator.
   *
   * @returns {Promise<{address:number, data:DataView, compressed:boolean}>}
   */
  async dataflashRead(address, blockSize = 2048, { timeoutMs = 4000 } = {}) {
    const w = new ByteWriter();
    w.u32(address);
    w.u16(blockSize);
    w.u8(1); // allow compression

    const res = await this.client.request(MSP.MSP_DATAFLASH_READ, w.toUint8Array(), { timeoutMs, retries: 1 });
    const r = new ByteReader(res.raw);

    const chunkAddress = r.u32();
    const dataSize = r.u16();
    const compressionType = r.u8();

    if (chunkAddress !== address) {
      throw new Error(`dataflash read returned address ${chunkAddress}, expected ${address}`);
    }

    if (compressionType === 0) {
      return {
        address,
        data: new DataView(res.raw.buffer, res.raw.byteOffset + 7, dataSize),
        compressed: false,
      };
    }

    if (compressionType === 1) {
      const uncompressedCharCount = r.u16();
      const compressed = res.raw.subarray(7 + 2, 7 + dataSize);
      const out = huffmanDecodeBuf(compressed, uncompressedCharCount, defaultHuffmanTree, defaultHuffmanLenIndex);
      return { address, data: new DataView(out.buffer, out.byteOffset, out.length), compressed: true };
    }

    throw new Error(`unknown dataflash compression type ${compressionType}`);
  }

  /* ---------------- CLI ---------------- */

  /**
   * Kept as the single entry point for CLI work, but there is no longer a
   * session to manage: each command is a one-shot the firmware enters and
   * leaves on its own (see msp-client.js). The method survives so call sites
   * read the same and so a future framing change has one place to live.
   */
  async withCli(fn) {
    return fn();
  }

  /**
   * Reads a set of CLI parameters via `get`.
   *
   * Betaflight accepts several names per call and prints `name = value`, one per
   * line, so a single round trip covers a whole panel of settings.
   *
   * @param {string[]} names
   * @returns {Promise<Record<string,string|number|null>>}
   */
  async cliGet(names) {
    return this.withCli(() => this.#cliGet(names));
  }

  async #cliGet(names) {
    const result = {};
    for (const n of names) result[n] = null;

    // Betaflight's `get` takes a SINGLE argument and does a substring match
    // (firmware cli.c cliGet: `strcasestr(valueTable[i].name, cmdline)`). A
    // multi-name `get a b c` therefore matches nothing and returns nothing,
    // which silently nulled every parameter after the first on real hardware.
    // Correct form: one command per parameter.
    for (const name of names) {
      if (!name) continue;
      let lines;
      try {
        ({ lines } = await this.client.cli(`get ${name}`, { timeoutMs: this.client.cliTimeoutMs }));
      } catch (err) {
        this.onLog('warn', `CLI get failed for ${name}: ${err.message}`);
        continue;
      }
      for (const line of lines) Object.assign(result, parseCliAssignments(line));
    }
    return result;
  }

  /** `dump` — the full configuration, used for the mandatory pre-write backup. */
  async cliDump() {
    return this.withCli(() => this.#cliDump());
  }

  async #cliDump() {
    const { lines } = await this.client.cli('dump', { timeoutMs: 30000 });
    return lines.join('\n');
  }

  /** `diff all` — only what differs from defaults; the human-readable summary. */
  async cliDiffAll() {
    return this.withCli(() => this.#cliDiffAll());
  }

  async #cliDiffAll() {
    const { lines } = await this.client.cli('diff all', { timeoutMs: 30000 });
    return lines.join('\n');
  }

  /** Runs CLI commands and reports per-command output. */
  async cliRun(commands, opts = {}) {
    return this.withCli(() => this.#cliRun(commands, opts));
  }

  async #cliRun(commands, opts = {}) {
    return this.client.cliBatch(commands, opts);
  }

  /** Persists the configuration to EEPROM. Only called after an approved write. */
  async cliSave() {
    return this.withCli(() => this.#cliSave());
  }

  async #cliSave() {
    return this.client.cli('save', { timeoutMs: 8000 });
  }

  /** Applies a batch of `set` commands and reports the per-line echoes. */
  async cliSet(commands, { onProgress } = {}) {
    return this.withCli(() => this.#cliSet(commands, { onProgress }));
  }

  async #cliSet(commands, { onProgress } = {}) {
    const batch = [...commands, 'save'];
    return this.client.cliBatch(batch, { onProgress, timeoutMs: 8000 });
  }
}

/**
 * Parses one line of CLI output, tolerating the several shapes Betaflight emits:
 *   `gyro_lpf1_static_hz = 250`
 *   `set gyro_lpf1_static_hz = 250`
 *   `Allowed values: ...`  (ignored)
 *
 * @returns {Record<string, string|number>}
 */
export function parseCliAssignments(line) {
  const out = {};
  if (typeof line !== 'string') return out;

  const text = line.trim().replace(/^set\s+/i, '');
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(text);
  if (!match) return out;

  const [, name, rawValue] = match;
  const value = rawValue.trim();
  out[name] = coerceCliValue(value);
  return out;
}

/** CLI values are ints, "ON"/"OFF", or free text. */
export function coerceCliValue(value) {
  if (value === '') return '';
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  const upper = value.toUpperCase();
  if (upper === 'ON') return 1;
  if (upper === 'OFF') return 0;
  return value;
}

export default MspHelper;
