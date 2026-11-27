import { describe, expect, it } from 'vitest';
import { liveWorktree } from '../src/renderer/src/lib/format.ts';

describe('terminals open in a worktree only while it exists', () => {
  it('uses the worktree of a live session and nothing for a landed or discarded one', () => {
    expect(liveWorktree({ state: 'ready', worktreePath: '/wt/a' })).toBe('/wt/a');
    expect(liveWorktree({ state: 'interrupted', worktreePath: '/wt/a' })).toBe('/wt/a');
    expect(liveWorktree({ state: 'discarded', worktreePath: '/wt/a' })).toBeNull();
    expect(liveWorktree({ state: 'landed', worktreePath: '/wt/a' })).toBeNull();
    expect(liveWorktree({ state: 'ready', worktreePath: null })).toBeNull();
    expect(liveWorktree(null)).toBeNull();
  });
});
