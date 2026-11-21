import type { CheckResult } from '@ade/contracts';

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
