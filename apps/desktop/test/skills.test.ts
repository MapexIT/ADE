import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import { parseSkillMd, renderSkillMd } from '../src/host/skills.ts';

let root: string;
let repo: string;
let home: string;
let host: Host;

const ID = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ade-skills-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo, env: ID });
  host = createHost({
    userData: join(root, 'userData'),
    node: { command: process.execPath, args: [] },
    nodeEnv: {},
    fakeAgentEntry: FAKE_AGENT_ENTRY,
    homeDir: home,
  });
});

afterEach(async () => {
  await host.dispose();
  rmSync(root, { recursive: true, force: true });
});

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('SKILL.md', () => {
  it('round-trips and reports problems', () => {
    const text = renderSkillMd(
      'release-notes',
      'Use when writing release notes: lists changes by area.',
      '# Steps\n\n1. Read the log.',
    );
    expect(text.startsWith('---\nname: release-notes\ndescription: ')).toBe(true);
    expect(parseSkillMd(text, 'release-notes')).toMatchObject({ name: 'release-notes', problems: [] });
    expect(parseSkillMd('no frontmatter', 'x').problems[0]).toContain('no frontmatter');
    expect(parseSkillMd('---\nname: other\n---\nbody', 'x').problems).toHaveLength(2);
  });
});

describe('skills (SK-01 to SK-05)', () => {
  it('builds repository and personal skills and lists installed ones (SK-02, SK-03)', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    mkdirSync(join(repo, '.claude', 'skills', 'by-hand'), { recursive: true });
    writeFileSync(
      join(repo, '.claude', 'skills', 'by-hand', 'SKILL.md'),
      renderSkillMd('by-hand', 'Hand-made.', 'Body'),
    );

    const saved = await host.handlers['skills.save']({
      workspaceId: ws.id,
      location: 'repository',
      name: 'house-style',
      description: 'Use for code style.',
      body: 'Use tabs.',
      overwrite: false,
    });
    expect(saved).toMatchObject({ id: 'repo:house-style', location: 'repository', problems: [] });
    expect(readFileSync(join(repo, '.ade', 'skills', 'house-style', 'SKILL.md'), 'utf8')).toContain(
      'Use tabs.',
    );
    await expect(
      host.handlers['skills.save']({
        workspaceId: ws.id,
        location: 'repository',
        name: 'house-style',
        description: 'x',
        body: '',
        overwrite: false,
      }),
    ).rejects.toMatchObject({ code: 'exists' });
    await host.handlers['skills.save']({
      workspaceId: null,
      location: 'personal',
      name: 'my-notes',
      description: 'Mine.',
      body: 'Notes.',
      overwrite: false,
    });

    const list = await host.handlers['skills.list']({ workspaceId: ws.id });
    expect(list.map((s) => `${s.location}:${s.name}`)).toEqual([
      'repository:house-style',
      'personal:my-notes',
      'installed:by-hand',
    ]);
    expect(list[2]!.agentFolder).toBe('.claude/skills');
    expect(
      (await host.handlers['skills.read']({ workspaceId: ws.id, id: 'repo:house-style' })).content,
    ).toContain('name: house-style');
  });

  it('loads skills into one session only, outside the change set (SK-01)', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    await host.handlers['skills.save']({
      workspaceId: ws.id,
      location: 'repository',
      name: 'house-style',
      description: 'Style.',
      body: 'Use tabs.',
      overwrite: false,
    });
    await git(['add', '-A'], { cwd: repo });
    await git(['commit', '-q', '-m', 'skill'], { cwd: repo, env: ID });

    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: [{ type: 'text', text: 'edit a.txt hi' }],
      permissionProfile: 'auto-edit',
      bringChanges: false,
      skills: ['house-style'],
    });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    expect(existsSync(join(session.worktreePath!, '.agents', 'skills', 'house-style', 'SKILL.md'))).toBe(
      true,
    );
    const changes = await host.handlers['sessions.changes']({ sessionId: session.id, turnIndex: null });
    expect(changes.map((c) => c.path)).toEqual(['a.txt']);
    expect(
      host.repos.events.list(session.id).some((e) => e.type === 'notice' && e.text.includes('house-style')),
    ).toBe(true);

    const missing = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: [{ type: 'text', text: 'say hi' }],
      permissionProfile: 'ask',
      bringChanges: false,
      skills: ['nope'],
    });
    await waitFor(() => host.repos.sessions.require(missing.id).state === 'interrupted');
    expect(
      host.repos.events.list(missing.id).some((e) => e.type === 'notice' && e.text.includes('nope')),
    ).toBe(true);
  });

  it('syncs a skill to the agents and never touches a hand-installed one (SK-05)', async () => {
    await host.handlers['skills.save']({
      workspaceId: null,
      location: 'personal',
      name: 'my-notes',
      description: 'Mine.',
      body: 'Notes.',
      overwrite: false,
    });
    const synced = await host.handlers['skills.sync']({
      workspaceId: null,
      id: 'personal:my-notes',
      enabled: true,
    });
    expect(synced.syncedTo).toEqual(['claude-code', 'codex', 'opencode']);
    expect(existsSync(join(home, '.claude', 'skills', 'my-notes', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, '.agents', 'skills', 'my-notes', 'SKILL.md'))).toBe(true);
    // Synced copies are not listed again as installed.
    expect(
      (await host.handlers['skills.list']({ workspaceId: null })).filter((s) => s.name === 'my-notes'),
    ).toHaveLength(1);

    // Saving again updates the synced copies.
    await host.handlers['skills.save']({
      workspaceId: null,
      location: 'personal',
      name: 'my-notes',
      description: 'Mine.',
      body: 'Updated.',
      overwrite: true,
    });
    expect(readFileSync(join(home, '.claude', 'skills', 'my-notes', 'SKILL.md'), 'utf8')).toContain(
      'Updated.',
    );

    const off = await host.handlers['skills.sync']({
      workspaceId: null,
      id: 'personal:my-notes',
      enabled: false,
    });
    expect(off.syncedTo).toEqual([]);
    expect(existsSync(join(home, '.claude', 'skills', 'my-notes'))).toBe(false);

    mkdirSync(join(home, '.claude', 'skills', 'my-notes'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'skills', 'my-notes', 'SKILL.md'),
      renderSkillMd('my-notes', 'By hand.', 'x'),
    );
    await expect(
      host.handlers['skills.sync']({ workspaceId: null, id: 'personal:my-notes', enabled: true }),
    ).rejects.toMatchObject({ code: 'exists' });
    expect(readFileSync(join(home, '.claude', 'skills', 'my-notes', 'SKILL.md'), 'utf8')).toContain(
      'By hand.',
    );
  });

  it('drafts a skill with an agent in a normal session (SK-04)', async () => {
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.handlers['skills.draft']({
      workspaceId: ws.id,
      agentId: 'fake',
      name: 'triage',
      description: 'How we triage bugs.',
    });
    expect(session.title).toBe('Draft skill: triage');
    const first = await waitFor(() =>
      host.repos.events.list(session.id).find((e) => e.type === 'user.message'),
    );
    expect(
      first?.type === 'user.message' && first.content[0]?.type === 'text' && first.content[0].text,
    ).toContain('.ade/skills/triage/SKILL.md');
  });
});
