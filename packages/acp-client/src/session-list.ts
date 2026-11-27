import { Readable, Writable } from 'node:stream';
import { client as acpClient, ndJsonStream, type InitializeResponse } from '@agentclientprotocol/sdk';
import { ADE_CLIENT_INFO } from './acp-session.ts';
import { killTree, spawnCommand, type Command } from './process.ts';

/** One conversation the agent's own CLI keeps, as `session/list` reports it. */
export interface ListedSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

/**
 * SR-10: asks an ACP agent for the conversations it keeps for `cwd` (`session/list`, ACP `sessionCapabilities.list`).
 * Starts the agent, runs `initialize`, lists up to `maxPages` pages, then stops it. Opens no session and sends no
 * prompt. Returns null when the agent does not advertise listing. Verified 2026-11-27: claude-agent-acp 0.109,
 * codex-acp 2.8 and OpenCode 1.19 all advertise `list` and `loadSession`.
 */
export async function listAgentSessions(cmd: Command, env: Record<string, string>, cwd: string, opts: { maxPages?: number; timeoutMs?: number } = {}): Promise<ListedSession[] | null> {
  const child = spawnCommand(cmd, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const stream = ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
  const connection = acpClient({ name: 'ade' }).connect(stream);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The agent did not list its sessions in time.')), opts.timeoutMs ?? 30_000);
  });
  const exited = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`The agent exited (code ${code}) before listing its sessions.`)));
  });
  try {
    return await Promise.race([
      (async () => {
        const agent = connection.agent;
        const init: InitializeResponse = await agent.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: ADE_CLIENT_INFO,
        });
        const caps = init.agentCapabilities;
        if (!caps?.sessionCapabilities?.list || !caps.loadSession) return null;
        const out: ListedSession[] = [];
        let cursor: string | null | undefined;
        for (let page = 0; page < (opts.maxPages ?? 5); page++) {
          const res = await agent.request('session/list', { cwd, ...(cursor ? { cursor } : {}) });
          for (const s of res.sessions ?? []) out.push({ sessionId: s.sessionId, cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt ?? null });
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        return out;
      })(),
      timeout,
      exited,
    ]);
  } finally {
    clearTimeout(timer);
    child.removeAllListeners('exit');
    try {
      connection.close();
    } catch {
      // already closed
    }
    if (child.pid && child.exitCode === null) await killTree(child.pid);
  }
}
