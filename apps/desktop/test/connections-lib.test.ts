import { describe, expect, it } from 'vitest';
import { gitIdentityCommands, suggestedGitEmail } from '../src/renderer/src/lib/connections.ts';

const account = { login: 'octocat', id: 583231, name: 'The Octocat', email: null };

describe('CO-11 Git identity suggestions', () => {
  it('prefers the public email, then the private no-reply address', () => {
    expect(suggestedGitEmail({ ...account, email: 'octo@example.invalid' })).toBe('octo@example.invalid');
    expect(suggestedGitEmail(account)).toBe('583231+octocat@users.noreply.github.com');
    expect(suggestedGitEmail({ ...account, id: null })).toBe('you@example.com');
    expect(suggestedGitEmail(null)).toBe('you@example.com');
  });

  it('suggests only what is missing, filled in from GitHub and safely quoted', () => {
    expect(gitIdentityCommands({ installed: true, name: null, email: null }, account)).toEqual([
      'git config --global user.name "The Octocat"',
      'git config --global user.email "583231+octocat@users.noreply.github.com"',
    ]);
    expect(gitIdentityCommands({ installed: true, name: 'Me', email: null }, null)).toEqual(['git config --global user.email "you@example.com"']);
    expect(gitIdentityCommands({ installed: true, name: null, email: 'a@b.c' }, { ...account, name: 'Say "hi"' })).toEqual(['git config --global user.name "Say hi"']);
    expect(gitIdentityCommands({ installed: true, name: null, email: 'a@b.c' }, { ...account, name: null })).toEqual(['git config --global user.name "octocat"']);
    expect(gitIdentityCommands({ installed: true, name: 'Me', email: 'a@b.c' }, account)).toEqual([]);
  });
});
