/**
 * Electron main process.
 *
 * Responsibilities, in order of importance:
 *   1. Create the single application window with a locked-down renderer
 *      (contextIsolation on, nodeIntegration off, sandbox on).
 *   2. Own the one Session instance and expose it over IPC.
 *   3. Forward session events to the renderer.
 *   4. Apply macOS-specific behaviour (Apple Silicon): correct activation
 *      policy, window-all-closed handling, and an explicit note about the
 *      unsigned-app quarantine situation in the About panel.
 *
 * No protocol, analysis or tuning logic lives here.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Session } from './session.js';
import { createHandlers, registerIpc, missingHandlers } from './tools/registry.js';
import { CH } from '../shared/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

const isDev = process.env.BF_TUNER_DEV === '1';

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {Session|null} */
let session = null;
let disposeIpc = null;

function userDataPaths() {
  const userDataDir = app.getPath('userData');
  return {
    userDataDir,
    seedMapPath: join(projectRoot, 'src', 'main', 'fc', 'model-map.json'),
    localMapPath: join(userDataDir, 'model-map.local.json'),
    // Holds the optional AI endpoint + API key; mode 0600, never exported.
    aiConfigPath: join(userDataDir, 'ai-config.json'),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    title: 'BF AI Tuner',
    backgroundColor: '#12141a',
    show: false,
    // macOS: keep the traffic lights but let the UI own the title area.
    //
    // `hiddenInset` removes the system title bar, which also removes the OS
    // drag anchor: with it, the window can ONLY be moved through a CSS drag
    // region. The renderer declares one on `.appbar` (`-webkit-app-region:
    // drag`); if that rule is ever removed the window becomes immovable.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Keep the traffic lights clear of the app bar's own content.
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      // .cjs because a sandboxed renderer cannot load an ESM preload and this package is "type": "module".
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The renderer never loads remote content.
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.loadFile(join(projectRoot, 'src', 'renderer', 'index.html'));

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Nothing in this app should open a new window; send external links to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function forwardEvents(target) {
  return (event) => {
    if (target && !target.isDestroyed()) target.webContents.send(CH.EVENT, event);
  };
}

async function bootstrap() {
  const paths = userDataPaths();
  session = new Session(paths);

  const handlers = createHandlers(session, {
    appInfo: () => ({
      version: app.getVersion(),
      name: app.getName(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      // Surfaced in the UI so the operator knows why Gatekeeper may complain.
      unsigned: process.platform === 'darwin' && !app.isPackaged,
    }),
    openPrivacySettings: async () => {
      if (process.platform !== 'darwin') return { opened: false, reason: 'not macOS' };
      // Deep link straight to Privacy & Security so the operator does not have
      // to hunt for the pane. The app must be added manually with "+".
      const url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
      await shell.openExternal(url);
      return { opened: true, url };
    },
    pickFile: async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open a Blackbox log',
        properties: ['openFile'],
        filters: [
          { name: 'Blackbox logs', extensions: ['bbl', 'BBL', 'txt', 'TXT'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
    },
    saveFile: async ({ defaultPath = null, filters = [] } = {}) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export',
        defaultPath: defaultPath || undefined,
        filters: filters.length ? filters : [{ name: 'All files', extensions: ['*'] }],
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
  });

  const missing = missingHandlers(handlers);
  if (missing.length) {
    // A schema without a handler would render as a dead button in the UI.
    console.error('Tool schemas without handlers:', missing.join(', '));
  }

  disposeIpc = registerIpc(ipcMain, handlers);

  const win = createWindow();
  session.on('event', forwardEvents(win));
}

/* ------------------------------------------------------------------ *
 * App lifecycle
 * ------------------------------------------------------------------ */

// Only one instance may own the serial port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({
        applicationName: 'BF AI Tuner',
        applicationVersion: app.getVersion(),
        version: `Electron ${process.versions.electron}`,
        credits:
          'Betaflight AI tuning assistant. GPL-3.0-or-later. ' +
          'This build is unsigned: if macOS reports the app as damaged, run scripts/dequarantine.sh.',
      });
    }

    await bootstrap();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention is to stay resident, but holding a serial port open with
    // no window is worse than the convention is good: release the FC.
    if (session) session.disconnect().catch(() => {});
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', async (event) => {
    if (session?.connected) {
      event.preventDefault();
      try {
        await session.disconnect();
      } catch {
        /* best effort */
      }
      disposeIpc?.();
      app.exit(0);
    }
  });
}

// A renderer crash must not leave the flight controller in CLI mode.
app.on('render-process-gone', (_event, _contents, details) => {
  console.error('Renderer gone:', details.reason);
  session?.disconnect().catch(() => {});
});
