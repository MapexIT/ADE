import type { CheckResult, ReviewState } from '@ade/contracts';

export interface ReviewComment {
  path: string;
  line: number;
  text: string;
}

/** RV-09: all collected comments as one review prompt, grouped by file. Pure. */
export function batchReviewPrompt(comments: ReviewComment[]): string {
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  const parts = [`Review of your changes (${comments.length} comment${comments.length === 1 ? '' : 's'}). Address each one, then summarise what you changed.`];
  for (const [path, list] of byFile) {
    parts.push(`${path}\n${list.sort((a, b) => a.line - b.line).map((c) => `- line ${c.line}: ${c.text.trim()}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** RV-10: the one-click prompt that hands failing checks to the agent. Pure. */
export function checkFailurePrompt(results: CheckResult[]): string {
  const failed = results.filter((r) => r.exitCode !== 0);
  return [
    `${failed.length === 1 ? 'This check fails' : 'These checks fail'} in your worktree. Fix the cause, then make sure ${failed.length === 1 ? 'it passes' : 'they pass'}.`,
    ...failed.map((r) => `Check "${r.name}" (${r.command.join(' ')}) exited with ${r.exitCode ?? 'no exit code'}:\n${r.output.slice(-6000)}`),
  ].join('\n\n');
}

/** RV-15: a file's review state by path; a path that is missing counts as not reviewed. */
export type ReviewStates = ReadonlyMap<string, ReviewState>;

/** RV-15: the first file after `after` (wrapping round) that is not reviewed, or null when every file is. Pure. */
export function nextUnreviewed(order: readonly string[], states: ReviewStates, after: string | null): string | null {
  const start = after === null ? -1 : order.indexOf(after);
  for (let step = 1; step <= order.length; step++) {
    const path = order[(start + step + order.length) % order.length]!;
    if (path !== after && states.get(path) !== 'reviewed') return path;
  }
  return null;
}

const WARN_LIST = 5;

/** RV-15 (AC7): the sentence the land confirmation adds when selected files are not reviewed; '' when all are. Pure. */
export function landWarning(selected: readonly string[], states: ReviewStates): string {
  const unreviewed = selected.filter((p) => states.get(p) !== 'reviewed');
  if (!unreviewed.length) return '';
  const shown = unreviewed.slice(0, WARN_LIST).join(', ');
  const more = unreviewed.length > WARN_LIST ? ` and ${unreviewed.length - WARN_LIST} more` : '';
  const lead =
    selected.length === 1
      ? 'The selected file is not marked as reviewed'
      : unreviewed.length === 1
        ? `1 of the ${selected.length} selected files is not marked as reviewed`
        : `${unreviewed.length} of the ${selected.length} selected files are not marked as reviewed`;
  return `${lead}: ${shown}${more}.`;
}

/** RV-15: what the palette's review commands run; set by the Review screen while it shows a live session. */
export const reviewActions: { mark: (() => void) | null; next: (() => void) | null } = { mark: null, next: null };
