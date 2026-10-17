/**
 * Per-quad tuning journal: one JSON file per craft holding its profile and a
 * timeline of analyses, writes and re-fly verdicts, so a tune is a history
 * rather than a series of disconnected sessions.
 *
 * Local only (userData/journal). Nothing here talks to the flight controller.
 * Ids are slugs checked against a strict pattern before they become a path.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_ENTRIES = 500;
const ENTRY_KINDS = new Set(['analysis', 'apply', 'evaluate', 'note']);

/** Editable profile fields and how each is sanitised. */
const PROFILE_FIELDS = {
  name: { type: 'string', max: 60 },
  frame: { type: 'string', max: 60 },
  props: { type: 'string', max: 60 },
  motors: { type: 'string', max: 60 },
  motorKv: { type: 'number', min: 100, max: 10000 },
  cells: { type: 'number', min: 1, max: 12 },
  weightG: { type: 'number', min: 20, max: 5000 },
  notes: { type: 'string', max: 2000 },
};

/**
 * Stable id for a craft: its craft name when set, else the board, else a
 * fixed bucket. Lower-case ASCII slug; other characters are hex-encoded so
 * two Chinese craft names never collapse onto one id.
 */
export function quadIdFor({ craftName = null, board = null } = {}) {
  const raw = String(craftName || board || 'unnamed-quad').trim().toLowerCase();
  let slug = '';
  for (const ch of raw) {
    if (/[a-z0-9]/.test(ch)) slug += ch;
    else if (/[\s_.-]/.test(ch)) slug += '-';
    else slug += ch.codePointAt(0).toString(16);
  }
  slug = slug.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  return ID_RE.test(slug) ? slug : 'unnamed-quad';
}

function sanitiseProfile(patch = {}) {
  const out = {};
  for (const [key, rule] of Object.entries(PROFILE_FIELDS)) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (v === null || v === '') {
      out[key] = null;
      continue;
    }
    if (rule.type === 'string') out[key] = String(v).slice(0, rule.max);
    else {
      const n = Number(v);
      if (Number.isFinite(n) && n >= rule.min && n <= rule.max) out[key] = n;
    }
  }
  return out;
}

export class JournalStore {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
  }

  #path(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('invalid quad id');
    return join(this.dir, `${id}.json`);
  }

  #read(id) {
    try {
      return JSON.parse(readFileSync(this.#path(id), 'utf8'));
    } catch (err) {
      if (err?.message === 'invalid quad id') throw err;
      return null;
    }
  }

  #write(doc) {
    mkdirSync(this.dir, { recursive: true });
    const path = this.#path(doc.id);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc)}\n`, 'utf8');
    renameSync(tmp, path);
  }

  #ensure(id, meta = {}) {
    const existing = this.#read(id);
    if (existing) {
      // Board / firmware follow the latest sighting; the profile is the user's.
      if (meta.board) existing.board = String(meta.board).slice(0, 80);
      if (meta.firmware) existing.firmware = String(meta.firmware).slice(0, 80);
      return existing;
    }
    const now = new Date().toISOString();
    return {
      id,
      createdAt: now,
      updatedAt: now,
      board: meta.board ? String(meta.board).slice(0, 80) : null,
      firmware: meta.firmware ? String(meta.firmware).slice(0, 80) : null,
      profile: { name: meta.craftName ? String(meta.craftName).slice(0, 60) : null },
      entries: [],
    };
  }

  /** Quads, most recently updated first, without their timelines. */
  list() {
    let names = [];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const quads = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const doc = this.#read(id);
      if (!doc) continue;
      quads.push({
        id: doc.id,
        profile: doc.profile || {},
        board: doc.board ?? null,
        firmware: doc.firmware ?? null,
        updatedAt: doc.updatedAt,
        entries: Array.isArray(doc.entries) ? doc.entries.length : 0,
      });
    }
    return quads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** One quad with its full timeline (oldest first), or null. */
  get(id) {
    return this.#read(id);
  }

  /**
   * Append a timeline entry, creating the quad on first sight.
   * @param {string} id
   * @param {{kind:'analysis'|'apply'|'evaluate'|'note'} & object} entry
   * @param {{craftName?:string|null, board?:string|null, firmware?:string|null}} [meta]
   */
  append(id, entry, meta = {}) {
    if (!entry || !ENTRY_KINDS.has(entry.kind)) throw new Error('invalid journal entry kind');
    const doc = this.#ensure(id, meta);
    const now = new Date().toISOString();
    doc.entries.push({ ...entry, at: entry.at || now });
    if (doc.entries.length > MAX_ENTRIES) doc.entries = doc.entries.slice(-MAX_ENTRIES);
    doc.updatedAt = now;
    this.#write(doc);
    return doc.entries[doc.entries.length - 1];
  }

  /** Merge user-editable profile fields; unknown keys are ignored. */
  setProfile(id, patch) {
    const doc = this.#ensure(id);
    doc.profile = { ...(doc.profile || {}), ...sanitiseProfile(patch) };
    doc.updatedAt = new Date().toISOString();
    this.#write(doc);
    return doc.profile;
  }

  addNote(id, text) {
    const body = String(text ?? '').trim().slice(0, 2000);
    if (!body) throw new Error('note is empty');
    return this.append(id, { kind: 'note', text: body });
  }
}

export default JournalStore;
