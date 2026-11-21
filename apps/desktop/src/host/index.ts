/**
 * Host utility process entry. Main hands it one MessagePort per renderer; requests and streams flow over that
 * port directly (they bypass main). Notifications go to main through the parent port.
 */
import type { MessagePortMain } from 'electron';
import { createPublisher, emitterPort, hostApi, hostTopics, serveApi } from '@ade/contracts';
import { join } from 'node:path';
import { createHost } from './app.ts';
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

parent.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const msg = event.data as { type?: string } | null;
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
  } else if (msg?.type === 'shutdown') {
    void host.dispose().finally(() => process.exit(0));
  }
});

parent.postMessage({ type: 'ready', pid: process.pid });
