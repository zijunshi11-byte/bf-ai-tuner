# Building BF AI Tuner for macOS (Apple Silicon)

Operator guide for producing and installing the macOS build of **BF AI Tuner** —
a Betaflight tuning assistant for 5-inch racing quads that talks to the flight
controller over USB CDC serial, decodes Blackbox `.bbl` logs and runs FFT
analysis.

This configuration targets **macOS on Apple Silicon (arm64) only**. There is no
Windows or Linux target.

---

## 1. Prerequisites

| Requirement | Why | Check |
| --- | --- | --- |
| macOS 11 "Big Sur" or newer | First macOS release that runs arm64 natively; also `mac.minimumSystemVersion` | `sw_vers` |
| Apple Silicon Mac | Primary target. Intel works only via the `--universal` build | `uname -m` → `arm64` |
| Node.js 20+ | `engines.node` in `package.json` | `node -v` |
| Xcode Command Line Tools | Compiles the `serialport` native addon against Electron's ABI | `xcode-select -p` |
| Python 3 | Required by `node-gyp` for the native rebuild (ships with the CLT) | `python3 -V` |
| ~2 GB free disk | Electron + two Electron binaries for a universal build | — |

Install the CLT if `xcode-select -p` errors:

```bash
xcode-select --install
```

A paid Apple Developer account is **not** required. Without one the build is
simply unsigned — see §5.

---

## 2. Install dependencies

```bash
cd bf-ai-tuner
npm install
```

`npm install` triggers the `postinstall` script
(`electron-builder install-app-deps`), which rebuilds every native dependency
against **Electron's** ABI rather than your system Node's.

The only runtime dependency is `serialport` (^12). `package.json` deliberately
declares no `electron-store` or similar — configuration is handled in-app.

> Skipping `postinstall` is the single most common cause of the
> `NODE_MODULE_VERSION` mismatch in §8.

---

## 3. Build

**Use the wrapper.** `build:mac` assembles the bundle outside the project tree
and publishes the DMG into `dist/`. On this project that is required, not a
convenience - see "Build outside iCloud Drive" below.

```bash
npm run build:mac             # RECOMMENDED: out-of-tree build, dmg into dist/
```

The raw electron-builder invocations still exist and are what the wrapper calls:

```bash
npx electron-builder --mac --arm64          # Apple Silicon
npx electron-builder --mac --universal      # fat binary: arm64 + x86_64
npx electron-builder --mac --arm64 --dir    # unpacked .app only, fastest check
```

These map to `electron-builder --mac --arm64`, `--mac --universal` and
`--mac --arm64 --dir`. The CPU architecture is selected **on the command line**;
`package.json (the `build` field)` only lists the target *types* (`dmg`, `zip`) so that the
CLI flag always wins.

Useful extras:

```bash
npm run lint:syntax   # node --check over every .js/.cjs/.mjs in src/ and scripts/
npm test              # Node's built-in runner, auto-discovers test/
```

> `npm test` runs a bare `node --test` rather than `node --test test/`. On
> Node 22+ a positional path is treated as a literal file/glob argument, so
> `node --test test/` fails with `pass 0 / fail 1` even when tests exist. Bare
> `node --test` auto-discovers the same files on Node 20 through 26, and exits
> 0 cleanly when `test/` is still empty.

### Build outside iCloud Drive (important)

If this project sits in `~/Documents` or `~/Desktop` **and** iCloud Drive's
"Desktop & Documents Folders" is on, codesigning the bundle fails:

```
resource fork, Finder information, or similar detritus not allowed
```

The FileProvider daemon stamps `com.apple.FinderInfo` onto every `.app` and
`.framework` directory and re-adds it within about a second of removal, and
`codesign` refuses to sign a bundle while that attribute is present. The build
still "completes" and still produces a `.dmg` - it just produces one whose app is
unsigned and therefore **dies at launch on Apple Silicon**.

`scripts/build-mac.sh` assembles the bundle in `$TMPDIR` and copies only the
finished `.dmg` back into `dist/`; a `.dmg` is a single file, so nothing inside
it can be re-stamped. Override the staging path with `BF_BUILD_DIR`.

Do not copy the built `.app` back into an iCloud-synced folder either: the
re-added attribute makes `codesign --verify` fail on the copy even though the
original is fine.

### Signing during the build

`package.json` sets `"identity": "-"`, but electron-builder 25 interprets that as
a certificate *name* and reports:

```
skipped macOS application code signing  reason=Identity name is specified, but no valid identity with this name in the keychain
```

That is expected, not an error. `scripts/afterSign.cjs` then applies an
**ad-hoc** signature itself, which is what makes a certificate-free build
runnable on Apple Silicon. A good build logs:

```
[afterSign] ad-hoc signature verified: identifier=com.bf.aituner signature=adhoc flags=0x10002(adhoc,runtime)
```

If you later add a real Developer ID, electron-builder signs normally and the
hook detects the valid signature and leaves the bundle untouched.

---

## 4. What lands in `dist/`

| Path | What it is |
| --- | --- |
| `dist/BF-AITuner-0.1.0-arm64.dmg` | Drag-to-Applications installer — the artifact you hand out |
| `dist/BF-AITuner-0.1.0-arm64.dmg.blockmap` | Delta-update map (unused unless you add auto-update) |
| `dist/BF-AITuner-0.1.0-arm64.zip` | Zipped `.app`, for `scp`/AirDrop/CI transfer |
| `dist/mac-arm64/BF-AITuner.app` | The raw bundle (`--dir` stops here) |
| `dist/mac-universal/BF-AITuner.app` | Fat bundle from `build:mac:universal` |
| `dist/builder-effective-config.yaml` | The fully resolved config electron-builder actually used |
| `dist/builder-debug.yml` | Debug log of the build |

`productName` is **BF AI Tuner** (with spaces), so the bundle is
`BF-AITuner.app` even though the file names use the slug `bf-ai-tuner`.

### Verify the native binding was unpacked

This is the check that catches the most common packaging failure:

```bash
ls "dist/mac-arm64/BF-AITuner.app/Contents/Resources/app.asar.unpacked/node_modules/@serialport/bindings-cpp/"
```

You should see `prebuilds/` (and/or `build/`). If `app.asar.unpacked` is missing
or empty, `asarUnpack` in `package.json (the `build` field)` did not match and the app will
crash on the first serial connection.

Only a small allow-list ships inside the app: `src/**/*`, `vendor/**/*` and
`package.json`. Runtime `node_modules` (just `serialport`) are added
automatically from the production dependency graph. Note that
`vendor/betaflight/LICENSE` is intentionally included — that code is GPL-3.0.

---

## 5. The unsigned-app problem

### What happens

The `.app` is ad-hoc/unsigned and not notarized. Any copy that arrives over a
quarantining transport (browser download, AirDrop, Mail, Slack, `scp` from an
untrusted host) gets the extended attribute `com.apple.quarantine`. Gatekeeper
then evaluates it, finds no Developer ID signature and no notarization ticket,
and refuses to launch — with the misleading message:

> **"BF-AITuner" is damaged and can't be opened. You should move it to the Bin.**

The app is not damaged. That is just how macOS words "unsigned and quarantined".

### The fix

On the machine where the app was installed:

```bash
# Default target: /Applications/BF-AITuner.app
npm run dequarantine

# or explicitly
bash scripts/dequarantine.sh "/Applications/BF-AITuner.app"

# preview without changing anything
bash scripts/dequarantine.sh --dry-run
```

The equivalent one-liner:

```bash
xattr -dr com.apple.quarantine "/Applications/BF-AITuner.app"
```

Confirm it worked:

```bash
xattr -r -l "/Applications/BF-AITuner.app" | grep quarantine   # expect no output
spctl -a -vv "/Applications/BF-AITuner.app"                    # see note below
```

`spctl` reporting **rejected** (`source=no usable signature`) is *normal* for an
unsigned build — it is informational, and it is precisely why the attribute had
to be removed by hand. On a machine where Gatekeeper assessment has already been
switched off system-wide, `spctl` instead prints `accepted` with
`override=security disabled`; both outcomes are expected here, and neither
changes the fact that the build is unsigned. `codesign -dv` will report
`code object is not signed at all` either way.

`afterSign.cjs` already runs `xattr -cr` on the bundle at the end of the build,
so a build you launch directly from `dist/` is usually fine. The problem
reappears the moment the app crosses a machine boundary.

### The supported GUI route

1. Double-click the app once and let it fail.
2. **System Settings → Privacy & Security**, scroll to **Security**.
3. An entry for *BF AI Tuner* appears with an **Open Anyway** button. Click it,
   authenticate, then confirm in the follow-up dialog.

(On macOS 13/14 this is the only supported per-app approval path. The old
right-click → **Open** trick also still works.)

### Why not `sudo spctl --master-disable`

It is the most copy-pasted advice on the internet and it is a bad idea. It
disables Gatekeeper for **every** application on the machine, permanently, and
removes the protection that stops genuinely malicious unsigned software. The
`xattr` approach above is scoped to exactly one app you built yourself.

> Only strip quarantine from apps you actually trust. The attribute exists
> because "unsigned binary from the internet" is genuinely risky.

---

## 6. Serial ports on macOS

### `cu.*` vs `tty.*` — use `cu.*`

macOS creates two device nodes per serial port:

| Node | Meaning | Use for |
| --- | --- | --- |
| `/dev/tty.usbmodem14101` | **Incoming** ("teletype") connection. Opening it waits for DCD (Data Carrier Detect) to be asserted, and blocks or fails if the line is not already up. | Dial-in modems, `getty` |
| `/dev/cu.usbmodem14101` | **Outgoing** ("call unit") connection. Never waits for DCD. | **Everything here** |

A flight controller never asserts DCD, so opening the `tty.*` node is a classic
source of "the port opens but nothing ever happens" / hangs. **Always open
`/dev/cu.usbmodem*`.** The UI should prefer `cu.*` when both nodes exist for the
same device, and `SerialPort.list()` on macOS returns both.

List what is actually attached:

```bash
ls -l /dev/cu.*
```

Devices on this machine are created `crw-rw-rw- root:wheel`, so any logged-in
user can open them. There is **no `dialout` group on macOS**, no `udev` rules to
write, and no `sudo` needed — that advice is Linux-specific.

### Drivers on Apple Silicon

| Chip / device | Appears as | Driver situation on Apple Silicon |
| --- | --- | --- |
| **STM32 USB CDC / VCP** (what Betaflight FCs present) | `/dev/cu.usbmodem*` | **Nothing to install.** Class-compliant USB CDC-ACM; macOS binds its built-in `AppleUSBACMData` driver. The STM32 DFU bootloader is class-compliant too, so firmware mode needs no vendor kext either. |
| Silicon Labs **CP210x** | `/dev/cu.SLAB_USBtoUART*` | Many parts are covered by a built-in macOS driver. If it does not enumerate, install Silicon Labs' macOS VCP driver — it must be the Apple Silicon/universal build. |
| **FTDI FT232** | `/dev/cu.usbserial-*` | Covered by Apple's built-in `AppleUSBFTDI` since 10.9. Do **not** install the FTDI VCP kext on top; it conflicts with the built-in driver. |
| **WCH CH340/CH341** | `/dev/cu.wchusbserial*`, `/dev/cu.usbserial-*` | No built-in support. Install the WCH CH34x driver, **Apple Silicon build**. Old Intel-only CH34x kexts will not load on arm64. |

Two Apple Silicon gotchas:

* Third-party drivers are **kernel extensions**. Loading one requires rebooting
  into recoveryOS and lowering **Startup Security** to "Reduced Security"
  (plus user consent in Privacy & Security). Prefer class-compliant devices —
  a genuine Betaflight FC needs none of this.
* `/dev/cu.Bluetooth-Incoming-Port` and `/dev/cu.debug-console` always exist on
  every Mac. They are not your flight controller; filter the port list to
  `usbmodem`/`SLAB`/`usbserial` families.

Finally, the boring causes first: use a **data-capable** USB-C cable (many are
charge-only), plug directly rather than through a hub, and make sure the flight
controller is powered (USB alone usually is enough; a LiPo guarantees it). If
macOS shows a USB accessory permission prompt, allow it.

---

## 7. Signing: what you have now, and what changes with a certificate

### Today — ad-hoc signed, not notarized

`package.json` sets `hardenedRuntime: true`, `gatekeeperAssess: false`,
`notarize: false` and `identity: "-"`.

electron-builder skips signing (there is no certificate), and
`scripts/afterSign.cjs` then applies an **ad-hoc** signature. On Apple Silicon
this is mandatory, not cosmetic: every Mach-O must carry at least an ad-hoc
signature, and electron-builder rewrites the bundle (renaming `Electron.app`,
adding `app.asar`), which invalidates the signature Electron shipped with.
Without the ad-hoc pass the app aborts at launch with:

```
mapping process and mapped file (non-platform) have different Team IDs
```

Two details make or break that signature, and both are handled in the hook:

- **Entitlements must be supplied through `optionsForFile`.** Passing the
  top-level `entitlements` option to `@electron/osx-sign` lets it substitute its
  own default entitlement set for each binary, silently dropping
  `com.apple.security.cs.disable-library-validation` - the one entitlement that
  lets an ad-hoc-signed main binary load the Electron Framework.
- **`timestamp` must be `'none'`.** It is a *string* option, so `timestamp: false`
  is ignored and `--timestamp` is still passed; ad-hoc signatures cannot be
  timestamped and signing fails.

An ad-hoc signature still does **not** satisfy Gatekeeper. It makes the app
runnable on the machine that built it; handing it to anyone else still requires a
Developer ID and notarization.

### Later — Developer ID + notarization

With an Apple Developer Program membership, nothing in the project structure has
to change:

```bash
export CSC_LINK="/path/to/DeveloperIDApplication.p12"   # or base64 of it
export CSC_KEY_PASSWORD="the-p12-password"
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"  # app-specific password
export APPLE_TEAM_ID="ABCDE12345"
```

Then flip one line in `package.json (the `build` field)`:

```yaml
notarize: true      # was: false
```

`hardenedRuntime: true` and both entitlements files are already correct for
notarization, so `npm run build:mac:arm64` now signs, notarizes and staples
automatically. Verify with:

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/BF-AITuner.app"
spctl -a -vv "dist/mac-arm64/BF-AITuner.app"   # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "dist/mac-arm64/BF-AITuner.app"
```

Notes:

* Notarization **rejects** binaries carrying `com.apple.security.get-task-allow`.
  Neither entitlements file includes it — keep it that way for release builds.
* `com.apple.security.cs.disable-library-validation` *is* accepted by the
  notary service, and is required here so the unpacked `serialport` binding can
  be loaded.
* Once the app is properly signed and notarized, §5 stops applying: ship the DMG
  and users just open it.

### Manual notarization (if you prefer to drive it yourself)

```bash
xcrun notarytool submit "dist/BF-AITuner-0.1.0-arm64.dmg" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --wait
xcrun stapler staple "dist/BF-AITuner-0.1.0-arm64.dmg"
```

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| *"BF-AITuner" is damaged and can't be opened* | `com.apple.quarantine` on an unsigned build | `bash scripts/dequarantine.sh` → §5, or **Open Anyway** |
| *"…cannot be opened because the developer cannot be verified"* | Same root cause, different macOS wording | Same fix |
| Double-click does nothing, no dialog at all | Gatekeeper silent block, or launching the wrong architecture | Run the binary directly to see stderr: `"…/BF-AITuner.app/Contents/MacOS/BF AI Tuner"`. Check `lipo -archs` shows `arm64`. Use `build:mac:universal` for Intel Macs |
| App opens, but the port list is empty | Cable/hub, unpowered FC, or a CH340 without a driver | `ls /dev/cu.*`, swap for a data cable, plug in directly, install the vendor driver (§6) |
| Port opens but the FC never answers | Opened `/dev/tty.usbmodem*` (blocks on DCD), or picked `Bluetooth-Incoming-Port` | Use `/dev/cu.usbmodem*`; filter out non-USB ports |
| `The module '…/bindings-cpp.node' was compiled against a different Node.js version` (`NODE_MODULE_VERSION` mismatch) | Native addon built for system Node, not Electron | `npm run postinstall`, then rebuild. Confirm with `npx electron -v` vs `node -v` |
| `Cannot find module '…/app.asar/node_modules/@serialport/bindings-cpp/…node'` or a `dlopen` failure | `asarUnpack` missing or not matching, so the `.node` file is trapped inside the asar | Confirm `asarUnpack: node_modules/@serialport/bindings-cpp/**` and that `app.asar.unpacked/…` exists (§4) |
| `code signature invalid` / `not valid for use in process` when the serial binding loads | Hardened runtime library validation rejecting the unpacked native addon | Ensure `com.apple.security.cs.disable-library-validation` is in **both** entitlements plists |
| Helper/renderer process dies instantly on launch under the hardened runtime | Child processes missing a parent entitlement | Both plists must list the *same* keys; `entitlementsInherit` is applied to helpers |
| Blank white window in the packaged app | Renderer HTML did not make it into the asar | Check `files` includes `src/renderer/**`; confirm `src/renderer/index.html` exists |
| `Cannot find module 'electron'` during build | `npm install` incomplete (Electron's own postinstall was skipped) | Re-run `npm install` |
| `xattr: [Errno 1] Operation not permitted` | Path is SIP-protected, or you pointed at the wrong bundle | Verify the path exists and is writable; reinstall to `/Applications` |
| `Cannot find module '…/app.asar/node_modules/serialport/dist/index.js'` — the app starts but **never sees a serial port** | A `files` negation matched *inside* `node_modules`. `"!**/{dist,out}/**"` deletes `node_modules/serialport/dist/`, which is that package's `main`. `files` is already an allow-list, so root-level `dist/` can never be included and the negation is both unnecessary and destructive | Keep negations out of `node_modules`: use `"!dist/**"` (root-anchored) or drop them. Verify with: `node -e "const a=require('@electron/asar');console.log(a.listPackage('…/app.asar').filter(f=>f.includes('serialport/dist')))"` |
| **The window cannot be moved by dragging** | `titleBarStyle: 'hiddenInset'` removes the system title bar, and with it the OS drag anchor. The window is then movable *only* through a CSS drag region | `.appbar` must carry `-webkit-app-region: drag` + `user-select: none`, with `-webkit-app-region: no-drag` on every interactive descendant. Confirm in the running app via CDP: `getComputedStyle(document.querySelector('.appbar')).webkitAppRegion === 'drag'` |
| *"Does the app need the App Sandbox disabled?"* | electron-builder 25 has **no `sandbox` key** under `mac` or `mas` (it is a hard schema error). For a non-MAS build the sandbox is controlled purely by the `com.apple.security.app-sandbox` entitlement | Do not set it. Omit `app-sandbox` from both plists — which this project does — and the process is unsandboxed, so `/dev/cu.*` is directly reachable. Verify: `codesign -d --entitlements - /Applications/BF-AITuner.app` |
| Port list empty on a **brand-new install** even with the FC plugged in | macOS has no consent record for an unsigned app and raises no prompt on its own | The app shows a first-run notice pointing at **System Settings > Privacy & Security > Full Disk Access**; add the app with **+**, then fully quit and relaunch |

| **App connects but every request fails**: log shows *"CLI probe did not answer"* then *"cannot send MSP 1 while in CLI mode"* | The host entered the flight controller's **interactive** CLI (by writing a bare `#`) and then spoke the **framed** CLI protocol. Firmware `src/main/msp/msp_serial.c` has two distinct CLI paths: `#` (0x23) → `cliEnter(port, interactive=TRUE)`, which prints a prompt and never emits STX/ETX framing; `0x02` (STX) → `cliEnter(port, interactive=FALSE)`, which runs one framed command, replies inside STX/ETX and then calls `cliExit(false)` — returning to MSP by itself | Never open a persistent CLI session. Send **one framed command per operation** (`STX + cmd + LF + ETX`) and let the firmware enter and leave CLI on its own. Serialise MSP and CLI on one chain so they never interleave. Regression-tested in `test/integration.test.js` ("identification survives a flight controller stuck in interactive CLI") |
| Log shows *"链路异常 … 自动恢复"* / *"关闭并重新打开串口"* | The MSP client's self-healing state machine detected a timeout or a dead port | Expected behaviour. It writes an unframed `\r\nexit\r\n`, probes with `MSP_API_VERSION`, and only if that fails does it close the port, wait 2 s and reopen. Tune with `reopenDelayMs` / `probeTimeoutMs` on `MspClient` |
| Status bar renders the literal text `nullnullnull` | `Element.replaceChildren(...)` converts `null` arguments into text nodes | Filter falsy values before calling `replaceChildren` |

| App lists the port but connect fails with *"Resource busy, cannot open /dev/cu.usbmodem\*"* | **Chrome/Edge's Web Serial API grabbed the USB CDC device.** It opens the port at the USB level, so BOTH `/dev/cu.*` and `/dev/tty.*` refuse to open, and the browser keeps reading the telemetry stream | Close the offending browser tab (or the whole browser). Check who holds it: `lsof /dev/cu.usbmodem*`. The app's connect error now names this cause explicitly |
| Bidirectional DShot/RPM page shows *"仅 USB 供电，未做动力验证"* | Battery voltage read over MSP is < 3.0 V - the FC runs from USB alone, so the ESCs have no power and cannot answer telemetry | Connect a LiPo, hand-spin a motor (back-EMF makes DShot telemetry answer without arming), then press the verify button again |

| Build warns *"default Electron icon is used"* | No icon in `build/` | Drop a 1024×1024 `build/icon.icns` in — electron-builder picks it up automatically (do not set `mac.icon` until the file exists, or the build fails) |

---

## 9. Where to change what

| File | Responsibility |
| --- | --- |
| `package.json` | Scripts, deps, `main`, `engines`. `"build": { "extends": null }` keeps electron-builder from inheriting any base config |
| `package.json (the `build` field)` | **All** build config: targets, `files` allow-list, `asarUnpack`, entitlements, DMG layout |
| `build/entitlements.mac.plist` | Entitlements for the main executable |
| `build/entitlements.mac.inherit.plist` | Same key set, for helpers/child processes |
| `scripts/afterSign.cjs` | `afterSign` hook: strips quarantine, warns about the unsigned build, never throws |
| `scripts/dequarantine.sh` | Repairs an installed copy on the target machine |
| `docs/BUILD-macOS.md` | This document |

The `afterSign` hook deliberately swallows all errors: a signing or `xattr`
hiccup must never fail an otherwise good build. If something goes wrong there,
it prints an `[afterSign] WARNING:` line and the build continues.
