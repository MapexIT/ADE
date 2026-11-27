/** Pty utility process entry: node-pty instances, shell-integration parsing, runs. */
import type { MessagePortMain } from 'electron';
import { existsSync } from 'node:fs';
import { spawn } from 'node-pty';
import { createPublisher, emitterPort, ptyApi, ptyTopics, RpcError, serveApi, type Handlers, type PtyApi } from '@ade/contracts';
import { TerminalManager } from './terminal-manager.ts';

const parent = process.parentPort;

type Publish = ReturnType<typeof createPublisher<typeof ptyTopics>>;
const publishers = new Set<Publish>();
const broadcast: Publish = (topic, payload) => {
  for (const p of publishers) p(topic, payload);
};

const manager = new TerminalManager(
  (file, args, opts) => {
    // A deleted worktree (a landed or discarded session) otherwise fails with Windows' bare "error code: 267".
    if (opts.cwd && !existsSync(opts.cwd)) throw new RpcError('not_found', `The folder ${opts.cwd} no longer exists. Open the terminal in the repository instead.`);
    return spawn(file, args, { ...opts, useConpty: true });
  },
  {
    data: (id, data) => broadcast('pty.data', { id, data }),
    block: (id, block) => broadcast('pty.block', { id, block }),
    exit: (id, exitCode) => broadcast('pty.exit', { id, exitCode }),
    changed: (info) => broadcast('pty.changed', info),
    runFinished: (runId, exitCode, output) => broadcast('pty.runFinished', { runId, exitCode, output }),
    watchFired: (fired) => broadcast('pty.watchFired', fired),
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
  'pty.clearBlocks': ({ id }) => {
    manager.clearBlocks(id);
    return { ok: true };
  },
  'pty.run': (o) => manager.run(o),
  'pty.watch': ({ id, rule }) => {
    manager.watch(id, rule);
    return { ok: true };
  },
  'pty.runWhenReady': ({ id, command }) => manager.runWhenReady(id, command),
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
  } else if (msg?.type === 'smoke') {
    // M5-T07: the native terminal module loads and a real shell starts and prints something.
    void smokeShell().then((check) => parent.postMessage({ type: 'smoke-result', checks: [check] }));
  } else if (msg?.type === 'shutdown') {
    void manager.dispose().finally(() => process.exit(0));
  }
});

async function smokeShell(): Promise<{ name: string; ok: boolean; detail: string }> {
  try {
    const shells = await handlers['pty.shells']({});
    const shell = shells[0];
    if (!shell) return { name: 'terminal', ok: false, detail: 'No shell was found.' };
    const marker = 'ade-smoke-ok';
    const output = await new Promise<string>((resolve) => {
      const proc = spawn(shell.path, [], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> });
      let seen = '';
      const finish = () => {
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
          // already gone
        }
        resolve(seen);
      };
      const timer = setTimeout(finish, 15_000);
      proc.onData((d) => {
        seen += d;
        if (seen.includes(marker)) finish();
      });
      proc.write(`echo ${marker}\r`);
    });
    const ok = output.includes('ade-smoke-ok');
    return { name: 'terminal', ok, detail: ok ? `${shell.label} started through node-pty and echoed.` : `${shell.label} printed: ${output.slice(-300)}` };
  } catch (err) {
    return { name: 'terminal', ok: false, detail: (err as Error).message };
  }
}

parent.postMessage({ type: 'ready', pid: process.pid });
