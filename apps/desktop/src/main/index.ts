import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell, Tray } from 'electron';
import { backgroundMessage, hideOnClose, type BackgroundState } from './background.ts';
import { isLocalPreviewUrl } from './preview.ts';
import { SmokeRun, type SmokeCheck, type SmokeReport } from './smoke.ts';
import { mainApi, RpcError, type Handlers, type MainApi } from '@ade/contracts';
import { CredentialStore } from './credentials.ts';
import { ProcessSupervisor, type ProcessName } from './supervisor.ts';

// Tests and screenshots can point ADE at a throwaway profile.
if (process.env.ADE_USER_DATA_DIR) app.setPath('userData', process.env.ADE_USER_DATA_DIR);
const userData = app.getPath('userData');
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
const devFakeAgent = !app.isPackaged || process.env.ADE_ENABLE_FAKE_AGENT === '1';

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let background: BackgroundState = { live: 0, keepRunning: true };
const credentials = new CredentialStore(userData);

// M5-T07: `ADE_SMOKE_TEST_RESULT=<file>` makes ADE check its own installation, write the result and exit.
const smokeFile = process.env.ADE_SMOKE_TEST_RESULT;
let smoke: SmokeRun | null = null;
const smokeChecks = (m: unknown): SmokeCheck[] | null => {
  const msg = m as { type?: string; checks?: SmokeCheck[] } | null;
  return msg?.type === 'smoke-result' && Array.isArray(msg.checks) ? msg.checks : null;
};

const publish = (topic: 'process.status' | 'focus.session', payload: unknown) => {
  window?.webContents.send('ade:main-event', { topic, payload });
};

const shellScripts = app.isPackaged ? join(process.resourcesPath, 'shell-integration') : join(__dirname, '../../../../packages/shell-integration/scripts');

const supervisors: Record<ProcessName, ProcessSupervisor> = {
  host: new ProcessSupervisor({
    name: 'host',
    entry: join(__dirname, 'host.js'),
    env: { ADE_USER_DATA: userData, ...(devFakeAgent ? { ADE_FAKE_AGENT_ENTRY: join(__dirname, 'fake-agent.js') } : {}) },
    onStatus: (status) => publish('process.status', { which: 'host', status }),
    onReady: () => {
      sendCredentials();
      supervisors.host.post({ type: 'background-query' });
      smoke?.markReady('host');
    },
    onMessage: (msg) => {
      const checks = smokeChecks(msg);
      if (checks) return smoke?.add('host', checks);
      const m = msg as { type?: string; sessionId?: string; title?: string; body?: string; live?: number; keepRunning?: boolean; id?: number; action?: string; args?: Record<string, string> };
      if (m.type === 'preview-request' && m.id !== undefined) {
        void drivePreview(m.action ?? '', m.args ?? {}).then(
          (result) => supervisors.host.post({ type: 'preview-response', id: m.id, ok: true, result }),
          (err: Error) => supervisors.host.post({ type: 'preview-response', id: m.id, ok: false, error: err.message }),
        );
      }
      if (m.type === 'notify' && m.sessionId) notify(m.title ?? 'ADE', m.body ?? '', m.sessionId);
      if (m.type === 'background') {
        background = { live: m.live ?? 0, keepRunning: m.keepRunning !== false };
        updateTray();
      }
    },
  }),
  pty: new ProcessSupervisor({
    name: 'pty',
    entry: join(__dirname, 'pty.js'),
    env: { ADE_SHELL_SCRIPTS: shellScripts },
    onStatus: (status) => publish('process.status', { which: 'pty', status }),
    onReady: () => smoke?.markReady('pty'),
    onMessage: (msg) => {
      const checks = smokeChecks(msg);
      if (checks) smoke?.add('pty', checks);
    },
  }),
};

/** Connector tokens go to the host in memory on every (re)start and after every change; never to disk unencrypted. */
function sendCredentials() {
  const values: Record<string, string> = {};
  for (const key of ['shortcut', 'github', 'telegram', 'telegram-password'] as const) {
    try {
      const v = credentials.get(key);
      if (v) values[key] = v;
    } catch {
      // unreadable entry: leave it out
    }
  }
  supervisors.host.post({ type: 'credentials', values });
}

function showWindow() {
  if (!window) createWindow();
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

/** PL-05: a tray entry while the window is hidden, so the running sessions can be reopened or ADE quit. */
function updateTray() {
  const hidden = !!window && !window.isVisible();
  if (!hidden) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (!tray) {
    tray = new Tray(join(resources, 'icon.png'));
    tray.on('click', showWindow);
  }
  tray.setToolTip(`ADE · ${background.live} running`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `${background.live} session(s) running`, enabled: false },
      { label: 'Open ADE', click: showWindow },
      { label: 'Quit ADE', click: () => app.quit() },
    ]),
  );
}

/** AP-05: a desktop notification; clicking it focuses that session. Skipped while the window has focus. */
function notify(title: string, body: string, sessionId?: string) {
  if (!Notification.isSupported() || window?.isFocused()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    showWindow();
    if (sessionId) publish('focus.session', { sessionId });
  });
  n.show();
}

const handlers: Handlers<MainApi> = {
  'main.pickDirectory': async ({ title }) => {
    const res = await dialog.showOpenDialog(window!, { title: title ?? 'Open a repository', properties: ['openDirectory'] });
    return { path: res.canceled ? null : (res.filePaths[0] ?? null) };
  },
  'main.openExternal': async ({ url }) => {
    await shell.openExternal(url);
    return { ok: true };
  },
  'main.openInEditor': async ({ path }) => {
    // ED-02: the configured editor command (argument array) or the system default.
    const editor = process.env.ADE_EDITOR?.trim();
    if (editor) {
      const child = spawn(editor, [path], { detached: true, stdio: 'ignore', shell: false });
      child.unref();
    } else {
      const err = await shell.openPath(path);
      if (err) throw new RpcError('open_failed', err);
    }
    return { ok: true };
  },
  'main.notify': ({ title, body, sessionId }) => {
    notify(title, body, sessionId);
    return { ok: true };
  },
  'main.credentials.status': () => ({ available: credentials.available(), backend: credentials.backend(), stored: credentials.stored() }),
  'main.credentials.set': ({ key, secret }) => {
    credentials.set(key, secret);
    sendCredentials();
    return { ok: true };
  },
  'main.credentials.delete': ({ key }) => {
    credentials.delete(key);
    sendCredentials();
    return { ok: true };
  },
  'main.info': () => ({ version: app.getVersion(), platform: process.platform, userData, isPackaged: app.isPackaged }),
  'main.restartProcess': ({ which }) => {
    supervisors[which].restart();
    return { ok: true };
  },
  // CR-11: secret values of environment sets. They go to the renderer only to start a run with them.
  'main.envSecret.set': ({ key, value }) => {
    credentials.set(key as `env:${string}`, value);
    return { ok: true };
  },
  'main.envSecret.delete': ({ key }) => {
    credentials.delete(key as `env:${string}`);
    return { ok: true };
  },
  'main.envSecret.get': ({ keys }) => Object.fromEntries(keys.flatMap((k) => {
    const v = credentials.get(k as `env:${string}`);
    return v === null ? [] : [[k, v]];
  })),
  'main.saveText': async ({ title, defaultName, content }) => {
    const res = await dialog.showSaveDialog(window!, { title, defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { path: null };
    await writeFile(res.filePath, content, 'utf8');
    return { path: res.filePath };
  },
  'main.openPreview': ({ url }) => {
    if (!isLocalPreviewUrl(url)) throw new RpcError('not_local', 'Only local web apps (localhost) open in the preview.');
    openPreview(url);
    return { ok: true };
  },
};

ipcMain.handle('ade:main', async (event, raw: unknown) => {
  if (event.senderFrame?.url && !isAppUrl(event.senderFrame.url)) throw new Error('Refused: unexpected sender');
  const { method, input } = (raw ?? {}) as { method?: string; input?: unknown };
  if (!method || !Object.hasOwn(mainApi, method)) return { ok: false, error: { code: 'unknown_method', message: String(method) } };
  const def = mainApi[method as keyof MainApi];
  const parsed = def.input.safeParse(input);
  if (!parsed.success) return { ok: false, error: { code: 'invalid_payload', message: parsed.error.message } };
  try {
    const result = await (handlers[method as keyof MainApi] as (i: unknown) => unknown)(parsed.data);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: { code: err instanceof RpcError ? err.code : 'handler_failed', message: (err as Error).message } };
  }
});

const devUrl = process.env.ELECTRON_RENDERER_URL;
function isAppUrl(url: string) {
  return devUrl ? url.startsWith(devUrl) : url.startsWith('file://');
}

/**
 * CR-10, HI-08: a local web app in its own window. It has no preload and no Node, its own storage partition,
 * cannot open other windows and cannot navigate away from its origin (other links open in the browser).
 */
const previews = new Map<string, BrowserWindow>();
function openPreview(url: string) {
  const origin = new URL(url).origin;
  const existing = previews.get(origin);
  if (existing && !existing.isDestroyed()) {
    void existing.loadURL(url);
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: `Preview · ${origin}`,
    backgroundColor: '#0F1318',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, partition: 'preview' },
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== origin) {
      e.preventDefault();
      if (/^https?:\/\//.test(target)) void shell.openExternal(target);
    }
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.on('closed', () => {
    previews.delete(origin);
    if (lastPreview === win) lastPreview = null;
  });
  win.on('focus', () => (lastPreview = win));
  lastPreview = win;
  previews.set(origin, win);
  void win.loadURL(url);
}

/** HI-08: the agent drives the most recently used preview window through the host's MCP server. */
let lastPreview: BrowserWindow | null = null;
async function drivePreview(action: string, args: Record<string, string>): Promise<unknown> {
  if (action === 'open') {
    if (!isLocalPreviewUrl(args.url ?? '')) throw new Error('Only local addresses can be opened.');
    openPreview(args.url!);
    const win = previews.get(new URL(args.url!).origin)!;
    lastPreview = win;
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) return resolve();
      win.webContents.once('did-stop-loading', () => resolve());
    });
    return null;
  }
  const win = lastPreview && !lastPreview.isDestroyed() ? lastPreview : [...previews.values()].find((w) => !w.isDestroyed());
  if (!win) throw new Error('No preview is open. Open one with preview_open first.');
  const sel = JSON.stringify(args.selector ?? '');
  switch (action) {
    case 'screenshot':
      return (await win.webContents.capturePage()).toPNG().toString('base64');
    case 'click':
      return win.webContents.executeJavaScript(`(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('Nothing matches ' + ${sel}); el.click(); return null; })()`);
    case 'type':
      return win.webContents.executeJavaScript(
        `(() => { const el = document.querySelector(${sel}); if (!el) throw new Error('Nothing matches ' + ${sel}); el.focus(); el.value = ${JSON.stringify(args.text ?? '')}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return null; })()`,
      );
    case 'text':
      return win.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
    default:
      throw new Error(`Unknown preview action ${action}.`);
  }
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0F1318',
    title: 'ADE',
    autoHideMenuBar: true,
    icon: join(resources, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const wc = window.webContents;
  // No remote content, no new windows, no navigation away from the app (rule 9).
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });
  window.once('ready-to-show', () => window?.show());
  wc.on('did-finish-load', () => {
    supervisors.host.attach(wc);
    supervisors.pty.attach(wc);
    if (smoke) void checkWindow(wc).then((check) => smoke?.add('window', [check]));
  });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  // PL-05: with sessions running, closing the window hides it; sessions go on and notifications still arrive.
  window.on('close', (e) => {
    if (!hideOnClose(background, quitting)) return;
    e.preventDefault();
    window?.hide();
    updateTray();
    notify('ADE is still running', backgroundMessage(background.live));
  });
  window.on('show', updateTray);
  window.on('closed', () => (window = null));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

/** M5-T07: the renderer loaded under the CSP and drew the app (buttons exist once React has rendered). */
async function checkWindow(wc: Electron.WebContents): Promise<SmokeCheck> {
  for (let i = 0; i < 100; i++) {
    const buttons = Number(await wc.executeJavaScript('document.querySelectorAll("button").length').catch(() => 0));
    if (buttons > 0) return { name: 'window', ok: true, detail: `The window rendered ${buttons} buttons.` };
    await new Promise((r) => setTimeout(r, 200));
  }
  return { name: 'window', ok: false, detail: 'The window loaded but rendered nothing.' };
}

function finishSmoke(report: SmokeReport) {
  void writeFile(smokeFile!, JSON.stringify(report, null, 2))
    .catch((err: Error) => console.error(`[main] could not write the smoke test result: ${err.message}`))
    .finally(() => {
      console.log(`[main] smoke test ${report.ok ? 'passed' : 'failed'}`);
      for (const c of report.checks) console.log(`[main]   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
      void Promise.all([supervisors.host.stop(), supervisors.pty.stop()]).finally(() => app.exit(report.ok ? 0 : 1));
    });
}

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (smokeFile) {
    smoke = new SmokeRun({
      version: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
      timeoutMs: 120_000,
      request: () => {
        supervisors.host.post({ type: 'smoke' });
        supervisors.pty.post({ type: 'smoke' });
      },
      finish: finishSmoke,
    });
    smoke.markReady('window');
  }
  supervisors.host.start();
  supervisors.pty.start();
  createWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void Promise.all([supervisors.host.stop(), supervisors.pty.stop()]).finally(() => app.quit());
});

// PK-04: on macOS an app stays open without windows and comes back from the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!window) createWindow();
  else showWindow();
});
