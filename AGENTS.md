# AGENTS.md — BF-AITuner

macOS (Apple Silicon) Electron desktop app: a 5-inch racing quad AI tuning
assistant derived from the official Betaflight Configurator. Connects over
USB/serial MSP, identifies the FC, reads Blackbox logs, does time/frequency
analysis, and emits **conservative, evidence-based** PID and filter proposals.

Read this file before changing anything. Every trap below has already cost real
debugging time — they are not theoretical.

---

## 1. Commands

```bash
npm install            # ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ if the mirror is needed
npm run lint:syntax    # parses every source file; run this first
npm test               # node --test; must stay green (currently 246/246)
npm start              # run from source
npm run build:mac      # THE macOS build. Never call electron-builder directly.
```

**Verification triple — run all three before claiming anything works:**

```bash
npm run lint:syntax && npm test && bash scripts/build-mac.sh
```

Artifact: `dist/BF-AITuner-0.1.0-arm64.dmg`.

---

## 2. Environment traps (already paid for — do not rediscover)

### 2.1 `ELECTRON_RUN_AS_NODE=1` is inherited globally on this machine

This shell has `ELECTRON_RUN_AS_NODE=1` exported. Any real Electron run or
Electron-based tooling must strip it, or Electron starts as plain Node and the
app never appears:

```bash
env -u ELECTRON_RUN_AS_NODE /Applications/BF-AITuner.app/Contents/MacOS/BF-AITuner
```

### 2.2 The macOS build MUST be out-of-tree

The project lives in an iCloud-synced folder. The iCloud FileProvider re-adds
`com.apple.FinderInfo` to files, and `codesign` then fails with
`resource fork, Finder information, or similar detritus not allowed`.

- Always build with `npm run build:mac` (→ `scripts/build-mac.sh`), which builds
  into `$TMPDIR`, signs, and only then copies the `.dmg` into `dist/`.
- **Never copy a built `.app` back into the project tree.**
- `scripts/afterSign.cjs` clears xattrs immediately before signing for the same
  reason.

### 2.3 `package.json` → `build.files`: never add these negations

Do **not** add `"!**/{figures,out,dist}/**"`. electron-builder applies the
negation to the *whole* bundle, so it also deletes
`node_modules/serialport/dist/` and the packaged app loses serial support.
This was already hit and removed once.

### 2.4 `mac.sandbox` / `mas.sandbox` are NOT valid electron-builder 25 fields

Setting either makes the build fail hard on schema validation. Sandboxing here
is entitlement-driven; `com.apple.security.app-sandbox` is intentionally
**absent** so the app can open `/dev/cu.*`.

### 2.5 Signing is ad-hoc, and `identity: "-"` does not do what it looks like

electron-builder treats `"identity": "-"` as a certificate *name* and finds no
match, so signing is done in `scripts/afterSign.cjs` via `@electron/osx-sign`
`signAsync({ identity: '-', identityValidation: false })`.

- Entitlements MUST be passed per binary via `optionsForFile`, not top-level —
  the top-level form is ignored per-binary and silently drops
  `disable-library-validation`.
- Use `timestamp: 'none'` (string) to avoid a `--timestamp` call.
- The result is ad-hoc signed and **not notarized**.

### 2.6 Native module ABI

`@serialport/bindings-cpp` is a native addon. It is rebuilt for the Electron
ABI by `npm run postinstall` / `electron-builder install-app-deps`, and
`asarUnpack`ed. If serial breaks after an Electron upgrade, rebuild it before
suspecting application code.

### 2.7 Frontend is vanilla JS, not Vue

Despite how it may be described, the renderer is hand-written ESM DOM-building
JS (`src/renderer/renderer.js`), with no framework and **no CDN** (the app must
work fully offline). Do not introduce a framework or a network-loaded asset.

---

## 3. Betaflight protocol traps

### 3.1 CLI `get` takes ONE argument and matches by SUBSTRING

Firmware `cli.c` `cliGet()` does `strcasestr(valueTable[i].name, cmdline)`.
`get a b c` therefore matches **nothing** and returns nothing. Every parameter
must be read with its own `get <name>` command.

Symptom if you get this wrong: every parameter after the first silently comes
back `null`, so e.g. `dshot_bidir` / `rpm_filter_*` always read as OFF. This
was the root cause of "bidirectional DShot and RPM detection is wrong".

Note: a bare `get` (no argument) matches every parameter and is used
deliberately by the backup snapshot — it is the one fast path.

### 3.2 CLI is a one-shot STX-framed command, NOT a persistent session

- `#` (0x23) enters the **interactive** CLI, which never emits STX/ETX and never
  returns on its own. Do not use it.
- `0x02` (STX) → `cliEnter(port, interactive=FALSE)` → one framed command →
  reply is STX/ETX framed → `cliExit(false)` returns to MSP automatically.

Commands must therefore be stateless one-shots. There is no persistent CLI
session anywhere in this codebase, and adding one reintroduces a deadlock where
MSP calls are attempted while the FC sits in CLI and the link wedges.

### 3.3 Other protocol facts

- MSP framing is MSPv1/MSPv2; CRC is CRC8-DVB-S2.
- The FC may reboot when the USB CDC port is opened. `SerialTransport` opens
  with `hupcl: false` and drops DTR/RTS, and `Session.connect()` settles +
  pings before reading settings. Removing this makes the first reads of a
  session come back empty.
- On macOS prefer `/dev/cu.*` over `/dev/tty.*` (the `tty.` variant blocks on DCD).
- A port held by Chrome/Edge Web Serial fails with `Resource busy`; the error
  message names the culprit.

---

## 4. Safety invariants — do not weaken these

Treat every one of these as a hard requirement, not a preference:

1. **No write before a verified backup.** A `diff all` snapshot must exist on
   disk (`BackupStore`) before any parameter write. `guard.backupDone` gates it.
2. **`FORBIDDEN_PARAMS` are permanently blocked** on every generic path:
   failsafe, motor direction, ESC protocol, voltage/current calibration,
   resource/timer. There is no override for these.
3. **Hardware faults latch read-only.** `MOTOR_DESYNC`, `SEVERE_VIBRATION`,
   `GYRO_CLIPPING`, `LOG_TRUNCATED`, `GYRO_ABSENT` set `blocksTuning` and are
   **not** overridable by force-trust. Force-trust restores logging/read
   capability only; flight-parameter writes stay locked.
4. **MSC mode refuses all MSP writes.** While the FC exposes its storage as a
   USB volume, the serial port is gone; every write path returns an explicit
   refusal instead of a confusing "not connected".
5. **All writes go through the two-phase token flow**: dry-run + single-use
   token → re-validate → screen every command → write → `save`. Never write
   directly from a UI handler.
6. **Conservative step sizes**: P/I ≤ 7 %, D ±2–3 units, filters ≤ 10 %,
   max one tuning round per session. Filter advice never proposes 0 and never
   cuts a low-pass below the sane floor (gyro 150 Hz, D-term 80 Hz).
7. **Restores are `diff all` only.** Never push a whole `dump` back; never
   restore across a different board or a different BF major version
   (`rollbackSafety()` enforces this).
8. **Propose, don't decide.** Recording/analysis stays read-only for unknown
   boards.
9. **The AI agent is untrusted input.** `src/main/analysis/ai-agent.js` may send
   an analysis pack to a user-configured OpenAI-compatible endpoint (never the
   raw `.bbl`; the pack is a serialised, budget-bounded summary). Everything the
   model returns passes TWO screens before it can reach a copy button or a diff:
   `filterDiff` (parameter names — `FORBIDDEN_PARAMS` + the `isTunableParam`
   whitelist) and `enforceStepLimits` (magnitudes — the same P/I ≤ 7 %, D ±3,
   filter ≤ 10 % budget the rules obey). A model-proposed diff is never
   `safeToApply`, and applying anything is still the audited two-phase token
   flow. The whitelist alone is NOT enough: `dterm_lpf1_static_hz: 82 -> 120` is
   a legal parameter name and an illegal step.
10. **The analysis pack is budget-bounded.** `PACK_LEVELS` (compact ≤ 9 KB /
    standard ≤ 120 KB / full ≤ 400 KB) cap the serialised characters; the time
    series is sized against what is actually left after the header, stats,
    spectra and segments, and `trimPackToBudget` verifies the result. Blowing
    the model's context window is a hard failure, not a warning. `buildTimeSeries`
    must stay fair-share: greedy filling gave gyro maximum resolution and
    dropped every motor/eRPM channel — the exact evidence a desync diagnosis
    needs.

---

## 5. Layout

```
src/main/main.js            BrowserWindow, single-instance lock, privacy deep link
src/main/preload.cjs        CommonJS bridge (sandbox:true forbids ESM preload)
src/main/session.js         connection lifecycle, backup/rollback, MSC, evaluation
src/main/tools/registry.js  every IPC handler (main.js wires this via registerIpc)
src/main/msp/               transport, client (self-healing), codec, helper
src/main/fc/                identification + settings reader
src/main/blackbox/          blackbox config/erase/download, msc.js
src/main/backup/            versioned snapshots + rollback packages
src/main/analysis/          bbl-decode, bbl-fft, bbl-metrics, ai-tune, ai-agent, compare-runs
src/main/ai-config.js       AI endpoint + API key store (userData, mode 0600)
src/main/safety/guard.js    the write gate
src/shared/contracts.js     frozen IPC contract (CH), forbidden params, typedefs
src/renderer/               vanilla-JS UI (index.html, styles.css, renderer.js)
test/                       node --test suites
```

### Contract discipline

`src/shared/contracts.js` holds the channel names (`CH`). `src/main/preload.cjs`
mirrors them, and a **contract-drift test fails the suite** if the two diverge.
When you add a channel: add it to `CH`, mirror it in `preload.cjs`, register the
handler in `registry.js` — in that order.

### Renderer rules

- Normalize both response shapes (`safety:status` has been returned both flat
  and nested; `port:list` returns `{ports, error, troubleshooting}`, not a bare
  array).
- `innerHTML` appears exactly once in `renderer.js`, inside a comment. Use
  `el()` / `setChildren()`. `setChildren()` filters falsy values because
  `replaceChildren` stringifies `null` into visible `null` text.
- There is no in-repo test harness for the renderer; `npm test` never imports
  it. Verify renderer changes by driving the packaged app over the Chrome
  DevTools Protocol (`--remote-debugging-port=9222`), or by a throwaway DOM stub
  harness.

---

## 6. Testing

- `npm test` runs `node --test` over `test/`. Keep it green; **246/246** is the
  current baseline.
- Test names state behaviour, not implementation. Prefer a regression test for
  every bug fixed.
- Unit-test pure logic directly (codecs, parsers, `ai-tune`, `compare-runs`,
  `backup-store`, `bbl-*`). Use `VirtualTransport` for session/integration tests
  instead of hardware.
- Never commit `.bbl` logs, `captures/`, `dist/`, or `node_modules/`.

---

## 7. Reporting style for this project

Proposals must stay in the fixed six-part order the UI renders: ① what is wrong
② evidence (numbers, axis, frequency) ③ the CLI change ④ why (latency / motor
heat / washout) ⑤ what to fly to verify ⑥ what happens if you don't apply it.
Quote the measured numbers; do not invent values. If nothing needs changing, say
so explicitly with the measurements rather than staying silent.
