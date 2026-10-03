# BF AI Tuner

A macOS (Apple Silicon) desktop assistant that connects to a Betaflight 4.x
flight controller over USB/serial MSP, captures Blackbox logs, analyses them in
the time and frequency domain, and proposes **conservative, evidence-backed**
tuning changes.

Built as an Electron application that reuses the official
[Betaflight Configurator](https://github.com/betaflight/betaflight-configurator)
protocol and blackbox-decoding logic (vendored, with provenance) rather than
re-implementing it.

> **This tool does not tune your quad for you.** It reads data, states what it
> found and what it would change, and asks you to confirm. Nothing is written to
> the flight controller without an explicit two-step confirmation, and never
> before a full `dump` backup exists on disk.

---

## Target aircraft and assumptions

| | |
|---|---|
| Airframe | 5-inch racing quadcopter |
| Firmware | Betaflight 4.x |
| Loop rates | 8k/8k or 4k/4k (rates are **measured** at runtime, not assumed) |
| ESC | DShot, optionally bidirectional DShot / RPM filter |
| Host | macOS on Apple Silicon, unsigned build (see [BUILD-macOS.md](docs/BUILD-macOS.md)) |

---

## Workflow → where it lives

The eight-step workflow maps onto the module graph one-to-one:

| # | Step | Implementation |
|---|---|---|
| 1 | Read firmware/board/rates/PID/filter/blackbox, back up `dump` | [`fc-settings.js`](src/main/fc/fc-settings.js) |
| 2 | Identify the board (MSP → CLI → capability), confidence, safe mode | [`fc-identify.js`](src/main/fc/fc-identify.js) |
| 3 | Configure the blackbox at 2 kHz, back-calculated from the loop | [`blackbox-manager.js`](src/main/blackbox/blackbox-manager.js) |
| 4 | Erase the medium by its own method | [`blackbox-manager.js`](src/main/blackbox/blackbox-manager.js) |
| 5 | Fly 30 s+ of a standard routine | renderer step 5 |
| 6 | Download `.bbl`, verify duration / drop rate / real rate | [`blackbox-manager.js`](src/main/blackbox/blackbox-manager.js) |
| 7 | Decode, FFT/Welch, time-domain metrics, fault detection | [`bbl-decode.js`](src/main/analysis/bbl-decode.js), [`bbl-fft.js`](src/main/analysis/bbl-fft.js), [`bbl-metrics.js`](src/main/analysis/bbl-metrics.js) |
| 8 | problem → evidence → CLI → re-fly verification | [`ai-tune.js`](src/main/analysis/ai-tune.js) |

---

## Architecture

```
src/
  shared/contracts.js          single source of truth: IPC channels, data
                               shapes, tool schemas, safety constants
  main/                        Electron main process (Node, no DOM)
    main.js                    window + app lifecycle + macOS behaviour
    preload.cjs                contextBridge -> window.bf  (CommonJS: see below)
    session.js                 owns the connection and the module graph
    tools/registry.js          the 13 tools, wired to IPC
    msp/
      msp-codes.js             command codes (ported from upstream)
      msp-codec.js             MSPv1/MSPv2/CLI framing + streaming parser
      msp-transport.js         serial / replay / virtual transports
      msp-client.js            request-response correlation, CLI session
      msp-helper.js            payload parsers + domain commands
    fc/
      fc-identify.js           three-layer identification + capabilities
      fc-settings.js           settings read + mandatory backup
      model-map.json           local, ship-empty model map (safe mode by default)
    blackbox/blackbox-manager.js
    analysis/
      bbl-decode.js            metadata + field decoding. Pure Node, no Electron,
                               so the whole flight workflow is testable headlessly
      bbl-fft.js               Welch PSD, peak detection, eRPM harmonic matching
      bbl-metrics.js           time + frequency metrics, fault detection
      ai-tune.js               rules -> proposals (never writes)
    safety/guard.js            the safety boundary; every write passes through it
  renderer/                    sandboxed UI (contextIsolation, no Node)
vendor/betaflight/             verbatim upstream modules + provenance
scripts/sync-upstream.mjs      re-vendor from an upstream checkout
```

### Why these boundaries

- **`session.js` knows nothing about Electron.** The whole flight-side workflow
  can be driven from a plain Node test against a `VirtualTransport`, which is
  exactly how the protocol layer is tested without hardware.
- **`ai-tune.js` never writes.** It returns diffs. `session.js` applies them,
  and only after `guard.js` has agreed.
- **`preload.cjs` is CommonJS** because a sandboxed renderer cannot load an ESM
  preload and this package is `"type": "module"`. The IPC channel names are
  mirrored there and `test/core.test.js` fails the build if they drift from
  `contracts.js`.
- **Writes go out as CLI `set` commands, not MSP structs.** CLI is auditable,
  is exactly the text the UI shows, and is immune to the MSP struct churn
  across API versions. MSP is used to read config back and to verify writes.

---

## Safety boundaries

Enforced in [`guard.js`](src/main/safety/guard.js), not by convention:

1. **Backup first.** No flight-behaviour write is permitted until a `dump` has
   been written to disk and hashed. A failed backup aborts the workflow.
2. **Immutable list.** `failsafe_*`, `motor_direction` / `yaw_motors_reversed`,
   `motor_pwm_protocol` (ESC protocol) and `vbat_scale` / `vbat_divider` /
   `current_meter_scale` are rejected — including if typed by hand into the CLI
   box, and including any `set` line whose parameter is not on the tunable
   whitelist.
3. **Hardware faults stop tuning.** `MOTOR_DESYNC`, `SEVERE_VIBRATION`,
   `GYRO_CLIPPING` and `LOG_TRUNCATED` latch the session read-only. Analysis
   continues; PID/filter writes are blocked and the latch is **not** dismissible.
4. **One round only.** At most one conservative write round per session.
5. **Conservative steps.** P/I move 5–10 % (7 % target), D moves 2–3 units,
   filters move at most 10 %. A proposal that would leave a sane range is still
   shown, but marked unsafe with the reason.
6. **Two-phase apply.** `apply_tune` first returns a dry-run diff plus a
   single-use token; the write only happens when that token is returned within
   10 minutes, and the diff is re-checked against the live values first.
7. **Unknown board → SAFE MODE.** Read-only for flight behaviour. Logging
   configuration stays available, because changing what is recorded cannot
   change how the aircraft flies.

---

## The tool surface

Declared in [`contracts.js`](src/shared/contracts.js) as `TOOL_SCHEMAS`; each
entry names the IPC channel that implements it.

```
fc_connect(port)              fc_get_settings()          fc_run_cli(commands[], dryRun)
fc_identify()                 fc_capabilities()          blackbox_config(rate, device, fields)
blackbox_erase(device)        blackbox_download()        bbl_decode(file)
bbl_fft(file)                 bbl_metrics(file)          propose_tune(metrics, pid, filter)
apply_tune(diff, requireConfirm=true, token)
```

`apply_tune` is the only entry that can mutate the aircraft.

---

## Getting started

```bash
npm install                 # also rebuilds the native serialport binding
npm run dev                 # launch with devtools
node --test                 # protocol + analysis test suite
```

Then read [docs/BUILD-macOS.md](docs/BUILD-macOS.md) for packaging, the
unsigned-app quarantine problem, and macOS serial-port specifics
(use `/dev/cu.*`, not `/dev/tty.*`).

### Offline / no-hardware use

Steps 6–8 work on any `.bbl` file with no flight controller attached: use
**Open log** in the UI, or call `bbl_metrics` directly. This is the fastest way
to evaluate whether the analysis agrees with your own read of a log.

---

## Upstream provenance

`vendor/betaflight/` contains five modules copied verbatim from the official
configurator, each carrying a header naming its upstream path and commit:

```
datastream.js  decoders.js  fft.js  huffman.js  default_huffman_tree.js
```

One patch is applied, and it is listed explicitly in the sync manifest:
`default_huffman_tree.js` uses an extensionless import that a bundler resolves
but plain Node ESM does not.

Re-vendor or verify drift against a checkout with:

```bash
node scripts/sync-upstream.mjs                       # copy
node scripts/sync-upstream.mjs --check               # fail if drifted
BF_CONFIGURATOR_PATH=~/betaflight-configurator node scripts/sync-upstream.mjs
```

Protocol constants and wire-format layouts were additionally cross-checked
against firmware source (`src/main/msp/msp.c`, `src/main/blackbox/blackbox.h`,
`blackbox_fielddefs.h`, `src/main/cli/settings.c`). The blackbox field bit
order and the `rate = 1 << sample_rate` relationship in particular are taken
from the firmware, not inferred.

Licence: GPL-3.0-or-later, inherited from the upstream project.

---

## Limitations worth knowing

- **The model map ships empty.** An unrecognised board runs in SAFE MODE and its
  *measured* capabilities are recorded to `model-map.local.json`. This is
  deliberate: a wrong map entry silently removes a real safety net. Add
  `verified: true` entries only after bench confirmation.
- **SD card and SERIAL blackbox media cannot be erased or downloaded over MSP.**
  The app says so and offers the correct route (MSC for SD, file import for a
  serial logger) instead of pretending.
- **No hardware-in-the-loop test.** The protocol layer is tested against a
  synthetic flight controller and the decoder against synthesised logs; it has
  not been flown against every 4.x firmware revision.
- **PID/filter values are read over CLI, not MSP**, so they are correct across
  API versions — but a firmware that renamed a parameter will report `null`
  rather than a wrong number, and the UI will show the gap.
