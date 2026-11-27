import { realpathSync } from 'node:fs';
import { RpcError, type ChangesByPrompt, type FileChange, type Session, type TraceDetail, type TraceFile } from '@ade/contracts';
import { changedBlobs, changedFiles, fileAt, git, looksBinary, snapshot } from '@ade/git';
import {
  checkpointChain,
  editReports,
  groupByPrompt,
  lineOrigins,
  resolveVia,
  traceDetail,
  traceFile,
  turnsOf,
  undoneTurns,
  type ChainPoint,
  type EditReport,
  type LineOrigin,
  type TracedFile,
  type TraceVersion,
} from '@ade/session-core';
import type { Repositories } from './repositories.ts';

const MAX_LINES = 200_000;
const MAX_FILES = 2_000;
const CACHE_SIZE = 200;

interface Context {
  session: Session & { worktreePath: string; baseCommit: string };
  chain: ChainPoint[];
  /** Paths each step of the chain changed (index k: from point k-1 to point k). */
  steps: Set<string>[];
  changes: FileChange[];
  /** `git diff --raw` metadata of each changed file, base to now: the cache key of its trace. */
  blobs: Map<string, string>;
  userEdits: Set<string>;
  reports: Map<number, EditReport[]>;
  prompts: Map<number, string>;
  /** Identifies the chain and the event log the trace was computed from. */
  stamp: string;
}

type Traced = { path: string; binary: true } | { path: string; binary: false; file: TracedFile; origins: LineOrigin[] };

/**
 * RV-17: Trace, computed on demand from the session's checkpoints and ACP events; nothing new is stored. Each file
 * is traced from its content at each checkpoint (only the steps that changed it are read) and cached in memory by
 * its blobs and the event log's length.
 */
export class TraceService {
  private readonly cache = new Map<string, Traced>();

  constructor(private readonly repos: Repositories) {}

  async trace(sessionId: string, path: string): Promise<TraceFile> {
    const ctx = await this.context(sessionId);
    const change = ctx.changes.find((c) => c.path === path);
    if (!change) return { path, binary: false, lines: [] };
    const t = await this.traceOne(ctx, change);
    if (t.binary) return { path, binary: true, lines: [] };
    return { path, binary: false, lines: t.origins.slice(0, MAX_LINES) };
  }

  async changesByPrompt(sessionId: string): Promise<ChangesByPrompt> {
    const ctx = await this.context(sessionId);
    const traced: Traced[] = [];
    for (const change of ctx.changes.slice(0, MAX_FILES)) traced.push(await this.traceOne(ctx, change));
    const files = traced.flatMap((t) => (t.binary ? [] : [{ path: t.path, file: t.file, origins: t.origins }]));
    const groups = groupByPrompt(files, ctx.prompts);
    return {
      groups,
      binary: traced.filter((t) => t.binary).map((t) => t.path),
      additions: groups.reduce((n, g) => n + g.additions, 0),
      deletions: groups.reduce((n, g) => n + g.deletions, 0),
    };
  }

  detail(sessionId: string, turnIndex: number, toolCallId: string | null): TraceDetail {
    this.repos.sessions.require(sessionId);
    return traceDetail(this.repos.events.list(sessionId), turnIndex, toolCallId);
  }

  private requireWorktree(sessionId: string): Context['session'] {
    const s = this.repos.sessions.require(sessionId);
    if (!s.worktreePath || !s.baseCommit) throw new RpcError('no_worktree', 'This session has no worktree.');
    if (s.state === 'landed' || s.state === 'discarded') throw new RpcError('session_ended', 'This session has ended.');
    return s as Context['session'];
  }

  private async context(sessionId: string): Promise<Context> {
    const session = this.requireWorktree(sessionId);
    const cwd = session.worktreePath;
    const current = await snapshot(cwd, null, 'ADE trace', session.inPlace);
    const turns = this.repos.turns.list(sessionId);
    const undos = this.repos.audit.forSession(sessionId, 'turn.undone').map((e) => ({ turnIndex: Number(e.detail.turnIndex), ts: e.ts }));
    const chain = checkpointChain(session.baseCommit, turns, current, undoneTurns(turns, undos));
    const steps: Set<string>[] = [new Set()];
    for (let k = 1; k < chain.length; k++) {
      const out = await git(['diff', '--name-only', '--no-renames', '-z', chain[k - 1]!.commit, chain[k]!.commit], { cwd });
      steps.push(new Set(out.split('\0').filter(Boolean)));
    }
    const [changes, blobs] = await Promise.all([changedFiles(cwd, session.baseCommit, current), changedBlobs(cwd, session.baseCommit, current)]);
    const userEdits = new Set(this.repos.audit.forSession(sessionId, 'user.edit').map((e) => String(e.detail.path)));
    const events = this.repos.events.list(sessionId);
    const roots = [cwd];
    try {
      const real = realpathSync.native(cwd);
      if (real !== cwd) roots.push(real);
    } catch {
      // the worktree is gone; Git above would have failed
    }
    const reports = new Map<number, EditReport[]>();
    const prompts = new Map<number, string>();
    for (const t of turnsOf(events)) {
      reports.set(t.index, editReports(t.events, roots));
      prompts.set(t.index, t.prompt);
    }
    const stamp = [chain.slice(0, -1).map((p) => `${p.commit}:${JSON.stringify(p.via)}`).join(','), JSON.stringify(chain.at(-1)?.via), events.length, userEdits.size].join('|');
    return { session, chain, steps, changes, blobs, userEdits, reports, prompts, stamp };
  }

  private async traceOne(ctx: Context, change: FileChange): Promise<Traced> {
    const { path, oldPath } = change;
    const key = `${ctx.session.id}\n${path}\n${ctx.blobs.get(path) ?? ''}\n${ctx.stamp}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const cwd = ctx.session.worktreePath;
    const read = async (commit: string, first: boolean) => {
      const buf = first && oldPath ? await fileAt(cwd, commit, oldPath) : await fileAt(cwd, commit, path);
      return buf ?? (oldPath && !first ? await fileAt(cwd, commit, oldPath) : null);
    };
    let buf = await read(ctx.chain[0]!.commit, true);
    let binary = looksBinary(buf);
    const versions: TraceVersion[] = [{ text: buf?.toString('utf8') ?? null, via: { kind: 'unknown' } }];
    const editedByUser = ctx.userEdits.has(path);
    for (let k = 1; k < ctx.chain.length && !binary; k++) {
      const changed = ctx.steps[k]!.has(path) || (!!oldPath && ctx.steps[k]!.has(oldPath));
      if (changed) {
        buf = await read(ctx.chain[k]!.commit, false);
        binary = looksBinary(buf);
      }
      versions.push({ text: changed ? (buf?.toString('utf8') ?? null) : versions.at(-1)!.text, via: resolveVia(ctx.chain[k]!.via, editedByUser) });
    }
    let out: Traced;
    if (binary || change.status === 'binary') out = { path, binary: true };
    else {
      const file = traceFile(versions);
      out = { path, binary: false, file, origins: lineOrigins(file, path, ctx.reports) };
    }
    this.cache.set(key, out);
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }
}
