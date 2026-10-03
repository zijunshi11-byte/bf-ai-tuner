# HANDOFF.md — BF-AITuner

> **Using Codex on this project? Read [docs/CODEX.md](docs/CODEX.md) first** — it covers the
> CLI setup, sandbox configuration, the read-only first-round prompt, and the branch → scope →
> review → verify → merge workflow.

Handoff notes for whoever picks this up next (Codex or a human). Companion to
[AGENTS.md](AGENTS.md), which lists the environment and protocol traps — read
that first; it is not repeated here.

**Status: builds, packages, and runs. 168/168 tests pass. Ready for continued
development, with two open decisions listed in §6.**

---

## 1. What it is

A macOS (Apple Silicon) Electron desktop app for tuning a 5-inch racing quad.
It talks MSP over USB/serial to a Betaflight FC, identifies the board, reads
Blackbox logs (over MSP or by mounting onboard storage), runs time-domain and
frequency-domain analysis, and produces conservative PID **and filter**
proposals with a CLI diff, an explanation, and a verification flight plan.

- Framework: Electron 33.4.11, ESM main process, CommonJS preload,
  `contextIsolation: true`, `sandbox: true`.
- Renderer: hand-written vanilla JS (**not Vue**, no framework, no CDN, fully
  offline).
- Build: electron-builder 25.1.8, arm64, ad-hoc signed, **not notarized**.
- Derived from the official Betaflight Configurator; GPL-3.0-or-later.

---

## 2. Verification triple

Run all three, in order, from `bf-ai-tuner/`:

```bash
npm run lint:syntax      # every source file parses
npm test                 # 168 tests / 21 suites / 168 pass / 0 fail
bash scripts/build-mac.sh # out-of-tree build + ad-hoc sign + dist/*.dmg
```

Everything below was verified at the time of handoff:

| Check | Result |
|---|---|
| `npm run lint:syntax` | every checked file parsed cleanly |
| `npm test` | **168 / 168 pass**, 0 fail |
| `bash scripts/build-mac.sh` | exit 0, `codesign --verify --deep --strict` → VALID |
| Packaged app launch | OK; UI driven over CDP (port 9222) |
| Signature | `Identifier=com.bf.aituner`, `Signature=adhoc`, `TeamIdentifier=not set` |

---

## 3. Build artifact and install

| | |
|---|---|
| Artifact | `dist/BF-AITuner-0.1.0-arm64.dmg` (94 MB) |
| sha256 | `bb87cd4d24729b03e931993e9590acf3770f786be91411e47b09428e87289fee` |
| Built | 2026-10-03 20:29 (local) |

`dist/` is gitignored, so the `.dmg` is **not** in the repository — rebuild it
with `bash scripts/build-mac.sh`.

After installing (drag to `/Applications`), the build is unsigned/unnotarized,
so macOS quarantines it. Clear that:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/BF-AITuner.app
```

If Gatekeeper still blocks the first launch: **System Settings → Privacy &
Security → "Open Anyway"**.

For serial access, also grant **System Settings → Privacy & Security → Full
Disk Access** to BF-AITuner (the app shows a first-run prompt with a deep link
to the right pane).

Note: launching from a shell that has `ELECTRON_RUN_AS_NODE=1` exported requires
`env -u ELECTRON_RUN_AS_NODE` — see AGENTS.md §2.1.

---

## 4. Current state by subsystem

| Subsystem | State |
|---|---|
| Connection / identification | Working. MSP variant → API version → CLI version/board/manufacturer → `get` params. Unknown board ⇒ read-only SAFE MODE. |
| Port handling | `/dev/cu.*` preferred; SLAB/wch/FTDI/usbserial recognised; 5-step troubleshooting payload returned with the port list. |
| Mandatory backup | Working. `diff all` + settings snapshot + rollback package, named `date_board_bfVersion_pidHz_note`. |
| Rollback | Working. `diff all` only; refuses cross-board and cross-BF-major restore. |
| Re-fly evaluation + auto-rollback | Working. Compares against the pre-change baseline; reverts automatically only on a hard regression past tolerance. |
| Blackbox | SPIFLASH via MSP (2k back-calculation, field selection, erase, download). SD cards only via MSC. |
| MSC (large logs) | Working. `msc` CLI → FC reboots → volume mounts → list/import → eject + power cycle. All MSP writes refused while in MSC. |
| Bidirectional DShot / RPM | Working, verified against real hardware (see §5). |
| Analysis — PID | Working: propwash, overshoot, sluggish, I-term; step response, tracking, saturation. |
| Analysis — filter | Working: measured attenuation across the 200 Hz+ noise band, residual peaks, D-term LPF, over-filtering, plus an explicit "filters are fine" verdict when nothing needs changing. |
| UI | 7-page nav, 11-slot status bar, six-part conclusion cards, diff-confirm dialogs, one-click rollback. |
| Report format | Implemented as specified (six parts, colour-coded verdicts). |

---

## 5. Real hardware used for validation

- FC: `MAMBAF722_2022A` (STM32F7X2), Betaflight `2025.12.2`, MSP API `1.47.0`,
  port `/dev/cu.usbmodem374E335D34331`.
- Confirmed on hardware: gyro 8000 Hz, PID 8000 Hz, DSHOT600,
  **`dshot_bidir` ON**, `motor_poles` 14, `rpm_filter` harmonics 3 / Q 500 /
  min 100 Hz.
- Reference log for the analysis path: a real ~99 s 8.9 MB `.bbl`
  (`btfl_all.bbl`, Betaflight 2026.6.0-rc3, H743, 2 kHz logging). On that log the
  filter chain attenuates 21–22 dB across the noise band, so the tool correctly
  reports "no filter change needed" instead of inventing one.

There has been **no hardware-in-the-loop flight test** of a written change:
proposals were verified as diffs and against log analysis, not by flying them.

---

## 6. Open items

### 6.1 Rule conflict needing a decision (unresolved)

The capture requirements contradict each other across two sets of instructions:

- An explicit instruction was given to **remove the 30-second timer and the
  single-manoeuvre requirement**.
- The later consolidated spec says to **validate duration ≥ 30 s** and to
  require a **30 s+ standard racing routine**.

Current implementation follows the explicit instruction: duration is reported
**informationally only** and never gates analysis. `SAMPLE_TOO_SHORT` is emitted
as `info` with `blocksTuning: false`; the capture page has no timer and no
manoeuvre requirement.

Reinstating a hard ≥ 30 s gate means changing `bbl-metrics.js`, the capture page,
and the tests. **Pick one; they cannot both hold.** Note that
`GYRO_ABSENT` remains blocking — an empty log still refuses to give advice.

### 6.2 Not implemented

1. **No standalone TPA rule.** `tpa_rate` / `tpa_breakpoint` / `tpa_mode` are
   read and are on the tunable whitelist, but nothing proposes them.
2. **No standalone `iterm_relax` rule.** The 25–35 Hz reference exists as
   `RACING_REFERENCE.itermRelaxCutoffHz` and the params are tunable, but
   throttle-chop hunt still routes through the existing I/D rules.
3. **MSC is a manual choice.** There is no automatic size-based routing between
   MSP download and MSC mounting.
4. **SD-card logs cannot be erased or downloaded over MSP** — MSC only. This is
   a firmware limitation, and the UI says so.
5. No notarization or Developer ID; ad-hoc signing only, so every distribution
   needs the quarantine step in §3.

---

## 7. Repository conventions

- `.gitignore` covers `node_modules/`, `dist/`, `*.dmg`, `captures/`, `*.bbl`
  (plus `.bfl`, `.bbl.gz`) and more. **Never commit build output or logs.**
- Adding an IPC channel is a three-file change in a fixed order: `CH` in
  `src/shared/contracts.js` → mirror in `src/main/preload.cjs` → handler in
  `src/main/tools/registry.js`. A contract-drift test fails the suite otherwise.
- Keep `npm test` at 168/168; add a regression test with every fix.
- The renderer has no in-repo test harness. Verify it by driving the packaged
  app over the DevTools Protocol, or with a throwaway DOM stub.
