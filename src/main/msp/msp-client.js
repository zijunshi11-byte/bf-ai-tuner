/**
 * MSP request/response client with a self-healing connection state machine.
 *
 * -- Why there is no persistent CLI session ---------------------------------
 *
 * Betaflight's MSP serial port has TWO ways into the CLI, and they are not
 * interchangeable (firmware src/main/msp/msp_serial.c, src/main/cli/cli.c):
 *
 *   '#' (0x23)  -> MSP_PENDING_CLI -> cliEnter(port, interactive = TRUE)
 *                  Interactive CLI prints a banner and a prompt and does NOT
 *                  emit STX/ETX framing. It stays in CLI until `exit` is typed.
 *
 *   0x02 (STX)  -> portState = PORT_CLI_CMD -> cliEnter(port, interactive = FALSE)
 *                  Non-interactive CLI consumes the framed command, writes the
 *                  reply, emits a closing ETX (0x03) and then calls
 *                  cliExit(false) - it returns to MSP BY ITSELF.
 *
 * Entering interactive mode and then speaking the framed protocol deadlocks:
 * the host believes it is "in CLI" and refuses to send MSP, while the FC never
 * answers the framed commands. That is exactly the failure this file used to
 * produce.
 *
 * So: every CLI command is a self-contained one-shot - STX + command + LF +
 * ETX - and the flight controller handles enter/exit on its own. There is no
 * session to leak and no host-side mode that can get stuck.
 *
 * Requests and CLI commands share one serialisation chain, because the FC is
 * genuinely in CLI while a command runs and would parse an interleaved MSP
 * frame as CLI text.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EventEmitter } from 'node:events';
import { MspParser, encode, encodeCli, ByteReader } from './msp-codec.js';
import { NO_REPLY_COMMANDS, MSP } from './msp-codes.js';

export class MspTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MspTimeoutError';
  }
}

export class MspProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MspProtocolError';
    this.code = code;
  }
}

/** Raised when the link could not be restored automatically. */
export class MspLinkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MspLinkError';
  }
}

/**
 * Raw text that leaves an interactive CLI, with the explicit newlines the
 * firmware needs. Sent UNframed on purpose: STX would be read as a request to
 * start a non-interactive CLI, which is not what we want here.
 */
const CLI_EXIT_TEXT = '\r\nexit\r\n';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MspClient extends EventEmitter {
  /**
   * @param {import('./msp-transport.js').Transport} transport
   */
  constructor(transport, {
    timeoutMs = 1500,
    cliTimeoutMs = 8000,
    retries = 2,
    trace = false,
    reopenDelayMs = 2000,
    probeTimeoutMs = 900,
  } = {}) {
    super();
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.cliTimeoutMs = cliTimeoutMs;
    this.retries = retries;
    this.traceEnabled = trace;
    this.reopenDelayMs = reopenDelayMs;
    this.probeTimeoutMs = probeTimeoutMs;

    this.parser = new MspParser();
    this.bytesIn = 0;
    this.bytesOut = 0;
    /** Exposed for the UI: 'msp' | 'recovering' | 'down'. */
    this.linkState = 'msp';
    this.recoveries = 0;
  }

  #pending = null;

  #cliWaiter = null;

  #chain = Promise.resolve();

  #closed = false;

  #healthy = true;

  #recovering = null;

  #recoverAttempts = 0;

  get isOpen() {
    return this.transport?.isOpen === true && !this.#closed;
  }

  /** True while the link is believed usable. */
  get isHealthy() {
    return this.#healthy;
  }

  /* ---------------- lifecycle ---------------- */

  async open() {
    this.#closed = false;
    this.#healthy = true;
    this.linkState = 'msp';
    this.transport.on('data', this.#onData);
    this.transport.on('error', this.#onError);
    await this.transport.open();
    return this;
  }

  async close() {
    this.#closed = true;
    this.#rejectPending(new Error('MSP client closed'));
    this.#rejectCli(new Error('MSP client closed'));
    try {
      this.transport.off('data', this.#onData);
      this.transport.off('error', this.#onError);
    } catch {
      /* transport may not support off() */
    }
    await this.transport.close();
    this.linkState = 'down';
  }

  /**
   * Hard reset of the serial link: close, wait, reopen, confirm with a probe.
   * The last resort when the FC is wedged, for example sitting in an
   * interactive CLI that framed commands cannot reach.
   *
   * @returns {Promise<boolean>} true when MSP answered after the reopen
   */
  async reconnect({ delayMs = this.reopenDelayMs, probe = true } = {}) {
    return this.#serialize(async () => {
      this.emit('reconnect-start', { delayMs });
      try {
        await this.#reopen(delayMs);
      } catch (err) {
        this.linkState = 'down';
        this.emit('reconnect-done', { ok: false, error: err.message });
        return false;
      }
      const ok = probe ? await this.#probe() : true;
      this.#healthy = ok;
      this.linkState = ok ? 'msp' : 'down';
      if (ok) this.recoveries += 1;
      this.emit('reconnect-done', { ok });
      return ok;
    });
  }

  async #reopen(delayMs) {
    try {
      await this.transport.close();
    } catch {
      /* already closed */
    }
    if (delayMs > 0) await sleep(delayMs);
    this.parser.reset();
    this.#rejectPending(new Error('serial port reopened'));
    this.#rejectCli(new Error('serial port reopened'));
    await this.transport.open();
    this.#closed = false;
  }

  /* ---------------- receive path ---------------- */

  #onData = (chunk) => {
    this.bytesIn += chunk.length;
    for (const msg of this.parser.push(chunk)) {
      if (this.traceEnabled) this.emit('trace', { direction: 'in', message: msg });

      if (msg.type === 'cli') {
        const waiter = this.#cliWaiter;
        if (waiter) {
          this.#cliWaiter = null;
          clearTimeout(waiter.timer);
          waiter.resolve({ lines: msg.lines, text: msg.text });
        } else {
          this.emit('cli-unsolicited', msg);
        }
        continue;
      }

      const pending = this.#pending;
      if (!pending) {
        // Any well-formed MSP reply is proof the FC is back in MSP mode.
        if (!this.#healthy) this.#markHealthy('unsolicited-reply');
        this.emit('unsolicited', msg);
        continue;
      }
      if (msg.code !== pending.code) {
        this.emit('stale-reply', msg);
        continue;
      }

      this.#pending = null;
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new MspProtocolError(`flight controller rejected MSP command ${msg.code}`, msg.code));
      } else {
        pending.resolve({ code: msg.code, payload: new ByteReader(msg.payload), raw: msg.payload, version: msg.version });
      }
    }
  };

  #onError = (err) => {
    this.#markUnhealthy(err);
    this.emit('transport-error', err);
  };

  /* ---------------- health ---------------- */

  #markUnhealthy(reason) {
    if (!this.#healthy) return;
    this.#healthy = false;
    this.linkState = 'recovering';
    this.emit('link-degraded', { reason: reason?.message || String(reason) });
  }

  #markHealthy(method) {
    this.#healthy = true;
    this.linkState = 'msp';
    this.#recoverAttempts = 0;
    this.emit('link-restored', { method });
  }

  /**
   * Runs before every request. If the link is not believed healthy, restore it
   * first: leave any interactive CLI, probe, then reopen. Serialised, so
   * concurrent callers share a single recovery attempt.
   */
  #ensureHealthy() {
    if (this.#healthy && this.isOpen) return Promise.resolve(true);
    if (this.#recovering) return this.#recovering;

    this.#recovering = (async () => {
      this.#recoverAttempts += 1;
      this.linkState = 'recovering';
      this.emit('recovering', { attempt: this.#recoverAttempts });

      // 1. The FC may be sitting in an interactive CLI. Unframed `exit` is the
      //    only thing that works there, and it is harmless while in MSP mode.
      try {
        this.transport.write(new TextEncoder().encode(CLI_EXIT_TEXT));
        this.bytesOut += CLI_EXIT_TEXT.length;
      } catch {
        /* transport may already be gone; the reopen below covers it */
      }
      await sleep(300);

      if (this.isOpen && (await this.#probe())) {
        this.#markHealthy('cli-exit');
        this.recoveries += 1;
        return true;
      }

      // 2. Still nothing: close the port, wait, reopen, probe again.
      this.emit('reopen', { delayMs: this.reopenDelayMs });
      try {
        await this.#reopen(this.reopenDelayMs);
      } catch (err) {
        this.linkState = 'down';
        this.emit('reopen-failed', { error: err.message });
        return false;
      }

      if (await this.#probe()) {
        this.#markHealthy('reopen');
        this.recoveries += 1;
        return true;
      }

      this.linkState = 'down';
      this.emit('recover-failed', { attempts: this.#recoverAttempts });
      return false;
    })().finally(() => {
      this.#recovering = null;
    });

    return this.#recovering;
  }

  /**
   * One MSP_API_VERSION round trip used purely as a liveness probe.
   * Never triggers recovery itself, so it is safe to call from recovery.
   */
  async #probe() {
    if (!this.isOpen) return false;
    try {
      const res = await this.#requestOnce(MSP.MSP_API_VERSION, null, this.probeTimeoutMs);
      return res.raw.length >= 3;
    } catch {
      return false;
    }
  }

  /** Public liveness probe with timing, used by the UI status loop. */
  async ping() {
    const startedAt = Date.now();
    return this.#serialize(async () => {
      await this.#ensureHealthy();
      const res = await this.#requestOnce(MSP.MSP_API_VERSION, null, this.probeTimeoutMs);
      if (!this.#healthy) this.#markHealthy('ping');
      return {
        ok: true,
        mspProtocolVersion: res.raw[0] ?? null,
        apiVersion: res.raw.length >= 3 ? `${res.raw[1]}.${res.raw[2]}.0` : null,
        latencyMs: Date.now() - startedAt,
      };
    });
  }

  /* ---------------- request path ---------------- */

  /**
   * Send an MSP command and await its reply.
   *
   * Requests are serialised and self-healing: if the link is degraded the client
   * restores it (leaving CLI, then reopening the port) before sending.
   *
   * @param {number} code
   * @param {Uint8Array|number[]|null} payload
   */
  request(code, payload = null, { timeoutMs, retries } = {}) {
    const timeout = timeoutMs ?? this.timeoutMs;
    const attempts = (retries ?? this.retries) + 1;

    return this.#serialize(async () => {
      let lastErr;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await this.#ensureHealthy();

        if (!this.isOpen) {
          lastErr = new MspLinkError('serial port is not open');
          if (attempt === attempts) throw lastErr;
          continue;
        }

        try {
          const result = await this.#requestOnce(code, payload, timeout);
          if (!this.#healthy) this.#markHealthy('reply');
          return result;
        } catch (err) {
          lastErr = err;
          // Only a timeout or a dead port means the link is suspect. A command
          // the firmware rejects ($M!) is a healthy link and must not trigger a
          // reconnect.
          if (err instanceof MspTimeoutError || err instanceof MspLinkError) {
            this.#markUnhealthy(err);
          } else {
            throw err;
          }
          if (attempt === attempts) throw err;
          this.emit('retry', { code, attempt, error: err.message });
        }
      }
      throw lastErr;
    });
  }

  #requestOnce(code, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        reject(new MspLinkError('serial port is not open'));
        return;
      }

      const bytes = encode(code, payload);
      const timer = setTimeout(() => {
        this.#pending = null;
        reject(new MspTimeoutError(`MSP ${code} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending = { code, resolve, reject, timer, sentAt: Date.now() };

      try {
        this.transport.write(bytes);
        this.bytesOut += bytes.length;
        if (this.traceEnabled) this.emit('trace', { direction: 'out', code, bytes });
      } catch (err) {
        clearTimeout(timer);
        this.#pending = null;
        reject(new MspLinkError(`write failed: ${err.message}`));
      }
    });
  }

  /** Fire-and-forget command (no reply expected). */
  send(code, payload = null) {
    if (!this.isOpen) throw new MspLinkError('serial port is not open');
    const bytes = encode(code, payload);
    this.transport.write(bytes);
    this.bytesOut += bytes.length;
    if (this.traceEnabled) this.emit('trace', { direction: 'out', code, bytes });
    return bytes;
  }

  /** Sends a command and tolerates the FC not answering. */
  async requestOptional(code, payload = null, opts = {}) {
    if (NO_REPLY_COMMANDS.has(code)) {
      this.send(code, payload);
      return null;
    }
    try {
      return await this.request(code, payload, opts);
    } catch (err) {
      if (err instanceof MspProtocolError) return null;
      throw err;
    }
  }

  #rejectPending(err) {
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      const { reject } = this.#pending;
      this.#pending = null;
      reject(err);
    }
  }

  #rejectCli(err) {
    if (this.#cliWaiter) {
      clearTimeout(this.#cliWaiter.timer);
      const { reject } = this.#cliWaiter;
      this.#cliWaiter = null;
      reject(err);
    }
  }

  /**
   * One serialisation chain for MSP AND CLI traffic: the FC is genuinely in CLI
   * while a command runs, so an interleaved MSP frame would be eaten as text.
   */
  #serialize(fn) {
    const result = this.#chain.then(fn, fn);
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /* ---------------- CLI (stateless, one shot per command) ---------------- */

  /**
   * Run one CLI command.
   *
   * Framed as STX + text + LF + ETX, which makes the firmware enter
   * non-interactive CLI, execute it, emit a closing ETX and return to MSP on its
   * own. Completion is the closing ETX; the timeout is only a net.
   */
  cli(command, { timeoutMs = this.cliTimeoutMs } = {}) {
    return this.#serialize(async () => {
      if (!this.isOpen) throw new MspLinkError('serial port is not open');
      await this.#ensureHealthy();

      try {
        return await this.#cliOnce(command, timeoutMs);
      } catch (err) {
        if (err instanceof MspTimeoutError) this.#markUnhealthy(err);
        throw err;
      }
    });
  }

  #cliOnce(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#cliWaiter = null;
        reject(new MspTimeoutError(`CLI "${command}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#cliWaiter = { command, resolve, reject, timer };

      const bytes = encodeCli(command);
      try {
        this.transport.write(bytes);
        this.bytesOut += bytes.length;
        if (this.traceEnabled) this.emit('trace', { direction: 'out', cli: command });
      } catch (err) {
        clearTimeout(timer);
        this.#cliWaiter = null;
        reject(new MspLinkError(`write failed: ${err.message}`));
      }
    });
  }

  /**
   * Run several CLI commands in order. Each is an independent one-shot, so one
   * failure cannot wedge the commands that follow.
   *
   * @param {string[]} commands
   */
  async cliBatch(commands, { stopOnError = false, onProgress = null, timeoutMs } = {}) {
    const results = [];
    let index = 0;
    for (const command of commands) {
      index++;
      if (!command || command.startsWith('#')) {
        results.push({ command, lines: [], skipped: true });
        continue;
      }
      try {
        const { lines } = await this.cli(command, { timeoutMs });
        results.push({ command, lines });
        onProgress?.({ index, total: commands.length, command, lines });
      } catch (err) {
        results.push({ command, lines: [], error: err.message });
        onProgress?.({ index, total: commands.length, command, error: err });
        if (stopOnError) break;
      }
    }
    return { results, lines: results.flatMap((r) => r.lines) };
  }

  /* ---------------- deprecated session API ---------------- */

  /**
   * @deprecated There is no persistent CLI session any more: the firmware enters
   * and leaves CLI per command, so there is nothing to enter. Retained so
   * existing call sites keep working.
   */
  async enterCli() {
    return true;
  }

  /**
   * @deprecated See enterCli. Kept as a real action rather than a no-op, because
   * an explicit exit is the correct fix when the FC has been left in an
   * interactive CLI by a serial terminal.
   */
  async exitCli() {
    const wasInterlocked = !this.#healthy;
    try {
      this.transport.write(new TextEncoder().encode(CLI_EXIT_TEXT));
      this.bytesOut += CLI_EXIT_TEXT.length;
      await sleep(250);
    } catch {
      /* ignore: the next request triggers a reopen if the port is gone */
    }
    if (wasInterlocked && this.isOpen && (await this.#probe())) this.#markHealthy('explicit-exit');
    return true;
  }

  /** Discards buffered input before a long download. */
  drainInput() {
    this.parser.reset();
  }
}

export default MspClient;
