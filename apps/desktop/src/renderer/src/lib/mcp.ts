import { McpServerConfig, type McpCheck, type McpServerEntry } from '@ade/contracts';

/** The add/edit form's fields. Values of env vars or headers are free text; `$NAME` is read from ADE's environment. */
export interface McpDraft {
  name: string;
  kind: 'stdio' | 'http';
  command: string;
  url: string;
  pairs: { key: string; value: string }[];
}

const quote = (arg: string) => (/[\s"]/.test(arg) ? `'${arg}'` : arg);

export function draftFrom(config: McpServerConfig | null): McpDraft {
  if (!config) return { name: '', kind: 'stdio', command: '', url: '', pairs: [] };
  if ('url' in config) return { name: config.name, kind: 'http', command: '', url: config.url, pairs: Object.entries(config.headers).map(([key, value]) => ({ key, value })) };
  const command = Array.isArray(config.command) ? config.command.map(quote).join(' ') : config.command;
  return { name: config.name, kind: 'stdio', command, url: '', pairs: Object.entries(config.env).map(([key, value]) => ({ key, value })) };
}

/** The server the form describes, or the first problem with it. Empty rows are ignored. */
export function configFrom(d: McpDraft): { ok: true; config: McpServerConfig } | { ok: false; error: string } {
  const pairs = d.pairs.filter((p) => p.key.trim() || p.value.trim());
  const bad = pairs.find((p) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(p.key.trim()));
  if (bad) return { ok: false, error: `"${bad.key}" is not a valid ${d.kind === 'http' ? 'header' : 'variable'} name.` };
  const values = Object.fromEntries(pairs.map((p) => [p.key.trim(), p.value]));
  const candidate = d.kind === 'http' ? { name: d.name.trim(), url: d.url.trim(), headers: values } : { name: d.name.trim(), command: d.command.trim(), env: values };
  const parsed = McpServerConfig.safeParse(candidate);
  if (parsed.success) return { ok: true, config: parsed.data };
  if (!d.name.trim()) return { ok: false, error: 'Give the server a name.' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(d.name.trim())) return { ok: false, error: 'Use letters, digits, dashes and underscores in the name.' };
  return { ok: false, error: d.kind === 'http' ? 'Enter an http or https URL.' : 'Enter the command that starts the server.' };
}

export type Tone = 'ok' | 'neutral' | 'attention' | 'danger' | 'accent';

/** The status shown for a server: off, missing something, the last check, or ready. */
export function statusOf(entry: McpServerEntry, check: McpCheck | null | undefined): { label: string; tone: Tone } {
  if (!entry.enabled) return { label: 'Off', tone: 'neutral' };
  if (entry.missing.length) return { label: `Needs ${entry.missing.join(', ')}`, tone: 'attention' };
  if (check) return check.ok ? { label: `Connected · ${check.tools.length} tool${check.tools.length === 1 ? '' : 's'}`, tone: 'ok' } : { label: 'Check failed', tone: 'danger' };
  return { label: entry.checkable ? 'On · not checked' : 'On', tone: 'accent' };
}

export const SOURCE_LABELS: Record<McpServerEntry['source'], string> = {
  personal: 'Personal',
  workspace: 'This repository',
  'built-in': 'Built into ADE',
};
