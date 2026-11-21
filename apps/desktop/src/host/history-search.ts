import { homedir } from 'node:os';
import { redactSecrets, type AuditEntry, type SessionSearchResult } from '@ade/contracts';
import type { Repositories } from './repositories.ts';

type Row = { session_id: string; ts: string; type: string; payload_json: string };

const textOf = (type: string, p: Record<string, unknown>): { kind: SessionSearchResult['matches'][number]['kind']; text: string } | null => {
  if (type === 'agent.message') return { kind: 'agent', text: String(p.text ?? '') };
  if (type === 'user.message') return { kind: 'you', text: ((p.content as { text?: string }[] | undefined) ?? []).map((b) => b.text ?? '').join(' ') };
  if (type === 'tool.call') return { kind: 'tool', text: String(p.title ?? '') };
  if (type === 'notice') return { kind: 'notice', text: String(p.text ?? '') };
  return null;
};

/** A window of text around the first match, on one line. Pure. */
export function snippet(text: string, query: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return flat.slice(0, width);
  const start = Math.max(0, at - Math.floor((width - query.length) / 2));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`;
}

/**
 * HI-06: full-text search over what was said and done in sessions (your prompts, agent messages, tool calls and
 * notices). SQLite narrows the rows; the exact match is checked on the decoded text.
 */
export function searchSessions(repos: Repositories, query: string, workspaceId?: string): SessionSearchResult[] {
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = repos.db.all<Row>(
    `SELECT e.session_id, e.ts, e.type, e.payload_json FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE e.type IN ('user.message', 'agent.message', 'tool.call', 'notice') AND e.payload_json LIKE ? ESCAPE '\\'
     ${workspaceId ? 'AND s.workspace_id = ?' : ''} ORDER BY e.ts DESC LIMIT 500`,
    ...(workspaceId ? [like, workspaceId] : [like]),
  );
  const bySession = new Map<string, SessionSearchResult>();
  const q = query.toLowerCase();
  for (const r of rows) {
    const found = textOf(r.type, JSON.parse(r.payload_json) as Record<string, unknown>);
    if (!found || !found.text.toLowerCase().includes(q)) continue;
    let entry = bySession.get(r.session_id);
    if (!entry) {
      const s = repos.sessions.get(r.session_id);
      if (!s) continue;
      if (bySession.size >= 50) continue;
      entry = { sessionId: s.id, title: s.title, agentId: s.agentId, state: s.state, matches: [] };
      bySession.set(s.id, entry);
    }
    if (entry.matches.length < 5) entry.matches.push({ kind: found.kind, snippet: snippet(found.text, query), at: r.ts });
  }
  return [...bySession.values()];
}

/**
 * HI-07: the audit log as JSON. Local paths become placeholders (the home folder, ADE's data folder, the
 * repository and each worktree) and anything that looks like a secret becomes [redacted].
 */
export function exportAudit(entries: AuditEntry[], paths: { workspace: string; userData: string; worktrees: string[]; home?: string }): string {
  const pairs: [string, string][] = [
    ...paths.worktrees.map((w) => [w, '<worktree>'] as [string, string]),
    [paths.workspace, '<repository>'],
    [paths.userData, '<ade-data>'],
    [paths.home ?? homedir(), '<home>'],
  ];
  // Longest first, and both slash styles, so nested paths and JSON-escaped Windows paths are caught.
  const variants = pairs
    .flatMap(([p, label]) => [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')].map((v) => [v, label] as [string, string]))
    .filter(([p]) => p.length > 2)
    .sort((a, b) => b[0].length - a[0].length);
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const [p, label] of variants) out = out.split(p).join(label);
      return redactSecrets(out);
    }
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  return JSON.stringify({ exportedAt: new Date().toISOString(), format: 'ade-audit-1', entries: entries.map((e) => clean(e)) }, null, 2);
}
