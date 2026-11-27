import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate, openDatabase } from '../src/host/db.ts';

const names = (db: ReturnType<typeof openDatabase>) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('events_type', 'problem_snapshots', 'problem_snapshots_key') ORDER BY name").map((r) => r.name);

describe('migrations', () => {
  it('builds a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(names(db)).toEqual(['events_type', 'problem_snapshots', 'problem_snapshots_key']);
  });

  it('upgrades a database from the order before SM-18 was rebased onto AP-09', () => {
    const db = openDatabase(':memory:');
    const events = MIGRATIONS.findIndex((m) => m.includes('CREATE INDEX IF NOT EXISTS events_type'));
    const problems = MIGRATIONS.findIndex((m) => m.includes('problem_snapshots ('));
    // That build applied problem_snapshots as migration 7 (in the slot events_type has now) and never had the index.
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.transaction(() => {
      for (let i = 0; i < events; i++) db.exec(MIGRATIONS[i]!);
      db.exec(MIGRATIONS[problems]!);
      for (let v = 1; v <= events + 1; v++) db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', v, 'then');
    });
    expect(() => migrate(db)).not.toThrow();
    expect(names(db)).toEqual(['events_type', 'problem_snapshots', 'problem_snapshots_key']);
    expect(db.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations')?.v).toBe(MIGRATIONS.length);
  });
});
