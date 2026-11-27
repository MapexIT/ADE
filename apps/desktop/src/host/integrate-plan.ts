import type { IntegrateAlone, IntegrateFit, IntegrateVerdict } from '@ade/contracts';

/**
 * PL-06: the pure parts of Integrate (no Git, no database), so they can be tested exhaustively.
 */

/** A matrix cell: conflicts win; otherwise shared paths that merge cleanly; otherwise the two simply fit. */
export function classifyFit(conflicts: readonly string[], shared: readonly string[]): { fit: IntegrateFit; files: string[] } {
  if (conflicts.length) return { fit: 'conflicts', files: [...conflicts].sort() };
  if (shared.length) return { fit: 'same-files', files: [...shared].sort() };
  return { fit: 'fits', files: [] };
}

/** The paths two change sets both touch. */
export function sharedPaths(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(a);
  return [...new Set(b)].filter((p) => set.has(p)).sort();
}

/** Default order: fewest changed lines first, then the title, then the id (stable for equal sessions). */
export function defaultOrder<T extends { sessionId: string; title: string; additions: number; deletions: number }>(items: readonly T[]): T[] {
  return [...items].sort(
    (x, y) => x.additions + x.deletions - (y.additions + y.deletions) || x.title.localeCompare(y.title) || x.sessionId.localeCompare(y.sessionId),
  );
}

/** What the trial remembers of each member, to notice when it goes out of date. */
export interface MemberMark {
  sessionId: string;
  /** The newest checkpoint commit when the trial ran (null when the session had none). */
  checkpoint: string | null;
}

export interface CurrentState {
  head: string;
  /** Per member: its newest checkpoint now, and whether it has ended. Missing means the session is gone. */
  members: Record<string, { checkpoint: string | null; ended: boolean; title: string } | undefined>;
}

/** Why a trial is out of date, in words, or null while it still describes the sessions and the checkout. */
export function staleness(trial: { head: string; members: readonly MemberMark[]; landed?: readonly string[] }, now: CurrentState): string | null {
  const landed = new Set(trial.landed ?? []);
  for (const m of trial.members) {
    if (landed.has(m.sessionId)) continue;
    const cur = now.members[m.sessionId];
    if (!cur) return 'A session in this trial no longer exists.';
    if (cur.ended) return `"${cur.title}" has ended.`;
    if (cur.checkpoint !== m.checkpoint) return `"${cur.title}" changed since the trial.`;
  }
  // Landing in order moves nothing (changes are applied uncommitted), so a moved HEAD always means someone else.
  if (now.head !== trial.head) return 'Your checkout moved to another commit.';
  return null;
}

/**
 * A combined check in words. "Passed alone, fails together" needs every session's own last run to have passed;
 * a session that never ran the check makes it a plain failure (its line says "Not run alone").
 */
export function checkVerdict(combinedExit: number | null, alone: readonly IntegrateAlone[]): IntegrateVerdict {
  if (combinedExit === 0) return 'passes';
  if (alone.length > 0 && alone.every((a) => a === 'passed')) return 'passed-alone-fails-together';
  return 'fails';
}

export interface BriefingSession {
  title: string;
  files: readonly string[];
  /** The session's closing agent message, if any. */
  lastMessage: string | null;
}

const MAX_MESSAGE = 1500;
const MAX_FILES = 30;

const fileList = (files: readonly string[]) =>
  files.length > MAX_FILES ? `${files.slice(0, MAX_FILES).join(', ')} and ${files.length - MAX_FILES} more` : files.join(', ');

/**
 * The prompt that asks a session to adapt to the sessions landing before it. `conflicts` for a conflicting step;
 * `failed` (check names with output) for "fails together". The session has already been moved onto `onto`.
 */
export function briefing(opts: {
  order: readonly string[];
  position: number;
  before: readonly BriefingSession[];
  onto: string;
  conflicts: readonly string[];
  failed: readonly { name: string; output: string }[];
}): string {
  const lines: string[] = [];
  const short = opts.onto.slice(0, 12);
  lines.push(
    `ADE is preparing to land several sessions in this order: ${opts.order.map((t, i) => `${i + 1}. ${t}`).join(', ')}. You are number ${opts.position + 1}.`,
  );
  if (opts.conflicts.length) {
    lines.push(
      '',
      `Your branch now sits on commit ${short}, which holds the checkout plus the changes of the sessions before you. Your changes were merged onto it, and these files now contain Git conflict markers (<<<<<<<, =======, >>>>>>>): ${fileList(opts.conflicts)}.`,
      'Resolve every conflict so both their change and yours work, remove the markers, and say what you decided.',
    );
  } else if (opts.failed.length) {
    lines.push(
      '',
      `Your branch now sits on commit ${short}, which holds the checkout plus the changes of the sessions before you, with your changes on top. Each change passed its checks alone, but together these fail:`,
    );
    for (const f of opts.failed) lines.push(`- ${f.name}:`, '```', f.output.trim().slice(-3000) || '(no output)', '```');
    lines.push('Find out why the combination fails, change your part so the checks pass with theirs in place, and say what you changed.');
  } else {
    lines.push('', `Your branch now sits on commit ${short}, which holds the checkout plus the changes of the sessions before you. Check that your change still works with theirs.`);
  }
  if (opts.before.length) {
    lines.push('', 'What the sessions before you changed:');
    for (const b of opts.before) {
      lines.push(`- "${b.title}" changed ${b.files.length ? fileList(b.files) : 'no files'}.`);
      const msg = b.lastMessage?.trim();
      if (msg) lines.push(`  Its last message: ${msg.length > MAX_MESSAGE ? `${msg.slice(0, MAX_MESSAGE)}…` : msg}`);
    }
  }
  lines.push('', 'Do not undo their changes. Keep your work uncommitted as before.');
  return lines.join('\n');
}
