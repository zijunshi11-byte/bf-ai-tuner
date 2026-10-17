/**
 * Tuning campaign: the order a 5-inch racing tune is done in, and where this
 * log puts the quad on that path.
 *
 *   logging -> mechanical -> filters -> P/D balance -> feel (FF, I, TPA)
 *
 * Each stage depends on the one before: PID numbers measured through a
 * noisy or mis-filtered gyro describe the noise, not the loop, and no filter
 * or PID change fixes a chipped prop. The planner is advisory ("propose, don't
 * decide"): it annotates every proposal with its stage and says which stage to
 * work on now; the write path, step limits and one-round-per-session limit are
 * unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const STAGES = Object.freeze([
  Object.freeze({
    id: 'logging',
    title: '记录设置',
    goal: '日志要能看到原始陀螺噪声：≥ 1 kHz 记录、含 gyroUnfilt；有 eRPM 更好',
    domains: ['logging'],
  }),
  Object.freeze({
    id: 'mechanical',
    title: '机械',
    goal: '没有失步、削波、剧烈振动、桨不平衡；机架共振已被滤掉或已加固',
    domains: [],
  }),
  Object.freeze({
    id: 'filters',
    title: '滤波',
    goal: '噪声带被充分衰减，且不多花一点延迟',
    domains: ['noise'],
  }),
  Object.freeze({
    id: 'pd',
    title: 'P/D 平衡',
    goal: '跟手、无明显超调与洗桨，电机不烫',
    domains: ['steps', 'propwash'],
  }),
  Object.freeze({
    id: 'feel',
    title: '手感（FF / I / TPA）',
    goal: '打杆无延迟感，收放油门稳，高油门不发热',
    domains: ['tracking'],
  }),
]);

const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

/** Which stage a proposal belongs to, from its rule id and category. */
export function stageOf(p) {
  const id = String(p?.id || '');
  if (id === 'evidence-gap') return null;
  if (p?.category === 'hardware' || /^(fault|warn)-/.test(id)) return 'mechanical';
  if (/^(feedforward-lag|i-(high|low)|tpa-|filter-iterm-relax)/.test(id)) return 'feel';
  if (/^(overshoot|sluggish|propwash|tf-tune)-/.test(id)) return 'pd';
  if (p?.category === 'filter' || /^filter-/.test(id)) return 'filters';
  if (p?.category === 'pid') return 'pd';
  return null;
}

const MECHANICAL_FAULTS = new Set(['MOTOR_DESYNC', 'SEVERE_VIBRATION', 'GYRO_CLIPPING', 'GYRO_ABSENT', 'LOG_TRUNCATED', 'PROP_IMBALANCE']);

function mechanicalIssues(metrics) {
  const issues = [];
  for (const f of metrics?.faults || []) {
    if (MECHANICAL_FAULTS.has(f.code)) issues.push({ code: f.code, blocks: Boolean(f.blocksTuning), evidence: f.evidence });
    if (f.code === 'FRAME_RESONANCE' && f.severity === 'warn') issues.push({ code: f.code, blocks: false, evidence: f.evidence });
  }
  return issues;
}

/**
 * @param {{metrics:object, proposals:object[]}} input  proposals = the full,
 *   un-truncated rule output (proposeTune shows at most three of them).
 * @returns {{stages:object[], current:string|null, summary:string}}
 */
export function planCampaign({ metrics, proposals = [] } = {}) {
  const missing = new Set(metrics?.evidence?.missing || []);
  const withheld = proposals.find((p) => p?.id === 'evidence-gap')?.withheld || [];
  const byStage = Object.fromEntries(STAGES.map((s) => [s.id, []]));
  for (const p of proposals) {
    const stage = stageOf(p);
    if (stage) byStage[stage].push(p);
  }
  for (const w of withheld) {
    const stage = stageOf({ id: w.id, category: /^filter-/.test(w.id) ? 'filter' : 'pid' });
    if (stage) byStage[stage].push({ id: w.id, withheld: true, domains: w.domains });
  }

  const mech = mechanicalIssues(metrics);
  const stages = STAGES.map((s) => {
    const items = byStage[s.id];
    const actions = items.filter((p) => !p.withheld && Array.isArray(p.diff) && p.diff.length > 0);
    const advisories = items.filter((p) => !p.withheld && !(Array.isArray(p.diff) && p.diff.length > 0));
    const held = items.filter((p) => p.withheld);
    const shortDomains = s.domains.filter((d) => missing.has(d));
    let status;
    if (s.id === 'mechanical') {
      status = mech.some((m) => m.blocks) ? 'blocked' : mech.length ? 'check' : 'ok';
    } else if (actions.length) status = 'action';
    else if (held.length || shortDomains.length === s.domains.length && s.domains.length) status = 'needs-data';
    else if (advisories.some((p) => p.category !== 'none' && p.id !== 'filter-assessment')) status = 'check';
    else status = 'ok';
    return {
      id: s.id,
      title: s.title,
      goal: s.goal,
      status,
      actions: actions.map((p) => p.id),
      advisories: advisories.map((p) => p.id),
      withheld: held.map((p) => p.id),
      shortDomains,
      issues: s.id === 'mechanical' ? mech : [],
    };
  });

  // Current = the first stage that still has something to do. 'needs-data'
  // on a later stage does not hold up an earlier one.
  const pending = stages.find((s) => s.status !== 'ok');
  const current = pending ? pending.id : null;
  let summary;
  if (!current) summary = '各阶段都没有需要改动的地方：按当前参数继续飞，下一次调参从复飞评估开始。';
  else {
    const s = stages[STAGE_INDEX[current]];
    const verb = {
      blocked: '先修硬件，本轮不改任何飞行参数',
      check: '先检查并处理提示的问题',
      action: `应用本阶段建议（${s.actions.length} 条），复飞后再进入下一阶段`,
      'needs-data': '先补飞，收集本阶段所需数据',
    }[s.status];
    summary = `当前阶段：${s.title}——${verb}。`;
  }
  return { stages, current, summary };
}

/**
 * Annotate proposals with their stage and, for proposals from a later stage
 * than the current one, a note saying what to finish first. Never changes
 * diffs, safeToApply or blockedBy.
 */
export function annotateStages(proposals, plan) {
  const currentIndex = plan?.current ? STAGE_INDEX[plan.current] : -1;
  return proposals.map((p) => {
    const stage = stageOf(p);
    if (!stage) return p;
    const out = { ...p, stage };
    if (currentIndex >= 0 && STAGE_INDEX[stage] > currentIndex) {
      out.stageNote = `建议先完成「${STAGES[currentIndex].title}」阶段，再处理这一条（${STAGES[STAGE_INDEX[stage]].title}）。`;
    }
    return out;
  });
}

export default { STAGES, stageOf, planCampaign, annotateStages };
