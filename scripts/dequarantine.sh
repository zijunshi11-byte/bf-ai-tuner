#!/usr/bin/env bash
#
# dequarantine.sh - make an unsigned "BF-AITuner.app" launchable on macOS.
#
# WHY THIS EXISTS
# ---------------
# `npm run build:mac:arm64` produces an app that is NOT signed with a Developer
# ID and NOT notarized (mac.notarize is false), because
# that is what you get without a paid Apple Developer account.
#
# macOS marks every file that arrives from the internet (Safari/Chrome download,
# AirDrop, Slack, email, `scp` from an untrusted source...) with the extended
# attribute `com.apple.quarantine`. When Gatekeeper then evaluates a quarantined
# app it finds no valid Developer ID signature and no notarization ticket, so it
# refuses to launch it. The wording it chooses is the infamous:
#
#     "BF-AITuner" is damaged and can't be opened. You should move it to the Bin.
#
# The app is not damaged. That message is simply how macOS reports "ad-hoc /
# unsigned + quarantined". Removing the quarantine attribute is the standard,
# targeted fix for software you built yourself or otherwise trust.
#
# WHAT THIS SCRIPT DOES
# ---------------------
#   1. Resolves and validates the target .app (absolute path, exists, *.app).
#   2. Removes com.apple.quarantine recursively.
#   3. Falls back to `xattr -cr` (clear every attribute) if the targeted delete
#      reports an error.
#   4. Prints the remaining attributes and the real `spctl` verdict, so you can
#      see exactly what Gatekeeper thinks rather than guessing.
#
# USAGE
# -----
#   bash scripts/dequarantine.sh                        # /Applications/BF-AITuner.app
#   bash scripts/dequarantine.sh ~/Applications/Foo.app # explicit path
#   bash scripts/dequarantine.sh --dry-run              # print commands only
#   npm run dequarantine                                # same as the first form
#
# This script only ever touches the path you give it. It never modifies system
# security policy - see the troubleshooting notes at the bottom for why
# `spctl --master-disable` is a bad idea.

set -euo pipefail

readonly DEFAULT_TARGET="/Applications/BF-AITuner.app"
readonly QUARANTINE_ATTR="com.apple.quarantine"

DRY_RUN=0
TARGET=""

# --------------------------------------------------------------------------
# output helpers
# --------------------------------------------------------------------------
say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
dequarantine.sh - clear com.apple.quarantine from an unsigned BF-AITuner.app

Usage:
  bash scripts/dequarantine.sh [options] [path/to/App.app]

Options:
  -n, --dry-run   Print the commands that would run, execute nothing.
  -h, --help      Show this help.

Default target:
  /Applications/BF-AITuner.app

Examples:
  bash scripts/dequarantine.sh
  bash scripts/dequarantine.sh "$HOME/Applications/BF-AITuner.app"
  bash scripts/dequarantine.sh --dry-run
EOF
}

# --------------------------------------------------------------------------
# argument parsing
# --------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n | --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      if [ "$#" -gt 0 ]; then
        if [ -n "$TARGET" ]; then
          die "more than one path given ('$TARGET' and '$1')"
        fi
        TARGET="$1"
        shift
      fi
      break
      ;;
    -*)
      die "unknown option: $1 (try --help)"
      ;;
    *)
      if [ -n "$TARGET" ]; then
        die "more than one path given ('$TARGET' and '$1')"
      fi
      TARGET="$1"
      ;;
  esac
  shift
done

if [ -z "$TARGET" ]; then
  TARGET="$DEFAULT_TARGET"
fi

# --------------------------------------------------------------------------
# validation - ALL of this happens before a single destructive command
# --------------------------------------------------------------------------

# Make the path absolute so the checks (and the user-facing output) are
# unambiguous. Deliberately not using `realpath`, which fails on missing paths
# and would replace our clear error message with a cryptic one.
case "$TARGET" in
  /*) ;;
  *) TARGET="$PWD/$TARGET" ;;
esac

# Never operate on the filesystem root, whatever the arguments said.
if [ "$TARGET" = "/" ]; then
  die "refusing to operate on '/' - pass the path of the .app bundle"
fi

# The path must end in .app. This is the main safety rail: it makes it very hard
# to accidentally point a recursive attribute wipe at, say, a home directory.
case "$TARGET" in
  *.app) ;;
  *) die "refusing to run: '$TARGET' does not end in .app" ;;
esac

if [ ! -e "$TARGET" ]; then
  die "'$TARGET' does not exist.
       Build and install the app first, then re-run this script.
       Expected default location: $DEFAULT_TARGET"
fi

if [ ! -d "$TARGET" ]; then
  die "'$TARGET' exists but is not a directory (.app bundles are directories)"
fi

say "target   : $TARGET"
if [ "$DRY_RUN" -eq 1 ]; then
  say "mode     : DRY RUN (nothing will be changed)"
else
  say "mode     : live"
fi

# Soft warning only: rewriting attributes of a running app is allowed, but the
# running process keeps the old state until it is relaunched.
if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  warn "the app appears to be running - quit it and relaunch after this script finishes"
fi

# --------------------------------------------------------------------------
# 1. remove the quarantine attribute
# --------------------------------------------------------------------------
step "Removing ${QUARANTINE_ATTR}"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '    [dry-run] xattr -dr %s %q\n' "$QUARANTINE_ATTR" "$TARGET"
  printf '    [dry-run] xattr -cr %q    # fallback: clears every attribute\n' "$TARGET"
else
  # -d delete, -r recursive. Exits 0 even when the attribute was not present,
  # so a non-zero exit here means something real went wrong.
  if xattr -dr "$QUARANTINE_ATTR" "$TARGET" 2>/dev/null; then
    say "    xattr -dr ${QUARANTINE_ATTR}: ok"
  else
    warn "xattr -dr ${QUARANTINE_ATTR} failed; falling back to xattr -cr (all attributes)"
    if xattr -cr "$TARGET" 2>/dev/null; then
      say "    xattr -cr: ok"
    else
      warn "xattr -cr also failed - the app will very likely still be blocked"
      warn "check ownership/permissions: ls -ld \"$TARGET\""
    fi
  fi
fi

# --------------------------------------------------------------------------
# 2. verification - show the real state, do not assume success
# --------------------------------------------------------------------------
step "Verification"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '    [dry-run] xattr -r -l %q | grep -c %s\n' "$TARGET" "$QUARANTINE_ATTR"
  printf '    [dry-run] spctl -a -vv %q\n' "$TARGET"
  say ""
  say "Dry run complete - nothing was modified."
  exit 0
fi

# Remaining quarantine attributes. `grep -c` prints 0 and exits non-zero when
# there is no match, hence the `|| true`.
remaining="$(xattr -r -l "$TARGET" 2>/dev/null | grep -c "$QUARANTINE_ATTR" || true)"
remaining="${remaining:-0}"

if [ "$remaining" -eq 0 ]; then
  say "    no ${QUARANTINE_ATTR} attributes remain."
else
  warn "$remaining file(s) still carry ${QUARANTINE_ATTR}"
fi

# The real Gatekeeper verdict. For an unsigned build expect:
#   "<path>: rejected"  (source=no usable signature)
# That is normal and expected here - it is the reason the quarantine attribute
# had to be removed by hand in the first place.
if command -v spctl >/dev/null 2>&1; then
  say "    \$ spctl -a -vv \"$TARGET\""
  spctl -a -vv "$TARGET" 2>&1 | sed 's/^/    /' || true
else
  warn "spctl not found; skipping Gatekeeper assessment"
fi

# Signature state, for completeness: unsigned builds report
# "code object is not signed at all".
if command -v codesign >/dev/null 2>&1; then
  say "    \$ codesign -dv --verbose=2 \"$TARGET\""
  codesign -dv --verbose=2 "$TARGET" 2>&1 | sed 's/^/    /' || true
fi

if [ "$remaining" -eq 0 ]; then
  step "Done"
  say "Launch it with:  open \"$TARGET\""
else
  step "Incomplete"
  say "Some files are still quarantined. Re-run, or check the troubleshooting"
  say "block below."
fi

# --------------------------------------------------------------------------
# troubleshooting
# --------------------------------------------------------------------------
cat <<'EOF'

If macOS still blocks it
------------------------
1. Try to open the app once (double-click). Let it fail.
2. Open  System Settings > Privacy & Security  and scroll to the "Security"
   section. An entry for "BF-AITuner" appears with an "Open Anyway" button.
   Click it, authenticate, then confirm in the follow-up dialog.
   (On macOS 13/14 this is the only supported way to approve a single app.)
3. Or right-click / Control-click the app in Finder and choose "Open", then
   click "Open" in the dialog. That records the exception too.

Manual one-liner
----------------
If you would rather do it by hand, or the app sits in /Applications and the
attribute cannot be cleared without elevated rights, this is the entire fix:

    sudo xattr -r -d com.apple.quarantine /Applications/BF-AITuner.app

Then confirm it took effect:

    xattr -r /Applications/BF-AITuner.app | grep -c com.apple.quarantine   # expect 0

Do NOT run `sudo spctl --master-disable`
----------------------------------------
It is widely copy-pasted advice and it is a bad idea: it switches Gatekeeper
off for EVERY app on the machine, permanently, and it hides the protection
that would otherwise stop genuinely malicious unsigned software. The
per-attribute fix in this script achieves the same thing for exactly one app,
and `Open Anyway` is Apple's supported per-app mechanism.

Also note: re-downloading or re-copying the .app through a quarantining
transport (browser, AirDrop, Mail) will set com.apple.quarantine again. Re-run
this script, or copy it with `ditto`/`rsync` from a location you already trust.
EOF
