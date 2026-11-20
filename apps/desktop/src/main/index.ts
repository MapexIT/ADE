import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron';
import { mainApi, RpcError, type Handlers, type MainApi } from '@ade/contracts';
import { CredentialStore } from './credentials.ts';
import { ProcessSupervisor, type ProcessName } from './supervisor.ts';

// Tests and screenshots can point ADE at a throwaway profile.
if (process.env.ADE_USER_DATA_DIR) app.setPath('userData', process.env.ADE_USER_DATA_DIR);
const userData = app.getPath('userData');
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
const devFakeAgent = !app.isPackaged || process.env.ADE_ENABLE_FAKE_AGENT === '1';

let window: BrowserWindow | null = null;
const credentials = new CredentialStore(userData);

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
    onMessage: (msg) => {
      const m = msg as { type?: string; sessionId?: string; title?: string; body?: string };
      if (m.type === 'notify' && m.sessionId) notify(m.title ?? 'ADE', m.body ?? '', m.sessionId);
    },
  }),
  pty: new ProcessSupervisor({
    name: 'pty',
    entry: join(__dirname, 'pty.js'),
    env: { ADE_SHELL_SCRIPTS: shellScripts },
    onStatus: (status) => publish('process.status', { which: 'pty', status }),
  }),
};

/** AP-05: a desktop notification; clicking it focuses that session. Skipped while the window has focus. */
function notify(title: string, body: string, sessionId?: string) {
  if (!Notification.isSupported() || window?.isFocused()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
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
    return { ok: true };
  },
  'main.credentials.delete': ({ key }) => {
    credentials.delete(key);
    return { ok: true };
  },
  'main.info': () => ({ version: app.getVersion(), platform: process.platform, userData, isPackaged: app.isPackaged }),
  'main.restartProcess': ({ which }) => {
    supervisors[which].restart();
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
  });
  if (devUrl) void window.loadURL(devUrl);
  else void window.loadFile(join(__dirname, '../renderer/index.html'));
  window.on('closed', () => (window = null));
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

void app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
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

app.on('window-all-closed', () => app.quit());
