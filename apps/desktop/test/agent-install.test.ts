import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { AgentInstallState } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { AgentInstaller, parseOsRelease, planInstall, tail, type PlanEnv } from '../src/host/agent-install.ts';

const env = (platform: NodeJS.Platform, os: string | null, tools: string[]): PlanEnv => ({ platform, os: os ? parseOsRelease(os) : null, has: (n) => tools.includes(n) });

describe('ST-07 install plans', () => {
  it('reads os-release', () => {
    expect(parseOsRelease('NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\n')).toEqual({ id: 'manjaro', idLike: ['arch'] });
    expect(parseOsRelease('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"')).toEqual({ id: 'opensuse-tumbleweed', idLike: ['opensuse', 'suse'] });
  });

  it('uses winget on Windows for all three', () => {
    const p = planInstall('opencode', env('win32', null, ['winget', 'npm']));
    expect(p).toMatchObject({ manager: 'winget', elevated: false });
    expect('argv' in p && p.argv).toEqual(['winget', 'install', '--id', 'Anomaly.OpenCode', '--exact', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity']);
    expect(planInstall('claude-code', env('win32', null, ['winget']))).toMatchObject({ argv: expect.arrayContaining(['Anthropic.ClaudeCode']) });
  });

  it('falls back to npm on Windows without winget', () => {
    expect(planInstall('codex', env('win32', null, ['npm']))).toMatchObject({ manager: 'npm', argv: ['npm', 'install', '--global', '@openai/codex'] });
  });

  it('uses pacman on Arch and its derivatives where the package exists, npm otherwise', () => {
    const arch = env('linux', 'ID=arch', ['pacman', 'pkexec', 'npm']);
    expect(planInstall('codex', arch)).toMatchObject({ manager: 'pacman', elevated: true, argv: ['pkexec', 'pacman', '-S', '--needed', '--noconfirm', 'openai-codex'] });
    expect(planInstall('opencode', env('linux', 'ID=manjaro\nID_LIKE=arch', ['pacman', 'pkexec', 'npm']))).toMatchObject({ manager: 'pacman' });
    expect(planInstall('claude-code', arch)).toMatchObject({ manager: 'npm', argv: ['npm', 'install', '--global', '@anthropic-ai/claude-code'] });
  });

  it('uses zypper only on Tumbleweed', () => {
    expect(planInstall('opencode', env('linux', 'ID="opensuse-tumbleweed"', ['zypper', 'pkexec', 'npm']))).toMatchObject({ manager: 'zypper', argv: ['pkexec', 'zypper', '--non-interactive', 'install', 'opencode'] });
    expect(planInstall('opencode', env('linux', 'ID="opensuse-leap"', ['zypper', 'pkexec', 'npm']))).toMatchObject({ manager: 'npm' });
  });

  it('uses npm on Debian, Ubuntu and Fedora, and without pkexec', () => {
    for (const os of ['ID=ubuntu\nID_LIKE=debian', 'ID=debian', 'ID=fedora']) expect(planInstall('codex', env('linux', os, ['apt', 'dnf', 'pkexec', 'npm']))).toMatchObject({ manager: 'npm' });
    expect(planInstall('codex', env('linux', 'ID=arch', ['pacman', 'npm']))).toMatchObject({ manager: 'npm' });
  });

  it('explains when nothing can install it', () => {
    expect(planInstall('codex', env('linux', 'ID=ubuntu', []))).toHaveProperty('problem');
    expect(planInstall('codex', env('win32', null, []))).toHaveProperty('problem');
  });

  it('keeps the end of long output', () => {
    expect(tail('abcdef', 3)).toBe('def');
  });
});

/** A PATH folder with fake programs, so `findOnPath` finds them. */
function fakePath(names: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ade-install-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const n of names) writeFileSync(join(bin, process.platform === 'win32' ? `${n}.exe` : n), '');
  return bin;
}

function fakeChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
  return child;
}

describe('ST-07 installer', () => {
  it('runs the plan as an argument array, reports output and re-detects on success', async () => {
    const bin = fakePath(['npm']);
    const child = fakeChild();
    const states: AgentInstallState[] = [];
    let spawned: { command: string; args: string[] } | null = null;
    let detected = 0;
    const inst = new AgentInstaller({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      env: { PATH: bin },
      readOsRelease: () => 'ID=ubuntu',
      spawn: (cmd) => ((spawned = cmd), child),
      emit: (s) => states.push(s),
      installed: () => void detected++,
    });
    const first = inst.install('codex');
    expect(first.state).toBe('running');
    expect(spawned!.args).toEqual(['install', '--global', '@openai/codex']);
    child.stdout!.emit('data', Buffer.from('added 1 package\n'));
    child.emit('close', 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(detected).toBe(1);
    expect(states.at(-1)).toMatchObject({ state: 'done', output: 'added 1 package\n' });
    expect(inst.list()).toHaveLength(1);
  });

  it('reports a failure with the exit code and does not start twice', async () => {
    const bin = fakePath(['npm']);
    const child = fakeChild();
    let spawns = 0;
    const inst = new AgentInstaller({
      platform: process.platform === 'win32' ? 'win32' : 'linux',
      env: { PATH: bin },
      readOsRelease: () => 'ID=fedora',
      spawn: () => (spawns++, child),
      emit: () => undefined,
      installed: () => undefined,
    });
    inst.install('opencode');
    inst.install('opencode');
    expect(spawns).toBe(1);
    child.emit('close', 243);
    await new Promise((r) => setTimeout(r, 0));
    expect(inst.list()[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('243') });
  });

  it('refuses when nothing can install it', () => {
    const inst = new AgentInstaller({ platform: 'linux', env: { PATH: '' }, readOsRelease: () => 'ID=ubuntu', emit: () => undefined, installed: () => undefined });
    expect(() => inst.install('codex')).toThrow(/npm was not found/);
    expect(inst.plans().every((p) => p.manager === null && p.problem)).toBe(true);
  });
});
