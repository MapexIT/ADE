import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AcpRuntime } from '@ade/acp-client';
import { AGENT_LABELS, RpcError, type AgentId, type AgentStatus, type FileContent, type FileEntry, type RunConfig, type Workspace } from '@ade/contracts';
import { git, isGitRepo, repoRoot } from '@ade/git';
import type { Repositories } from './repositories.ts';
import type { SessionService } from './session-service.ts';

/** Opening repositories (M1-T05). Only Git repositories can become workspaces. */
export class WorkspaceService {
  constructor(private readonly repos: Repositories) {}

  list(): Workspace[] {
    return this.repos.workspaces.list();
  }

  async open(path: string): Promise<Workspace> {
    if (!isAbsolute(path) || !existsSync(path)) throw new RpcError('not_found', 'That folder does not exist.');
    if (!(await isGitRepo(path))) throw new RpcError('not_a_repo', 'ADE works on Git repositories. Choose a folder that contains one.');
    const root = await repoRoot(path);
    const ws = this.repos.workspaces.upsert(root, basename(root));
    this.repos.settings.set('lastWorkspaceId', ws.id);
    return ws;
  }
}

/** Agent detection and health (ST-01). Capabilities are read from `initialize` when a session starts. */
export class AgentService {
  private cache: AgentStatus[] | null = null;
  private readonly needsSignIn = new Set<AgentId>();

  constructor(private readonly runtimes: Map<AgentId, AcpRuntime>) {}

  markNeedsSignIn(id: AgentId) {
    this.needsSignIn.add(id);
    this.cache = null;
  }

  async status(refresh: boolean): Promise<AgentStatus[]> {
    if (this.cache && !refresh) return this.cache;
    const out: AgentStatus[] = [];
    for (const rt of this.runtimes.values()) {
      const [install, launch] = await Promise.all([rt.detect(), rt.launchable()]);
      out.push({
        id: rt.id,
        label: AGENT_LABELS[rt.id],
        health: !launch.ok ? 'not-installed' : this.needsSignIn.has(rt.id) ? 'needs-sign-in' : 'ready',
        path: install?.path ?? null,
        version: install?.version ?? null,
        reason: launch.ok ? null : launch.reason,
      });
    }
    this.cache = out;
    return out;
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', 'out', '.venv', 'target']);
const MAX_FILES = 20_000;
const MAX_READ = 5 * 1024 * 1024;

/** File tree, read and write for the editor (ED-01) with external-change detection and RV-06 attribution. */
export class FileService {
  constructor(
    private readonly repos: Repositories,
    private readonly sessions: SessionService,
  ) {}

  /** Allowed roots: workspace checkouts and session worktrees. Nothing outside them is readable or writable. */
  private assertAllowed(path: string) {
    const full = resolve(path);
    // Compare real paths so Windows short (8.3) names and symlinks cannot slip past the check.
    const real = (p: string): string => {
      try {
        return realpathSync.native(p);
      } catch {
        const parent = dirname(p);
        return parent === p ? p : join(real(parent), basename(p));
      }
    };
    const fullReal = real(full);
    const roots = [
      ...this.repos.workspaces.list().map((w) => w.rootPath),
      ...this.repos.workspaces.list().flatMap((w) => this.repos.sessions.list(w.id).map((s) => s.worktreePath).filter((p): p is string => !!p)),
    ];
    const ok = roots.some((r) => {
      const rel = relative(real(resolve(r)), fullReal);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
    if (!ok) throw new RpcError('forbidden', 'That path is outside every workspace and worktree.');
    return full;
  }

  async list(root: string): Promise<FileEntry[]> {
    const base = this.assertAllowed(root);
    let files: string[];
    if (await isGitRepo(base)) {
      const out = await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: base });
      files = out.split('\0').filter(Boolean).slice(0, MAX_FILES);
    } else {
      files = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (files.length >= MAX_FILES) return;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name));
          } else files.push(relative(base, join(dir, e.name)).split(sep).join('/'));
        }
      };
      await walk(base);
    }
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return [
      ...[...dirs].sort().map((d) => ({ path: d, name: d.split('/').pop()!, isDir: true })),
      ...files.sort().map((f) => ({ path: f, name: f.split('/').pop()!, isDir: false })),
    ];
  }

  async read(path: string): Promise<FileContent> {
    const full = this.assertAllowed(path);
    const info = await stat(full);
    if (info.size > MAX_READ) throw new RpcError('too_large', 'The file is too large to open in ADE.');
    return { path: full, content: await readFile(full, 'utf8'), mtimeMs: info.mtimeMs };
  }

  async write(path: string, content: string, expectedMtimeMs: number | null, sessionId?: string) {
    const full = this.assertAllowed(path);
    const current = await stat(full).catch(() => null);
    if (current && expectedMtimeMs !== null && Math.abs(current.mtimeMs - expectedMtimeMs) > 1) return { ok: false as const, conflict: true as const };
    await writeFile(full, content);
    const info = await stat(full);
    if (sessionId) {
      const s = this.repos.sessions.get(sessionId);
      // RV-06: edits made while the agent is idle are attributed to the user.
      if (s?.worktreePath && !this.sessions.hasActiveTurn(sessionId)) {
        const rel = relative(s.worktreePath, full).split(sep).join('/');
        this.repos.audit.append({ workspaceId: s.workspaceId, sessionId, actor: 'user', action: 'user.edit', detail: { path: rel } });
        this.sessions.record(sessionId, { type: 'notice', level: 'info', text: `You edited ${rel}.` });
      }
    }
    return { ok: true as const, mtimeMs: info.mtimeMs };
  }
}

type DetectedConfig = Omit<RunConfig, 'id' | 'workspaceId' | 'source'>;

/** CR-01: run, test and build commands detected from project manifests. */
export async function detectRunConfigs(root: string): Promise<DetectedConfig[]> {
  const out: DetectedConfig[] = [];
  const has = (f: string) => existsSync(join(root, f));
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      for (const name of Object.keys(pkg.scripts ?? {})) out.push({ name: `${pm} ${name}`, command: [pm, 'run', name], cwd: '.' });
    } catch {
      // invalid package.json
    }
  }
  const entries = await readdir(root).catch(() => [] as string[]);
  const dotnet = entries.find((e) => e.endsWith('.sln') || e.endsWith('.slnx')) ?? entries.find((e) => e.endsWith('.csproj'));
  if (dotnet) {
    out.push({ name: 'dotnet build', command: ['dotnet', 'build', dotnet], cwd: '.' });
    out.push({ name: 'dotnet test', command: ['dotnet', 'test', dotnet], cwd: '.' });
    if (dotnet.endsWith('.csproj')) out.push({ name: 'dotnet run', command: ['dotnet', 'run', '--project', dotnet], cwd: '.' });
  }
  if (has('Makefile')) {
    const text = await readFile(join(root, 'Makefile'), 'utf8').catch(() => '');
    for (const m of text.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)) {
      if (m[1] && !m[1].startsWith('.')) out.push({ name: `make ${m[1]}`, command: ['make', m[1]], cwd: '.' });
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py')) out.push({ name: 'pytest', command: ['python', '-m', 'pytest'], cwd: '.' });
  if (has('Cargo.toml')) {
    out.push({ name: 'cargo build', command: ['cargo', 'build'], cwd: '.' });
    out.push({ name: 'cargo test', command: ['cargo', 'test'], cwd: '.' });
  }
  if (has('go.mod')) out.push({ name: 'go test', command: ['go', 'test', './...'], cwd: '.' });
  return out;
}
