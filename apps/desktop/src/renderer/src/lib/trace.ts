import type { PromptGroup, TraceLine } from '@ade/contracts';

/** RV-17: the words for where a line came from. Words, never colour alone. */
export function traceLabel(l: Pick<TraceLine, 'kind' | 'turnIndex'>): string {
  switch (l.kind) {
    case 'agent':
      return l.turnIndex === null ? 'Turn unknown' : `Turn ${l.turnIndex + 1}`;
    case 'unreported':
      return 'Not reported as an edit';
    case 'user':
      return 'You';
    case 'unknown':
      return 'Turn unknown';
  }
}

/** The short form in the diff gutter, next to the line number. */
export function gutterLabel(l: Pick<TraceLine, 'kind' | 'turnIndex'>): string {
  if (l.kind === 'user') return 'You';
  if (l.kind === 'unknown' || l.turnIndex === null) return '?';
  return `T${l.turnIndex + 1}`;
}

export function groupTitle(g: Pick<PromptGroup, 'kind' | 'turnIndex'>): string {
  if (g.kind === 'turn') return g.turnIndex === null ? 'Turn unknown' : `Turn ${g.turnIndex + 1}`;
  return traceLabel({ kind: g.kind, turnIndex: g.turnIndex });
}

/** Lines highlighted with the selected one: the same turn, or the same kind for You and Turn unknown. */
export function sameOrigin(a: Pick<TraceLine, 'kind' | 'turnIndex'>, b: Pick<TraceLine, 'kind' | 'turnIndex'>): boolean {
  if (a.turnIndex !== null || b.turnIndex !== null) return a.turnIndex === b.turnIndex;
  return a.kind === b.kind;
}

export interface TraceIndex {
  new: Map<number, TraceLine>;
  old: Map<number, TraceLine>;
}

export function indexTrace(lines: readonly TraceLine[]): TraceIndex {
  const out: TraceIndex = { new: new Map(), old: new Map() };
  for (const l of lines) out[l.side].set(l.line, l);
  return out;
}

/** The first `max` characters of a prompt, cut at a word when one is near. */
export function excerpt(text: string, max = 300): { text: string; more: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, more: false };
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return { text: `${(space > max * 0.7 ? cut.slice(0, space) : cut).trimEnd()}…`, more: true };
}

/** RV-05 prefill for Comment to agent: the turn and its prompt, so the agent has the context of the line. */
export function commentPrefill(l: Pick<TraceLine, 'kind' | 'turnIndex' | 'side' | 'line'>, prompt: string | null): string {
  const where = l.side === 'old' ? `old line ${l.line}` : 'this line';
  if (l.turnIndex === null) return `About ${where}: `;
  const verb = l.side === 'old' ? 'removed' : 'written';
  const asked = prompt ? `, when I asked: "${excerpt(prompt.replace(/\s+/g, ' '), 120).text}"` : '';
  return `About ${where}, ${verb} in turn ${l.turnIndex + 1}${asked}. `;
}
