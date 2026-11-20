import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

/** `.ade/workspace.yaml`: setup commands run after a worktree is created, and untracked files to copy (CN-02). */
export const WorkspaceConfig = z.object({
  setup: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).default([]),
  copy: z.array(z.string().min(1)).default([]),
  setupTimeoutSeconds: z.number().int().positive().max(3600).default(600),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

export const WORKSPACE_FILE = join('.ade', 'workspace.yaml');

/**
 * A setup command written as a string is split on whitespace (quotes group words). It is never handed to a
 * shell; people who need shell features write `["bash", "-c", "..."]` explicitly.
 */
export function toArgv(command: string | string[]): string[] {
  if (Array.isArray(command)) return command;
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export async function readWorkspaceConfig(root: string): Promise<{ exists: boolean; raw: string; config: WorkspaceConfig; error: string | null }> {
  let raw = '';
  try {
    raw = await readFile(join(root, WORKSPACE_FILE), 'utf8');
  } catch {
    return { exists: false, raw: '', config: WorkspaceConfig.parse({}), error: null };
  }
  try {
    const parsed = WorkspaceConfig.safeParse(parse(raw) ?? {});
    if (!parsed.success) return { exists: true, raw, config: WorkspaceConfig.parse({}), error: z.prettifyError(parsed.error) };
    return { exists: true, raw, config: parsed.data, error: null };
  } catch (err) {
    return { exists: true, raw, config: WorkspaceConfig.parse({}), error: (err as Error).message };
  }
}
