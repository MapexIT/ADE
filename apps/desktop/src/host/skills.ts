import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { RpcError, type AgentId, type Skill } from '@ade/contracts';
import { git } from '@ade/git';
import { parse, stringify } from 'yaml';

/**
 * Where each agent discovers skills (verified in M0/M6, see docs/DECISIONS.md):
 * Claude Code reads `.claude/skills`, Codex reads `.agents/skills`, OpenCode reads `.opencode/skills` (and the
 * other two). User-level folders are used by the skills manager (SK-05).
 */
export const PROJECT_SKILL_DIRS: Record<AgentId, string> = {
  'claude-code': join('.claude', 'skills'),
  codex: join('.agents', 'skills'),
  opencode: join('.opencode', 'skills'),
  fake: join('.agents', 'skills'),
};

type SyncAgent = 'claude-code' | 'codex' | 'opencode';
const SYNC_AGENTS: SyncAgent[] = ['claude-code', 'codex', 'opencode'];

/** User-level skill folders. Codex and OpenCode both read `~/.agents/skills`. */
export const userSkillDirs = (home: string): Record<SyncAgent, string> => ({
  'claude-code': join(home, '.claude', 'skills'),
  codex: join(home, '.agents', 'skills'),
  opencode: join(home, '.agents', 'skills'),
});

const MARK = 'ade-managed';

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
  problems: string[];
}

/** Reads `SKILL.md`: YAML frontmatter between `---` lines, then the instructions. */
export function parseSkillMd(text: string, folderName: string): ParsedSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const problems: string[] = [];
  let front: Record<string, unknown> = {};
  if (!m) problems.push('SKILL.md has no frontmatter.');
  else {
    try {
      const v = parse(m[1]!) as unknown;
      if (v && typeof v === 'object') front = v as Record<string, unknown>;
    } catch (err) {
      problems.push(`The frontmatter is invalid YAML: ${(err as Error).message}`);
    }
  }
  const name = typeof front.name === 'string' ? front.name : folderName;
  const description = typeof front.description === 'string' ? front.description : '';
  if (!description) problems.push('The skill has no description, so agents will not offer it.');
  if (name !== folderName) problems.push(`The name ${name} does not match its folder ${folderName}.`);
  return {
    name,
    description,
    body: m ? m[2]! : text,
    metadata: (front.metadata as Record<string, unknown>) ?? {},
    problems,
  };
}

export function renderSkillMd(
  name: string,
  description: string,
  body: string,
  metadata?: Record<string, unknown>,
): string {
  const front = stringify(
    { name, description, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) },
    { lineWidth: 0 },
  ).trimEnd();
  return `---\n${front}\n---\n\n${body.trim()}\n`;
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** SK-02 to SK-05: the skill library, builder, per-session skills and sync to the agents' own folders. */
export class SkillService {
  constructor(
    private readonly personalDir: string,
    private readonly home: string,
  ) {}

  private async scan(
    dir: string,
    location: Skill['location'],
    idPrefix: string,
    agentFolder: string | null,
  ): Promise<Skill[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: Skill[] = [];
    for (const folder of names.sort()) {
      const file = join(dir, folder, 'SKILL.md');
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) continue;
      const p = parseSkillMd(text, folder);
      out.push({
        id: `${idPrefix}${folder}`,
        name: p.name,
        description: p.description,
        location,
        agentFolder,
        path: join(dir, folder),
        syncedTo: [],
        problems: p.problems,
      });
    }
    return out;
  }

  /** SK-02: repository, personal and installed skills. */
  async list(repoRoot: string | null): Promise<Skill[]> {
    const own: Skill[] = [];
    if (repoRoot)
      own.push(...(await this.scan(join(repoRoot, '.ade', 'skills'), 'repository', 'repo:', null)));
    own.push(...(await this.scan(this.personalDir, 'personal', 'personal:', null)));
    for (const s of own) s.syncedTo = await this.syncedTo(s.name);

    const installed: Skill[] = [];
    const seen = new Set<string>();
    const dirs: [string, string][] = [];
    if (repoRoot)
      for (const d of new Set(Object.values(PROJECT_SKILL_DIRS)))
        dirs.push([join(repoRoot, d), d.split(sep).join('/')]);
    for (const d of new Set(Object.values(userSkillDirs(this.home))))
      dirs.push([d, `~/${relative(this.home, d).split(sep).join('/')}`]);
    for (const [dir, label] of dirs) {
      for (const s of await this.scan(dir, 'installed', `installed:${label}/`, label)) {
        // Copies ADE synced are shown on the library skill, not again as installed.
        if (await this.isManaged(s.path)) continue;
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        installed.push(s);
      }
    }
    return [...own, ...installed];
  }

  async read(repoRoot: string | null, id: string): Promise<{ skill: Skill; content: string }> {
    const skill = (await this.list(repoRoot)).find((s) => s.id === id);
    if (!skill) throw new RpcError('not_found', 'Unknown skill');
    return { skill, content: await readFile(join(skill.path, 'SKILL.md'), 'utf8') };
  }

  /** SK-03: writes the `SKILL.md` folder. */
  async save(
    repoRoot: string | null,
    input: {
      location: 'repository' | 'personal';
      name: string;
      description: string;
      body: string;
      overwrite: boolean;
    },
  ): Promise<Skill> {
    const base =
      input.location === 'repository'
        ? repoRoot
          ? join(repoRoot, '.ade', 'skills')
          : null
        : this.personalDir;
    if (!base) throw new RpcError('no_workspace', 'Open a repository to save a repository skill.');
    const dir = join(base, input.name);
    if (!input.overwrite && (await exists(join(dir, 'SKILL.md'))))
      throw new RpcError('exists', `A skill called ${input.name} already exists there.`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), renderSkillMd(input.name, input.description, input.body), 'utf8');
    const id = `${input.location === 'repository' ? 'repo' : 'personal'}:${input.name}`;
    const skill = (await this.list(repoRoot)).find((s) => s.id === id);
    if (!skill) throw new RpcError('not_found', 'The skill was not saved.');
    // Keep synced copies current.
    if (skill.syncedTo.length) await this.sync(repoRoot, id, true);
    return skill;
  }

  /** Resolves skill names for a session: repository skills win over personal ones. */
  async resolve(repoRoot: string, names: string[]): Promise<{ name: string; path: string }[]> {
    const lib = (await this.list(repoRoot)).filter((s) => s.location !== 'installed');
    return names.map((name) => {
      const s =
        lib.find((x) => x.location === 'repository' && x.name === name) ?? lib.find((x) => x.name === name);
      if (!s)
        throw new RpcError(
          'unknown_skill',
          `The skill ${name} is not in .ade/skills or your personal library.`,
        );
      return { name, path: s.path };
    });
  }

  /**
   * SK-01: copies skills into the agent's project skills folder inside the worktree, and keeps them out of the
   * change set with an exclude entry. Existing folders of the same name are left alone (the repository's own
   * skill wins).
   */
  async install(
    worktree: string,
    agentId: AgentId,
    skills: { name: string; path: string }[],
  ): Promise<string[]> {
    const dir = PROJECT_SKILL_DIRS[agentId];
    const copied: string[] = [];
    for (const s of skills) {
      const target = join(worktree, dir, s.name);
      if (await exists(target)) continue;
      await mkdir(join(worktree, dir), { recursive: true });
      await cp(s.path, target, { recursive: true });
      copied.push(`${dir.split(sep).join('/')}/${s.name}`);
    }
    if (copied.length) await excludePaths(worktree, copied);
    return copied;
  }

  private async isManaged(path: string): Promise<boolean> {
    return exists(join(path, `.${MARK}`));
  }

  private async syncedTo(name: string): Promise<SyncAgent[]> {
    const dirs = userSkillDirs(this.home);
    const out: SyncAgent[] = [];
    for (const a of SYNC_AGENTS) if (await this.isManaged(join(dirs[a], name))) out.push(a);
    return out;
  }

  /**
   * SK-05: install once, sync to all three agents' user folders. Only folders ADE created (marked with a
   * `.ade-managed` file) are ever replaced or removed; a skill the user installed by hand is never touched.
   */
  async sync(repoRoot: string | null, id: string, enabled: boolean): Promise<Skill> {
    const skill = (await this.list(repoRoot)).find((s) => s.id === id);
    if (!skill || skill.location === 'installed')
      throw new RpcError('not_found', 'Only repository and personal skills can be synced.');
    for (const dir of new Set(Object.values(userSkillDirs(this.home)))) {
      const target = join(dir, skill.name);
      const there = await exists(target);
      if (there && !(await this.isManaged(target))) {
        if (enabled)
          throw new RpcError(
            'exists',
            `${target} already holds a skill ADE did not install. Remove it first.`,
          );
        continue;
      }
      await rm(target, { recursive: true, force: true });
      if (enabled) {
        await mkdir(dir, { recursive: true });
        await cp(skill.path, target, { recursive: true });
        await writeFile(join(target, `.${MARK}`), `Synced by ADE from ${skill.path}\n`, 'utf8');
      }
    }
    return (await this.list(repoRoot)).find((s) => s.id === id)!;
  }
}

/** Adds paths to the repository's exclude file inside a marked block. Worktrees share it. */
export async function excludePaths(worktree: string, paths: string[]): Promise<void> {
  // `info/` is shared by every worktree, so this resolves to the main repository's exclude file.
  const path = resolve(
    worktree,
    (await git(['rev-parse', '--git-path', 'info/exclude'], { cwd: worktree })).trim(),
  );
  await mkdir(dirname(path), { recursive: true });
  const current = await readFile(path, 'utf8').catch(() => '');
  const begin = '# >>> ADE skills (copied into session worktrees)';
  const end = '# <<< ADE skills';
  const lines = new Set<string>();
  const m = new RegExp(`${begin}\\n([\\s\\S]*?)${end}\\n?`).exec(current);
  if (m) for (const l of m[1]!.split('\n')) if (l.trim()) lines.add(l.trim());
  for (const p of paths) lines.add(`/${p}/`);
  const block = `${begin}\n${[...lines].sort().join('\n')}\n${end}\n`;
  const next = m
    ? current.replace(m[0], block)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${block}`;
  await writeFile(path, next, 'utf8');
}
