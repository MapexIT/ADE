import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/host/db.ts';
import { Repositories } from '../src/host/repositories.ts';
import { classifyReview, reviewedBlob, unreviewedAmong } from '../src/host/review-progress.ts';

/** A fingerprint whose new side is the digit `n` repeated. */
const fp = (n: string) => `100644 100644 ${'a'.repeat(40)} ${n.repeat(40)}`;

describe('RV-15 classification', () => {
  const current = new Map([
    ['a.ts', fp('1')],
    ['b.ts', fp('2')],
    ['c.ts', fp('3')],
  ]);

  it('classifies files by comparing marks with the current fingerprints, in change-set order', () => {
    const progress = classifyReview(current, [
      { path: 'b.ts', fingerprint: fp('9'), markedAt: 't1' },
      { path: 'a.ts', fingerprint: fp('1'), markedAt: 't2' },
      { path: 'gone.ts', fingerprint: fp('4'), markedAt: 't3' },
    ]);
    expect(progress.files).toEqual([
      { path: 'a.ts', fingerprint: fp('1'), state: 'reviewed', markedAt: 't2' },
      { path: 'b.ts', fingerprint: fp('2'), state: 'changed', markedAt: 't1' },
      { path: 'c.ts', fingerprint: fp('3'), state: 'unreviewed', markedAt: null },
    ]);
    expect(progress).toMatchObject({ reviewed: 1, total: 3 });
  });

  it('handles an empty change set', () => {
    expect(classifyReview(new Map(), [{ path: 'a.ts', fingerprint: fp('1'), markedAt: 't' }])).toEqual({ files: [], reviewed: 0, total: 0 });
  });

  it('reads the reviewed blob and lists unreviewed files among a selection', () => {
    expect(reviewedBlob(fp('7'))).toBe('7'.repeat(40));
    const progress = classifyReview(current, [{ path: 'a.ts', fingerprint: fp('1'), markedAt: 't' }]);
    expect(unreviewedAmong(progress, ['a.ts', 'c.ts', 'unknown.ts'])).toEqual(['c.ts', 'unknown.ts']);
    expect(unreviewedAmong(progress, ['a.ts'])).toEqual([]);
  });
});

describe('RV-15 review marks table', () => {
  it('stores, replaces and removes marks per session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ade-marks-'));
    const db = openDatabase(join(dir, 'ade.db'));
    try {
      migrate(db);
      const repos = new Repositories(db);
      const ws = repos.workspaces.upsert(dir, 'demo');
      db.run(
        "INSERT INTO sessions (id, workspace_id, agent_id, title, state, base_commit, permission_profile, sandbox_state, created_at) VALUES ('s1', ?, 'fake', 't', 'ready', 'x', 'ask', 'none', 'now')",
        ws.id,
      );
      repos.reviewMarks.set('s1', 'b.ts', fp('1'));
      repos.reviewMarks.set('s1', 'a.ts', fp('2'));
      repos.reviewMarks.set('s1', 'a.ts', fp('3'));
      expect(repos.reviewMarks.list('s1').map((m) => [m.path, m.fingerprint])).toEqual([
        ['a.ts', fp('3')],
        ['b.ts', fp('1')],
      ]);
      expect(repos.reviewMarks.remove('s1', 'a.ts')).toBe(true);
      expect(repos.reviewMarks.remove('s1', 'a.ts')).toBe(false);
      expect(repos.reviewMarks.list('s1').map((m) => m.path)).toEqual(['b.ts']);
      expect(repos.reviewMarks.list('other')).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
