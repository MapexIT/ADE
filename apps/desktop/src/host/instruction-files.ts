import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix } from 'node:path';
import type { InstructionStatus } from '@ade/contracts';
import { git } from '@ade/git';

/**
 * ED-04: which instruction files each agent reads, from their documentation (see docs/DECISIONS.md):
 * - Claude Code reads CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md, and AGENTS.md only when none of those
 *   exist; ~/.claude/CLAUDE.md for every project; nested CLAUDE.md files when it works in that folder.
 * - Codex reads AGENTS.override.md, otherwise AGENTS.md, in the project and in its home (~/.codex or CODEX_HOME).
 * - OpenCode reads AGENTS.md, otherwise CLAUDE.md, in each folder, and ~/.config/opencode/AGENTS.md (otherwise
 *   ~/.claude/CLAUDE.md); nested files when it works in that folder.
 */
export interface InstructionInput {
  /** Repository-relative paths (forward slashes) of instruction files that exist. */
  files: string[];
  /** Absolute paths of the user-level files that exist. */
  userFiles: string[];
  home: string;
  codexHome: string;
  /** Contents of root files, for the divergence check. */
  read: (path: string) => string | null;
}

const ROOT_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'];
const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\s+$/gm, '').trim();

/** Pure: the files per agent and the problems worth showing. */
export function resolveInstructions(input: InstructionInput): InstructionStatus {
  const has = (p: string) => input.files.includes(p);
  const user = (p: string) => input.userFiles.includes(p);
  const nestedOf = (names: string[]) => input.files.filter((f) => f.includes('/') && !f.startsWith('.claude/') && names.includes(posix.basename(f)));
  const claudeHome = join(input.home, '.claude', 'CLAUDE.md');
  const codexOverride = join(input.codexHome, 'AGENTS.override.md');
  const codexAgents = join(input.codexHome, 'AGENTS.md');
  const opencodeHome = join(input.home, '.config', 'opencode', 'AGENTS.md');

  const claudeProject = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'].filter(has);
  const claude = [
    ...claudeProject.map((path) => ({ path, scope: 'project' as const, note: path === 'CLAUDE.local.md' ? 'personal, usually not committed' : null })),
    ...(claudeProject.length === 0 && has('AGENTS.md') ? [{ path: 'AGENTS.md', scope: 'project' as const, note: 'read because there is no CLAUDE.md' }] : []),
    ...(user(claudeHome) ? [{ path: claudeHome, scope: 'user' as const, note: null }] : []),
    ...nestedOf(['CLAUDE.md']).map((path) => ({ path, scope: 'nested' as const, note: 'when it works in that folder' })),
  ];
  const codexProject = has('AGENTS.override.md') ? 'AGENTS.override.md' : has('AGENTS.md') ? 'AGENTS.md' : null;
  const codexUser = user(codexOverride) ? codexOverride : user(codexAgents) ? codexAgents : null;
  const codex = [
    ...(codexUser ? [{ path: codexUser, scope: 'user' as const, note: null }] : []),
    ...(codexProject ? [{ path: codexProject, scope: 'project' as const, note: codexProject === 'AGENTS.override.md' && has('AGENTS.md') ? 'replaces AGENTS.md' : null }] : []),
    ...nestedOf(['AGENTS.md', 'AGENTS.override.md']).map((path) => ({ path, scope: 'nested' as const, note: 'when started in that folder' })),
  ];
  const opencodeProject = has('AGENTS.md') ? 'AGENTS.md' : has('CLAUDE.md') ? 'CLAUDE.md' : null;
  const opencodeUser = user(opencodeHome) ? opencodeHome : user(claudeHome) ? claudeHome : null;
  const opencode = [
    ...(opencodeUser ? [{ path: opencodeUser, scope: 'user' as const, note: opencodeUser === claudeHome ? 'read because there is no global AGENTS.md' : null }] : []),
    ...(opencodeProject ? [{ path: opencodeProject, scope: 'project' as const, note: opencodeProject === 'CLAUDE.md' ? 'read because there is no AGENTS.md' : null }] : []),
    ...nestedOf(['AGENTS.md', 'CLAUDE.md']).map((path) => ({ path, scope: 'nested' as const, note: 'when it works in that folder' })),
  ];

  const problems: string[] = [];
  const claudeText = claudeProject.includes('CLAUDE.md') ? input.read('CLAUDE.md') : null;
  const agentsText = has('AGENTS.md') ? input.read('AGENTS.md') : null;
  if (claudeText !== null && agentsText !== null && norm(claudeText) !== norm(agentsText) && !/@AGENTS\.md\b/.test(claudeText)) {
    problems.push('CLAUDE.md and AGENTS.md differ: Claude Code reads CLAUDE.md, while Codex and OpenCode read AGENTS.md. Make them the same, or put "@AGENTS.md" in CLAUDE.md.');
  }
  if (claudeProject.length && !codexProject) problems.push('Codex reads no project instructions: there is no AGENTS.md (it does not read CLAUDE.md).');
  if (!claudeProject.length && !has('AGENTS.md') && !has('AGENTS.override.md')) problems.push('No agent reads project instructions: there is no CLAUDE.md or AGENTS.md.');
  if (has('AGENTS.override.md') && has('AGENTS.md')) problems.push('Codex reads AGENTS.override.md instead of AGENTS.md, but OpenCode reads AGENTS.md: they get different instructions.');

  return {
    agents: [
      { agentId: 'claude-code', files: claude },
      { agentId: 'codex', files: codex },
      { agentId: 'opencode', files: opencode },
    ],
    problems,
  };
}

/** Reads the repository and the user's home (existence only there) and resolves the instructions. */
export async function instructionStatus(root: string): Promise<InstructionStatus> {
  const listed = (await git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root }).catch(() => ''))
    .split('\n')
    .filter((f) => /(^|\/)(CLAUDE|AGENTS|AGENTS\.override)\.md$/.test(f));
  // CLAUDE.local.md is usually ignored, so the root names are checked on disk too.
  const files = [...new Set([...listed, ...ROOT_NAMES.filter((n) => existsSync(join(root, n)))])];
  const home = homedir();
  const codexHome = process.env.CODEX_HOME || join(home, '.codex');
  const userFiles = [join(home, '.claude', 'CLAUDE.md'), join(codexHome, 'AGENTS.override.md'), join(codexHome, 'AGENTS.md'), join(home, '.config', 'opencode', 'AGENTS.md')].filter((p) => existsSync(p));
  return resolveInstructions({
    files,
    userFiles,
    home,
    codexHome,
    read: (p) => {
      try {
        return readFileSync(join(root, p), 'utf8');
      } catch {
        return null;
      }
    },
  });
}
