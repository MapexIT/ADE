import { describe, expect, it } from 'vitest';
import { ConnectionStatusService, firstLine, parseGhUser, parseGhVersion } from '../src/host/connection-status.ts';
import { CredentialCache, type Runner } from '../src/host/connectors.ts';

type Call = { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string };

/** A fake `gh` and `git`: answers by the joined arguments. */
function fake(answers: Record<string, { code: number; stdout?: string; stderr?: string }>) {
  const calls: Call[] = [];
  const run: Runner = async (file, args, env, cwd) => {
    calls.push({ file, args, env, cwd });
    const a = answers[args.join(' ')] ?? { code: 1 };
    return { code: a.code, stdout: a.stdout ?? '', stderr: a.stderr ?? '' };
  };
  return { run, calls };
}

const GIT_OK = {
  'config --get user.name': { code: 0, stdout: 'Ada Lovelace\n' },
  'config --get user.email': { code: 0, stdout: 'ada@example.invalid\n' },
};

describe('CO-14 connection status', () => {
  it('parses what gh prints', () => {
    expect(parseGhVersion('gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases/tag/v2.101.0\n')).toBe('2.101.0');
    expect(parseGhVersion('nonsense')).toBeNull();
    expect(parseGhUser('{"login":"octocat","name":"The Octocat","id":1,"email":"octo@example.invalid"}')).toEqual({ login: 'octocat', id: 1, name: 'The Octocat', email: 'octo@example.invalid' });
    expect(parseGhUser('{"login":"octocat","name":null,"email":null}')).toEqual({ login: 'octocat', id: null, name: null, email: null });
    expect(parseGhUser('{"message":"Bad credentials"}')).toBeNull();
    expect(parseGhUser('not json')).toBeNull();
    expect(firstLine('\n  To get started with GitHub CLI, please run:  gh auth login\nmore')).toBe('To get started with GitHub CLI, please run:  gh auth login');
    expect(firstLine('  \n')).toBeNull();
  });

  it('reports the signed-in account, the Git identity and stored tokens without exposing them', async () => {
    const creds = new CredentialCache();
    creds.set({ shortcut: 'sc-secret' });
    const { run, calls } = fake({
      '--version': { code: 0, stdout: 'gh version 2.101.0 (2026-09-15)\n' },
      'api user': { code: 0, stdout: '{"login":"octocat","id":583231,"name":"The Octocat","email":null}' },
      ...GIT_OK,
    });
    const status = await new ConnectionStatusService(creds, run, '/bin/gh', '/bin/git').status('/repo');
    expect(status).toEqual({
      github: { cli: { installed: true, version: '2.101.0' }, account: { login: 'octocat', id: 583231, name: 'The Octocat', email: null }, tokenStored: false, problem: null },
      shortcut: { tokenStored: true },
      git: { installed: true, name: 'Ada Lovelace', email: 'ada@example.invalid' },
    });
    expect(JSON.stringify(status)).not.toContain('sc-secret');
    // Git reads the open repository's config; gh never prompts.
    expect(calls.filter((c) => c.file === '/bin/git').every((c) => c.cwd === '/repo')).toBe(true);
    expect(calls.find((c) => c.args[0] === 'api')!.env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('uses a stored GitHub token for gh, and says why gh could not sign in', async () => {
    const creds = new CredentialCache();
    creds.set({ github: 'gh-secret' });
    const { run, calls } = fake({
      '--version': { code: 0, stdout: 'gh version 2.40.0 (2023-12-01)\n' },
      'api user': { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)\n' },
    });
    const status = await new ConnectionStatusService(creds, run, '/bin/gh', '/bin/git').status(null);
    expect(status.github).toEqual({ cli: { installed: true, version: '2.40.0' }, account: null, tokenStored: true, problem: 'HTTP 401: Bad credentials (https://api.github.com/user)' });
    expect(calls.find((c) => c.args[0] === 'api')!.env.GH_TOKEN).toBe('gh-secret');
    // No identity configured: git config exits 1 and the guide asks for one.
    expect(status.git).toEqual({ installed: true, name: null, email: null });
    expect(JSON.stringify(status)).not.toContain('gh-secret');
  });

  it('works without gh or git installed', async () => {
    const { run, calls } = fake({});
    const status = await new ConnectionStatusService(new CredentialCache(), run, null, null).status(null);
    expect(status.github).toEqual({ cli: { installed: false, version: null }, account: null, tokenStored: false, problem: null });
    expect(status.git).toEqual({ installed: false, name: null, email: null });
    expect(calls).toHaveLength(0);
  });

  it('is answered through the host API', async () => {
    const { createHost } = await import('../src/host/app.ts');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'ade-conn-'));
    const { run } = fake({ '--version': { code: 0, stdout: 'gh version 2.101.0\n' }, 'api user': { code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' } });
    const host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, github: { gh: '/bin/gh', run } });
    try {
      const status = await host.handlers['connectors.status']({ workspaceId: null });
      expect(status.github.account).toBeNull();
      expect(status.github.problem).toBe('To get started with GitHub CLI, please run:  gh auth login');
    } finally {
      await host.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
