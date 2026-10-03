/**
 * Byte transports for MSP.
 *
 * A transport is deliberately dumb: bytes in, bytes out. All framing lives in
 * msp-codec.js and all request/response correlation lives in msp-client.js, so
 * a transport can be swapped (real serial, recorded replay, virtual FC) without
 * touching protocol logic. This is what makes the analysis pipeline testable
 * with no hardware attached.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EventEmitter } from 'node:events';

/** Vendor IDs commonly used by flight controllers / USB-UART bridges. */
/**
 * Returned by a VirtualTransport handler to send NO reply at all, which is how
 * tests simulate an unresponsive or wedged flight controller.
 */
export const SILENT = Symbol('msp.silent');

export const FC_VENDOR_IDS = new Set([
  '0x0483', // STMicroelectronics (STM32 USB CDC / VCP) - most Betaflight boards
  '0x2e3c', // STMicroelectronics (alt)
  '0x10c4', // Silicon Labs CP210x
  '0x1a86', // QinHeng CH340 / CH9102
  '0x0403', // FTDI
  '0x2341', // Arduino-style CDC
  '0x2e8a', // Raspberry Pi Pico (some FCs)
  '0x1209', // InterBiometrics / pid.codes
]);

export class Transport extends EventEmitter {
  constructor(name = 'transport') {
    super();
    this.name = name;
    this.opened = false;
  }

  get isOpen() {
    return this.opened;
  }

  // eslint-disable-next-line no-unused-vars
  async open() {
    throw new Error('open() not implemented');
  }

  async close() {
    this.opened = false;
  }

  // eslint-disable-next-line no-unused-vars
  write(_bytes) {
    throw new Error('write() not implemented');
  }

  /** Subclasses call this when bytes arrive. */
  _emitData(bytes) {
    if (bytes && bytes.length) this.emit('data', bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes));
  }

  _emitError(err) {
    this.emit('error', err);
  }
}

/* ------------------------------------------------------------------ *
 * Serial (real hardware)
 * ------------------------------------------------------------------ */

/**
 * Opens the port at the MSP baud rate. Betaflight's USB CDC ignores baud rate,
 * but USB-UART bridges (CP210x/CH340/FTDI) do not, so 115200 is the safe value.
 */
export class SerialTransport extends Transport {
  constructor(path, { baudRate = 115200 } = {}) {
    super(path);
    this.path = path;
    this.baudRate = baudRate;
    this.port = null;
  }

  async open() {
    // Lazy import: the app must still start (analysis-only mode) when the
    // native `serialport` binding is unavailable or failed to rebuild.
    let SerialPort;
    try {
      ({ SerialPort } = await import('serialport'));
    } catch (err) {
      throw new Error(
        `serialport module unavailable (${err.message}). Run "npm install" so the native binding is rebuilt for Electron.`,
      );
    }

    await new Promise((resolve, reject) => {
      // hupcl:false keeps the driver from toggling the modem lines that make a
      // flight controller's USB CDC reboot when the port is opened/closed.
      this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, autoOpen: false, hupcl: false });
      this.port.open((err) => {
        if (!err) return resolve();
        // The single most common reason a flight-controller port refuses to
        // open: Chrome/Edge's Web Serial API has grabbed the USB CDC device.
        if (/EBUSY|Resource busy/i.test(err.message || '')) {
          err.message +=
            ' - 端口被其他程序占用（常见：Chrome/Edge 网页串口 Web Serial）。' +
            '请关闭占用该端口的浏览器标签或应用后重试。';
        }
        reject(err);
      });
    });

    // Drop DTR/RTS right after open: on STM32 VCP asserting DTR can reboot the
    // flight controller, which would kill the connection we just made. Best
    // effort - some drivers reject it, which is harmless.
    try {
      if (typeof this.port.set === 'function') this.port.set({ dtr: false, rts: false });
    } catch {
      /* ignore */
    }

    this.port.on('data', (buf) => this._emitData(buf));
    this.port.on('error', (err) => this._emitError(err));
    this.port.on('close', () => {
      this.opened = false;
      this.emit('close');
    });

    this.opened = true;
    this.emit('open', { path: this.path, baudRate: this.baudRate });
    return this;
  }

  write(bytes) {
    if (!this.port || !this.opened) throw new Error(`serial port ${this.path} is not open`);
    this.port.write(Buffer.from(bytes));
    return true;
  }

  async drain() {
    if (!this.port || !this.opened) return;
    await new Promise((resolve) => this.port.drain(() => resolve()));
  }

  async close() {
    if (this.port && this.opened) {
      await new Promise((resolve) => this.port.close(() => resolve()));
    }
    this.port = null;
    this.opened = false;
  }

  /** Flushes stale bytes, e.g. the tail of a previous session. */
  async flushInput() {
    if (!this.port || !this.opened) return;
    await new Promise((resolve) => {
      try {
        this.port.flush(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

/**
 * Enumerates serial ports and marks the ones that look like a flight controller.
 *
 * On macOS, prefer `/dev/cu.*` over `/dev/tty.*`: the `tty.` variant blocks on
 * carrier detect, which stalls an outbound MSP connection on some USB stacks.
 */
export async function listPorts() {
  let SerialPort;
  try {
    ({ SerialPort } = await import('serialport'));
  } catch (err) {
    return { ports: [], error: `serialport unavailable: ${err.message}` };
  }

  const raw = await SerialPort.list();
  const ports = raw
    .map((p) => {
      const vendorId = (p.vendorId || '').toLowerCase();
      const path = p.path || '';
      const macTty = path.startsWith('/dev/tty.');
      return {
        path,
        manufacturer: p.manufacturer || '',
        serialNumber: p.serialNumber || '',
        vendorId,
        productId: (p.productId || '').toLowerCase(),
        pnpId: p.pnpId || '',
        likelyFc:
          FC_VENDOR_IDS.has(vendorId) ||
          // STM32 VCP (usbmodem), plus the USB-UART bridges a FC can appear
          // behind: SLAB (CP210x), wch (CH340/CH341), FTDI, and macOS's
          // generic usbserial naming.
          /usbmodem|usbserial|SLAB|wchusbserial|wch-|FTDI|ftdi/i.test(path),
        // Surface the `cu.` alternative so the UI can offer the non-blocking one.
        preferredPath: macTty ? path.replace('/dev/tty.', '/dev/cu.') : path,
      };
    })
    .sort((a, b) => Number(b.likelyFc) - Number(a.likelyFc) || a.path.localeCompare(b.path));

  return { ports, error: null, troubleshooting: connectionTroubleshooting(ports) };
}

/**
 * What to check when no port looks like a flight controller.
 *
 * Ordered cheapest-first, because the usual causes are a charge-only cable and
 * a missing USB-UART driver, not a broken FC.
 */
export function connectionTroubleshooting(ports = []) {
  const steps = [
    '换一根**数据线**：很多 USB-C 线只供电不传数据，这是最常见的原因。',
    '打开「系统信息 → USB」看是否有设备出现；没有则说明线或口的问题。',
    '装了 CP210x / CH340 / FTDI 驱动的外置串口板需要对应驱动（CH34x 在 Apple Silicon 上需新版驱动）。',
    '确认飞控已上电，且没有被 Betaflight 地面站、Chrome/Edge 网页串口等程序占用。',
    'STM32 VCP 直连通常无需驱动；若设备出现但无 /dev 节点，重新插拔或换 USB 口。',
  ];
  const anyPorts = Array.isArray(ports) && ports.length > 0;
  return {
    found: anyPorts,
    steps: anyPorts
      ? ['检测到串口设备，但没有识别为飞控：可能是外置串口板或其他 USB 串口设备。', ...steps.slice(1)]
      : ['没有检测到任何串口设备。', ...steps],
  };
}

/* ------------------------------------------------------------------ *
 * Replay (tests, offline fixtures)
 * ------------------------------------------------------------------ */

/**
 * Feeds a pre-recorded request/response script. `script` is a list of
 * `{ expect?: Uint8Array|number[], reply: Uint8Array|number[] }` pairs; a
 * request is matched against `expect` (or answered in order when omitted).
 */
export class ReplayTransport extends Transport {
  constructor(script, { name = 'replay' } = {}) {
    super(name);
    this.script = script.map((s) => ({
      expect: s.expect ? Uint8Array.from(s.expect) : null,
      reply: Uint8Array.from(s.reply || []),
      delayMs: s.delayMs || 0,
    }));
    this.cursor = 0;
    this.sent = [];
  }

  async open() {
    this.opened = true;
    return this;
  }

  write(bytes) {
    const sent = Uint8Array.from(bytes);
    this.sent.push(sent);
    const entry = this.script[this.cursor];
    if (!entry) return true;

    const matches = !entry.expect || bytesEqual(entry.expect, sent);
    if (!matches) {
      // Out-of-order request: do not consume the entry.
      this._emitError(new Error(`replay: unexpected request ${toHex(sent)} (expected ${toHex(entry.expect)})`));
      return true;
    }

    this.cursor++;
    const deliver = () => this._emitData(entry.reply);
    if (entry.delayMs > 0) setTimeout(deliver, entry.delayMs);
    else queueMicrotask(deliver);
    return true;
  }

  async close() {
    this.opened = false;
  }
}

/* ------------------------------------------------------------------ *
 * Virtual (in-process flight controller stub)
 * ------------------------------------------------------------------ */

/**
 * A tiny synthetic FC. Handlers are keyed by MSP code and receive the decoded
 * request payload, returning reply bytes. Used by the test suite to exercise
 * the full identify -> capabilities -> blackbox path without hardware.
 */
export class VirtualTransport extends Transport {
  #codec = null;

  #parser = null;

  #parserPromise = null;

  /**
   * @param {Record<number, Function>} handlers  MSP code -> payload producer.
   *        Return the SILENT symbol to send no reply at all.
   * @param {{name?:string, cliHandler?:Function, wedged?:boolean}} opts
   *        `wedged` models the FC sitting in an interactive CLI: it accepts
   *        bytes but never answers a framed command. That is the state the old
   *        client deadlocked in, so tests need to be able to reproduce it.
   */
  constructor(handlers = {}, { name = 'virtual', cliHandler = null, wedged = false } = {}) {
    super(name);
    this.handlers = handlers;
    this.cliHandler = cliHandler;
    this.wedged = wedged;
    this.sent = [];
    /** Every CLI command the FC received, in order. */
    this.cliCommands = [];
    /** Incremented by open(); lets tests assert a real reopen happened. */
    this.openCount = 0;
    this.#parserPromise = import('./msp-codec.js').then((m) => {
      this.#codec = m;
    });
  }

  async open() {
    await this.#parserPromise;
    this.#parser = new this.#codec.MspParser();
    this.opened = true;
    this.openCount += 1;
    return this;
  }

  write(bytes) {
    this.sent.push(Uint8Array.from(bytes));
    if (!this.#parser) throw new Error('virtual transport not opened');

    for (const msg of this.#parser.push(bytes)) {
      if (msg.type === 'cli') this.#handleCli(msg);
      else this.#handleMsp(msg);
    }
    return true;
  }

  #handleMsp(msg) {
    if (msg.direction !== 'request') return;
    const handler = this.handlers[msg.code];
    if (!handler) {
      // Firmware replies `$M!` for unknown commands.
      this.#respondError(msg);
      return;
    }
    const reply = handler(msg.payload);
    if (reply === SILENT) return; // simulate a wedged FC
    const bytes = reply || new Uint8Array(0);
    queueMicrotask(() => this._emitData(this.#codec.encode(msg.code, bytes)));
  }

  #respondError(msg) {
    const err = new Uint8Array([0x24, 0x4d, 0x21, 0x00, msg.code & 0xff, msg.code & 0xff]);
    queueMicrotask(() => this._emitData(err));
  }

  /**
   * Models the real firmware: a framed command is a one-shot. The FC runs it,
   * replies inside an STX/ETX envelope, and returns to MSP on its own. There is
   * no persistent CLI mode to model - that is the whole point of the protocol.
   */
  #handleCli(msg) {
    const text = (msg.lines || []).join('\n').trim();
    this.cliCommands.push(text);
    if (this.wedged) return; // accepts input, never answers

    const lines = this.cliHandler ? this.cliHandler(text) || [] : [`Unknown command: ${text}`];
    queueMicrotask(() => this._emitData(this.#cliFrame(lines)));
  }

  #cliFrame(lines) {
    const out = [0x02];
    for (const line of lines) {
      for (const ch of String(line)) out.push(ch.charCodeAt(0) & 0xff);
      out.push(0x0a);
    }
    out.push(0x03);
    return Uint8Array.from(out);
  }

  async close() {
    this.opened = false;
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function toHex(bytes) {
  return Array.from(bytes || [])
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

export default { Transport, SerialTransport, ReplayTransport, VirtualTransport, listPorts };
