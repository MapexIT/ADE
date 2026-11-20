/** Pty utility process entry: node-pty instances, shell-integration parsing, runs. */
import type { MessagePortMain } from 'electron';
import { spawn } from 'node-pty';
import { createPublisher, emitterPort, ptyApi, ptyTopics, serveApi, type Handlers, type PtyApi } from '@ade/contracts';
import { TerminalManager } from './terminal-manager.ts';

const parent = process.parentPort;

type Publish = ReturnType<typeof createPublisher<typeof ptyTopics>>;
const publishers = new Set<Publish>();
const broadcast: Publish = (topic, payload) => {
  for (const p of publishers) p(topic, payload);
};

const manager = new TerminalManager(
  (file, args, opts) => spawn(file, args, { ...opts, useConpty: true }),
  {
    data: (id, data) => broadcast('pty.data', { id, data }),
    block: (id, block) => broadcast('pty.block', { id, block }),
    exit: (id, exitCode) => broadcast('pty.exit', { id, exitCode }),
    changed: (info) => broadcast('pty.changed', info),
    runFinished: (runId, exitCode, output) => broadcast('pty.runFinished', { runId, exitCode, output }),
  },
  process.env.ADE_SHELL_SCRIPTS || undefined,
);

const handlers: Handlers<PtyApi> = {
  'pty.shells': () => manager.shells(),
  'pty.create': (o) => manager.create(o),
  'pty.write': ({ id, data }) => {
    manager.write(id, data);
    return { ok: true };
  },
  'pty.resize': ({ id, cols, rows }) => {
    manager.resize(id, cols, rows);
    return { ok: true };
  },
  'pty.kill': async ({ id }) => {
    await manager.kill(id);
    return { ok: true };
  },
  'pty.killSession': async ({ sessionId }) => {
    await manager.killSession(sessionId);
    return { ok: true };
  },
  'pty.list': () => manager.list(),
  'pty.blocks': ({ id }) => manager.blocks(id),
  'pty.run': (o) => manager.run(o),
};

parent.on('message', (event: { data: unknown; ports: MessagePortMain[] }) => {
  const msg = event.data as { type?: string } | null;
  if (msg?.type === 'renderer-port' && event.ports[0]) {
    const raw = event.ports[0];
    const port = emitterPort(raw);
    const stop = serveApi(ptyApi, handlers, port);
    const publish = createPublisher(ptyTopics, port);
    publishers.add(publish);
    raw.on('close', () => {
      stop();
      publishers.delete(publish);
    });
  } else if (msg?.type === 'shutdown') {
    void manager.dispose().finally(() => process.exit(0));
  }
});

parent.postMessage({ type: 'ready', pid: process.pid });
