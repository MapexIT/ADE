import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const McpName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'use letters, digits, dashes and underscores');
const Values = z.record(z.string(), z.string()).default({});

/**
 * ST-05: an MCP server every session in the workspace receives. Values may name environment variables
 * (`$NAME` or `${NAME}`), read from ADE's environment at launch, so no secret has to live in the file.
 */
export const McpServerConfig = z.union([
  z.object({ name: McpName, command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]), env: Values }),
  z.object({ name: McpName, url: z.url({ protocol: /^https?$/ }), headers: Values }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** `.ade/workspace.yaml`: setup commands run after a worktree is created, and untracked files to copy (CN-02). */
export const WorkspaceConfig = z.object({
  setup: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).default([]),
  copy: z.array(z.string().min(1)).default([]),
  setupTimeoutSeconds: z.number().int().positive().max(3600).default(600),
  mcpServers: z.array(McpServerConfig).max(20).default([]),
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

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Replaces `$NAME` and `${NAME}` from `env`. Returns the names that were missing. Pure. */
export function expandVars(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(VAR, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b)!;
    const v = env[name];
    if (v === undefined) missing.push(name);
    return v ?? '';
  });
  return { value: out, missing };
}

export type ResolvedMcpServer =
  | { name: string; command: string; args: string[]; env: Record<string, string> }
  | { name: string; url: string; headers: Record<string, string> };

/** ST-05: the servers ready to hand to an agent, and the ones skipped because a variable is not set. Pure. */
export function resolveMcpServers(servers: McpServerConfig[], env: NodeJS.ProcessEnv): { servers: ResolvedMcpServer[]; skipped: { name: string; missing: string[] }[] } {
  const ok: ResolvedMcpServer[] = [];
  const skipped: { name: string; missing: string[] }[] = [];
  for (const s of servers) {
    const missing: string[] = [];
    const expand = (rec: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(rec).map(([k, v]) => {
          const r = expandVars(v, env);
          missing.push(...r.missing);
          return [k, r.value];
        }),
      );
    if ('url' in s) {
      const headers = expand(s.headers);
      if (missing.length) skipped.push({ name: s.name, missing });
      else ok.push({ name: s.name, url: s.url, headers });
    } else {
      const [command = '', ...args] = toArgv(s.command);
      const vars = expand(s.env);
      if (missing.length) skipped.push({ name: s.name, missing });
      else ok.push({ name: s.name, command, args, env: vars });
    }
  }
  return { servers: ok, skipped };
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
