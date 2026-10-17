/**
 * Persistence for the AI agent settings.
 *
 * Stored as JSON under the app's userData directory, mode 0600: the file holds
 * an API key, and it must never end up in the repo, a backup snapshot, or the
 * exported report. The key is also never sent back to the renderer - the UI
 * only ever learns whether one is set (`hasApiKey`).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

import { DEFAULT_AI_CONFIG, mergeAiConfig, publicAiConfig } from './analysis/ai-agent.js';

/** Read the stored config, falling back to defaults on anything unreadable. */
export function readAiConfig(path) {
  try {
    if (!path || !existsSync(path)) return { ...DEFAULT_AI_CONFIG };
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_AI_CONFIG };
    return mergeAiConfig({ ...DEFAULT_AI_CONFIG }, parsed);
  } catch {
    // A corrupt config must never take the app down, and must never be treated
    // as "configured": falling back to the disabled default is the safe read.
    return { ...DEFAULT_AI_CONFIG };
  }
}

/** Persist a config. Returns the stored value (still containing the key). */
export function writeAiConfig(path, config) {
  const next = mergeAiConfig({ ...DEFAULT_AI_CONFIG }, config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: some filesystems ignore mode bits.
  }
  return next;
}

export { publicAiConfig };
export default { readAiConfig, writeAiConfig, publicAiConfig };
