import type { ReviewProgress, ReviewState } from '@ade/contracts';

/** RV-15: a stored review mark, as far as classification needs it. */
export interface MarkLike {
  path: string;
  fingerprint: string;
  markedAt: string;
}

/**
 * RV-15: the review state of each file in the change set, in the order of `current` (path to fingerprint).
 * A mark counts only when its fingerprint equals the file's current one; marks for files outside the change
 * set are ignored (and kept, so a file that returns to the reviewed content is reviewed again).
 */
export function classifyReview(current: Map<string, string>, marks: readonly MarkLike[]): ReviewProgress {
  const byPath = new Map(marks.map((m) => [m.path, m]));
  const files = [...current].map(([path, fingerprint]) => {
    const mark = byPath.get(path);
    const state: ReviewState = !mark ? 'unreviewed' : mark.fingerprint === fingerprint ? 'reviewed' : 'changed';
    return { path, fingerprint, state, markedAt: mark?.markedAt ?? null };
  });
  return { files, reviewed: files.filter((f) => f.state === 'reviewed').length, total: files.length };
}

/** RV-15: the blob id of the reviewed content (the new side of the fingerprint). */
export function reviewedBlob(fingerprint: string): string {
  return fingerprint.split(' ')[3] ?? '';
}

/** RV-15 (AC8): the files among `files` that are not reviewed as they are now. Files with no entry count as not reviewed. */
export function unreviewedAmong(progress: ReviewProgress, files: readonly string[]): string[] {
  const reviewed = new Set(progress.files.filter((f) => f.state === 'reviewed').map((f) => f.path));
  return files.filter((f) => !reviewed.has(f));
}
