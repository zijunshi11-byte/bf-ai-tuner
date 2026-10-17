/**
 * Reads the craft's actual PID / filter configuration out of a Blackbox header.
 *
 * Why this exists: offline analysis has no flight controller to ask, so the
 * rules had no "current value" to build a concrete `from -> to` change from -
 * which is why the advice read as vague and why filter findings never fired.
 * Betaflight logs its own settings in the header, so the log is self-describing.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** `"34,60,15"` -> `[34, 60, 15]`. */
function nums(value, count) {
  const parts = String(value ?? '')
    .split(',')
    .map((v) => Number(String(v).trim()));
  if (parts.length < count) return null;
  if (parts.slice(0, count).some((v) => !Number.isFinite(v))) return null;
  return parts;
}

function num(value) {
  const raw = String(value ?? '').trim();
  // '' must stay "unknown": Number('') is 0, and a filter silently read as
  // 0 Hz would look like a badly mis-set parameter rather than a missing one.
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The first value of a `a,b` header pair. */
function first(value) {
  const parts = String(value ?? '').split(',');
  return num(parts[0]);
}

/**
 * Current PID gains. Feedforward is only meaningful when the log carries an
 * explicit FF gain; `ff_weight` is a scaling percentage, not a gain, so it is
 * deliberately not mapped onto F.
 */
export function readPid(header = {}) {
  const roll = nums(header.rollPID, 3);
  const pitch = nums(header.pitchPID, 3);
  const yaw = nums(header.yawPID, 3);
  if (!roll || !pitch || !yaw) return null;
  return {
    roll: { P: roll[0], I: roll[1], D: roll[2] },
    pitch: { P: pitch[0], I: pitch[1], D: pitch[2] },
    yaw: { P: yaw[0], I: yaw[1], D: yaw[2] },
  };
}

/**
 * Current filter configuration, in the same shape the rules expect.
 * Dynamic ranges are reported alongside the static value because a dynamic
 * low-pass is what a racing quad actually flies.
 */
export function readFilter(header = {}) {
  const gyroLpf1 = first(header.gyro_lpf1_static_hz);
  const dtermLpf1 = first(header.dterm_lpf1_static_hz);
  const dynNotchCount = num(header.dyn_notch_count);
  const rpmHarmonics = num(header.rpm_filter_harmonics);
  const bidir = num(header.dshot_bidir);
  const gyroDyn = nums(header.gyro_lpf1_dyn_hz, 2);
  const dtermDyn = nums(header.dterm_lpf1_dyn_hz, 2);
  const gyroNotch = nums(header.gyro_notch_hz, 2);

  return {
    gyroLpf1Hz: gyroLpf1,
    gyroLpf1DynMinHz: gyroDyn ? gyroDyn[0] : null,
    gyroLpf1DynMaxHz: gyroDyn ? gyroDyn[1] : null,
    gyroLpf2Hz: num(header.gyro_lpf2_static_hz),
    dtermLpf1Hz: dtermLpf1,
    dtermLpf1DynMinHz: dtermDyn ? dtermDyn[0] : null,
    dtermLpf1DynMaxHz: dtermDyn ? dtermDyn[1] : null,
    dtermLpf2Hz: num(header.dterm_lpf2_static_hz),
    dtermNotchHz: first(header.dterm_notch_hz) ?? 0,
    gyroNotch1Hz: gyroNotch ? gyroNotch[0] : 0,
    gyroNotch1CutoffHz: first(header.gyro_notch_cutoff) ?? 0,
    dynamicNotchEnabled: (dynNotchCount ?? 0) > 0,
    dynamicNotchCount: dynNotchCount ?? 0,
    dynamicNotchQ: num(header.dyn_notch_q) ?? 0,
    dynamicNotchMinHz: num(header.dyn_notch_min_hz) ?? 0,
    dynamicNotchMaxHz: num(header.dyn_notch_max_hz) ?? 0,
    rpmFilterHarmonics: rpmHarmonics ?? 0,
    rpmFilterQ: num(header.rpm_filter_q) ?? 0,
    rpmFilterMinHz: num(header.rpm_filter_min_hz) ?? 0,
    // The RPM filter needs bidirectional DShot; harmonics > 0 with bidir off
    // means the filter is configured but does nothing at all.
    bidirDshot: bidir === 1,
    rpmFilterActive: (rpmHarmonics ?? 0) > 0 && bidir === 1,
    // Carried here as well as in `dynamics` because the filter rules read the
    // configuration through one normalised shape.
    itermRelaxCutoff: num(header.iterm_relax_cutoff),
    antiGravityGain: num(header.anti_gravity_gain),
    tpaRate: num(header.tpa_rate),
    tpaBreakpoint: num(header.tpa_breakpoint),
  };
}

/** Dynamic-D floor / I-term relax / TPA - the levers propwash advice uses. */
export function readDynamics(header = {}) {
  return {
    dMax: nums(header.d_max, 3),
    dMaxGain: num(header.d_max_gain),
    dMaxAdvance: num(header.d_max_advance),
    itermRelax: num(header.iterm_relax),
    itermRelaxType: num(header.iterm_relax_type),
    itermRelaxCutoff: num(header.iterm_relax_cutoff),
    antiGravityGain: num(header.anti_gravity_gain),
    tpaRate: num(header.tpa_rate),
    tpaBreakpoint: num(header.tpa_breakpoint),
    tpaMode: num(header.tpa_mode),
  };
}

/** Loop / logging rates, used for the 2 kHz back-calculation and evidence. */
export function readRates(header = {}) {
  const looptime = num(header.looptime);
  const pidDenom = num(header.pid_process_denom) || 1;
  const pidHz = looptime && looptime > 0 ? Math.round(1_000_000 / (looptime * pidDenom)) : null;
  return { looptimeUs: looptime, pidHz };
}

/**
 * Everything the rules need, read from one header.
 * Returns null sections rather than throwing when a field is absent - older
 * logs simply do not carry all of it.
 */
export function readCraftSettings(header = {}) {
  return {
    pid: readPid(header),
    filter: readFilter(header),
    dynamics: readDynamics(header),
    rates: readRates(header),
    motorPoles: num(header.motor_poles),
    source: 'blackbox-header',
  };
}

export default { readCraftSettings, readPid, readFilter, readDynamics, readRates };
