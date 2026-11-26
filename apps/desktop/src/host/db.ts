import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlValue = string | number | null | bigint | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * The small slice of SQLite the host needs. Implemented with Node's built-in `node:sqlite`, which Electron's
 * Node also ships, so the same code runs in tests and in the app without a native rebuild (docs/DECISIONS.md).
 */
export interface Database {
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  return {
    run: (sql, ...params) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    get: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).get(...params) as T | undefined,
    all: <T>(sql: string, ...params: SqlValue[]) => stmt(sql).all(...params) as T[],
    exec: (sql) => db.exec(sql),
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}

/** Ordered migrations. Never edit a shipped migration; append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    base_commit TEXT,
    branch TEXT,
    worktree_path TEXT,
    permission_profile TEXT NOT NULL,
    sandbox_state TEXT NOT NULL,
    agent_session_id TEXT,
    work_item_ref TEXT,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX sessions_workspace ON sessions(workspace_id, created_at);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    "index" INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    stop_reason TEXT,
    start_checkpoint TEXT,
    end_checkpoint TEXT,
    UNIQUE(session_id, "index")
  );
  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    turn_id TEXT,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );
  CREATE TABLE permission_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT,
    tool_call_id TEXT NOT NULL,
    title TEXT NOT NULL,
    options_json TEXT NOT NULL,
    decision_json TEXT,
    decided_by TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    position INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE run_configs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    command_json TEXT NOT NULL,
    cwd TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    run_config_id TEXT,
    session_id TEXT,
    workspace_id TEXT,
    worktree_path TEXT NOT NULL,
    command_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    output TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    workspace_id TEXT,
    session_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );
  CREATE INDEX audit_workspace ON audit_log(workspace_id, ts);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
  // M6-T02: workflow runs. The YAML is copied in so a run keeps its graph when the file changes later.
  `
  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL,
    workflow_yaml TEXT NOT NULL,
    status TEXT NOT NULL,
    state_json TEXT NOT NULL,
    context_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX workflow_runs_workspace ON workflow_runs(workspace_id, created_at);
  `,
  // M7-T01: host sandbox (CN-07) and run in place (CN-08).
  `
  ALTER TABLE sessions ADD COLUMN containment TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE sessions ADD COLUMN in_place INTEGER NOT NULL DEFAULT 0;
  `,
  // M7-T02: compare runs (PL-03).
  `
  ALTER TABLE sessions ADD COLUMN compare_group TEXT;
  `,
  // M7-T05: terminal command history (SM-11).
  `
  CREATE TABLE command_history (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    session_id TEXT,
    command TEXT NOT NULL,
    cwd TEXT,
    exit_code INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX command_history_created ON command_history(created_at);
  `,
  // M8-T03: review progress (RV-15). One row per file the user marked as reviewed.
  `
  CREATE TABLE review_marks (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    path TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    marked_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path)
  );
  `,
  // M12-T04: rule advice (AP-09) reads one event type across a workspace's sessions.
  `
  CREATE INDEX events_type ON events(type, session_id);
  `,
];

export function migrate(db: Database): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const current = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', i + 1, new Date().toISOString());
    });
  }
  return MIGRATIONS.length;
}
