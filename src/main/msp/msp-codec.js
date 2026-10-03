/**
 * MSP wire codec: framing for MSPv1, MSPv2 and the CLI passthrough session.
 *
 * Framing rules ported from betaflight-configurator `src/js/msp.js`
 * (upstream commit 00dcc98d) and verified against firmware
 * `src/main/msp/msp_serial.c`.
 *
 *   MSPv1  $ M < size cmd payload... xor
 *   MSPv2  $ X < flag func(2,LE) size(2,LE) payload... crc8_dvb_s2
 *   CLI    STX cmd LF ETX   - the FC echoes the same STX/ETX envelope,
 *                             which is how we detect command completion.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SYM = {
  BEGIN: 0x24, // '$'
  PROTO_V1: 0x4d, // 'M'
  PROTO_V2: 0x58, // 'X'
  TO_FC: 0x3c, // '<'
  FROM_FC: 0x3e, // '>'
  UNSUPPORTED: 0x21, // '!'
  STX: 0x02,
  ETX: 0x03,
  EOT: 0x04,
  LF: 0x0a,
  CR: 0x0d,
};

/* ------------------------------------------------------------------ *
 * CRC
 * ------------------------------------------------------------------ */

/** CRC8 DVB-S2 - the MSPv2 checksum. */
export function crc8DvbS2(crc, byte) {
  crc ^= byte;
  for (let i = 0; i < 8; i++) {
    crc = crc & 0x80 ? ((crc << 1) ^ 0xd5) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function crc8DvbS2Buf(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = crc8DvbS2(crc, bytes[i]);
  return crc;
}

/* ------------------------------------------------------------------ *
 * Byte reader / writer
 * ------------------------------------------------------------------ */

export class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  u32(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  /** Zero-terminated ASCII string, as used by MSP_BOARD_INFO and friends. */
  str(text) {
    for (const ch of String(text)) this.bytes.push(ch.charCodeAt(0) & 0xff);
    this.bytes.push(0);
    return this;
  }

  toUint8Array() {
    return Uint8Array.from(this.bytes);
  }
}

export class ByteReader {
  constructor(bytes) {
    this.view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    this.pos = 0;
  }

  get remaining() {
    return this.view.length - this.pos;
  }

  get eof() {
    return this.pos >= this.view.length;
  }

  u8() {
    return this.pos < this.view.length ? this.view[this.pos++] : 0;
  }

  s8() {
    const v = this.u8();
    return v & 0x80 ? v - 0x100 : v;
  }

  u16() {
    return this.u8() | (this.u8() << 8);
  }

  s16() {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }

  u32() {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
  }

  s32() {
    return this.u32() | 0;
  }

  /** Reads until NUL, consuming it. */
  str() {
    let out = '';
    while (!this.eof) {
      const c = this.u8();
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  /** Reads the remainder as ASCII with NULs stripped. */
  restAsString() {
    let out = '';
    while (!this.eof) {
      const c = this.u8();
      if (c !== 0) out += String.fromCharCode(c);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Encoders
 * ------------------------------------------------------------------ */

/** MSPv1 frame. `code` must fit in one byte. */
export function encodeV1(code, payload) {
  const data = payload ? Uint8Array.from(payload) : new Uint8Array(0);
  const out = new Uint8Array(data.length + 6);
  out[0] = SYM.BEGIN;
  out[1] = SYM.PROTO_V1;
  out[2] = SYM.TO_FC;
  out[3] = data.length & 0xff;
  out[4] = code & 0xff;
  let checksum = out[3] ^ out[4];
  for (let i = 0; i < data.length; i++) {
    out[5 + i] = data[i];
    checksum ^= data[i];
  }
  out[5 + data.length] = checksum & 0xff;
  return out;
}

/** MSPv2 frame. `code` is a 16-bit function id (0x1000+). */
export function encodeV2(code, payload) {
  const data = payload ? Uint8Array.from(payload) : new Uint8Array(0);
  const out = new Uint8Array(data.length + 9);
  out[0] = SYM.BEGIN;
  out[1] = SYM.PROTO_V2;
  out[2] = SYM.TO_FC;
  out[3] = 0; // flags
  out[4] = code & 0xff;
  out[5] = (code >> 8) & 0xff;
  out[6] = data.length & 0xff;
  out[7] = (data.length >> 8) & 0xff;
  out.set(data, 8);
  out[out.length - 1] = crc8DvbS2Buf(out, 3, out.length - 1);
  return out;
}

/** Auto-selects v1 or v2 based on code width. */
export function encode(code, payload) {
  return code > 0xff ? encodeV2(code, payload) : encodeV1(code, payload);
}

/**
 * CLI packet: STX + command + LF + ETX.
 * The FC replies inside the same envelope; the closing ETX is our completion
 * signal (with a timeout as the safety net).
 */
export function encodeCli(command) {
  const text = String(command);
  const out = new Uint8Array(text.length + 3);
  out[0] = SYM.STX;
  for (let i = 0; i < text.length; i++) out[1 + i] = text.charCodeAt(i) & 0xff;
  out[out.length - 2] = SYM.LF;
  out[out.length - 1] = SYM.ETX;
  return out;
}

/* ------------------------------------------------------------------ *
 * Streaming parser
 * ------------------------------------------------------------------ */

const S = {
  IDLE: 'idle',
  AFTER_DOLLAR: 'after-dollar',
  V1_DIR: 'v1-dir',
  V1_SIZE: 'v1-size',
  V1_CMD: 'v1-cmd',
  V1_PAYLOAD: 'v1-payload',
  V1_CHECKSUM: 'v1-checksum',
  V2_DIR: 'v2-dir',
  V2_FLAG: 'v2-flag',
  V2_FUNC_LO: 'v2-func-lo',
  V2_FUNC_HI: 'v2-func-hi',
  V2_SIZE_LO: 'v2-size-lo',
  V2_SIZE_HI: 'v2-size-hi',
  V2_PAYLOAD: 'v2-payload',
  V2_CRC: 'v2-crc',
  CLI: 'cli',
};

/**
 * Incremental parser producing whole messages from an arbitrarily chunked
 * serial stream. MSP and CLI traffic may interleave, so one state machine
 * handles both.
 *
 * Emits either:
 *   { type: 'msp', version, code, direction, error, checksumOk, payload: Uint8Array }
 *   { type: 'cli', lines: string[], text: string, closed: true }
 */
export class MspParser {
  constructor() {
    this.stats = { msp: 0, cli: 0, badChecksum: 0, noise: 0 };
    this.reset();
  }

  reset() {
    this.state = S.IDLE;
    this.expect = 0;
    this.code = 0;
    this.flags = 0;
    this.direction = 'response';
    this.error = false;
    this.checksum = 0;
    this.crc = 0;
    this.payload = [];
    this.cliByteBuf = [];
    this.cliLines = [];
  }

  /**
   * @param {Uint8Array|Buffer|number[]} chunk
   * @returns {Array<object>} zero or more complete messages
   */
  push(chunk) {
    const out = [];
    for (let i = 0; i < chunk.length; i++) {
      const msg = this.#byte(chunk[i]);
      if (msg) out.push(msg);
    }
    return out;
  }

  #byte(b) {
    switch (this.state) {
      case S.IDLE:
        if (b === SYM.BEGIN) this.state = S.AFTER_DOLLAR;
        else if (b === SYM.STX) this.#beginCli();
        return null;

      case S.AFTER_DOLLAR:
        if (b === SYM.PROTO_V1) {
          this.state = S.V1_DIR;
        } else if (b === SYM.PROTO_V2) {
          this.state = S.V2_DIR;
        } else if (b === SYM.BEGIN) {
          // consecutive '$' - stay put
        } else if (b === SYM.STX) {
          this.#beginCli();
        } else {
          // Not a frame we understand; resynchronise on the next '$'.
          this.stats.noise++;
          this.state = S.IDLE;
        }
        return null;

      /* ---------------- MSPv1 ---------------- */
      case S.V1_DIR:
        if (b === SYM.FROM_FC || b === SYM.TO_FC || b === SYM.UNSUPPORTED) {
          this.direction = b === SYM.TO_FC ? 'request' : 'response';
          this.error = b === SYM.UNSUPPORTED;
          this.state = S.V1_SIZE;
        } else {
          this.stats.noise++;
          this.state = S.IDLE;
        }
        return null;

      case S.V1_SIZE:
        this.expect = b;
        this.state = S.V1_CMD;
        return null;

      case S.V1_CMD:
        this.code = b;
        this.payload = [];
        // checksum covers size ^ cmd ^ payload
        this.checksum = (this.expect ^ b) & 0xff;
        this.state = this.expect > 0 ? S.V1_PAYLOAD : S.V1_CHECKSUM;
        return null;

      case S.V1_PAYLOAD:
        this.payload.push(b);
        this.checksum = (this.checksum ^ b) & 0xff;
        if (this.payload.length >= this.expect) this.state = S.V1_CHECKSUM;
        return null;

      case S.V1_CHECKSUM: {
        this.state = S.IDLE;
        this.stats.msp++;
        const ok = this.checksum === b;
        if (!ok) this.stats.badChecksum++;
        return {
          type: 'msp',
          version: 1,
          code: this.code,
          direction: this.direction,
          error: this.error,
          checksumOk: ok,
          payload: Uint8Array.from(this.payload),
        };
      }

      /* ---------------- MSPv2 ---------------- */
      case S.V2_DIR:
        if (b === SYM.FROM_FC || b === SYM.TO_FC || b === SYM.UNSUPPORTED) {
          this.direction = b === SYM.TO_FC ? 'request' : 'response';
          this.error = b === SYM.UNSUPPORTED;
          this.state = S.V2_FLAG;
        } else {
          this.stats.noise++;
          this.state = S.IDLE;
        }
        return null;

      case S.V2_FLAG:
        this.flags = b;
        this.state = S.V2_FUNC_LO;
        return null;

      case S.V2_FUNC_LO:
        this.code = b;
        this.state = S.V2_FUNC_HI;
        return null;

      case S.V2_FUNC_HI:
        this.code |= b << 8;
        this.state = S.V2_SIZE_LO;
        return null;

      case S.V2_SIZE_LO:
        this.expect = b;
        this.state = S.V2_SIZE_HI;
        return null;

      case S.V2_SIZE_HI: {
        this.expect |= b << 8;
        this.payload = [];
        // CRC covers flag, func(2), size(2), payload - bytes [3 .. len-1)
        let crc = crc8DvbS2(0, this.flags);
        crc = crc8DvbS2(crc, this.code & 0xff);
        crc = crc8DvbS2(crc, (this.code >> 8) & 0xff);
        crc = crc8DvbS2(crc, this.expect & 0xff);
        crc = crc8DvbS2(crc, (this.expect >> 8) & 0xff);
        this.crc = crc;
        this.state = this.expect > 0 ? S.V2_PAYLOAD : S.V2_CRC;
        return null;
      }

      case S.V2_PAYLOAD:
        this.payload.push(b);
        this.crc = crc8DvbS2(this.crc, b);
        if (this.payload.length >= this.expect) this.state = S.V2_CRC;
        return null;

      case S.V2_CRC: {
        this.state = S.IDLE;
        this.stats.msp++;
        const ok = this.crc === b;
        if (!ok) this.stats.badChecksum++;
        return {
          type: 'msp',
          version: 2,
          code: this.code,
          direction: this.direction,
          error: this.error,
          checksumOk: ok,
          payload: Uint8Array.from(this.payload),
        };
      }

      /* ---------------- CLI ---------------- */
      case S.CLI:
        if (b === SYM.ETX) {
          if (this.cliByteBuf.length) this.cliLines.push(decodeAscii(this.cliByteBuf));
          const lines = this.cliLines;
          this.#endCli();
          return { type: 'cli', lines, text: lines.join('\n'), closed: true };
        }
        if (b === SYM.LF) {
          this.cliLines.push(decodeAscii(this.cliByteBuf));
          this.cliByteBuf = [];
          return null;
        }
        if (b === SYM.CR) return null;
        this.cliByteBuf.push(b);
        return null;

      default:
        this.state = S.IDLE;
        return null;
    }
  }

  #beginCli() {
    this.state = S.CLI;
    this.cliByteBuf = [];
    this.cliLines = [];
  }

  #endCli() {
    this.state = S.IDLE;
    this.cliByteBuf = [];
    this.cliLines = [];
  }
}

function decodeAscii(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Convenience: parse a whole buffer at once. */
export function parseAll(buffer) {
  const parser = new MspParser();
  return parser.push(buffer instanceof Uint8Array ? buffer : Uint8Array.from(buffer));
}

export default {
  encode,
  encodeV1,
  encodeV2,
  encodeCli,
  MspParser,
  parseAll,
  crc8DvbS2,
  crc8DvbS2Buf,
  ByteReader,
  ByteWriter,
  SYM,
};
