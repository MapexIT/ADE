import { AGENT_LABELS, type AgentId, type PromptBlock, type SandboxState, type ToolStatus } from '@ade/contracts';

export const agentLabel = (id: AgentId) => AGENT_LABELS[id];

export const SANDBOX_LABELS: Record<SandboxState, string> = {
  sandboxed: 'Sandboxed',
  'commands-sandboxed': 'Commands sandboxed',
  'not-sandboxed': 'Not sandboxed',
};

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export const PROFILE_LABELS = {
  ask: 'Ask',
  'auto-edit': 'Auto-edit',
  autonomous: 'Autonomous',
  'read-only': 'Read-only',
} as const;

export function elapsed(fromIso: string, toIso?: string | null): string {
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : Date.now()) - Date.parse(fromIso));
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export const textPrompt = (text: string, attachments: PromptBlock[] = []): PromptBlock[] => [
  ...(text.trim() ? [{ type: 'text' as const, text: text.trim() }] : []),
  ...attachments,
];

export function promptPreview(blocks: PromptBlock[]): string {
  return blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' ? `[${b.name}]` : '[image]'))
    .join(' ')
    .slice(0, 200);
}

export const attachmentText = (name: string, text: string, uri = `ade://${encodeURIComponent(name)}`): PromptBlock => ({
  type: 'resource',
  uri,
  name,
  text,
  mimeType: 'text/plain',
});

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '').split('/').join(sep)}`;
}

/** Monaco language id from a file name. */
export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', md: 'markdown', css: 'css', scss: 'scss', html: 'html', yml: 'yaml', yaml: 'yaml',
    cs: 'csharp', py: 'python', go: 'go', rs: 'rust', java: 'java', sh: 'shell', bash: 'shell',
    ps1: 'powershell', sql: 'sql', xml: 'xml', csproj: 'xml', toml: 'ini', ini: 'ini', c: 'c', h: 'c', cpp: 'cpp',
  };
  return map[ext] ?? 'plaintext';
}

/** The session's worktree while it still exists: landing or discarding a session removes it. Pure. */
export function liveWorktree(session: { state: string; worktreePath: string | null } | null | undefined): string | null {
  if (!session?.worktreePath || session.state === 'landed' || session.state === 'discarded') return null;
  return session.worktreePath;
}
