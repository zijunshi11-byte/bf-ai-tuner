#!/usr/bin/env node
/**
 * Re-vendors the upstream Betaflight Configurator modules this app depends on.
 *
 * The vendored files are copied verbatim (with a provenance header prepended)
 * rather than imported from a package, because the configurator is an
 * application, not a library: it has no stable public entry point to import.
 * Copying keeps this app buildable offline and pins exactly which upstream
 * revision the decoding logic came from.
 *
 * Usage:
 *   node scripts/sync-upstream.mjs [--upstream /path/to/betaflight-configurator] [--check]
 *
 *   --check   verify the vendored files match upstream without writing
 *
 * Environment:
 *   BF_CONFIGURATOR_PATH   upstream checkout (default: ~/betaflight-configurator)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(projectRoot, 'vendor', 'betaflight');

/**
 * upstream path -> vendored filename.
 * Keep this list minimal: every entry is code we must re-verify on each sync.
 */
const MANIFEST = [
  { upstream: 'src/js/blackbox/datastream.js', local: 'datastream.js' },
  { upstream: 'src/js/blackbox/decoders.js', local: 'decoders.js' },
  { upstream: 'src/js/blackbox/fft.js', local: 'fft.js' },
  { upstream: 'src/js/huffman.js', local: 'huffman.js' },
  { upstream: 'src/js/default_huffman_tree.js', local: 'default_huffman_tree.js' },
];

/**
 * Patches applied after copying. Each one must be justified: these files are
 * otherwise byte-identical to upstream so a diff against a fresh checkout is
 * meaningful.
 */
const PATCHES = [
  {
    file: 'default_huffman_tree.js',
    // Upstream relies on a bundler to resolve the extensionless specifier;
    // plain Node ESM requires it.
    from: 'from "./huffman";',
    to: 'from "./huffman.js"; // PATCHED: explicit extension for Node ESM',
    why: 'extensionless import is not resolvable by Node ESM',
  },
];

function parseArgs(argv) {
  const args = { upstream: process.env.BF_CONFIGURATOR_PATH || join(homedir(), 'betaflight-configurator'), check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--upstream') args.upstream = argv[++i];
    else if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).join('\n'));
      process.exit(0);
    }
  }
  return args;
}

function upstreamCommit(upstream) {
  try {
    return execFileSync('git', ['-C', upstream, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function provenanceHeader(upstreamPath, commit) {
  return [
    '/*',
    ' * VENDORED VERBATIM from betaflight-configurator',
    ` *   upstream path  : ${upstreamPath}`,
    ` *   upstream commit: ${commit}`,
    ' *   license        : GPL-3.0-or-later (see LICENSE in this directory)',
    ' * Regenerate with: node scripts/sync-upstream.mjs',
    ' */',
    '',
  ].join('\n');
}

/** Removes a previously generated provenance header so syncs are idempotent. */
function stripHeader(text) {
  const marker = ' * Regenerate with: node scripts/sync-upstream.mjs\n */\n';
  const end = text.indexOf(marker);
  if (!text.startsWith('/*') || end === -1) return text;
  return text.slice(end + marker.length);
}

function applyPatches(localName, text) {
  let out = text;
  const applied = [];
  for (const patch of PATCHES) {
    if (patch.file !== localName) continue;
    if (out.includes(patch.to)) continue; // idempotent
    if (!out.includes(patch.from)) {
      applied.push({ ...patch, status: 'skipped (source text not found - upstream may have changed)' });
      continue;
    }
    out = out.replace(patch.from, patch.to);
    applied.push({ ...patch, status: 'applied' });
  }
  return { text: out, applied };
}

/** Confirms a vendored module actually loads under Node ESM. */
async function canLoad(file) {
  try {
    await import(pathToFileURL(file).href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const upstream = resolve(args.upstream);

  if (!existsSync(upstream)) {
    console.error(`Upstream checkout not found: ${upstream}`);
    console.error('Pass --upstream <path> or set BF_CONFIGURATOR_PATH.');
    process.exit(1);
  }

  const commit = upstreamCommit(upstream);
  console.log(`Upstream : ${upstream}`);
  console.log(`Commit   : ${commit}`);
  console.log(`Mode     : ${args.check ? 'check only (no writes)' : 'sync'}\n`);

  if (!args.check) mkdirSync(vendorDir, { recursive: true });

  const results = [];
  let changed = 0;

  for (const entry of MANIFEST) {
    const source = join(upstream, entry.upstream);
    const target = join(vendorDir, entry.local);

    if (!existsSync(source)) {
      results.push({ local: entry.local, status: 'MISSING UPSTREAM', ok: false });
      continue;
    }

    const raw = readFileSync(source, 'utf8');
    const patched = applyPatches(entry.local, raw);
    const next = provenanceHeader(entry.upstream, commit) + patched.text;

    const previous = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const unchanged = previous !== null && stripHeader(previous) === stripHeader(next);

    if (args.check) {
      results.push({
        local: entry.local,
        status: unchanged ? 'in sync' : 'DIFFERS from upstream',
        ok: unchanged,
        patches: patched.applied,
      });
      continue;
    }

    if (!unchanged) {
      writeFileSync(target, next, 'utf8');
      changed++;
    }
    results.push({
      local: entry.local,
      status: unchanged ? 'unchanged' : previous === null ? 'created' : 'updated',
      ok: true,
      patches: patched.applied,
    });
  }

  // Vendor the licence alongside the code, as GPL requires.
  const licenceSource = join(upstream, 'LICENSE');
  if (!args.check && existsSync(licenceSource)) {
    writeFileSync(join(vendorDir, 'LICENSE'), readFileSync(licenceSource));
  }

  console.log('file                      status');
  console.log('-'.repeat(58));
  for (const r of results) {
    console.log(`${r.local.padEnd(24)}  ${r.status}`);
    for (const p of r.patches || []) console.log(`  patch: ${p.status} - ${p.why}`);
  }

  // Verify every vendored module imports cleanly.
  console.log('\nload check:');
  let allLoad = true;
  for (const entry of MANIFEST) {
    if (entry.local === 'default_huffman_tree.js') continue; // verified via huffman.js
    const target = join(vendorDir, entry.local);
    if (!existsSync(target)) continue;
    const result = await canLoad(target);
    if (!result.ok) allLoad = false;
    console.log(`  ${result.ok ? 'OK  ' : 'FAIL'} ${entry.local}${result.ok ? '' : ` - ${result.error}`}`);
  }

  if (args.check) {
    const drifted = results.filter((r) => !r.ok);
    if (drifted.length) {
      console.error(`\n${drifted.length} vendored file(s) differ from upstream. Re-run without --check to update.`);
      process.exit(1);
    }
    console.log('\nAll vendored files are in sync with upstream.');
    return;
  }

  console.log(`\n${changed} file(s) written to vendor/betaflight/.`);
  if (!allLoad) {
    console.error('One or more vendored modules failed to load - inspect before committing.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
