/**
 * Mass-storage (MSC) mode for pulling logs that are too large to read over MSP.
 *
 * Real behaviour, confirmed against the firmware (`cliMsc` in cli.c):
 *
 *   1. The CLI command `msc` prints "# Restarting in mass storage mode" and
 *      calls `systemResetToMsc()`, which REBOOTS the flight controller.
 *   2. The onboard storage then enumerates as a USB volume. macOS mounts it
 *      under /Volumes.
 *   3. There is no CLI command to leave: the volume is ejected and the FC is
 *      power-cycled (or unplugged and replugged).
 *
 * While the FC is in MSC the serial port is gone, so MSP is impossible. That
 * is why entering this mode is treated as a state the whole app must respect:
 * every write path is blocked until the operator comes back.
 */

import { existsSync, readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { execFile } from 'node:child_process';

/** Volumes that look like flight-controller storage rather than a disk image. */
export const FC_VOLUME_PATTERN = /betaflight|bf_?flash|onboard|blackbox|sdcard|bf-sd/i;

/** Log-ish file extensions worth offering for import. */
export const LOG_EXTENSIONS = new Set(['.bbl', '.bfl', '.txt', '.csv']);

/**
 * `msc` output that proves the firmware accepted the command. Without it the
 * reboot is not coming and the caller should not tell the user to wait.
 */
export const MSC_ACCEPT_MARKER = /Restarting in mass storage mode/i;

export function looksLikeFcVolume(name) {
  return FC_VOLUME_PATTERN.test(String(name ?? ''));
}

/** Every mounted volume that could be flight-controller storage. */
export function findFcVolumes(root = '/Volumes') {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!looksLikeFcVolume(name)) continue;
    out.push({ name, path, files: listLogFiles(path) });
  }
  return out;
}

/** Log files directly inside `dir`, largest first. */
export function listLogFiles(dir) {
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!LOG_EXTENSIONS.has(extname(name).toLowerCase())) continue;
      out.push({ name, path, size: st.size, mtime: st.mtime.toISOString() });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** True when the FC answered the `msc` command and is about to reboot. */
export function mscAccepted(lines = []) {
  return lines.some((line) => MSC_ACCEPT_MARKER.test(String(line)));
}

/**
 * Asks the FC to reboot into mass-storage mode.
 *
 * The command is sent through the CLI passthrough; the connection is expected
 * to drop immediately afterwards, which is success, not failure.
 */
export async function enterMsc(helper, { onLog = () => {} } = {}) {
  try {
    const { lines } = await helper.cliRun(['msc'], { timeoutMs: 8000, allowDisconnect: true });
    if (mscAccepted(lines)) {
      onLog('info', '飞控已进入大容量存储模式，正在重启…');
      return {
        ok: true,
        rebooting: true,
        message: '飞控正在重启为大容量存储设备；稍后其存储会出现在访达（/Volumes）中。',
        volumeHint: 'Betaflight Onboard Flash',
      };
    }
    return {
      ok: false,
      rebooting: false,
      message: '飞控未接受 msc 命令：存储未就绪或本固件未启用 USE_USB_MSC。',
      lines,
    };
  } catch (err) {
    // A dropped port during the reboot is the normal outcome.
    if (/timeout|closed|disconnect|not open/i.test(err.message)) {
      return {
        ok: true,
        rebooting: true,
        message: '飞控已重启为大容量存储设备；稍后其存储会出现在访达（/Volumes）中。',
        volumeHint: 'Betaflight Onboard Flash',
      };
    }
    return { ok: false, rebooting: false, message: err.message };
  }
}

/**
 * Copies the selected logs into `destDir`.
 *
 * Copying is done through the filesystem, never MSP, so it is safe to run the
 * whole time the FC is in MSC.
 */
export function importLogs({ volumePath, files = [], destDir } = {}) {
  if (!volumePath) return { ok: false, reason: '缺少卷路径' };
  if (!existsSync(volumePath)) return { ok: false, reason: `卷不存在：${volumePath}` };
  if (!destDir) return { ok: false, reason: '缺少导入目标目录' };

  const available = new Map(listLogFiles(volumePath).map((f) => [f.name, f]));
  const wanted = files.length ? files : [...available.keys()];
  if (!wanted.length) return { ok: false, reason: '该卷上没有可导入的日志文件' };

  mkdirSync(destDir, { recursive: true });
  const imported = [];
  const failed = [];
  for (const name of wanted) {
    const src = available.get(basename(name));
    if (!src) {
      failed.push({ name, reason: '卷上不存在' });
      continue;
    }
    const dest = join(destDir, `${Date.now().toString(36)}-${basename(name)}`);
    try {
      copyFileSync(src.path, dest);
      imported.push({ from: src.path, to: dest, bytes: src.size });
    } catch (err) {
      failed.push({ name, reason: err.message });
    }
  }
  return { ok: imported.length > 0, imported, failed, dir: destDir };
}

/** Ejects the volume. macOS needs this before the FC can be power-cycled. */
export async function exitMsc(volumePath) {
  if (!volumePath) return { ok: false, message: '没有可弹出的卷' };
  await new Promise((resolve) => {
    execFile('diskutil', ['eject', volumePath], (err) => resolve(err ?? null));
  });
  return {
    ok: true,
    message: '已弹出卷。现在给飞控断电再上电（或重新插拔 USB）即可回到正常 MSP 连接。',
  };
}

export default { enterMsc, exitMsc, findFcVolumes, importLogs, listLogFiles, mscAccepted, looksLikeFcVolume };
