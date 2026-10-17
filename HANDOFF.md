# HANDOFF.md — BF-AITuner

> **Using Codex on this project? Read [docs/CODEX.md](docs/CODEX.md) first** — it covers the
> CLI setup, sandbox configuration, the read-only first-round prompt, and the branch → scope →
> review → verify → merge workflow.

Handoff notes for whoever picks this up next (Codex or a human). Companion to
[AGENTS.md](AGENTS.md), which lists the environment and protocol traps — read
that first; it is not repeated here.

**Status: builds, packages, and runs. 304/304 tests pass. Ready for continued
development, with the open items listed in §6.**

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
npm test                 # 304 tests / 304 pass / 0 fail
bash scripts/build-mac.sh # out-of-tree build + ad-hoc sign + dist/*.dmg
```

Everything below was verified at the time of handoff:

| Check | Result |
|---|---|
| `npm run lint:syntax` | every checked file parsed cleanly |
| `npm test` | **304 / 304 pass**, 0 fail |
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
| Bidirectional DShot / RPM | Working, verified against real hardware (see §5). Motor-desync detection is command-aware: a single motor is a desync only when it is still commanded to spin (above half its command range) while its eRPM reads near zero (absolute < 2k eRPM floor, not "10% of the fastest"); **two or more motors at zero eRPM together while flying is flagged as a crash signature regardless of command** (btfl_003.bbl regression). This stops healthy hard-roll logs (inner motors idling at ~8–20k eRPM beside a 200k eRPM neighbour, or bidir-DShot telemetry dropping to 0 during braking/reversal) from latching the session read-only, while still catching a real two-corner desync crash. |
| Analysis — PID | Working: propwash, overshoot, sluggish (with PIDtoolbox-style PID-error × stick-deflection slope as the authority check), I-term, feedforward (setpoint→gyro phase lag / step latency → `f_*`, stands down on overshoot-owned axes), and transfer-function recommendation (BetaflightAssistant-style bandwidth/phase-margin/low-freq-error → P/I/D/FF scales, gated by mean coherence ≥ 0.5); step response, tracking, saturation. PID proposals carry an advisory BF slider-mode equivalent (`sliderHint`, upstream non-expert bounds 0.70–1.40). Note: the Blackbox header carries `d_max_*` but NOT `d_min_*`, so offline analysis reads d_min as `null` — the propwash rule treats `null` as "unknown" (falls back to static D) and only treats a real `0` as "disabled"; `Number(null) === 0` made this easy to get wrong. |
| Analysis — filter | Working: measured attenuation across the 200 Hz+ noise band, residual peaks, D-term LPF, over-filtering, RPM-filter health (harmonics / min_hz / Q from RPM-matched residual peaks), evidence-driven iterm_relax (throttle-chop hunt), plus an explicit "filters are fine" verdict when nothing needs changing. **Every filter step is bounded by `STEP_LIMITS.FILTER_PCT` (≤ 10 %) via `filterOpenStep`/`filterTightenStep`** — the earlier ad-hoc multipliers (`dtermLpf1 * 1.6`, `lpf1 * 0.8/1.3`, `dtermLpf1 * 0.85`, `worst.hz * 0.85`) broke the "filters ≤ 10 %" invariant and the D-term-over-filtering rule jumped `dterm_lpf1_static_hz` 82 → 120 Hz (+46 %), which let enough D-term noise through to desync/crash a quad on the next flight (btfl_003.bbl). One 10 % step per round only. **Notch parameter naming trap:** the Blackbox *header* field is `gyro_notch_hz = "hz1,hz2"` (a pair), but the Betaflight *CLI* parameters are `gyro_notch1_hz`/`gyro_notch1_cutoff` (and `gyro_notch2_*`); emitting `set gyro_notch_hz = …` is rejected by the FC with "INVALID NAME". Header parsing stays on the header name, but every `set`/`get`/whitelist entry must use `gyro_notch1_*` (the D-term notch `dterm_notch_hz`/`dterm_notch_cutoff` is a single notch and is already correct). |
| Analysis — TPA | Working: high-throttle D-term heat (motor saturation + D/gyro ratio) proposes one conservative TPA step from the live `tpa_rate` / `tpa_breakpoint` / `tpa_mode` read-back; advisory-only when the read-back is missing, and it stands the D-term-LPF rule down when it owns the symptom. |
| Analysis — AI agent (optional) | Working: `src/main/analysis/ai-agent.js` serialises the log into a **budget-bounded analysis pack** and sends it to a user-configured OpenAI-compatible `/chat/completions` endpoint, then renders the model's six-part review beside the rule proposals. Three detail levels (`PACK_LEVELS`): **compact** ≤ 9 KB (derived numbers only), **standard** ≤ 120 KB (full blackbox header + every channel statistic + every detected peak + decimated spectra + 12-segment summary + the 15 core channels as time-series envelopes), **full** ≤ 400 KB (all 34 channels, higher resolution). Measured on a real 78.5 s / 157 k-frame log: compact 2 KB, standard 105 KB @ 5.2 Hz, full 316 KB @ 8.6 Hz — every channel present for the entire flight. Each envelope bucket carries `[min, mean, max]` so spikes survive decimation, plus `everySamples` for time alignment; `trimPackToBudget` verifies the serialised size, because blowing the context window is a hard failure. **导出分析包** (`ai:export_pack`) writes pack + prompt to a .txt so any assistant can receive it without this app holding a key. Settings live in `userData/ai-config.json` (mode 0600) and the key is write-only — the renderer only ever learns `hasApiKey`. **Two screens gate every model-proposed diff**: `filterDiff` (names: `FORBIDDEN_PARAMS` + the `isTunableParam` whitelist) and `enforceStepLimits` (magnitudes: the same P/I ≤ 7 %, D ±3, filter ≤ 10 % budget the rules obey, clamped + flagged). AI diffs are never `safeToApply`; the CLI shown is re-derived from the screened diff so a hallucinated or out-of-budget line can never reach the copy button. Requires an API key; the offline rule engine is unaffected and remains the default. |
| Tuning write path | Two-phase dry-run + token, screened diff, then `set` + `save` in one audited batch. **The `save` was missing until this branch** — a tuning write reached RAM only and the UI still reported success, so the change was lost at the next reboot. |
| UI | **3-page nav** (连接 / 分析调参 / 历史报告), 11-slot status bar, six-part conclusion cards, diff-confirm dialogs, one-click rollback. The flow was collapsed from 7 → 3 pages: connecting now **auto-runs the whole read-only pre-flight chain** (`identify → getSettings+backup → bidir probe → bb.readConfig`) the moment the link is up, and the connect page carries the resulting status cards (identity / bidir / blackbox / 2 kHz write / rollback). The redundant per-card buttons (识别飞控 / 读取设置并备份 / 一键准备 / 探测能力) were removed; only a 「重新准备」 re-run and an explicit 「仅重新备份 dump」 remain. The log download lives on the analysis page and offers **下载并分析** (download + metrics in one click). No safety gate changed: the 2 kHz write, the mandatory backup, and the two-phase token flow are all still separate, explicitly confirmed actions. |
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

### 6.1 Capture duration — resolved (2026-10-17)

Decision: **no duration gate**; evidence sufficiency replaces it.
`SAMPLE_TOO_SHORT` is gone. `analysis/evidence.js` checks, per analysis domain,
whether the log holds what that rule needs (clean stick input per axis, throttle
chops, raw-gyro averaging, ≥ 2 s above 70 % throttle before any filter may be
loosened, eRPM, logging rate). Rules whose domain is short stand down and one
`evidence-gap` notice names the guided test flight (cards A–D) to fill it.
`GYRO_ABSENT` remains blocking.

### 6.1a Improvement roadmap (P0–P3 done, P4 open)

Derived from a survey of similar tools (official Betaflight Autotune tab,
PIDtoolbox, PID-Analyzer, bbx-analyzer, ArkanaDigital/pid-tuner, Debrief, FPVtune,
betaflight-mcp). Done on this branch:

- **P0** transfer-function rule never derives filter changes from tracking
  coherence (upstream #5258) and never raises P/FF on a margin-short loop.
- **P1** evidence gate + guided test-flight cards; Wiener-deconvolution step
  response (`stepDeconv`). The isolated-step detector found **0** steps on every
  real log; deconvolution finds 40–240 stick windows per axis.
- **P2** mechanical health: per-motor 1x vibration (prop/shaft) and fixed-vs-moving
  resonance classification. Static notches are no longer proposed for peaks that
  move with RPM (btfl_002/btfl_all were getting 475/485 Hz notches for a motor
  peak sweeping 289→375→473 Hz).
- **P3** stage plan (logging → mechanical → filters → P/D → feel), racing
  scorecard, per-quad journal (History page).

Open:

- **Step rules still read isolated steps only.** `stepDeconv` includes
  feedforward (btfl_002, FF 120: 41–72 % "overshoot" at 2 ms delay), so it is
  evidence + display + AI pack only. Calibrating overshoot/sluggish/I rules
  against it needs flights with FF temporarily at 0 (PIDtoolbox method) and a
  before/after on real hardware.
- **P4 (undecided):** learned-plant PID simulator to predict a change before
  flying it.
- `filter-iterm-relax` (configuration-only) moves `iterm_relax_cutoff` 15 → 30 in
  one step on btfl_001; iterm_relax is not a noise filter so the 10 % filter
  budget does not apply, but the step is large — review.

### 6.2 Not implemented

1. **MSC is a manual choice.** There is no automatic size-based routing between
   MSP download and MSC mounting.
2. **SD-card logs cannot be erased or downloaded over MSP** — MSC only. This is
   a firmware limitation, and the UI says so.
3. No notarization or Developer ID; ad-hoc signing only, so every distribution
   needs the quarantine step in §3.

The standalone TPA rule, the standalone evidence-driven `iterm_relax` rule
(previously items here), the feedforward (F) rule and the RPM-filter health
rule are implemented on this branch — see `ruleFeedforward`,
`ruleItermRelaxEvidence` and `ruleRpmHealth` in `ai-tune.js`.

---

## 7. Repository conventions

- `.gitignore` covers `node_modules/`, `dist/`, `*.dmg`, `captures/`, `*.bbl`
  (plus `.bfl`, `.bbl.gz`) and more. **Never commit build output or logs.**
- Adding an IPC channel is a three-file change in a fixed order: `CH` in
  `src/shared/contracts.js` → mirror in `src/main/preload.cjs` → handler in
  `src/main/tools/registry.js`. A contract-drift test fails the suite otherwise.
- Keep `npm test` green (currently 304/304); add a regression test with every fix.
- The renderer has no in-repo test harness. Verify it by driving the packaged
  app over the DevTools Protocol, or with a throwaway DOM stub.
