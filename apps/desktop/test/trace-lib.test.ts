import { describe, expect, it } from 'vitest';
import { commentPrefill, excerpt, groupTitle, gutterLabel, indexTrace, sameOrigin, traceLabel } from '../src/renderer/src/lib/trace.ts';

describe('RV-17 trace labels', () => {
  it('says where a line came from in words', () => {
    expect(traceLabel({ kind: 'agent', turnIndex: 3 })).toBe('Turn 4');
    expect(traceLabel({ kind: 'unreported', turnIndex: 1 })).toBe('Not reported as an edit');
    expect(traceLabel({ kind: 'user', turnIndex: null })).toBe('You');
    expect(traceLabel({ kind: 'unknown', turnIndex: null })).toBe('Turn unknown');
    expect(groupTitle({ kind: 'turn', turnIndex: 0 })).toBe('Turn 1');
    expect(groupTitle({ kind: 'unreported', turnIndex: null })).toBe('Not reported as an edit');
  });

  it('has a short gutter form', () => {
    expect(gutterLabel({ kind: 'agent', turnIndex: 1 })).toBe('T2');
    expect(gutterLabel({ kind: 'unreported', turnIndex: 1 })).toBe('T2');
    expect(gutterLabel({ kind: 'user', turnIndex: null })).toBe('You');
    expect(gutterLabel({ kind: 'unknown', turnIndex: null })).toBe('?');
  });

  it('highlights the same turn, or the same kind without a turn', () => {
    expect(sameOrigin({ kind: 'agent', turnIndex: 1 }, { kind: 'unreported', turnIndex: 1 })).toBe(true);
    expect(sameOrigin({ kind: 'agent', turnIndex: 1 }, { kind: 'agent', turnIndex: 2 })).toBe(false);
    expect(sameOrigin({ kind: 'user', turnIndex: null }, { kind: 'user', turnIndex: null })).toBe(true);
    expect(sameOrigin({ kind: 'user', turnIndex: null }, { kind: 'unknown', turnIndex: null })).toBe(false);
  });

  it('indexes lines by side', () => {
    const idx = indexTrace([
      { line: 2, side: 'new', turnIndex: 0, toolCallId: 'a', kind: 'agent' },
      { line: 2, side: 'old', turnIndex: 1, toolCallId: null, kind: 'unreported' },
    ]);
    expect(idx.new.get(2)?.toolCallId).toBe('a');
    expect(idx.old.get(2)?.kind).toBe('unreported');
  });

  it('cuts long prompts at a word and prefills a comment with the turn', () => {
    expect(excerpt('short')).toEqual({ text: 'short', more: false });
    const long = excerpt('word '.repeat(100), 50);
    expect(long.more).toBe(true);
    expect(long.text.endsWith('word…')).toBe(true);
    expect(commentPrefill({ kind: 'agent', turnIndex: 1, side: 'new', line: 4 }, 'Add  beta\nplease')).toBe('About this line, written in turn 2, when I asked: "Add beta please". ');
    expect(commentPrefill({ kind: 'agent', turnIndex: 0, side: 'old', line: 3 }, null)).toBe('About old line 3, removed in turn 1. ');
    expect(commentPrefill({ kind: 'user', turnIndex: null, side: 'new', line: 1 }, null)).toBe('About this line: ');
  });
});
