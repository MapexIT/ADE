import { Badge, Button, cx, EmptyState, SectionLabel } from '@ade/ui';
import type { AgentId, Skill } from '@ade/contracts';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCATIONS: { id: Skill['location']; label: string }[] = [
  { id: 'repository', label: 'In this repository' },
  { id: 'personal', label: 'Personal library' },
  { id: 'installed', label: 'Installed in agents' },
];
const SYNC_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Splits a SKILL.md into its description and body for editing. */
function bodyOf(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  return (m ? m[1]! : content).trim();
}

type Pane =
  | { kind: 'view'; id: string }
  | {
      kind: 'build';
      from?: { name: string; description: string; body: string; location: 'repository' | 'personal' };
    }
  | { kind: 'draft' }
  | null;

/** Screen 7: skill library, builder, drafting with an agent, and sync to the agents (SK-02 to SK-05). */
export function SkillsScreen() {
  const workspaceId = useStore((s) => s.workspaceId);
  const toast = useStore((s) => s.toast);
  const set = useStore((s) => s.set);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>(null);

  const reload = useCallback(
    async () => setSkills((await attempt(() => host.call('skills.list', { workspaceId }))) ?? []),
    [workspaceId],
  );
  useEffect(() => void reload(), [reload]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : skills;
  }, [skills, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="m-0 text-[16px] font-semibold">Skills</h1>
        <span className="text-ink-muted">
          Agent Skills folders you can attach to sessions and workflow steps.
        </span>
        <span className="flex-1" />
        <Button size="dense" onClick={() => setPane({ kind: 'draft' })} disabled={!workspaceId}>
          Draft with an agent
        </Button>
        <Button size="dense" variant="primary" onClick={() => setPane({ kind: 'build' })}>
          New skill
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Skill library"
          className="flex w-80 flex-col gap-3 overflow-auto border-r border-line bg-surface p-3"
        >
          <label htmlFor="skill-search" className="sr-only">
            Search skills
          </label>
          <input
            id="skill-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills"
            className={inputClass}
          />
          {LOCATIONS.map((loc) => {
            const items = shown.filter((s) => s.location === loc.id);
            return (
              <section key={loc.id} className="flex flex-col gap-2">
                <SectionLabel>{loc.label}</SectionLabel>
                {items.length === 0 ? (
                  <p className="m-0 text-[12px] text-ink-muted">
                    {loc.id === 'repository'
                      ? 'Skills in .ade/skills/ are versioned with the code.'
                      : 'None.'}
                  </p>
                ) : null}
                {items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setPane({ kind: 'view', id: s.id })}
                    aria-current={pane?.kind === 'view' && pane.id === s.id ? 'true' : undefined}
                    className={cx(
                      'flex flex-col gap-0.5 rounded-[var(--radius)] border px-3 py-2 text-left',
                      pane?.kind === 'view' && pane.id === s.id
                        ? 'border-accent bg-accent-tint'
                        : 'border-line hover:bg-surface-raised',
                    )}
                  >
                    <span className="font-semibold">{s.name}</span>
                    <span className="line-clamp-2 text-[12px] text-ink-muted">
                      {s.description || 'No description'}
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {s.agentFolder ? <Badge>{s.agentFolder}</Badge> : null}
                      {s.syncedTo.length ? <Badge tone="ok">Synced</Badge> : null}
                      {s.problems.length ? (
                        <Badge tone="attention">{s.problems.length} problem(s)</Badge>
                      ) : null}
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
        </aside>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {pane?.kind === 'view' ? (
            <SkillDetail
              key={pane.id}
              id={pane.id}
              workspaceId={workspaceId}
              onChanged={reload}
              onEdit={(from) => setPane({ kind: 'build', from })}
              onTry={(name) => set({ newSession: { skills: [name] } })}
            />
          ) : pane?.kind === 'build' ? (
            <SkillBuilder
              key={pane.from?.name ?? 'new'}
              workspaceId={workspaceId}
              from={pane.from}
              onSaved={async (s) => {
                await reload();
                toast(`Saved ${s.name}.`, 'info');
                setPane({ kind: 'view', id: s.id });
              }}
            />
          ) : pane?.kind === 'draft' && workspaceId ? (
            <SkillDraft workspaceId={workspaceId} />
          ) : (
            <EmptyState
              title="Pick a skill"
              body="Browse the library on the left, build a skill in a form, or have an agent draft one."
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SkillDetail({
  id,
  workspaceId,
  onChanged,
  onEdit,
  onTry,
}: {
  id: string;
  workspaceId: string | null;
  onChanged: () => void;
  onEdit: (from: {
    name: string;
    description: string;
    body: string;
    location: 'repository' | 'personal';
  }) => void;
  onTry: (name: string) => void;
}) {
  const [data, setData] = useState<{ skill: Skill; content: string } | null>(null);
  const load = useCallback(
    () => void attempt(() => host.call('skills.read', { workspaceId, id })).then((d) => setData(d ?? null)),
    [id, workspaceId],
  );
  useEffect(load, [load]);
  if (!data) return null;
  const { skill, content } = data;
  const own = skill.location !== 'installed';
  const synced = skill.syncedTo.length > 0;
  return (
    <div className="flex max-w-3xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="m-0 text-[16px] font-semibold">{skill.name}</h2>
        <Badge>{LOCATIONS.find((l) => l.id === skill.location)?.label}</Badge>
        {skill.syncedTo.map((a) => (
          <Badge key={a} tone="ok">
            Synced to {SYNC_LABELS[a]}
          </Badge>
        ))}
      </div>
      <p className="m-0">{skill.description}</p>
      <span className="font-mono text-[12px] text-ink-muted">{skill.path}</span>
      {skill.problems.map((p) => (
        <p
          key={p}
          className="m-0 rounded-[var(--radius)] border border-attention-line px-3 py-2 text-attention"
        >
          {p}
        </p>
      ))}
      {own ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="dense"
            onClick={() =>
              onEdit({
                name: skill.name,
                description: skill.description,
                body: bodyOf(content),
                location: skill.location as 'repository' | 'personal',
              })
            }
          >
            Edit
          </Button>
          <Button size="dense" onClick={() => onTry(skill.name)} disabled={!workspaceId}>
            Try in a session
          </Button>
          <Button
            size="dense"
            variant={synced ? 'ghost' : 'secondary'}
            onClick={() =>
              void attempt(() =>
                host.call('skills.sync', { workspaceId, id: skill.id, enabled: !synced }),
              ).then((s) => {
                if (s) {
                  load();
                  onChanged();
                }
              })
            }
          >
            {synced ? 'Stop syncing to agents' : 'Sync to all agents'}
          </Button>
        </div>
      ) : (
        <p className="m-0 text-[12px] text-ink-muted">
          Installed directly in an agent's folder. ADE lists it but does not change it.
        </p>
      )}
      {own ? (
        <p className="m-0 text-[12px] text-ink-muted">
          Syncing copies the skill into ~/.claude/skills (Claude Code) and ~/.agents/skills (Codex and
          OpenCode), so every session of those agents can use it.
        </p>
      ) : null}
      <pre className="m-0 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-3 font-mono text-[12px] whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  );
}

function SkillBuilder({
  workspaceId,
  from,
  onSaved,
}: {
  workspaceId: string | null;
  from: { name: string; description: string; body: string; location: 'repository' | 'personal' } | undefined;
  onSaved: (s: Skill) => void | Promise<void>;
}) {
  const [name, setName] = useState(from?.name ?? '');
  const [description, setDescription] = useState(from?.description ?? '');
  const [body, setBody] = useState(from?.body ?? '## When to use\n\n## Steps\n\n1. ');
  const [location, setLocation] = useState<'repository' | 'personal'>(
    from?.location ?? (workspaceId ? 'repository' : 'personal'),
  );
  const nameError =
    name && !NAME.test(name)
      ? 'Use lower-case letters, digits and single dashes.'
      : name.length > 64
        ? 'At most 64 characters.'
        : null;
  const preview = `---\nname: ${name || 'skill-name'}\ndescription: ${description || '…'}\n---\n\n${body.trim()}\n`;
  const disabled = !name || !!nameError || !description.trim() || (location === 'repository' && !workspaceId);
  return (
    <div className="grid max-w-6xl gap-4 lg:grid-cols-2">
      <form
        className="flex flex-col gap-3"
        aria-label="Skill builder"
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(() =>
            host.call('skills.save', {
              workspaceId,
              location,
              name,
              description: description.trim(),
              body,
              overwrite: !!from,
            }),
          ).then((s) => s && onSaved(s));
        }}
      >
        <h2 className="m-0 text-[16px] font-semibold">{from ? `Edit ${from.name}` : 'New skill'}</h2>
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-name" className="font-semibold">
            Name
          </label>
          <input
            id="skill-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!from}
            className={`${inputClass} font-mono`}
            aria-invalid={!!nameError}
          />
          <span className={cx('text-[12px]', nameError ? 'text-danger' : 'text-ink-muted')}>
            {nameError ?? 'Also the folder name, for example release-notes.'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-description" className="font-semibold">
            Description
          </label>
          <textarea
            id="skill-description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputClass} py-2`}
          />
          <span className="text-[12px] text-ink-muted">
            Agents read this to decide when to use the skill. Say what it does and when.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-body" className="font-semibold">
            Instructions
          </label>
          <textarea
            id="skill-body"
            rows={14}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className={`${inputClass} py-2 font-mono`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="skill-location" className="font-semibold">
            Save in
          </label>
          <select
            id="skill-location"
            value={location}
            onChange={(e) => setLocation(e.target.value as 'repository' | 'personal')}
            disabled={!!from}
            className={inputClass}
          >
            <option value="repository" disabled={!workspaceId}>
              This repository (.ade/skills)
            </option>
            <option value="personal">My personal library</option>
          </select>
        </div>
        <div>
          <Button type="submit" variant="primary" disabled={disabled}>
            Save skill
          </Button>
        </div>
      </form>
      <section aria-label="SKILL.md preview" className="flex flex-col gap-2">
        <SectionLabel>SKILL.md preview</SectionLabel>
        <pre className="m-0 min-h-60 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-3 font-mono text-[12px] whitespace-pre-wrap">
          {preview}
        </pre>
      </section>
    </div>
  );
}

function SkillDraft({ workspaceId }: { workspaceId: string }) {
  const agents = useStore((s) => s.agents);
  const sessions = useStore((s) => s.sessions);
  const set = useStore((s) => s.set);
  const selectSession = useStore((s) => s.selectSession);
  const upsert = useStore((s) => s.upsertSession);
  const ready = agents.filter((a) => a.health === 'ready');
  const [agentId, setAgentId] = useState<AgentId | ''>(
    ready.find((a) => a.id !== 'fake')?.id ?? ready[0]?.id ?? '',
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [from, setFrom] = useState('');
  const past = Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const nameError = name && !NAME.test(name) ? 'Use lower-case letters, digits and single dashes.' : null;
  return (
    <form
      className="flex max-w-2xl flex-col gap-3"
      aria-label="Draft a skill"
      onSubmit={(e) => {
        e.preventDefault();
        if (!agentId) return;
        void attempt(() =>
          host.call('skills.draft', {
            workspaceId,
            agentId,
            name,
            description,
            ...(from ? { fromSessionId: from } : {}),
          }),
        ).then((s) => {
          if (!s) return;
          upsert(s);
          selectSession(s.id);
          set({ tab: 'sessions' });
        });
      }}
    >
      <h2 className="m-0 text-[16px] font-semibold">Draft a skill with an agent</h2>
      <p className="m-0 text-ink-muted">
        The agent writes .ade/skills/&lt;name&gt;/SKILL.md in its own worktree. Review and land it like any
        other change.
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor="draft-name" className="font-semibold">
          Name
        </label>
        <input
          id="draft-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${inputClass} font-mono`}
        />
        {nameError ? <span className="text-[12px] text-danger">{nameError}</span> : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="draft-description" className="font-semibold">
          What should the skill do?
        </label>
        <textarea
          id="draft-description"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={`${inputClass} py-2`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="draft-from" className="font-semibold">
          Learn from a past session (optional)
        </label>
        <select id="draft-from" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass}>
          <option value="">None</option>
          {past.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="draft-agent" className="font-semibold">
          Agent
        </label>
        <select
          id="draft-agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value as AgentId)}
          className={inputClass}
        >
          {ready.length === 0 ? <option value="">No agent is ready</option> : null}
          {ready.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Button
          type="submit"
          variant="primary"
          disabled={!agentId || !name || !!nameError || !description.trim()}
        >
          Start drafting
        </Button>
      </div>
    </form>
  );
}
