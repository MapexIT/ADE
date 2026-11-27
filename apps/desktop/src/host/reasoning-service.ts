import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRuntime } from '@ade/acp-client';
import { RpcError, type AgentId, type PromptBlock, type ReasoningSettings } from '@ade/contracts';
import { git, snapshot } from '@ade/git';
import { buildPrompt, ReasoningCancelled, strategyFor, type Thinker } from '@ade/reasoning';
import { isTerminal } from '@ade/session-core';
import { askOnce } from './one-shot.ts';
import type { Repositories } from './repositories.ts';
import type { SandboxProvider, SessionService } from './session-service.ts';

const CALL_TIMEOUT_MS = 10 * 60_000;
const MAX_CONTEXT = 60_000;
const CONCURRENCY = 3;

/** The user's words: every text block joined. */
export function promptText(content: PromptBlock[]): string {
  return content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
}

/** What the reasoning calls see: the words plus attached files' text, capped. */
export function reasoningContext(content: PromptBlock[]): string {
  const parts = content.flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'resource' ? [`Attached file ${b.name}:\n${b.text}`] : []));
  const all = parts.join('\n\n');
  return all.length > MAX_CONTEXT ? `${all.slice(0, MAX_CONTEXT)}\n[truncated]` : all;
}

/** The turn's content: the text blocks become one block with the reasoned prompt; attachments stay as they were. */
export function reasonedContent(content: PromptBlock[], text: string): PromptBlock[] {
  return [{ type: 'text', text }, ...content.filter((b) => b.type !== 'text')];
}

type Ask = typeof askOnce;

/** One temporary worktree that reasoning calls borrow, one call at a time. */
interface Lane {
  path: string;
  wrapper: Awaited<ReturnType<SandboxProvider['wrapperFor']>> | null;
  added: boolean;
}

/**
 * GN-01: runs a reasoning method before a turn. Every extra agent call goes to the session's own agent, read-only,
 * in temporary detached worktrees of the session's current state (one per call running at the same time), with every permission request refused, so
 * reasoning cannot change anything. Progress is stored as `reasoning.*` events; the result is sent like any prompt.
 */
export class ReasoningService {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
    private readonly runtimes: Map<AgentId, AgentRuntime>,
    private readonly tmpRoot: string,
    private readonly sandbox: () => SandboxProvider | null,
    private readonly baseEnv: () => NodeJS.ProcessEnv,
    private readonly ask: Ask = askOnce,
  ) {}

  /** Closes runs that were still going when ADE last quit, so their sessions do not look busy forever. */
  recover(): void {
    for (const w of this.repos.workspaces.list()) {
      for (const s of this.repos.sessions.list(w.id)) {
        if (isTerminal(s.state)) continue;
        const open = new Set<string>();
        for (const e of this.repos.events.list(s.id)) {
          if (e.type === 'reasoning.started') open.add(e.runId);
          else if (e.type === 'reasoning.finished') open.delete(e.runId);
        }
        for (const runId of open) {
          this.sessions.record(s.id, { type: 'reasoning.finished', runId, outcome: 'cancelled', approach: null, calls: 0 });
          this.sessions.record(s.id, { type: 'notice', level: 'warning', text: 'ADE closed while reasoning. Nothing was sent.' });
        }
      }
    }
  }

  isReasoning(sessionId: string) {
    return this.running.has(sessionId);
  }

  /** Sends `content` through the chosen method. IO sends at once; the others start a background run. */
  async prompt(sessionId: string, content: PromptBlock[], settings: ReasoningSettings): Promise<{ reasoning: boolean }> {
    const s = this.repos.sessions.require(sessionId);
    if (isTerminal(s.state)) throw new RpcError('session_ended', 'This session has ended.');
    const strategy = strategyFor(settings.method);
    const text = promptText(content);
    if (settings.method === 'io') {
      await this.sessions.prompt(sessionId, content);
      return { reasoning: false };
    }
    if (settings.method === 'cot') {
      await this.sessions.prompt(sessionId, reasonedContent(content, buildPrompt('cot', text, null)));
      return { reasoning: false };
    }
    if (this.running.has(sessionId)) throw new RpcError('busy', 'This session is already reasoning. Wait for it or cancel it.');
    if (!s.worktreePath) throw new RpcError('no_worktree', 'This session has no worktree yet.');
    const runtime = this.runtimes.get(s.agentId);
    if (!runtime) throw new RpcError('agent_unavailable', `Agent ${s.agentId} is not available`);

    const ac = new AbortController();
    this.running.set(sessionId, ac);
    const runId = randomUUID();
    this.sessions.record(sessionId, { type: 'reasoning.started', runId, method: settings.method, plannedCalls: strategy.plannedCalls(settings) });
    void this.reason(sessionId, runId, content, settings, runtime, ac).finally(() => this.running.delete(sessionId));
    return { reasoning: true };
  }

  /** Stops a running reasoning run. Nothing is sent. Returns false when none was running. */
  cancel(sessionId: string): boolean {
    const ac = this.running.get(sessionId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  private async reason(sessionId: string, runId: string, content: PromptBlock[], settings: ReasoningSettings, runtime: AgentRuntime, ac: AbortController) {
    const s = this.repos.sessions.require(sessionId);
    const root = this.repos.workspaces.get(s.workspaceId)!.rootPath;
    const lanes: Lane[] = [];
    let calls = 0;
    try {
      const snap = await snapshot(s.worktreePath!, null, 'ADE reasoning', s.inPlace);
      // Calls that run at the same time (parallel paths, fleet agents) each get their own worktree of the same
      // snapshot, so one call never sees another's files. A worktree is reset before it is lent again.
      const free: Lane[] = [];
      const lease = async (): Promise<Lane> => {
        const reused = free.pop();
        if (reused) {
          await git(['reset', '--hard', '-q', snap], { cwd: reused.path });
          await git(['clean', '-fdq'], { cwd: reused.path });
          return reused;
        }
        const lane: Lane = { path: join(this.tmpRoot, `${s.id.slice(0, 8)}-${runId.slice(0, 8)}-${lanes.length + 1}`), wrapper: null, added: false };
        lanes.push(lane);
        await git(['worktree', 'add', '--detach', lane.path, snap], { cwd: root });
        lane.added = true;
        lane.wrapper = s.containment !== 'none' ? ((await this.sandbox()?.wrapperFor({ ...s, worktreePath: lane.path }, root)) ?? null) : null;
        return lane;
      };
      const thinker: Thinker = {
        think: async (prompt, signal) => {
          const lane = await lease();
          try {
            return await this.ask(runtime, { cwd: lane.path, prompt, baseEnv: this.baseEnv(), wrapper: lane.wrapper, timeoutMs: CALL_TIMEOUT_MS, timeoutMessage: 'A reasoning call did not finish in time.', signal });
          } catch (err) {
            if (signal.aborted) throw new ReasoningCancelled();
            throw err;
          } finally {
            free.push(lane);
          }
        },
      };
      const strategy = strategyFor(settings.method);
      const result = await strategy.run(reasoningContext(content), settings, {
        thinker,
        signal: ac.signal,
        random: Math.random,
        concurrency: CONCURRENCY,
        report: (step) => {
          if (step.status === 'running') calls++;
          this.sessions.record(sessionId, { type: 'reasoning.step', runId, ...step });
        },
      });
      calls = result.calls;
      this.sessions.record(sessionId, { type: 'reasoning.finished', runId, outcome: 'sent', approach: result.approach, calls });
      await this.sessions.prompt(sessionId, reasonedContent(content, buildPrompt(settings.method, promptText(content), result.approach)));
    } catch (err) {
      const cancelled = err instanceof ReasoningCancelled || ac.signal.aborted;
      this.sessions.record(sessionId, { type: 'reasoning.finished', runId, outcome: cancelled ? 'cancelled' : 'failed', approach: null, calls });
      this.sessions.record(sessionId, {
        type: 'notice',
        level: cancelled ? 'info' : 'error',
        text: cancelled ? 'Reasoning was cancelled. Nothing was sent.' : `Reasoning failed, so nothing was sent: ${(err as Error).message.slice(0, 1000)}`,
      });
    } finally {
      for (const lane of lanes) if (lane.added) await git(['worktree', 'remove', '--force', lane.path], { cwd: root }).catch(() => undefined);
    }
  }
}
