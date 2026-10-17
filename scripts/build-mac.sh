#!/usr/bin/env bash
#
# build-mac.sh - reproducible Apple Silicon build for BF-AITuner.
#
# Why this wrapper exists instead of a bare `npx electron-builder`:
#
#   macOS Extended Attributes vs. codesign
#   --------------------------------------
#   When this project lives under ~/Documents or ~/Desktop with iCloud Drive
#   ("Desktop & Documents Folders") enabled, the FileProvider daemon stamps
#   com.apple.FinderInfo onto every .app and .framework directory and re-adds it
#   within about a second of any attempt to remove it.
#
#   codesign refuses to sign a bundle while that attribute is present:
#       "resource fork, Finder information, or similar detritus not allowed"
#
#   The result is a build that completes, produces a .dmg, and then dies at
#   launch on Apple Silicon with a Team ID error, because the bundle never got
#   the mandatory ad-hoc signature.
#
#   So the bundle is assembled OUTSIDE the synced tree and only the finished
#   .dmg is copied back in. A .dmg is a single file, so FileProvider cannot
#   corrupt what is inside it.
#
# Usage:
#   bash scripts/build-mac.sh                 # arm64 dmg
#   BF_BUILD_DIR=/some/path bash scripts/build-mac.sh
#
# SPDX-License-Identifier: GPL-3.0-or-later

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# Out-of-tree staging area. Override with BF_BUILD_DIR if you prefer.
STAGING="${BF_BUILD_DIR:-${TMPDIR:-/tmp}/bf-ai-tuner-dist}"
STAGING="${STAGING%/}"

# Electron refuses to behave like Electron when this is set; some CI sandboxes
# export it. Harmless here, but defensive.
unset ELECTRON_RUN_AS_NODE

# Mirrors, so the Electron binary download does not crawl on CN networks.
# Override by exporting these yourself if you are not behind one.
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

step "Preflight"
say "project : $PROJECT_ROOT"
say "staging : $STAGING"

command -v node >/dev/null 2>&1 || die "node is not on PATH"
[ -d node_modules ] || die "node_modules is missing - run 'npm install' first"
[ -x node_modules/.bin/electron-builder ] || die "electron-builder is not installed locally - run 'npm install --save-dev electron-builder'"

if [ ! -x node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]; then
  die "Electron binary is missing. Run: npm rebuild electron
     (note: @electron/get's extractor is broken on Node 26 - if the binary is
      still absent afterwards, extract node_modules/electron/dist manually with
      'ditto -x -k <cached zip>' and write node_modules/electron/path.txt)"
fi

ELECTRON_VERSION="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || echo '?')"
BUILDER_VERSION="$(node -p "require('./node_modules/electron-builder/package.json').version" 2>/dev/null || echo '?')"
say "electron: v$ELECTRON_VERSION (local)"
say "builder : v$BUILDER_VERSION (local)"

# Warn, but do not fail: an out-of-tree build works either way.
case "$PROJECT_ROOT" in
  *"/Documents/"*|*"/Desktop/"*)
    say "note    : project is inside a possibly iCloud-synced folder;"
    say "          building out-of-tree is required, not optional. See header."
    ;;
esac

step "Releasing any stale installer volume"
# electron-builder mounts the dmg it just built under /Volumes to apply the
# window layout, then detaches it by volume name. If a volume with that same
# name is already mounted - typically because the operator is running the app
# straight out of the previous .dmg - its detach lands on the wrong volume and
# the build dies after six retries with a bare
# "hdiutil: couldn't unmount ... resource busy". Clear the name first, and when
# it is genuinely in use, say who is using it instead of retrying blindly.
DMG_TITLE="$(
  node -p 'const p=require("./package.json");const d=(p.build&&p.build.dmg)||{};String(d.title||p.productName+" ${version}").replace("${version}",p.version)'
)"
DMG_VOLUME="/Volumes/$DMG_TITLE"
if mount | grep -Fq "on ${DMG_VOLUME} "; then
  say "found a mounted installer volume: $DMG_VOLUME"
  if DETACH_OUT="$(hdiutil detach "$DMG_VOLUME" 2>&1)"; then
    say "detached it - electron-builder needs the volume name free"
  else
    say "hdiutil said: ${DETACH_OUT:-<no output>}"
    say "whoever holds it open must stop first - usually BF-AITuner itself,"
    say "launched straight out of the .dmg. Check with:"
    say "  lsof +c 0 \"$DMG_VOLUME\""
    die "installer volume $DMG_VOLUME is still mounted"
  fi
else
  say "none mounted"
fi

step "Cleaning previous output"
rm -rf "$STAGING"
mkdir -p "$STAGING"
say "removed $STAGING"

step "Building (electron-builder --mac --arm64)"
npx electron-builder --mac --arm64 --config.directories.output="$STAGING"

DMG="$STAGING/BF-AITuner-$(node -p "require('./package.json').version")-arm64.dmg"
[ -f "$DMG" ] || die "expected artifact not found: $DMG"

step "Verifying the signature of the app inside the staging build"
APP="$STAGING/mac-arm64/BF-AITuner.app"
[ -d "$APP" ] || die "expected app bundle not found: $APP"

if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  say "codesign --verify --deep --strict : VALID"
  codesign -dv --verbose=2 "$APP" 2>&1 | grep -E 'Identifier=|Signature=|flags=' | sed 's/^/  /' || true
else
  say "WARNING: the app bundle is NOT validly signed."
  say "         It will fail to launch on Apple Silicon. Build outside iCloud."
fi

step "Publishing the dmg into the project dist/"
mkdir -p dist
cp "$DMG" dist/
[ -f "$DMG.blockmap" ] && cp "$DMG.blockmap" dist/ || true
say "dist/$(basename "$DMG")"

step "Done"
say "install :  open \"dist/$(basename "$DMG")\"   # drag BF-AITuner into /Applications"
say "run     :  open \"/Applications/BF-AITuner.app\""
say "first-launch de-quarantine (unsigned build):"
say "           sudo xattr -r -d com.apple.quarantine /Applications/BF-AITuner.app"
