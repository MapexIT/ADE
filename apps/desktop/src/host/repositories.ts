import { randomUUID } from 'node:crypto';
import {
  SessionEvent,
  type AuditEntry,
  type NewSessionEvent,
  type PermissionDecision,
  type PermissionOption,
  type PermissionRequest,
  type PromptBlock,
  type Run,
  type RunConfig,
  type Session,
  type SessionState,
  type Turn,
  type Workspace,
} from '@ade/contracts';
import type { Database } from './db.ts';

const now = () => new Date().toISOString();
type R = Record<string, unknown>;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** Repository pattern: each class owns one table and maps rows to contract types. */
export class WorkspaceRepo {
  constructor(private readonly db: Database) {}

  private map = (r: R): Workspace => ({
    id: String(r.id),
    rootPath: String(r.root_path),
    name: String(r.name),
    createdAt: String(r.created_at),
    lastOpenedAt: String(r.last_opened_at),
  });

  list(): Workspace[] {
    return this.db.all<R>('SELECT * FROM workspaces ORDER BY last_opened_at DESC').map(this.map);
  }

  get(id: string): Workspace | null {
    const r = this.db.get<R>('SELECT * FROM workspaces WHERE id = ?', id);
    return r ? this.map(r) : null;
  }

  /** Inserts the workspace or bumps its last-opened time. */
  upsert(rootPath: string, name: string): Workspace {
    const existing = this.db.get<R>('SELECT * FROM workspaces WHERE root_path = ?', rootPath);
    const ts = now();
    if (existing) {
      this.db.run('UPDATE workspaces SET last_opened_at = ? WHERE id = ?', ts, String(existing.id));
      return this.map({ ...existing, last_opened_at: ts });
    }
    const id = randomUUID();
    this.db.run('INSERT INTO workspaces (id, root_path, name, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)', id, rootPath, name, ts, ts);
    return { id, rootPath, name, createdAt: ts, lastOpenedAt: ts };
  }
}

export class SessionRepo {
  constructor(private readonly db: Database) {}

  private map = (r: R): Session => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    agentId: String(r.agent_id) as Session['agentId'],
    title: String(r.title),
    state: String(r.state) as SessionState,
    baseCommit: str(r.base_commit),
    branch: str(r.branch),
    worktreePath: str(r.worktree_path),
    permissionProfile: String(r.permission_profile) as Session['permissionProfile'],
    sandboxState: String(r.sandbox_state) as Session['sandboxState'],
    containment: String(r.containment ?? 'none') as Session['containment'],
    inPlace: Number(r.in_place ?? 0) === 1,
    agentSessionId: str(r.agent_session_id),
    workItemRef: str(r.work_item_ref),
    createdAt: String(r.created_at),
    endedAt: str(r.ended_at),
  });

  insert(s: Session): void {
    this.db.run(
      `INSERT INTO sessions (id, workspace_id, agent_id, title, state, base_commit, branch, worktree_path, permission_profile,
        sandbox_state, containment, in_place, agent_session_id, work_item_ref, created_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.id, s.workspaceId, s.agentId, s.title, s.state, s.baseCommit, s.branch, s.worktreePath, s.permissionProfile,
      s.sandboxState, s.containment, s.inPlace ? 1 : 0, s.agentSessionId, s.workItemRef, s.createdAt, s.endedAt,
    );
  }

  get(id: string): Session | null {
    const r = this.db.get<R>('SELECT * FROM sessions WHERE id = ?', id);
    return r ? this.map(r) : null;
  }

  require(id: string): Session {
    const s = this.get(id);
    if (!s) throw new Error(`Unknown session ${id}`);
    return s;
  }

  list(workspaceId: string): Session[] {
    return this.db.all<R>('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId).map(this.map);
  }

  inStates(states: SessionState[]): Session[] {
    const marks = states.map(() => '?').join(',');
    return this.db.all<R>(`SELECT * FROM sessions WHERE state IN (${marks}) ORDER BY created_at ASC`, ...states).map(this.map);
  }

  update(id: string, patch: Partial<Pick<Session, 'state' | 'agentSessionId' | 'endedAt' | 'baseCommit' | 'branch' | 'worktreePath' | 'sandboxState'>>): Session {
    const cols: Record<string, string> = {
      state: 'state',
      agentSessionId: 'agent_session_id',
      endedAt: 'ended_at',
      baseCommit: 'base_commit',
      branch: 'branch',
      worktreePath: 'worktree_path',
      sandboxState: 'sandbox_state',
    };
    const entries = Object.entries(patch).filter(([k]) => k in cols);
    if (entries.length) {
      this.db.run(
        `UPDATE sessions SET ${entries.map(([k]) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`,
        ...entries.map(([, v]) => (v ?? null) as string | null),
        id,
      );
    }
    return this.require(id);
  }
}

export class TurnRepo {
  constructor(private readonly db: Database) {}

  private map = (r: R): Turn => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    index: Number(r.index),
    startedAt: String(r.started_at),
    endedAt: str(r.ended_at),
    stopReason: str(r.stop_reason),
    startCheckpoint: str(r.start_checkpoint),
    endCheckpoint: str(r.end_checkpoint),
  });

  start(sessionId: string, startCheckpoint: string | null): Turn {
    const index = (this.db.get<{ n: number | null }>('SELECT MAX("index") AS n FROM turns WHERE session_id = ?', sessionId)?.n ?? -1) + 1;
    const t: Turn = { id: randomUUID(), sessionId, index, startedAt: now(), endedAt: null, stopReason: null, startCheckpoint, endCheckpoint: null };
    this.db.run(
      'INSERT INTO turns (id, session_id, "index", started_at, start_checkpoint) VALUES (?, ?, ?, ?, ?)',
      t.id, sessionId, index, t.startedAt, startCheckpoint,
    );
    return t;
  }

  end(id: string, stopReason: string, endCheckpoint: string | null): void {
    this.db.run('UPDATE turns SET ended_at = ?, stop_reason = ?, end_checkpoint = ? WHERE id = ?', now(), stopReason, endCheckpoint, id);
  }

  list(sessionId: string): Turn[] {
    return this.db.all<R>('SELECT * FROM turns WHERE session_id = ? ORDER BY "index"', sessionId).map(this.map);
  }

  byIndex(sessionId: string, index: number): Turn | null {
    const r = this.db.get<R>('SELECT * FROM turns WHERE session_id = ? AND "index" = ?', sessionId, index);
    return r ? this.map(r) : null;
  }

  /** Turns left open when the app closed. */
  closeDangling(sessionId: string, reason: string): void {
    this.db.run('UPDATE turns SET ended_at = ?, stop_reason = ? WHERE session_id = ? AND ended_at IS NULL', now(), reason, sessionId);
  }
}

/** Append-only event store. `seq` is assigned here, unique per session. */
export class EventStore {
  constructor(private readonly db: Database) {}

  append(event: NewSessionEvent, turnId: string | null = null): SessionEvent {
    return this.db.transaction(() => {
      const seq = (this.db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM events WHERE session_id = ?', event.sessionId)?.n ?? -1) + 1;
      const full = SessionEvent.parse({ ...event, seq, ts: now() });
      this.db.run(
        'INSERT INTO events (session_id, seq, ts, type, turn_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
        full.sessionId, full.seq, full.ts, full.type, turnId, JSON.stringify(full),
      );
      return full;
    });
  }

  list(sessionId: string): SessionEvent[] {
    return this.db
      .all<{ payload_json: string }>('SELECT payload_json FROM events WHERE session_id = ? ORDER BY seq', sessionId)
      .map((r) => JSON.parse(r.payload_json) as SessionEvent);
  }

  lastSeq(sessionId: string): number {
    return this.db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM events WHERE session_id = ?', sessionId)?.n ?? -1;
  }
}

export class PermissionRepo {
  constructor(private readonly db: Database) {}

  private map = (r: R): PermissionRequest => ({
    id: String(r.id),
    sessionId: String(r.session_id),
    turnId: str(r.turn_id),
    toolCallId: String(r.tool_call_id),
    title: String(r.title),
    options: JSON.parse(String(r.options_json)) as PermissionOption[],
    decision: r.decision_json ? (JSON.parse(String(r.decision_json)) as PermissionDecision) : null,
    decidedBy: str(r.decided_by),
    decidedAt: str(r.decided_at),
  });

  insert(p: Omit<PermissionRequest, 'decision' | 'decidedBy' | 'decidedAt'>): void {
    this.db.run(
      'INSERT INTO permission_requests (id, session_id, turn_id, tool_call_id, title, options_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      p.id, p.sessionId, p.turnId, p.toolCallId, p.title, JSON.stringify(p.options), now(),
    );
  }

  decide(id: string, decision: PermissionDecision, decidedBy: string): void {
    this.db.run('UPDATE permission_requests SET decision_json = ?, decided_by = ?, decided_at = ? WHERE id = ?', JSON.stringify(decision), decidedBy, now(), id);
  }

  pending(): PermissionRequest[] {
    return this.db.all<R>('SELECT * FROM permission_requests WHERE decision_json IS NULL ORDER BY created_at').map(this.map);
  }

  /** Requests left unanswered when the app closed are recorded as cancelled. */
  cancelDangling(sessionId: string): void {
    this.db.run(
      "UPDATE permission_requests SET decision_json = ?, decided_by = 'system', decided_at = ? WHERE session_id = ? AND decision_json IS NULL",
      JSON.stringify({ outcome: 'cancelled' }), now(), sessionId,
    );
  }
}

export class QueueRepo {
  constructor(private readonly db: Database) {}

  list(sessionId: string): { id: string; content: PromptBlock[] }[] {
    return this.db
      .all<R>('SELECT id, content_json FROM queued_messages WHERE session_id = ? ORDER BY position', sessionId)
      .map((r) => ({ id: String(r.id), content: JSON.parse(String(r.content_json)) as PromptBlock[] }));
  }

  push(sessionId: string, content: PromptBlock[], front = false): string {
    const id = randomUUID();
    const edge = this.db.get<{ lo: number | null; hi: number | null }>('SELECT MIN(position) AS lo, MAX(position) AS hi FROM queued_messages WHERE session_id = ?', sessionId);
    const position = front ? (edge?.lo ?? 0) - 1 : (edge?.hi ?? 0) + 1;
    this.db.run('INSERT INTO queued_messages (id, session_id, position, content_json, created_at) VALUES (?, ?, ?, ?, ?)', id, sessionId, position, JSON.stringify(content), now());
    return id;
  }

  shift(sessionId: string): { id: string; content: PromptBlock[] } | null {
    const first = this.list(sessionId)[0];
    if (!first) return null;
    this.remove(sessionId, first.id);
    return first;
  }

  edit(sessionId: string, id: string, content: PromptBlock[]): boolean {
    return this.db.run('UPDATE queued_messages SET content_json = ? WHERE id = ? AND session_id = ?', JSON.stringify(content), id, sessionId).changes > 0;
  }

  remove(sessionId: string, id: string): boolean {
    return this.db.run('DELETE FROM queued_messages WHERE id = ? AND session_id = ?', id, sessionId).changes > 0;
  }
}

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get<T>(key: string, fallback: T): T {
    const r = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    return r ? (JSON.parse(r.value_json) as T) : fallback;
  }

  raw(key: string): unknown {
    const r = this.db.get<{ value_json: string }>('SELECT value_json FROM settings WHERE key = ?', key);
    return r ? JSON.parse(r.value_json) : null;
  }

  set(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      key, JSON.stringify(value ?? null),
    );
  }
}

export class AuditRepo {
  constructor(private readonly db: Database) {}

  append(e: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const entry: AuditEntry = { id: randomUUID(), ts: now(), ...e };
    this.db.run(
      'INSERT INTO audit_log (id, ts, workspace_id, session_id, actor, action, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entry.id, entry.ts, entry.workspaceId, entry.sessionId, entry.actor, entry.action, JSON.stringify(entry.detail),
    );
    return entry;
  }

  list(workspaceId: string): AuditEntry[] {
    return this.db.all<R>('SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY ts DESC LIMIT 1000', workspaceId).map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      workspaceId: str(r.workspace_id),
      sessionId: str(r.session_id),
      actor: String(r.actor),
      action: String(r.action),
      detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
    }));
  }

  forSession(sessionId: string, action: string): AuditEntry[] {
    return this.db.all<R>('SELECT * FROM audit_log WHERE session_id = ? AND action = ? ORDER BY ts', sessionId, action).map((r) => ({
      id: String(r.id),
      ts: String(r.ts),
      workspaceId: str(r.workspace_id),
      sessionId: str(r.session_id),
      actor: String(r.actor),
      action: String(r.action),
      detail: JSON.parse(String(r.detail_json)) as Record<string, unknown>,
    }));
  }
}

export class RunRepo {
  constructor(private readonly db: Database) {}

  private mapConfig = (r: R): RunConfig => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name),
    command: JSON.parse(String(r.command_json)) as string[],
    cwd: String(r.cwd),
    source: String(r.source) as RunConfig['source'],
  });

  configs(workspaceId: string): RunConfig[] {
    return this.db.all<R>('SELECT * FROM run_configs WHERE workspace_id = ? ORDER BY source DESC, name', workspaceId).map(this.mapConfig);
  }

  replaceDetected(workspaceId: string, configs: Omit<RunConfig, 'id' | 'workspaceId' | 'source'>[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM run_configs WHERE workspace_id = ? AND source = 'detected'", workspaceId);
      for (const c of configs) {
        this.db.run(
          "INSERT INTO run_configs (id, workspace_id, name, command_json, cwd, source) VALUES (?, ?, ?, ?, ?, 'detected')",
          randomUUID(), workspaceId, c.name, JSON.stringify(c.command), c.cwd,
        );
      }
    });
  }

  saveUser(c: Omit<RunConfig, 'id' | 'source'> & { id?: string }): RunConfig {
    const id = c.id ?? randomUUID();
    this.db.run(
      `INSERT INTO run_configs (id, workspace_id, name, command_json, cwd, source) VALUES (?, ?, ?, ?, ?, 'user')
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, command_json = excluded.command_json, cwd = excluded.cwd, source = 'user'`,
      id, c.workspaceId, c.name, JSON.stringify(c.command), c.cwd,
    );
    return { ...c, id, source: 'user' };
  }

  record(run: Omit<Run, 'id'>, workspaceId: string | null): Run {
    const id = randomUUID();
    this.db.run(
      'INSERT INTO runs (id, run_config_id, session_id, workspace_id, worktree_path, command_json, started_at, ended_at, exit_code, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, run.runConfigId, run.sessionId, workspaceId, run.worktreePath, JSON.stringify(run.command), run.startedAt, run.endedAt, run.exitCode, run.output.slice(-200_000),
    );
    return { ...run, id };
  }

  history(workspaceId: string): Run[] {
    return this.db.all<R>('SELECT * FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 200', workspaceId).map((r) => ({
      id: String(r.id),
      runConfigId: str(r.run_config_id),
      sessionId: str(r.session_id),
      worktreePath: String(r.worktree_path),
      command: JSON.parse(String(r.command_json)) as string[],
      startedAt: String(r.started_at),
      endedAt: str(r.ended_at),
      exitCode: r.exit_code === null ? null : Number(r.exit_code),
      output: String(r.output),
    }));
  }
}

export interface WorkflowRunRow {
  id: string;
  workspaceId: string;
  workflowId: string;
  yaml: string;
  status: string;
  state: unknown;
  context: unknown;
  createdAt: string;
}

/** Workflow run persistence (M6-T02). State and context are JSON owned by the workflow service. */
export class WorkflowRunRepo {
  constructor(private readonly db: Database) {}

  private map = (r: R): WorkflowRunRow => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    workflowId: String(r.workflow_id),
    yaml: String(r.workflow_yaml),
    status: String(r.status),
    state: JSON.parse(String(r.state_json)),
    context: JSON.parse(String(r.context_json)),
    createdAt: String(r.created_at),
  });

  insert(row: Omit<WorkflowRunRow, 'createdAt'>): WorkflowRunRow {
    const now = new Date().toISOString();
    this.db.run(
      'INSERT INTO workflow_runs (id, workspace_id, workflow_id, workflow_yaml, status, state_json, context_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.workspaceId, row.workflowId, row.yaml, row.status, JSON.stringify(row.state), JSON.stringify(row.context), now, now,
    );
    return { ...row, createdAt: now };
  }

  save(id: string, status: string, state: unknown, context: unknown): void {
    this.db.run('UPDATE workflow_runs SET status = ?, state_json = ?, context_json = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(state), JSON.stringify(context), new Date().toISOString(), id);
  }

  get(id: string): WorkflowRunRow | null {
    const r = this.db.get<R>('SELECT * FROM workflow_runs WHERE id = ?', id);
    return r ? this.map(r) : null;
  }

  list(workspaceId: string): WorkflowRunRow[] {
    return this.db.all<R>('SELECT * FROM workflow_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100', workspaceId).map(this.map);
  }

  /** Every session a workflow step ever started. */
  allSessionIds(): string[] {
    const ids: string[] = [];
    for (const r of this.db.all<R>('SELECT state_json FROM workflow_runs')) {
      const state = JSON.parse(String(r.state_json)) as { nodes?: Record<string, { sessionId?: string | null }> } | null;
      for (const n of Object.values(state?.nodes ?? {})) if (n.sessionId) ids.push(n.sessionId);
    }
    return ids;
  }

  inStatuses(statuses: string[]): WorkflowRunRow[] {
    return this.db.all<R>(`SELECT * FROM workflow_runs WHERE status IN (${statuses.map(() => '?').join(', ')})`, ...statuses).map(this.map);
  }
}

export class Repositories {
  readonly workspaces: WorkspaceRepo;
  readonly sessions: SessionRepo;
  readonly turns: TurnRepo;
  readonly events: EventStore;
  readonly permissions: PermissionRepo;
  readonly queue: QueueRepo;
  readonly settings: SettingsRepo;
  readonly audit: AuditRepo;
  readonly runs: RunRepo;
  readonly workflowRuns: WorkflowRunRepo;

  constructor(readonly db: Database) {
    this.workspaces = new WorkspaceRepo(db);
    this.sessions = new SessionRepo(db);
    this.turns = new TurnRepo(db);
    this.events = new EventStore(db);
    this.permissions = new PermissionRepo(db);
    this.queue = new QueueRepo(db);
    this.settings = new SettingsRepo(db);
    this.audit = new AuditRepo(db);
    this.runs = new RunRepo(db);
    this.workflowRuns = new WorkflowRunRepo(db);
  }
}
