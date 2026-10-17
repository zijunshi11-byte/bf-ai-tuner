/**
 * Tests for the optional AI agent layer.
 *
 * The important ones are the SAFETY tests: the model is untrusted input, and
 * these lock down the two screens every model-proposed diff must pass -
 * the whitelist (parameter names) and the step budget (magnitudes). The
 * btfl_003.bbl crash is the reason the second screen exists at all: a
 * legal-looking `dterm_lpf1_static_hz: 82 -> 120` took a quad down.
 *
 * No network: `callChatCompletions`/`runAiAnalysis` take an injectable fetch.
 *
 * Run with: node --test test/
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_AI_CONFIG,
  PACK_LEVELS,
  publicAiConfig,
  mergeAiConfig,
  buildEvidencePack,
  buildTimeSeries,
  decimateEnvelope,
  trimPackToBudget,
  packSizeChars,
  buildUserPrompt,
  buildMessages,
  callChatCompletions,
  extractJsonObject,
  enforceStepLimits,
  screenAiSuggestions,
  runAiAnalysis,
} from '../src/main/analysis/ai-agent.js';
import { readAiConfig, writeAiConfig } from '../src/main/ai-config.js';

/* ------------------------------------------------------------------ *
 * Response parsing
 * ------------------------------------------------------------------ */

test('extractJsonObject reads a bare object, a fenced block, and prose-wrapped JSON', () => {
  const bare = '{"verdict":"ok","suggestions":[]}';
  assert.equal(extractJsonObject(bare).verdict, 'ok');

  const fenced = 'Here you go:\n```json\n{"verdict":"fenced","suggestions":[]}\n```\nThanks!';
  assert.equal(extractJsonObject(fenced).verdict, 'fenced');

  const prose = 'Sure. {"verdict":"prose","suggestions":[{"problem":"p"}]} and that is that.';
  assert.equal(extractJsonObject(prose).verdict, 'prose');

  assert.equal(extractJsonObject('no json at all'), null);
  assert.equal(extractJsonObject(''), null);
});

test('extractJsonObject ignores braces inside strings', () => {
  const payload = '{"verdict":"a {brace} inside a string","suggestions":[]}';
  const parsed = extractJsonObject(payload);
  assert.equal(parsed.verdict, 'a {brace} inside a string');
});

/* ------------------------------------------------------------------ *
 * Evidence pack
 * ------------------------------------------------------------------ */

test('buildEvidencePack keeps the measurements and drops the spectrum arrays', () => {
  const metrics = {
    file: '/tmp/x.bbl',
    durationS: 79.435929,
    sampleRateHz: 2000,
    dropRatePct: 0.123,
    motorSaturationPct: 1.4,
    sampleQuality: 0.87,
    faults: [{ code: 'SAMPLE_TOO_SHORT', severity: 'info', blocksTuning: false, evidence: 'log is 4.8 s long' }],
    axes: {
      roll: {
        gyroRms: 45.678,
        propwashIndex: 0.321,
        // These must never travel: they are megabytes.
        gyroSpectrum: { freqs: Array.from({ length: 2000 }, (_, i) => i), psd: new Array(2000).fill(-30) },
        gyroUnfiltSpectrum: { freqs: new Array(2000).fill(1), psd: new Array(2000).fill(-10) },
        peaks: [{ hz: 484.2, prominenceDb: 12.7 }],
      },
      pitch: {},
      yaw: {},
    },
    craftSettings: null,
  };
  const pack = buildEvidencePack({ metrics });
  const text = JSON.stringify(pack);

  assert.equal(pack.log.sampleRateHz, 2000);
  assert.equal(pack.axes.roll.gyroRmsDps, 45.7);
  assert.equal(pack.axes.roll.propwashIndex, 0.321);
  assert.equal(pack.axes.roll.peaks[0].hz, 484);
  assert.equal(pack.faults.length, 1);

  assert.equal(text.includes('gyroUnfiltSpectrum'), false, 'raw spectra must not be uploaded');
  assert.ok(text.length < 4000, `evidence pack should stay small, got ${text.length} bytes`);
});

test('buildUserPrompt embeds the pack as compact JSON and asks for the fixed format', () => {
  const prompt = buildUserPrompt({ level: 'compact', log: { durationS: 12 } });
  // Compact JSON on purpose: a "full" pack can be hundreds of KB, and
  // indentation alone would waste tens of thousands of tokens.
  assert.match(prompt, /"durationS":12/);
  assert.match(prompt, /紧凑档/);
  assert.match(prompt, /JSON/);
});

test('buildUserPrompt explains the time-series envelope when the full pack is used', () => {
  const prompt = buildUserPrompt({ level: 'full', timeSeries: { channels: {} }, segments: { rows: [] }, spectra: {} });
  assert.match(prompt, /完整档/);
  assert.match(prompt, /最小值, 平均值, 最大值/);
  assert.match(prompt, /不要从它推断单点精确数值/);
});

test('buildMessages sends the system contract first', () => {
  const msgs = buildMessages({ log: {} });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[0].content, /只输出一个 JSON 对象/);
  assert.match(msgs[0].content, /严禁建议修改安全相关参数/);
  assert.equal(msgs[1].role, 'user');
});

/* ------------------------------------------------------------------ *
 * SAFETY: magnitude screen (the btfl_003.bbl lesson)
 * ------------------------------------------------------------------ */

test('enforceStepLimits clamps a filter jump to the 10% budget', () => {
  // This is the exact advice that crashed the quad: 82 -> 120 is +46%.
  const { diff, clamped } = enforceStepLimits([{ param: 'dterm_lpf1_static_hz', from: 82, to: 120 }]);
  assert.equal(diff[0].to, 90, `expected the 10% step (90), got ${diff[0].to}`);
  assert.equal(diff[0].clampedFrom, 120);
  assert.equal(clamped.length, 1);
  assert.match(clamped[0], /超出保守步长/);
});

test('enforceStepLimits refuses an absurd filter value outright', () => {
  const { diff } = enforceStepLimits([{ param: 'dterm_lpf1_static_hz', from: 82, to: 2000 }]);
  assert.ok(diff[0].to <= 90, `clamped target must stay within budget, got ${diff[0].to}`);
});

test('enforceStepLimits bounds P, D and the notch params', () => {
  const { diff } = enforceStepLimits([
    { param: 'p_roll', from: 45, to: 80 },
    { param: 'd_pitch', from: 17, to: 40 },
    { param: 'gyro_notch1_hz', from: 0, to: 600 },
  ]);
  const byParam = Object.fromEntries(diff.map((d) => [d.param, d]));

  // 7% of 45 = 3.15 -> 3
  assert.equal(byParam.p_roll.to, 48);
  // D moves in whole units, max 3
  assert.equal(byParam.d_pitch.to, 20);
  // A notch from 0 has no relative budget; it must still be bounded, and the
  // guard falls back to a 1-unit absolute move rather than letting 600 through.
  assert.ok(Math.abs(byParam.gyro_notch1_hz.to - 0) <= 1, `notch from 0 got ${byParam.gyro_notch1_hz.to}`);
});

test('enforceStepLimits passes a conservative change through untouched', () => {
  const input = [
    { param: 'd_pitch', from: 17, to: 20 },
    { param: 'dterm_lpf1_static_hz', from: 82, to: 90 },
  ];
  const { diff, clamped } = enforceStepLimits(input);
  assert.deepEqual(
    diff.map((d) => ({ param: d.param, from: d.from, to: d.to })),
    input,
  );
  assert.equal(clamped.length, 0);
});

test('enforceStepLimits rejects a diff with no usable from/to', () => {
  const { diff, rejected } = enforceStepLimits([{ param: 'd_pitch', from: null, to: 20 }]);
  assert.equal(diff.length, 0);
  assert.equal(rejected.length, 1);
});

/* ------------------------------------------------------------------ *
 * SAFETY: parameter screen
 * ------------------------------------------------------------------ */

test('screenAiSuggestions blocks forbidden and non-whitelisted parameters', () => {
  const parsed = {
    verdict: 'v',
    suggestions: [
      {
        problem: 'tries to touch failsafe and an invented knob',
        evidence: 'e',
        diff: [
          { param: 'failsafe_throttle', from: 1000, to: 1200 },
          { param: 'gtune_0', from: 0, to: 1 },
          { param: 'd_pitch', from: 17, to: 20 },
        ],
      },
    ],
  };
  const out = screenAiSuggestions(parsed);
  const p = out.proposals[0];

  assert.equal(p.diff.length, 1, 'only the whitelisted param survives');
  assert.equal(p.diff[0].param, 'd_pitch');
  assert.equal(p.blockedDiff.length, 2);
  assert.equal(p.blockedBy.length, 1);
  assert.match(p.blockedBy[0], /failsafe_throttle/);
  assert.match(p.blockedBy[0], /gtune_0/);
  // The CLI is re-derived, so the blocked lines can never be copied.
  assert.deepEqual(p.cli, ['set d_pitch = 20']);
});

test('screenAiSuggestions clamps magnitudes and reports it', () => {
  const parsed = {
    verdict: 'v',
    suggestions: [
      { problem: 'rail voltage', evidence: 'e', diff: [{ param: 'dterm_lpf1_static_hz', from: 82, to: 200 }] },
    ],
  };
  const p = screenAiSuggestions(parsed).proposals[0];
  assert.equal(p.diff[0].to, 90);
  assert.ok(p.blockedBy.some((n) => /收敛/.test(n)), JSON.stringify(p.blockedBy));
  assert.deepEqual(p.cli, ['set dterm_lpf1_static_hz = 90']);
});

test('screenAiSuggestions never marks an AI proposal safeToApply', () => {
  const parsed = { verdict: 'v', suggestions: [{ problem: 'p', evidence: 'e', diff: [{ param: 'd_pitch', from: 17, to: 20 }] }] };
  const p = screenAiSuggestions(parsed).proposals[0];
  assert.equal(p.safeToApply, false, 'the model must never be able to write directly');
});

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

const okResponse = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }], usage: { total_tokens: 123 }, model: 'test-model' }),
  text: async () => text,
});

test('callChatCompletions posts to /chat/completions with the bearer key', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return okResponse('{"verdict":"ok","suggestions":[]}');
  };
  const res = await callChatCompletions({
    config: { baseUrl: 'https://example.test/v1', model: 'm', apiKey: 'sk-test' },
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
  });
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  assert.match(seen.init.headers.authorization, /^Bearer sk-test$/);
  assert.equal(JSON.parse(seen.init.body).model, 'm');
  assert.equal(res.text, '{"verdict":"ok","suggestions":[]}');
});

test('callChatCompletions surfaces an HTTP error with its body', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'invalid api key', json: async () => ({}) });
  await assert.rejects(
    () => callChatCompletions({ config: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' }, messages: [], fetchImpl }),
    /401.*invalid api key/s,
  );
});

test('callChatCompletions refuses to run without a key or endpoint', async () => {
  await assert.rejects(() => callChatCompletions({ config: { baseUrl: 'https://x/v1', model: 'm', apiKey: '' }, messages: [] }), /API key/);
  await assert.rejects(() => callChatCompletions({ config: { baseUrl: '', model: 'm', apiKey: 'k' }, messages: [] }), /baseUrl/);
});

test('runAiAnalysis goes pack -> completion -> screened proposals end to end', async () => {
  const reply = JSON.stringify({
    verdict: '整体健康，只需小幅抬 D',
    confidence: 0.7,
    suggestions: [
      {
        problem: '俯仰轴收油门抖动',
        evidence: 'pitch propwashIndex 0.44，77 段收油门事件',
        diff: [{ param: 'd_pitch', from: 17, to: 20 }],
        cli: ['set d_pitch = 20'],
        why: 'D 提供阻尼',
        verification: '复飞做收油门下落',
        ifNotApplied: '继续抖',
        confidence: 0.6,
      },
    ],
  });
  const out = await runAiAnalysis({
    config: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
    pack: { log: { durationS: 12 } },
    fetchImpl: async () => okResponse(reply),
  });

  assert.equal(out.ok, true);
  assert.equal(out.verdict, '整体健康，只需小幅抬 D');
  assert.equal(out.proposals.length, 1);
  assert.deepEqual(out.proposals[0].diff, [{ param: 'd_pitch', from: 17, to: 20, deltaPct: null }]);
  assert.equal(out.usage.total_tokens, 123);
});

test('runAiAnalysis reports an unparseable reply instead of throwing', async () => {
  const out = await runAiAnalysis({
    config: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'k' },
    pack: {},
    fetchImpl: async () => okResponse('I am sorry, I cannot help with that.'),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /JSON/);
  assert.match(out.raw, /sorry/);
});

/* ------------------------------------------------------------------ *
 * Config: the key must never leak
 * ------------------------------------------------------------------ */

test('publicAiConfig reports hasApiKey without ever returning the key', () => {
  const pub = publicAiConfig({ enabled: true, baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-secret' });
  assert.equal(pub.hasApiKey, true);
  assert.equal('apiKey' in pub, false);
  assert.equal(JSON.stringify(pub).includes('sk-secret'), false);
});

test('mergeAiConfig keeps the stored key when the patch sends an empty string', () => {
  const current = { ...DEFAULT_AI_CONFIG, apiKey: 'sk-stored' };
  const next = mergeAiConfig(current, { apiKey: '', model: 'other' });
  assert.equal(next.apiKey, 'sk-stored');
  assert.equal(next.model, 'other');

  // An explicit new key replaces it.
  assert.equal(mergeAiConfig(current, { apiKey: 'sk-new' }).apiKey, 'sk-new');
});

test('the config file round-trips and is written 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bf-ai-config-'));
  try {
    const path = join(dir, 'ai-config.json');
    writeAiConfig(path, { enabled: true, baseUrl: 'https://x/v1/', model: 'm', apiKey: 'sk-secret' });

    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.apiKey, 'sk-secret');
    // Trailing slash is normalised away so `${baseUrl}/chat/completions` is sane.
    assert.equal(onDisk.baseUrl, 'https://x/v1');

    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

    assert.equal(readAiConfig(path).model, 'm');
    // A missing file must read back as the disabled default, never as configured.
    assert.equal(readAiConfig(join(dir, 'missing.json')).enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * Detail levels: how much of the log travels
 * ------------------------------------------------------------------ */

/** A small synthetic decoded log: 2000 samples at 1 kHz, four channels. */
function fakeLog(samples = 2000, sampleRateHz = 1000) {
  const t = (i) => i / sampleRateHz;
  const channels = {
    'gyroADC[0]': Array.from({ length: samples }, (_, i) => 50 * Math.sin(2 * Math.PI * 40 * t(i)) + (i % 97 === 0 ? 300 : 0)),
    'gyroADC[1]': Array.from({ length: samples }, (_, i) => 30 * Math.sin(2 * Math.PI * 55 * t(i))),
    'gyroADC[2]': Array.from({ length: samples }, (_, i) => 5 * Math.sin(2 * Math.PI * 10 * t(i))),
    'setpoint[0]': Array.from({ length: samples }, (_, i) => 60 * Math.sin(2 * Math.PI * 2 * t(i))),
    throttle: Array.from({ length: samples }, (_, i) => 1000 + Math.round(500 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.5 * t(i))))),
    'motor[0]': Array.from({ length: samples }, (_, i) => 1200 + ((i * 7) % 500)),
    'motor[1]': Array.from({ length: samples }, (_, i) => 1200 + ((i * 5) % 500)),
    'motor[2]': Array.from({ length: samples }, (_, i) => 1200 + ((i * 3) % 500)),
    'motor[3]': Array.from({ length: samples }, (_, i) => 1200 + ((i * 11) % 500)),
    'eRPM[0]': Array.from({ length: samples }, (_, i) => 400 + ((i * 3) % 800)),
    'eRPM[1]': Array.from({ length: samples }, (_, i) => 400 + ((i * 4) % 800)),
  };
  return {
    sampleRateHz,
    durationS: samples / sampleRateHz,
    header: { rollPID: '45,80,34', pitchPID: '47,85,36', dterm_lpf1_static_hz: '82', 'Firmware revision': 'Betaflight 2025.12.1' },
    channels,
  };
}

const metricsFixture = () => ({
  file: '/tmp/fake.bbl',
  durationS: 2,
  sampleRateHz: 1000,
  warnings: ['no "vbat" column'],
  faults: [{ code: 'SAMPLE_TOO_SHORT', severity: 'info', blocksTuning: false, evidence: 'short' }],
  axes: {
    roll: {
      gyroRms: 40,
      peaks: [{ hz: 484.2, prominenceDb: 12.7 }, { hz: 120.4, prominenceDb: 9.1 }],
      gyroSpectrum: { freqs: Array.from({ length: 500 }, (_, i) => i), psd: Array.from({ length: 500 }, (_, i) => -20 - i * 0.02) },
    },
    pitch: {},
    yaw: {},
  },
});

test('compact is the small default and carries no raw-data sections', () => {
  const log = fakeLog();
  const pack = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'compact' });
  assert.equal(pack.level, 'compact');
  assert.equal('timeSeries' in pack, false);
  assert.equal('channelStats' in pack, false);
  assert.equal('spectra' in pack, false);
  assert.equal('blackboxHeader' in pack, false);
  assert.ok(packSizeChars(pack) < 4000, `compact should stay small, got ${packSizeChars(pack)}`);
});

test('standard adds the header, channel stats, spectra, segments and a time series', () => {
  const log = fakeLog();
  const pack = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'standard' });
  assert.equal(pack.level, 'standard');
  assert.ok(pack.blackboxHeader, 'full header expected');
  assert.equal(pack.blackboxHeader.pitchPID, '47,85,36');
  assert.ok(pack.channelStats['gyroADC[0]'], 'per-channel stats expected');
  assert.ok(pack.spectra.roll.hz.length > 10, 'spectrum expected');
  assert.ok(pack.segments.rows.length >= 2, 'segments expected');
  assert.ok(pack.timeSeries, 'time series expected');
  assert.ok(Object.keys(pack.timeSeries.channels).length > 3);
});

test('standard stays inside its advertised character budget', () => {
  const log = fakeLog(20000, 1000);
  const pack = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'standard' });
  const size = packSizeChars(pack);
  assert.ok(size <= PACK_LEVELS.standard.maxChars, `standard pack ${size} exceeded ${PACK_LEVELS.standard.maxChars}`);
});

test('full carries a bigger time series than standard for the same log', () => {
  const log = fakeLog(20000, 1000);
  const std = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'standard' });
  const full = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'full' });
  const stdPoints = Object.values(std.timeSeries.channels)[0].values.length;
  const fullPoints = Object.values(full.timeSeries.channels)[0].values.length;
  assert.ok(fullPoints > stdPoints, `full (${fullPoints}) should out-resolve standard (${stdPoints})`);
  assert.ok(packSizeChars(full) > packSizeChars(std));
});

test('the time series covers the whole flight, not just its start', () => {
  const log = fakeLog(20000, 1000);
  const pack = buildEvidencePack({ metrics: metricsFixture(), log, header: log.header, level: 'full' });
  // everySamples * buckets should reach the end of the log.
  for (const [name, series] of Object.entries(pack.timeSeries.channels)) {
    const buckets = series.values.length / 3;
    const covered = series.everySamples * buckets;
    const total = log.channels[name].length;
    assert.ok(covered >= total * 0.9, `${name}: covered ${covered} of ${total}`);
  }
});

test('decimateEnvelope preserves extremes instead of hiding spikes', () => {
  const values = Array.from({ length: 1000 }, (_, i) => (i === 500 ? 9999 : 0));
  const out = decimateEnvelope(values, 30);
  assert.ok(out.includes(9999), 'the spike must survive decimation');
  assert.ok(out.length <= 30 + 3);
});

test('decimateEnvelope returns the raw series when it already fits', () => {
  const values = [1, 2, 3];
  assert.deepEqual(decimateEnvelope(values, 30), [1, 2, 3]);
});

test('buildTimeSeries spreads the budget across every channel, not greedily', () => {
  const log = fakeLog(50000, 1000);
  const series = buildTimeSeries(log, 60000);
  assert.ok(series);
  // Greedy filling used to hand the whole budget to the first channel and drop
  // motors + eRPM entirely - the exact evidence a desync diagnosis needs.
  for (const name of ['gyroADC[0]', 'setpoint[0]', 'throttle', 'motor[3]', 'eRPM[1]']) {
    assert.ok(series.channels[name], `${name} must survive budget allocation`);
  }
  const sizes = Object.values(series.channels).map((c) => c.values.length);
  assert.ok(Math.max(...sizes) / Math.min(...sizes) < 3, `channel sizes unbalanced: ${sizes.join(',')}`);
  assert.ok(packSizeChars(series) <= 60000 * 1.1, `series ${packSizeChars(series)} overshot badly`);
});

test('trimPackToBudget enforces the hard cap by dropping tail channels', () => {
  const log = fakeLog(50000, 1000);
  const pack = { timeSeries: buildTimeSeries(log, 200000) };
  const before = packSizeChars(pack);
  assert.ok(before > 40000, 'fixture should start oversized');
  trimPackToBudget(pack, 40000);
  assert.ok(packSizeChars(pack) <= 40000, `still ${packSizeChars(pack)} after trim`);
  // Core channels are kept longest.
  assert.ok(pack.timeSeries.channels['gyroADC[0]'], 'gyro must survive trimming');
});
