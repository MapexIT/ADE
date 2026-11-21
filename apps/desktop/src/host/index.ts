/**
 * Host utility process entry. Main hands it one MessagePort per renderer; requests and streams flow over that
 * port directly (they bypass main). Notifications go to main through the parent port.
 */
import type { MessagePortMain } from 'electron';
import { createPublisher, emitterPort, hostApi, hostTopics, serveApi } from '@ade/contracts';
import { join } from 'node:path';
import { createHost, defaultAdapterEntry } from './app.ts';
import { runSmokeChecks } from './smoke.ts';
import { KEEP_RUNNING_SETTING } from '../main/background.ts';

const parent = process.parentPort;
const userData = process.env.ADE_USER_DATA;
if (!userData) throw new Error('ADE_USER_DATA is not set');

const host = createHost({
  userData,
  node: { command: process.execPath, args: [] },
  nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
  ...(process.env.ADE_FAKE_AGENT_ENTRY ? { fakeAgentEntry: process.env.ADE_FAKE_AGENT_ENTRY } : {}),
  runnerMcpEntry: join(__dirname, 'runner-mcp.js'),
});

type Publish = ReturnType<typeof createPublisher<typeof hostTopics>>;
const publishers = new Set<Publish>();
const broadcast: Publish = (topic, payload) => {
  for (const p of publishers) {
    try {
      p(topic, payload);
    } catch (err) {
      console.error('[host] publish failed', err);
    }
  }
};

host.bus.on('session.event', (e) => broadcast('session.event', e));
host.bus.on('session.changed', (e) => {
  broadcast('session.changed', e);
  reportBackground();
});

/** PL-05: main keeps the app running in the background while sessions are live. */
function reportBackground() {
  const live = host.repos.sessions.inStates(['starting', 'working', 'waiting-on-user']).length;
  parent.postMessage({ type: 'background', live, keepRunning: host.repos.settings.get<boolean>(KEEP_RUNNING_SETTING, true) });
}
host.bus.on('inbox.changed', (e) => broadcast('inbox.changed', e));
host.bus.on('workflow.run', (e) => broadcast('workflow.run', e));
host.bus.on('notify', (e) => {
  broadcast('notify', e);
  parent.postMessage({ type: 'notify', ...e });
});

// HI-08: the preview window lives in main; the agent's tools reach it through these requests.
let previewSeq = 0;
const previewWaiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const previewCall = (action: string, args: Record<string, string>) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++previewSeq;
    const timer = setTimeout(() => {
      previewWaiting.delete(id);
      reject(new Error('The preview did not answer in time.'));
    }, 30_000);
    previewWaiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    parent.postMessage({ type: 'preview-request', id, action, args });
  });
host.setPreviewDriver({
  open: async (url) => void (await previewCall('open', { url })),
  screenshot: async () => Buffer.from(String(await previewCall('screenshot', {})), 'base64'),
  click: async (selector) => void (await previewCall('click', { selector })),
  type: async (selector, text) => void (await previewCall('type', { selector, text })),
  text: async () => String(await previewCall('text', {})),
});

parent.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const msg = event.data as { type?: string } | null;
  if (msg?.type === 'preview-response') {
    const r = msg as { id: number; ok: boolean; result?: unknown; error?: string };
    const w = previewWaiting.get(r.id);
    previewWaiting.delete(r.id);
    if (r.ok) w?.resolve(r.result);
    else w?.reject(new Error(r.error ?? 'The preview failed.'));
    return;
  }
  if (msg?.type === 'renderer-port' && event.ports[0]) {
    const raw = event.ports[0];
    const port = emitterPort(raw);
    const stop = serveApi(hostApi, host.handlers, port);
    const publish = createPublisher(hostTopics, port);
    publishers.add(publish);
    raw.on('close', () => {
      stop();
      publishers.delete(publish);
    });
  } else if (msg?.type === 'background-query') {
    reportBackground();
  } else if (msg?.type === 'credentials') {
    host.setCredentials((msg as { values?: Partial<Record<'shortcut' | 'github', string>> }).values ?? {});
  } else if (msg?.type === 'smoke') {
    // M5-T07: main asks for the install checks when ADE runs as a smoke test.
    void runSmokeChecks(host, { adapterEntry: defaultAdapterEntry, scratch: join(userData, 'smoke') })
      .catch((err: Error) => [{ name: 'host', ok: false, detail: err.message }])
      .then((checks) => parent.postMessage({ type: 'smoke-result', checks }));
  } else if (msg?.type === 'shutdown') {
    void host.dispose().finally(() => process.exit(0));
  }
});

parent.postMessage({ type: 'ready', pid: process.pid });
