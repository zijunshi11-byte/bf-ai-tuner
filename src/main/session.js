/**
 * Session orchestration: owns the connection and the module graph, and is the
 * only thing the IPC layer talks to.
 *
 * Nothing here knows about Electron, which is what lets the whole flight-side
 * workflow be driven from a plain Node test with a VirtualTransport.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { MspClient } from './msp/msp-client.js';
import { MspHelper } from './msp/msp-helper.js';
import { SerialTransport, listPorts } from './msp/msp-transport.js';
import { FcIdentifier } from './fc/fc-identify.js';
import { FcSettingsReader } from './fc/fc-settings.js';
import { BlackboxManager } from './blackbox/blackbox-manager.js';
import { SafetyGuard } from './safety/guard.js';
import { proposeTune, collectProposals, filterDiff } from './analysis/ai-tune.js';
import { annotateStages, planCampaign } from './analysis/campaign.js';
import { buildScorecard, compareScorecards } from './analysis/scorecard.js';
import { JournalStore, quadIdFor } from './journal/journal-store.js';
import { BackupStore, BACKUP_PARAMS, parseSettings, extractSetCommands, rollbackSafety } from './backup/backup-store.js';
import { enterMsc, exitMsc, findFcVolumes, importLogs } from './blackbox/msc.js';
import { compareRuns } from './analysis/compare-runs.js';
import { decodeBbl } from './analysis/bbl-decode.js';
import { computeMetrics } from './analysis/bbl-metrics.js';
import { buildEvidencePack, runAiAnalysis, buildUserPrompt, AI_SYSTEM_PROMPT, packSizeChars } from './analysis/ai-agent.js';
import { readAiConfig, writeAiConfig, publicAiConfig } from './ai-config.js';

export class Session extends EventEmitter {
  /**
   * @param {{userDataDir:string, seedMapPath:string, localMapPath:string, aiConfigPath?:string}} paths
   */
  constructor({ userDataDir, seedMapPath, localMapPath, aiConfigPath = null, transportFactory = (p) => new SerialTransport(p) }) {
    super();
    // Injectable so the full workflow can be driven against a VirtualTransport in tests.
    this.transportFactory = transportFactory;
    this.paths = {
      userDataDir,
      seedMapPath,
      localMapPath,
      aiConfigPath: aiConfigPath ?? `${userDataDir}/ai-config.json`,
      backupDir: `${userDataDir}/backups`,
      backupStoreDir: `${userDataDir}/backups/store`,
      captureDir: `${userDataDir}/captures`,
      reportsDir: `${userDataDir}/reports`,
      journalDir: `${userDataDir}/journal`,
    };

    this.transport = null;
    this.client = null;
    this.helper = null;
    this.identifier = null;
    this.settingsReader = null;
    this.blackbox = null;

    this.backupStore = new BackupStore(this.paths.backupStoreDir);
    /** Per-quad timeline of analyses, writes and re-fly verdicts (local only). */
    this.journal = new JournalStore(this.paths.journalDir);
    /** Campaign plan + scorecard of the latest proposeTune, served by tune:plan. */
    this.lastPlan = null;
    this.guard = new SafetyGuard({ onLog: (level, message) => this.#log(level, message) });
    this.settings = null;
    this.identity = null;
    // Ties a written change to the analysis that justified it and to the
    // backup that can undo it, so a re-fly can be judged and reverted.
    this.lastReportId = null;
    this.lastBackupId = null;
    // True while the FC is exposing its storage as a USB volume. MSP is
    // physically unavailable then, so every write path must refuse.
    this.inMsc = false;
    this.capabilities = null;
    this.metrics = null;
    this.lastProposal = null;
    /** Latest bidirectional DShot/RPM probe result (see contracts BidirProbe). */
    this.bidir = null;
    /** Pending confirmation token for a two-phase apply. */
    this.pendingApply = null;
    /** Pending confirmation token for the scoped bidir/RPM write path. */
    this.pendingBidirApply = null;
    this.trace = [];
  }

  get connected() {
    return Boolean(this.client?.isOpen);
  }

  /* ---------------- events ---------------- */

  #log(level, message, data) {
    const event = { level, kind: 'log', message, data, ts: Date.now() };
    this.emit('event', event);
  }

  #state() {
    this.emit('event', {
      level: 'info',
      kind: 'state',
      message: 'session state',
      ts: Date.now(),
      data: {
        connected: this.connected,
        port: this.transport?.path || null,
        safety: this.guard.status,
        identity: this.identity,
        capabilities: this.capabilities,
      },
    });
  }

  /* ---------------- connect / disconnect ---------------- */

  static async listPorts() {
    return listPorts();
  }

  async connect(port) {
    if (this.connected) await this.disconnect();

    this.guard.reset();

    this.transport = this.transportFactory(port);
    this.client = new MspClient(this.transport, { trace: true });
    this.client.on('trace', (t) => {
      // Bounded ring buffer: the UI can show recent wire traffic without
      // unbounded memory growth on a long session.
      this.trace.push({ ...t, ts: Date.now() });
      if (this.trace.length > 400) this.trace.shift();
    });
    this.client.on('warn', (m) => this.#log('warn', m));

    // Surface the self-healing state machine so the operator can see the link
    // recover instead of watching an unexplained failure.
    this.client.on('link-degraded', (e) => this.#log('warn', `链路异常：${e.reason} —— 正在自动恢复…`));
    this.client.on('recovering', (e) => this.#log('warn', `自动恢复第 ${e.attempt} 次…`));
    this.client.on('reopen', (e) => this.#log('warn', `关闭并重新打开串口（等待 ${e.delayMs} ms）…`));
    this.client.on('link-restored', (e) => this.#log('info', `链路已恢复（方式：${e.method}）`));
    this.client.on('recover-failed', () => this.#log('error', '自动恢复失败，请检查 USB 连接后重试。'));
    this.client.on('reconnect-done', (e) => this.#log(e.ok ? 'info' : 'error', e.ok ? '串口重连成功' : '串口重连失败'));

    await this.client.open();

    // Opening the USB CDC port can reset the FC (DTR). Give it a moment, then
    // confirm it answers before anything reads settings - otherwise the first
    // few reads (e.g. the first CLI get) land in the boot window and come back
    // empty. Not fatal: the self-healing client retries on the next request.
    await new Promise((resolve) => setTimeout(resolve, 700));
    try {
      await this.client.ping();
    } catch {
      this.#log('warn', '连接后飞控尚未应答；后续请求将自动重试。');
    }

    this.helper = new MspHelper(this.client, { onLog: (level, m) => this.#log(level, m) });
    this.identifier = new FcIdentifier(this.helper, {
      seedMapPath: this.paths.seedMapPath,
      localMapPath: this.paths.localMapPath,
      onLog: (level, m) => this.#log(level, m),
    });
    this.settingsReader = new FcSettingsReader(this.helper, this.identifier, {
      backupDir: this.paths.backupDir,
      onLog: (level, m) => this.#log(level, m),
    });
    this.blackbox = new BlackboxManager(this.helper, this.identifier, {
      captureDir: this.paths.captureDir,
      onEvent: (e) => this.emit('event', { ...e, ts: Date.now() }),
      onLog: (level, m) => this.#log(level, m),
    });

    this.#log('info', `Connected to ${port}`);
    this.#state();
    return { ok: true, port };
  }

  async disconnect() {
    try {
      await this.client?.close();
    } finally {
      this.transport = null;
      this.client = null;
      this.helper = null;
      this.pendingApply = null;
      this.#log('info', 'Disconnected');
      this.#state();
    }
    return { ok: true };
  }

  #requireConnection() {
    if (!this.connected) throw new Error('not connected to a flight controller');
  }

  /* ---------------- workflow step 1 + 2 ---------------- */

  async identify() {
    this.#requireConnection();
    const identity = await this.identifier.identify();
    this.identity = identity;
    this.capabilities = this.identifier.capabilities;

    if (!identity.known) {
      this.guard.enterSafeMode('Unknown board - SAFE MODE (read-only analysis, no parameter writes)');
    }
    this.#state();
    return identity;
  }

  /**
   * Probes and caches capabilities.
   *
   * Named `probeCapabilities`, not `capabilities`: the cached result lives in
   * `this.capabilities`, and an instance property shadows a prototype method of
   * the same name - which silently made the Capabilities step throw
   * "session.capabilities is not a function".
   */
  async probeCapabilities() {
    this.#requireConnection();
    this.capabilities = await this.identifier.probeCapabilities();
    this.#state();
    return this.capabilities;
  }

  /** Reads everything AND writes the mandatory backup before any write is allowed. */
  async getSettings() {
    this.#requireConnection();
    if (!this.identity) await this.identify();

    const settings = await this.settingsReader.read({ identity: this.identity });
    this.settings = settings;
    this.guard.markBackup({ path: settings.backupPath, sha256: settings.backupSha256 });
    this.#state();
    return settings;
  }

  /**
   * The mandatory pre-write snapshot: `diff all` plus the settings the tune
   * actually consists of, stored under a name that says when, what board, what
   * firmware, what loop rate and why.
   */
  async backup({ note = '', pendingDiff = [] } = {}) {
    this.#requireConnection();
    const settings = await this.getSettings();

    // `get` with no argument lists every parameter in one round trip; fall back
    // to the explicit list if the firmware declines to dump them all.
    let settingsText = '';
    try {
      const { lines } = await this.client.cli('get', { timeoutMs: 20000 });
      settingsText = lines.join('\n');
    } catch (err) {
      this.#log('warn', `读取参数清单失败，改用逐项读取：${err.message}`);
    }
    const parsed = parseSettings(settingsText);
    if (Object.keys(parsed).length < 10) {
      const missing = await this.helper.cliGet(BACKUP_PARAMS).catch(() => ({}));
      settingsText = Object.entries({ ...parsed, ...missing })
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k} = ${v}`)
        .join('\n');
    }

    const info = this.identity ?? {};
    const entry = this.backupStore.create({
      diffAll: settings.diffAll ?? settings.dump ?? '',
      settings: settingsText,
      pendingDiff,
      previousId: this.backupStore.list()[0]?.id ?? null,
      connection: {
        board: this.#boardLabel(),
        bfVersion: info.version ?? null,
        pidHz: this.capabilities?.pidRateHz ?? null,
      },
      note,
    });

    this.guard.markBackup({ path: entry.dir, sha256: settings.backupSha256 });
    this.lastBackupId = entry.id;
    this.#log('info', `已创建备份 ${entry.id}`);
    return { ok: true, ...entry, path: entry.dir, sha256: settings.backupSha256 };
  }

  /** A reason writes are impossible right now, or null. */
  #mscBlock() {
    return this.inMsc
      ? '当前处于大容量存储模式（MSC）：请先弹出卷并给飞控重新上电，回到 MSP 连接后再写参数。'
      : null;
  }

  /* ---------------- large-log transfer (mass storage) ---------------- */

  /** Reboots the FC into mass-storage mode so its storage mounts in Finder. */
  async mscEnter() {
    this.#requireConnection();
    const res = await enterMsc(this.helper, { onLog: (l, m) => this.#log(l, m) });
    if (res.ok) {
      this.inMsc = true;
      this.#log('warn', '已进入 MSC 模式：在弹出卷并重新上电前，所有 MSP 写参均被禁用。');
    }
    return res;
  }

  /** Current MSC state plus any flight-controller volumes currently mounted. */
  mscStatus() {
    // The FC only answers MSP again after a power cycle, so a live link means
    // the operator has already come back.
    if (this.inMsc && this.client?.linkState === 'msp') this.inMsc = false;
    return { inMsc: this.inMsc, volumes: findFcVolumes() };
  }

  /** Copies logs off the mounted volume. Filesystem only - never MSP. */
  async mscImport({ volumePath = null, files = [] } = {}) {
    const target = volumePath || findFcVolumes()[0]?.path || null;
    const res = importLogs({ volumePath: target, files, destDir: this.paths.captureDir });
    if (res.ok) this.#log('info', `已从卷导入 ${res.imported.length} 个日志文件`);
    return res;
  }

  /** Ejects the volume; the FC then needs a power cycle to leave MSC. */
  async mscExit() {
    const volumePath = findFcVolumes()[0]?.path ?? null;
    const res = await exitMsc(volumePath);
    this.inMsc = false;
    return res;
  }

  /** Stable board label used in backup names and the restore safety check. */
  #boardLabel() {
    const info = this.identity ?? {};
    return info.boardName || info.targetName || info.boardIdentifier || null;
  }

  /** The change a re-fly is being judged against, or null. */
  #readLastChange() {
    try {
      const path = `${this.paths.userDataDir}/last-change.json`;
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  #recordLastChange(change) {
    try {
      mkdirSync(this.paths.userDataDir, { recursive: true });
      writeFileSync(
        `${this.paths.userDataDir}/last-change.json`,
        `${JSON.stringify({ at: new Date().toISOString(), ...change }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      this.#log('warn', `变更记录写入失败：${err.message}`);
    }
  }

  /**
   * Judges a post-change flight against the analysis that drove the change.
   *
   * When the verdict is a clear regression the previous tuning is restored
   * automatically from the backup taken before the write, and the reason is
   * reported alongside the numbers.
   */
  async evaluateReflight({ file = null, metrics = null, autoRollback = true } = {}) {
    const change = this.#readLastChange();
    if (!change) {
      return { ok: false, reason: '还没有写入过改动，没有可对比的基线' };
    }

    const baseline = change.baselineReportId ? await this.getReport(change.baselineReportId).catch(() => null) : null;
    if (!baseline?.metrics) {
      return { ok: false, reason: '找不到改动前的分析基线（报告可能已删除）' };
    }

    let after = metrics;
    if (!after) {
      if (!file) return { ok: false, reason: '需要一份复飞日志（file）或已计算的 metrics' };
      const decoded = await decodeBbl(file);
      const log = decoded.logs?.[0];
      if (!log) return { ok: false, reason: '复飞日志无法解析' };
      after = computeMetrics(log, { currentPid: this.settings?.pid ?? null, currentFilter: this.settings?.filter ?? null });
    }

    const verdict = compareRuns(baseline.metrics, after);

    let rollback = null;
    let rolledBack = false;
    if (verdict.shouldRollback && autoRollback && change.backupId) {
      this.#log('warn', `复飞判定变差，自动回退到备份 ${change.backupId}：${verdict.summary}`);
      rollback = await this.rollback({ id: change.backupId, requireConfirm: false, token: `auto-${change.backupId}` }).catch((err) => ({
        ok: false,
        reason: err.message,
      }));
      rolledBack = Boolean(rollback?.ok);
      this.#recordLastChange({ ...change, rolledBackAt: new Date().toISOString() });
    }

    const scorecardDelta = compareScorecards(
      baseline.metrics.scorecard || buildScorecard(baseline.metrics),
      after.scorecard || buildScorecard(after),
    );
    const quadId = change.quadId || this.#quadMeta(after).id;
    this.#journal({ id: quadId }, {
      kind: 'evaluate',
      verdict: verdict.verdict,
      summary: verdict.summary,
      rolledBack,
      appliedDiff: change.diff ?? [],
      baselineReportId: baseline.id ?? change.baselineReportId ?? null,
      scorecard: after.scorecard || buildScorecard(after),
      scorecardDelta,
    });

    return {
      ok: true,
      verdict: verdict.verdict,
      reasons: verdict.reasons,
      summary: verdict.summary,
      scorecardDelta,
      shouldRollback: verdict.shouldRollback,
      rolledBack,
      rollback,
      appliedDiff: change.diff ?? [],
      baselineId: baseline.id,
      backupId: change.backupId ?? null,
    };
  }

  /** Backups, newest first. */
  listBackups() {
    return { backups: this.backupStore.list() };
  }

  /**
   * Restores a snapshot with `diff all` only.
   *
   * Refuses when the board or the BF major version differs: a cross-board or
   * cross-generation restore silently rewrites parameters whose meaning moved.
   */
  async rollback({ id = null, requireConfirm = true, token = null } = {}) {
    this.#requireConnection();
    const mscBlock = this.#mscBlock();
    if (mscBlock) return { ok: false, reason: mscBlock };

    const entry = id ? this.backupStore.get(id) : this.backupStore.latest();
    if (!entry) return { ok: false, reason: '没有可用的备份' };

    const info = this.identity ?? {};
    const safety = rollbackSafety(entry.meta, {
      board: this.#boardLabel(),
      bfVersion: info.version ?? null,
    });
    if (!safety.ok) {
      return { ok: false, reason: safety.reasons.join('；'), blocked: safety.reasons };
    }

    const commands = extractSetCommands(entry.diffAll);
    if (!commands.length) return { ok: false, reason: '备份中没有可恢复的 set 命令' };

    const screen = this.guard.screenCommands(commands);
    if (screen.blocked.length) {
      return { ok: false, reason: `备份包含受保护参数：${screen.blocked.map((b) => b.param).join(', ')}` };
    }

    const dryRun = requireConfirm && !token;
    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        id: entry.meta.id,
        token: `rollback-${entry.meta.id}`,
        commands: screen.allowed,
        count: screen.allowed.length,
        reason: `将恢复 ${screen.allowed.length} 项到 ${entry.meta.createdAt}`,
      };
    }

    const { results } = await this.helper.cliRun(screen.allowed, { onProgress: () => {} });
    const errors = results.filter((r) => r.error);
    if (errors.length) {
      return { ok: false, reason: `恢复过程中飞控报错：${errors.map((e) => e.command).join(', ')}` };
    }
    await this.helper.cliSave();
    await this.client.reconnect({ delayMs: 2000 }).catch(() => {});

    // Read back so the operator sees what actually landed.
    const verified = await this.helper.cliGet(BACKUP_PARAMS).catch(() => ({}));
    const reportPath = this.#saveRollbackReport({ entry, applied: screen.allowed, verified });
    this.#log('info', `已回退到备份 ${entry.meta.id}（${screen.allowed.length} 项）`);

    return { ok: true, dryRun: false, applied: screen.allowed, verified, reportPath };
  }

  #saveRollbackReport({ entry, applied, verified }) {
    try {
      mkdirSync(this.paths.reportsDir, { recursive: true });
      const path = `${this.paths.reportsDir}/rollback-${entry.meta.id}.json`;
      writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), entry: entry.meta, applied, verified }, null, 2)}\n`, 'utf8');
      return path;
    } catch (err) {
      this.#log('warn', `回退报告写入失败：${err.message}`);
      return null;
    }
  }

  /* ---------------- CLI passthrough ---------------- */

  /**
   * Runs CLI commands with the safety screen applied.
   * dryRun (the default) reports what would be sent and writes nothing.
   */
  async runCli(commands = [], { dryRun = true, kind = 'logging' } = {}) {
    this.#requireConnection();

    const gate = this.guard.canWrite({ kind });
    const screen = this.guard.screenCommands(commands);
    if (screen.blocked.length) {
      return {
        ok: false,
        dryRun,
        lines: [],
        blocked: screen.blocked,
        reason: 'one or more commands are on the immutable safety list',
      };
    }
    if (!dryRun && !gate.ok) {
      return { ok: false, dryRun, lines: [], blocked: [], reason: gate.reasons.join('; ') };
    }
    if (dryRun) {
      return { ok: true, dryRun: true, lines: [], wouldSend: screen.allowed, blocked: [] };
    }

    const mscBlock = this.#mscBlock();
    if (mscBlock) return { ok: false, dryRun: false, lines: [], blocked: [], reason: mscBlock };

    const { results, lines } = await this.helper.cliRun(screen.allowed, {
      onProgress: (p) => this.#log('debug', `cli: ${p.command}`),
    });
    const errors = results.filter((r) => r.error);
    return { ok: errors.length === 0, dryRun: false, lines, results, errors };
  }

  /* ---------------- blackbox ---------------- */

  async blackboxConfig(opts) {
    this.#requireConnection();
    const result = await this.blackbox.configure(opts);
    this.#state();
    return result;
  }

  async blackboxErase(opts) {
    this.#requireConnection();
    return this.blackbox.erase(opts);
  }

  async blackboxDownload(opts) {
    this.#requireConnection();
    return this.blackbox.download(opts);
  }

  /* ---------------- analysis (works offline too) ---------------- */

  async decodeLog(file) {
    const { logs, stats } = await decodeBbl(file, { maxLogs: 8 });
    return { logs, stats };
  }

  async computeMetrics(file, { axis = null } = {}) {
    const { logs, stats } = await decodeBbl(file, { maxLogs: 8 });
    if (!logs.length) throw new Error('no decodable blackbox logs found in that file');

    // Analyse the longest log; short fragments from an interrupted download
    // would skew every aggregate metric.
    const log = logs.reduce((a, b) => (b.durationS > a.durationS ? b : a));
    const report = computeMetrics(log, {
      currentPid: this.settings?.pid || null,
      currentFilter: this.settings?.filter || null,
    });

    report.file = file;
    report.decodeStats = stats;

    this.metrics = report;
    // Kept so the optional AI agent can serialise the whole flight (channels,
    // header, time series) instead of only the derived numbers. Cleared when
    // the analysed file changes.
    this.lastLog = log;
    this.lastLogFile = file;
    this.guard.latchFaults(report.faults || []);
    if (axis) report.axisFilter = axis;

    this.#state();
    return report;
  }

  /* ---------------- tuning ---------------- */

  async proposeTune({ metrics = null, currentPid = null, currentFilter = null } = {}) {
    const report = metrics || this.metrics;
    if (!report) throw new Error('run bbl_metrics on a log first');

    // Live FC settings win; when the operator is analysing a log offline there
    // is no FC, so fall back to the configuration the log itself carries. That
    // is what turns "your filters may be off" into "75 Hz -> 120 Hz".
    const craft = report.craftSettings || {};
    const pid = currentPid || this.settings?.pid || craft.pid || null;
    const filter = currentFilter || this.settings?.filter || craft.filter || null;

    // Dynamic-D and I-term-relax decide whether propwash is fixed by raising
    // D_min (preferred, no extra motor heat) or by static D.
    const raw = this.settings?.raw ?? {};
    const numeric = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const dynamics = {
      dMin: {
        roll: numeric(raw.d_min_roll),
        pitch: numeric(raw.d_min_pitch),
        yaw: numeric(raw.d_min_yaw),
      },
      dMinBoostGain: numeric(raw.d_min_boost_gain),
      // Live read-back first, then whatever the log's own header recorded.
      itermRelaxCutoff: numeric(raw.iterm_relax_cutoff) ?? craft.dynamics?.itermRelaxCutoff ?? null,
      antiGravityGain: numeric(raw.anti_gravity_gain) ?? craft.dynamics?.antiGravityGain ?? null,
      // TPA: the high-throttle heat lever. The rule refuses to build a diff
      // without the live read-back, so these must travel with the analysis
      // input - without them the finding is permanently advisory on hardware.
      // tpa_mode stays a string ('D' / 'PD'); it decides whether the
      // attenuation hits D only or P and D together.
      tpaRate: numeric(raw.tpa_rate),
      tpaBreakpoint: numeric(raw.tpa_breakpoint),
      tpaMode: typeof raw.tpa_mode === 'string' ? raw.tpa_mode : null,
    };

    const ruleInput = {
      metrics: report,
      currentPid: pid,
      currentFilter: filter,
      capabilities: this.capabilities,
      dynamics,
    };
    // The campaign plan reads every finding, not just the three shown.
    const collected = collectProposals(ruleInput);
    const plan = planCampaign({
      metrics: report,
      proposals: collected.blocking || [...collected.kept, ...(collected.gap ? [collected.gap] : [])],
    });
    const proposals = annotateStages(proposeTune(ruleInput), plan);

    // Annotate each proposal with the live safety gate so the UI can disable
    // the apply button with a real reason rather than guessing.
    const annotated = proposals.map((p) => {
      const gate = this.guard.guardProposal(p);
      return { ...p, applyGate: { ok: gate.ok, reasons: gate.reasons }, writableDiff: gate.writableDiff };
    });

    this.lastProposal = annotated[0] || null;
    // Kept so the optional AI review can see what the rule engine already
    // concluded (agree / disagree / add) instead of re-deriving it blind.
    this.lastProposalsForAi = annotated;

    // History: persist the analysis + proposals so the 历史报告 page can reopen
    // them. The return value stays a bare array (renderer contract).
    const reportId = this.#saveReport(report, annotated);
    if (reportId) {
      this.lastReportId = reportId;
      this.#log('info', `分析报告已存档：${reportId}`);
    }

    const scorecard = report.scorecard || buildScorecard(report);
    const quad = this.#quadMeta(report);
    this.lastPlan = { plan, scorecard, quadId: quad.id, reportId };
    this.#journal(quad, {
      kind: 'analysis',
      reportId,
      file: report.file || null,
      scorecard,
      stage: plan.current,
      summary: plan.summary,
      missing: report.evidence?.missing || [],
      faults: (report.faults || []).filter((f) => f.severity !== 'info').map((f) => f.code),
      proposals: annotated.map((p) => ({ id: p.id, stage: p.stage ?? null, diff: p.diff || [] })),
    });

    return annotated;
  }

  /* ---------------- AI agent analysis (optional) ---------------- */

  /** Stored AI settings, key redacted down to a boolean. */
  getAiConfig() {
    return publicAiConfig(readAiConfig(this.paths.aiConfigPath));
  }

  /** Patch the AI settings. An empty `apiKey` leaves the stored one untouched. */
  setAiConfig(patch = {}) {
    const current = readAiConfig(this.paths.aiConfigPath);
    const next = writeAiConfig(this.paths.aiConfigPath, { ...current, ...patch });
    this.#log('info', `AI 设置已保存：${next.model || '未指定模型'} @ ${next.baseUrl || '未指定地址'}${next.enabled ? '' : '（未启用）'}`);
    return publicAiConfig(next);
  }

  /**
   * Build the analysis pack that would be sent for a given detail level.
   *
   * Kept separate so the operator can inspect/export exactly what the model
   * would receive before spending a request on it.
   */
  buildAiPack({ metrics = null, level = 'standard' } = {}) {
    const report = metrics || this.metrics || null;
    if (!report) throw new Error('run bbl_metrics on a log first');
    const log = this.lastLog && this.lastLogFile === (report.file || this.lastLogFile) ? this.lastLog : this.lastLog;
    const pack = buildEvidencePack({
      metrics: report,
      craftSettings: report.craftSettings || null,
      proposals: this.lastProposalsForAi || [],
      identity: this.identity || null,
      header: log?.header || null,
      log,
      level,
    });
    return { pack, chars: packSizeChars(pack) };
  }

  /**
   * Export the pack + prompt to a text file.
   *
   * Lets the operator hand the *complete* log summary to any assistant that
   * accepts an attachment, without this app holding an API key for it.
   */
  async exportAiPack({ metrics = null, level = 'full', filePath = null } = {}) {
    const { pack, chars } = this.buildAiPack({ metrics, level });
    if (!filePath) throw new Error('a destination path is required');
    const prompt = buildUserPrompt(pack);
    const text = [
      `# BF-AITuner AI 分析包 / analysis pack`,
      `# level: ${pack.level}   chars: ${chars}`,
      `# generated: ${new Date().toISOString()}`,
      `# 用法：把本文件内容整段粘贴给任意大模型，或作为附件上传。`,
      '',
      '===== SYSTEM =====',
      AI_SYSTEM_PROMPT,
      '',
      '===== USER =====',
      prompt,
      '',
    ].join('\n');
    await writeFile(filePath, text, 'utf8');
    this.#log('info', `AI 分析包已导出：${filePath}（${level} 档，${Math.round(text.length / 1024)} KB）`);
    return { path: filePath, level: pack.level, chars: text.length, packBytes: chars };
  }

  /**
   * Run the optional AI review over an already-measured report.
   *
   * The rules measured; the model reasons. Nothing is written to the FC here -
   * the return value is advisory text plus screened diffs, and applying is
   * still the separate two-phase flow.
   */
  async aiAnalyze({ metrics = null, file = null, level = 'standard' } = {}) {
    const config = readAiConfig(this.paths.aiConfigPath);
    if (!config.enabled) throw new Error('AI 分析未启用，请先在设置里打开并填写 API key / AI disabled');
    if (!config.apiKey) throw new Error('未配置 API key / no API key configured');

    const report = metrics || (this.metrics ? this.metrics : null);
    if (!report) throw new Error('run bbl_metrics on a log first');

    const { pack, chars } = this.buildAiPack({ metrics: report, level });

    this.#log(
      'info',
      `AI 分析中：${config.model} @ ${config.baseUrl}（${pack.level} 档，${Math.round(chars / 1024)} KB 分析包；原始 .bbl 不上传）`,
    );
    const started = Date.now();
    const result = await runAiAnalysis({ config, pack });
    const elapsedMs = Date.now() - started;
    this.#log(
      result.ok ? 'info' : 'warn',
      result.ok
        ? `AI 分析完成：${result.proposals.length} 条建议（${elapsedMs} ms，模型 ${result.model || config.model}）`
        : `AI 分析失败：${result.error}`,
    );

    const saved = {
      ...result,
      file: file || report.file || null,
      elapsedMs,
      packLevel: pack.level,
      packChars: chars,
      provider: { baseUrl: config.baseUrl, model: config.model },
    };
    if (result.ok) {
      // Keep them for the next run so the model can see its own prior findings.
      this.lastProposalsForAi = result.proposals;
    }
    return saved;
  }

  /**
   * Two-phase apply.
   *
   * Phase 1 (requireConfirm, no token): validates and returns a dry-run diff
   * plus a single-use token. Nothing is written.
   * Phase 2 (token supplied): re-validates the token, re-checks the safety
   * gate, screens every command, writes them, then persists with `save`.
   */
  async applyTune({ proposalId = null, diff = null, requireConfirm = true, token = null, proposal = null } = {}) {
    this.#requireConnection();
    const mscBlockTune = this.#mscBlock();
    if (mscBlockTune) return { applied: false, dryRun: true, cliSent: [], diff: [], reason: mscBlockTune };

    const target = proposal || this.#findProposal(proposalId);
    const proposedDiff = diff || target?.diff || [];

    if (!proposedDiff.length) {
      return { applied: false, dryRun: true, cliSent: [], diff: [], reason: 'nothing to apply' };
    }

    // --- phase 1: dry run + token ---
    if (requireConfirm && !token) {
      const gate = target ? this.guard.guardProposal(target) : { ok: true, reasons: [], writableDiff: proposedDiff };
      const { allowed, blocked } = filterDiff(proposedDiff);
      const writable = gate.writableDiff?.length ? gate.writableDiff : allowed;

      if (blocked.length) {
        return {
          applied: false,
          dryRun: true,
          cliSent: [],
          diff: proposedDiff,
          reason: `refused: ${blocked.map((b) => `${b.param} (${b.reason})`).join('; ')}`,
        };
      }

      const commands = writable.map((d) => `set ${d.param} = ${d.to}`);
      const newToken = randomToken();
      this.pendingApply = {
        token: newToken,
        proposalId: target?.id || proposalId,
        commands,
        diff: writable,
        createdAt: Date.now(),
      };

      this.#log('info', `Apply dry-run prepared ${commands.length} command(s); awaiting confirmation`);
      return {
        applied: false,
        dryRun: true,
        cliSent: [],
        wouldSend: commands,
        diff: writable,
        token: newToken,
        gate,
      };
    }

    // --- phase 2: write ---
    const pending = this.pendingApply;
    if (requireConfirm) {
      if (!pending || token !== pending.token) {
        return { applied: false, dryRun: false, cliSent: [], diff: [], reason: 'confirmation token is missing, stale or incorrect' };
      }
      if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
        this.pendingApply = null;
        return { applied: false, dryRun: false, cliSent: [], diff: [], reason: 'confirmation token expired; re-run the dry run' };
      }
      if (!this.guard.backupDone) {
        return { applied: false, dryRun: false, cliSent: [], diff: [], reason: 'no verified backup on disk; refusing to write' };
      }
    }

    const commands = pending?.commands || proposedDiff.map((d) => `set ${d.param} = ${d.to}`);
    const screen = this.guard.screenCommands(commands);
    if (screen.blocked.length) {
      return {
        applied: false,
        dryRun: false,
        cliSent: [],
        diff: proposedDiff,
        reason: `refused: ${screen.blocked.map((b) => `${b.command} - ${b.reason}`).join('; ')}`,
      };
    }

    const gate = this.guard.canWrite({ kind: 'tune' });
    if (!gate.ok) {
      return { applied: false, dryRun: false, cliSent: [], diff: proposedDiff, reason: gate.reasons.join('; ') };
    }

    // Re-read the live values so a stale proposal cannot write a wrong number.
    const paramNames = screen.allowed.map((c) => /^set\s+([a-z0-9_]+)/i.exec(c)?.[1]).filter(Boolean);
    const live = await this.helper.cliGet(paramNames).catch(() => ({}));
    const drift = this.guard.verifyAgainstLive(pending?.diff || proposedDiff, live);
    if (!drift.ok) {
      this.#log('warn', `Live values drifted since the proposal was built: ${JSON.stringify(drift.mismatches)}`);
    }

    // `set` writes the live values; `save` is what persists them to EEPROM.
    // Without it the tuning is lost on the next reboot - and the FC does reboot
    // (MSC entry, power cycle, the verification flight's own disconnect), so the
    // operator would fly the old values while the UI reported success.
    // Same shape as applyBidir: the audited batch always ends with save.
    const commandsToSend = [...screen.allowed, 'save'];
    this.#log('warn', `Writing ${screen.allowed.length} parameter(s) to the flight controller...`);
    const result = await this.runCli(commandsToSend, { dryRun: false, kind: 'tune' });

    if (!result.ok) {
      return {
        applied: false,
        dryRun: false,
        cliSent: commandsToSend,
        diff: pending?.diff || proposedDiff,
        reason: `flight controller rejected the write: ${(result.errors || []).map((e) => e.command).join(', ') || result.reason}`,
      };
    }

    this.guard.recordWrite(target?.id || proposalId, commandsToSend);
    this.pendingApply = null;
    this.#recordLastChange({
      proposalId: target?.id || proposalId || null,
      diff: pending?.diff || proposedDiff,
      backupId: this.lastBackupId,
      baselineReportId: this.lastReportId,
      quadId: this.lastPlan?.quadId ?? null,
    });
    if (this.lastPlan?.quadId) {
      this.#journal({ id: this.lastPlan.quadId }, {
        kind: 'apply',
        proposalId: target?.id || proposalId || null,
        stage: target?.stage ?? null,
        diff: pending?.diff || proposedDiff,
        backupId: this.lastBackupId,
        baselineReportId: this.lastReportId,
      });
    }

    // Reflect the write in the cached settings so later diffs are correct.
    if (this.settings?.raw) {
      for (const d of pending?.diff || proposedDiff) this.settings.raw[d.param] = d.to;
    }
    this.#state();

    return {
      applied: true,
      dryRun: false,
      cliSent: commandsToSend,
      diff: pending?.diff || proposedDiff,
      drift: drift.ok ? null : drift.mismatches,
      preWriteBackupPath: this.guard.backupPath,
      lines: result.lines,
    };
  }

  #findProposal(proposalId) {
    if (!proposalId) return null;
    if (this.lastProposal?.id === proposalId) return this.lastProposal;
    return null;
  }

  /* ---------------- link health ---------------- */

  /** One MSP round trip, used by the UI auto-debug loop. */
  async ping() {
    this.#requireConnection();
    return this.client.ping();
  }

  /** Force a close / wait / reopen cycle and report whether MSP came back. */
  async reconnect() {
    if (!this.client) throw new Error('not connected to a flight controller');
    const ok = await this.client.reconnect({ delayMs: 2000 });
    this.#state();
    return { ok, linkState: this.client.linkState, recoveries: this.client.recoveries };
  }

  /** Advanced override for an unrecognised board; tuning stays locked. */
  async forceTrust() {
    const result = this.guard.forceTrust();
    this.#state();
    return result;
  }

  /** Reads the live blackbox configuration (allowed in SAFE MODE). */
  async blackboxReadConfig() {
    this.#requireConnection();
    return this.blackbox.readConfig();
  }

  /* ---------------- bidirectional DShot / RPM ---------------- */

  /**
   * Runs the full bidirectional DShot/RPM probe. Read-only: suggestions come
   * back as `suggestedCli` and nothing is written to the flight controller.
   */
  async probeBidirDshot() {
    this.#requireConnection();
    const probe = await this.identifier.probeBidirDshot();
    this.bidir = probe;
    this.#state();
    return probe;
  }

  /* ---------------- bidirectional DShot / RPM scoped writes ---------------- */

  /**
   * The ONLY write path for dshot_bidir / motor_poles / rpm_filter_*.
   *
   * These parameters are dangerous, so the generic paths (manual CLI box,
   * proposal diffs) keep them on the immutable list. This scoped path exists
   * because the operator explicitly asked for a dry-run -> confirm -> CLI save
   * flow for exactly this audited set:
   *
   *   1. commands are screened against the bidir whitelist - anything else is
   *      refused and reported, never sent;
   *   2. a verified dump backup must exist on disk;
   *   3. phase 1 returns a dry-run diff plus a single-use token;
   *   4. phase 2 (explicit confirmation with that token) writes via CLI and
   *      then persists with `save`.
   */
  async applyBidir({ commands = [], requireConfirm = true, token = null } = {}) {
    this.#requireConnection();
    const mscBlockBidir = this.#mscBlock();
    if (mscBlockBidir) return { ok: false, reason: mscBlockBidir };

    const allowed = [];
    const blocked = [];
    for (const raw of commands) {
      const command = String(raw || '').trim();
      if (!command) continue;
      const match = /^set\s+([a-z0-9_]+)\s*=/.exec(command);
      if (match && /^(dshot_bidir|motor_poles|rpm_filter_(harmonics|q|min_hz))$/.test(match[1])) {
        allowed.push(command);
      } else {
        blocked.push({ command, reason: '不在双向DShot/RPM 白名单内（仅 dshot_bidir / motor_poles / rpm_filter_*）' });
      }
    }

    if (!allowed.length) {
      return { applied: false, dryRun: true, blocked, reason: blocked.length ? 'no whitelisted commands' : 'nothing to apply' };
    }

    if (!this.guard.backupDone) {
      return { applied: false, dryRun: true, blocked, reason: '尚未生成完整 dump 备份：拒绝写入' };
    }

    // --- phase 1: dry run + token ---
    if (requireConfirm && !token) {
      const newToken = randomToken();
      this.pendingBidirApply = { token: newToken, commands: allowed, createdAt: Date.now() };
      const diff = allowed.map((command) => {
        const m = /^set\s+([a-z0-9_]+)\s*=\s*(.+)$/.exec(command);
        return { param: m[1], to: m[2].trim() };
      });
      this.#log('info', `双向DShot/RPM dry-run 已就绪（${allowed.length} 条），等待确认`);
      return { applied: false, dryRun: true, wouldSend: allowed, diff, token: newToken, blocked };
    }

    // --- phase 2: confirmed write ---
    const pending = this.pendingBidirApply;
    if (requireConfirm) {
      if (!pending || token !== pending.token) {
        return { applied: false, dryRun: false, blocked, reason: '确认令牌缺失、过期或不匹配' };
      }
      if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
        this.pendingBidirApply = null;
        return { applied: false, dryRun: false, blocked, reason: '确认令牌已过期，请重新 dry-run' };
      }
    }
    this.pendingBidirApply = null;

    const sendList = pending?.commands || allowed;
    this.#log('warn', `写入双向DShot/RPM 设置（用户已确认）：${sendList.join(' ; ')}`);
    const result = await this.runCli([...sendList, 'save'], { dryRun: false, kind: 'logging' });

    return {
      applied: result.ok,
      dryRun: false,
      cliSent: [...sendList, 'save'],
      diff: sendList.map((command) => {
        const m = /^set\s+([a-z0-9_]+)\s*=\s*(.+)$/.exec(command);
        return { param: m[1], to: m[2].trim() };
      }),
      blocked,
      lines: result.lines,
      reason: result.ok ? undefined : result.reason,
    };
  }

  /* ---------------- tuning journal (per quad) ---------------- */

  /**
   * Which craft a report belongs to: the connected FC's craft name / board
   * when there is one, else what the log header recorded.
   */
  #quadMeta(report) {
    const craftName = this.identity?.craftName || report?.craft?.name || null;
    const board = this.identity?.boardName || this.identity?.boardIdentifier || report?.craft?.board || null;
    const firmware = this.identity?.version || report?.craft?.firmware || null;
    return { id: quadIdFor({ craftName, board }), craftName, board, firmware };
  }

  /** Append to the journal; a failure is logged, never thrown into the tune path. */
  #journal(quad, entry) {
    try {
      this.journal.append(quad.id, entry, quad);
    } catch (err) {
      this.#log('warn', `调参档案写入失败：${err.message}`);
    }
  }

  /** Campaign plan + scorecard from the latest proposeTune. */
  getPlan() {
    return this.lastPlan || { plan: null, scorecard: null, quadId: null, reportId: null };
  }

  listQuads() {
    return { quads: this.journal.list() };
  }

  getQuad(id) {
    const quad = this.journal.get(id);
    if (!quad) throw new Error('no journal for this quad yet');
    return { quad };
  }

  setQuadProfile(id, patch) {
    return { profile: this.journal.setProfile(id, patch) };
  }

  addQuadNote(id, text) {
    return { entry: this.journal.addNote(id, text) };
  }

  /* ---------------- report history ---------------- */

  #saveReport(metrics, proposals) {
    try {
      mkdirSync(this.paths.reportsDir, { recursive: true });
      const id = `report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const payload = {
        id,
        savedAt: new Date().toISOString(),
        file: metrics.file || null,
        summary: {
          durationS: metrics.durationS ?? null,
          sampleRateHz: metrics.sampleRateHz ?? null,
          sampleQuality: metrics.sampleQuality ?? null,
          dropRatePct: metrics.dropRatePct ?? null,
          blocksTuning: metrics.blocksTuning ?? false,
          faults: (metrics.faults || []).map((f) => f.code),
          proposalCount: proposals.length,
        },
        metrics,
        proposals,
      };
      writeFileSync(`${this.paths.reportsDir}/${id}.json`, `${JSON.stringify(payload)}\n`, 'utf8');
      return id;
    } catch (err) {
      this.#log('warn', `报告落盘失败：${err.message}`);
      return null;
    }
  }

  async listReports() {
    try {
      mkdirSync(this.paths.reportsDir, { recursive: true });
      const reports = [];
      for (const entry of readdirSync(this.paths.reportsDir)) {
        if (!entry.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(readFileSync(`${this.paths.reportsDir}/${entry}`, 'utf8'));
          reports.push({ id: raw.id || entry.slice(0, -5), savedAt: raw.savedAt, file: raw.file, summary: raw.summary });
        } catch {
          /* skip corrupt entries */
        }
      }
      reports.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
      return { reports };
    } catch (err) {
      return { reports: [], error: err.message };
    }
  }

  async getReport(id) {
    // id is a path component: strict shape check prevents traversal.
    if (typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(id)) {
      throw new Error('invalid report id');
    }
    const report = JSON.parse(readFileSync(`${this.paths.reportsDir}/${id}.json`, 'utf8'));
    return { report };
  }

  /* ---------------- status ---------------- */

  status() {
    return {
      connected: this.connected,
      linkState: this.client?.linkState ?? 'down',
      linkHealthy: this.client?.isHealthy ?? false,
      recoveries: this.client?.recoveries ?? 0,
      port: this.transport?.path || null,
      hasIdentity: Boolean(this.identity),
      hasSettings: Boolean(this.settings),
      hasMetrics: Boolean(this.metrics),
      bidir: this.bidir
        ? {
            protocol: this.bidir.protocol,
            bidirOn: this.bidir.bidirOn,
            motorPoles: this.bidir.motorPoles,
            escSupported: this.bidir.escSupported,
            confidence: this.bidir.confidence,
            conclusion: this.bidir.conclusion,
            powerState: this.bidir.powerState,
          }
        : null,
      safety: this.guard.status,
    };
  }
}

function randomToken() {
  return `confirm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default Session;
