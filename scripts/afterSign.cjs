'use strict';

/**
 * electron-builder `afterSign` hook - macOS only.
 *
 * Referenced from package.json `build.afterSign`. The file is CommonJS (.cjs)
 * on purpose: package.json declares `"type": "module"`, so a plain .js hook
 * would be loaded as ESM and electron-builder's `require()` of it would fail.
 *
 * Why this hook exists at all:
 *
 *   This project has no Apple Developer ID, so electron-builder cannot sign the
 *   bundle. On Apple Silicon that is not a cosmetic problem - every Mach-O must
 *   carry at least an ad-hoc signature, and electron-builder rewrites the bundle
 *   (renaming Electron.app, adding app.asar) which invalidates the signature
 *   Electron shipped with. The result is an app that dies at launch with
 *   "mapping process and mapped file (non-platform) have different Team IDs".
 *
 *   So the hook performs an explicit AD-HOC signature, which is what makes a
 *   local, certificate-free build runnable.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Clear signing-blocking extended attributes. codesign refuses with
 *      "resource fork, Finder information, or similar detritus not allowed"
 *      while com.apple.FinderInfo is present on a bundle directory. macOS adds
 *      it to .app/.framework directories, and iCloud Drive (FileProvider)
 *      re-adds it aggressively - which is why this runs immediately before
 *      signing, and why the build output should live outside iCloud Drive.
 *   2. Ad-hoc sign. Entitlements are supplied through `optionsForFile`, NOT via
 *      the top-level `entitlements` option: osx-sign otherwise substitutes its
 *      own default entitlement set for every binary and
 *      `com.apple.security.cs.disable-library-validation` is silently lost,
 *      which is exactly the entitlement that lets the ad-hoc-signed main binary
 *      load the Electron Framework.
 *   3. Verify. A build that cannot launch is worse than a failed build.
 *   4. Clear quarantine, so a locally built copy does not need the manual step.
 *
 * Contract: this hook NEVER throws and NEVER rejects. A signing or xattr hiccup
 * must not fail an otherwise good build - it degrades to loud warnings.
 * An app that is already validly signed (e.g. a future Developer ID build) is
 * left completely untouched.
 *
 * @param {object} context
 * @param {string} context.appOutDir           e.g. <project>/dist/mac-arm64
 * @param {object} context.packager            electron-builder Packager
 * @param {string} context.electronPlatformName 'darwin' | 'win32' | 'linux' | 'mas'
 * @returns {Promise<void>}
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TAG = '[afterSign]';
const FALLBACK_PRODUCT_NAME = 'BF-AITuner';

/** Extended attributes that make codesign refuse to sign a bundle. */
const SIGNING_BLOCKERS = [
  'com.apple.FinderInfo',
  'com.apple.ResourceFork',
  'com.apple.fileprovider.fpfs#P',
];

function log(message) {
  console.log(`${TAG} ${message}`);
}

function warn(message) {
  console.warn(`${TAG} WARNING: ${message}`);
}

/**
 * fs.statSync wrapper that never throws.
 *
 * @param {string} target
 * @returns {fs.Stats | null}
 */
function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

/**
 * @param {string} target
 * @returns {boolean} true when `target` is an existing directory.
 */
function isDirectory(target) {
  const stats = statSafe(target);
  return stats !== null && stats.isDirectory();
}

/**
 * Work out the product name electron-builder used for the bundle.
 *
 * @param {object} packager
 * @returns {string}
 */
function resolveProductName(packager) {
  const appInfo = packager && packager.appInfo ? packager.appInfo : null;
  if (appInfo) {
    // `productFilename` is the name actually used on disk (productName with
    // path-hostile characters removed); prefer it over the raw productName.
    if (typeof appInfo.productFilename === 'string' && appInfo.productFilename) {
      return appInfo.productFilename;
    }
    if (typeof appInfo.productName === 'string' && appInfo.productName) {
      return appInfo.productName;
    }
  }
  return FALLBACK_PRODUCT_NAME;
}

/**
 * Find the .app bundle inside the build output directory.
 *
 * Strategy: try `<productName>.app` first, then fall back to the first `.app`
 * entry in `appOutDir`. Returns null when nothing usable is found.
 *
 * @param {string} appOutDir
 * @param {string} productName
 * @returns {string | null} absolute path to an existing .app directory
 */
function findAppBundle(appOutDir, productName) {
  const outDir = path.resolve(appOutDir);

  const preferred = path.join(outDir, `${productName}.app`);
  if (isDirectory(preferred)) {
    return preferred;
  }

  /** @type {string[]} */
  let entries;
  try {
    entries = fs.readdirSync(outDir);
  } catch (error) {
    warn(`could not read app output directory "${outDir}": ${error.message}`);
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.app')) {
      continue;
    }
    const candidate = path.join(outDir, entry);
    if (isDirectory(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Validate a resolved bundle path before touching it.
 *
 * Guards against the three ways this could go wrong: a non-string, a path that
 * is not a `.app`, and a path that escapes `appOutDir` (so a bad productName
 * could never make us sign or xattr, say, /Applications).
 *
 * @param {unknown} appPath
 * @param {string} appOutDir
 * @returns {boolean}
 */
function isSafeAppBundle(appPath, appOutDir) {
  if (typeof appPath !== 'string' || appPath.length === 0) {
    return false;
  }
  if (!appPath.endsWith('.app')) {
    return false;
  }
  if (!isDirectory(appPath)) {
    return false;
  }

  const resolved = path.resolve(appPath);
  const root = path.resolve(appOutDir);
  const relative = path.relative(root, resolved);

  // Must be a strict descendant of appOutDir.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    warn(`refusing to act on "${resolved}": it is not inside "${root}"`);
    return false;
  }

  return true;
}

/**
 * Collect every path in the bundle (files and directories) that still carries
 * one of the signing-blocking extended attributes.
 *
 * @param {string} appPath
 * @returns {string[]}
 */
function findSigningBlockers(appPath) {
  const offenders = [];

  /** @type {string[]} */
  const stack = [appPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }

    for (const candidate of [current, ...names.map((n) => path.join(current, n))]) {
      // `xattr <path>` lists attribute names; a non-zero exit simply means the
      // command failed on that path, which we treat as "no attributes".
      const listed = spawnSync('xattr', [candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const attrs = listed.status === 0 && typeof listed.stdout === 'string' ? listed.stdout.trim() : '';
      if (attrs && SIGNING_BLOCKERS.some((blocker) => attrs.split('\n').includes(blocker))) {
        offenders.push(candidate);
      }
    }

    for (const name of names) {
      const child = path.join(current, name);
      if (isDirectory(child)) {
        stack.push(child);
      }
    }
  }

  return offenders;
}

/**
 * Remove the extended attributes that block codesign. Never throws.
 *
 * @param {string} appPath
 * @returns {boolean} true when nothing is left blocking
 */
function clearSigningBlockers(appPath) {
  try {
    const offenders = findSigningBlockers(appPath);
    if (offenders.length === 0) {
      return true;
    }

    for (const target of offenders) {
      for (const attr of SIGNING_BLOCKERS) {
        spawnSync('xattr', ['-d', attr, target], { stdio: 'ignore' });
      }
    }

    const remaining = findSigningBlockers(appPath);
    if (remaining.length > 0) {
      warn(
        `${remaining.length} path(s) still carry a signing-blocking xattr ` +
          `(e.g. ${remaining[0]}). If signing fails, build outside iCloud Drive.`,
      );
      return false;
    }

    log(`cleared signing-blocking extended attributes on ${offenders.length} path(s)`);
    return true;
  } catch (error) {
    warn(`could not clear extended attributes: ${error.message}`);
    return false;
  }
}

/**
 * True when the bundle already satisfies its own code signature, i.e. a real
 * signing identity was used and we must not overwrite it with an ad-hoc one.
 *
 * @param {string} appPath
 * @returns {boolean}
 */
function isAlreadySigned(appPath) {
  const result = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Apply an ad-hoc signature.
 *
 * Entitlements go through `optionsForFile` because osx-sign ignores the
 * top-level `entitlements` option for the per-binary pass and substitutes its
 * own defaults, which drops disable-library-validation.
 *
 * @param {string} appPath
 * @returns {Promise<boolean>}
 */
async function adHocSign(appPath) {
  let signAsync;
  try {
    ({ signAsync } = require(path.join(__dirname, '..', 'node_modules', '@electron', 'osx-sign')));
  } catch (error) {
    warn(`@electron/osx-sign is unavailable (${error.message}); the app will not launch on Apple Silicon`);
    return false;
  }

  const projectRoot = path.resolve(__dirname, '..');
  const entitlements = path.join(projectRoot, 'build', 'entitlements.mac.inherit.plist');

  const signOptions = {
    app: appPath,
    platform: 'darwin',
    // '-' is codesign's ad-hoc marker. identityValidation must be off or
    // osx-sign looks for a certificate literally named "-" and gives up.
    identity: '-',
    identityValidation: false,
    hardenedRuntime: true,
    // Ad-hoc signatures cannot be timestamped (there is no TSA-issued cert),
    // and `timestamp` is a string option - the string 'none' disables it.
    optionsForFile: () => ({
      entitlements: fs.existsSync(entitlements) ? entitlements : undefined,
      hardenedRuntime: true,
      timestamp: 'none',
    }),
  };

  try {
    await signAsync(signOptions);
    return true;
  } catch (error) {
    warn(`ad-hoc signing failed: ${error.message}`);
    return false;
  }
}

/**
 * Strip every extended attribute (including com.apple.quarantine). Never throws.
 *
 * Runs AFTER signing: xattr -cr would otherwise remove attributes codesign
 * relies on, and there is no reason to clean before the signature exists.
 *
 * @param {string} appPath
 * @returns {boolean} true when xattr exited 0
 */
function stripQuarantine(appPath) {
  try {
    const result = spawnSync('xattr', ['-cr', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      warn(`could not run xattr (${result.error.message}); skipping quarantine strip`);
      return false;
    }

    if (result.status !== 0) {
      const detail = (result.stderr || '').trim() || `exit code ${result.status}`;
      warn(`xattr -cr exited non-zero: ${detail}; skipping quarantine strip`);
      return false;
    }

    return true;
  } catch (error) {
    warn(`unexpected failure while running xattr: ${error.message}`);
    return false;
  }
}

/**
 * Describe the applied signature for the build log.
 *
 * @param {string} appPath
 * @returns {string}
 */
function describeSignature(appPath) {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', appPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  const signature = /Signature=(\S+)/.exec(text);
  const identifier = /Identifier=(\S+)/.exec(text);
  const flags = /flags=(\S+)/.exec(text);
  return [
    `identifier=${identifier ? identifier[1] : '?'}`,
    `signature=${signature ? signature[1] : '?'}`,
    `flags=${flags ? flags[1] : '?'}`,
  ].join(' ');
}

/**
 * @param {object} context
 * @returns {Promise<void>}
 */
async function afterSign(context) {
  try {
    const { appOutDir, packager, electronPlatformName } = context || {};

    // Not a macOS build - nothing to do. `mas` (Mac App Store) is deliberately
    // excluded as well: those builds are always signed and notarized, and must
    // not have their attributes rewritten.
    if (electronPlatformName !== 'darwin') {
      return;
    }

    if (typeof appOutDir !== 'string' || appOutDir.length === 0) {
      warn('no appOutDir in the afterSign context; skipping');
      return;
    }

    if (!isDirectory(appOutDir)) {
      warn(`app output directory "${appOutDir}" does not exist; skipping`);
      return;
    }

    const productName = resolveProductName(packager);
    const appPath = findAppBundle(appOutDir, productName);

    if (appPath === null) {
      warn(`no .app bundle found in "${path.resolve(appOutDir)}" (looked for "${productName}.app"); skipping`);
      return;
    }

    if (!isSafeAppBundle(appPath, appOutDir)) {
      warn(`resolved bundle path "${appPath}" failed validation; skipping`);
      return;
    }

    log(`resolved app bundle: ${path.resolve(appPath)}`);

    // --- signing ---------------------------------------------------------
    if (isAlreadySigned(appPath)) {
      log('bundle already carries a valid signature (a real identity was used); leaving it untouched');
    } else {
      log('no valid signature (no Developer ID available) - applying an ad-hoc signature');
      clearSigningBlockers(appPath);

      const signed = await adHocSign(appPath);
      if (!signed) {
        warn('ad-hoc signing did not complete; the app will NOT launch on Apple Silicon');
      } else if (isAlreadySigned(appPath)) {
        log(`ad-hoc signature verified: ${describeSignature(appPath)}`);
      } else {
        warn('ad-hoc signing reported success but verification failed');
      }
    }

    // --- quarantine ------------------------------------------------------
    if (stripQuarantine(appPath)) {
      log('cleared extended attributes (xattr -cr) so a local copy opens without the manual step');
    } else {
      warn('the bundle may still carry com.apple.quarantine on this machine');
    }

    log('NOTE: this build is NOT NOTARIZED (mac.notarize is false) and carries no Developer ID.');
    log('NOTE: after copying to another Mac it will be quarantined again; on that machine run:');
    log(`NOTE:   sudo xattr -r -d com.apple.quarantine "/Applications/${productName}.app"`);
    log('NOTE: or use System Settings > Privacy & Security > "Open Anyway" on first launch.');
  } catch (error) {
    // Swallow everything: a hook failure must never break the build.
    warn(`unexpected failure in afterSign hook: ${error && error.message ? error.message : String(error)}`);
  }
}

module.exports = afterSign;
// electron-builder (and some loaders) look for a `default` export on the
// required module; expose it under every shape that is checked.
module.exports.default = afterSign;
module.exports.afterSign = afterSign;
