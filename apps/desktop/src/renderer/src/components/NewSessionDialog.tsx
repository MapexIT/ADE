import { Badge, Button, cx, Tabs } from '@ade/ui';
import type { AgentId, PermissionProfile, WorkflowSummary } from '@ade/contracts';
import { useEffect, useMemo, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { PROFILE_LABELS, promptPreview, textPrompt } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';
import { AgentOverrideFields, useAgentOverrides } from './workflows/AgentOverrides.tsx';

const PROFILES: { id: PermissionProfile; hint: string }[] = [
  { id: 'ask', hint: 'Ask before edits and commands.' },
  { id: 'auto-edit', hint: 'File edits are approved automatically; commands still ask.' },
  { id: 'read-only', hint: 'Edits and commands are refused automatically.' },
  { id: 'autonomous', hint: 'Nothing asks. Only for sandboxed sessions.' },
];

/**
 * ST-02 composer for a new session; CO-02 shows exactly what is sent before sending. WF-02: the same dialog can
 * start a workflow instead of a single agent, with the text as the work item.
 */
export function NewSessionDialog() {
  const prefill = useStore((s) => s.newSession);
  const agents = useStore((s) => s.agents);
  const workspaceId = useStore((s) => s.workspaceId);
  const set = useStore((s) => s.set);
  const selectSession = useStore((s) => s.selectSession);
  const upsert = useStore((s) => s.upsertSession);
  const open = prefill !== null;

  const usable = agents.filter((a) => a.health !== 'not-installed');
  const [agentId, setAgentId] = useState<AgentId | ''>('');
  const [prompt, setPrompt] = useState('');
  const [title, setTitle] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [profile, setProfile] = useState<PermissionProfile>('ask');
  const [bringChanges, setBringChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'agent' | 'workflow'>('agent');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState('');
  const workflow = workflows.find((w) => w.id === workflowId) ?? null;
  const stand = useAgentOverrides(workflow?.agents ?? [], open && mode === 'workflow');

  useEffect(() => {
    if (!open) return;
    const item = prefill?.workItem;
    setPrompt(prefill?.prompt ?? (item ? `${item.title}\n\n${item.description}`.trim() : ''));
    setTitle(prefill?.title ?? item?.title ?? '');
    setBaseRef('HEAD');
    setProfile('ask');
    setBringChanges(false);
    setMode(prefill?.mode ?? 'agent');
  }, [open, prefill]);

  // Runnable workflows: repository files first, then templates; ones whose trigger matches the context first.
  useEffect(() => {
    if (!open || !workspaceId) return;
    void attempt(() => host.call('workflows.list', { workspaceId })).then((l) => {
      const want = prefill?.handOff?.checkOutput
        ? ['failed-check', 'terminal-command']
        : prefill?.workItem
          ? ['work-item']
          : ['manual'];
      const valid = (l ?? []).filter((w) => !w.problems.some((p) => p.level === 'error'));
      valid.sort((a, b) => Number(want.includes(b.trigger)) - Number(want.includes(a.trigger)));
      setWorkflows(valid);
      setWorkflowId((cur) => (valid.some((w) => w.id === cur) ? cur : (valid[0]?.id ?? '')));
    });
  }, [open, workspaceId, prefill]);

  // Pick a ready agent when the list arrives; never reset the typed fields (the list refreshes in the background).
  useEffect(() => {
    if (!open) return;
    const fallback =
      agents.find((a) => a.health === 'ready' && a.id !== 'fake') ?? agents.find((a) => a.health === 'ready');
    setAgentId((current) =>
      current && agents.some((a) => a.id === current && a.health === 'ready')
        ? current
        : (fallback?.id ?? ''),
    );
  }, [open, agents]);

  const agent = agents.find((a) => a.id === agentId);
  const startDisabledReason = !workspaceId
    ? 'Open a repository first.'
    : !agent
      ? 'Choose an agent.'
      : agent.health !== 'ready'
        ? (agent.reason ?? `${agent.label} needs you to sign in through its own terminal UI.`)
        : !prompt.trim()
          ? 'Write what the agent should do.'
          : profile === 'autonomous'
            ? 'Autonomous needs a sandboxed session, and no agent is sandboxed on this platform yet.'
            : null;

  const runDisabledReason = !workspaceId
    ? 'Open a repository first.'
    : !workflow
      ? 'Choose a workflow.'
      : stand.blocked
        ? 'No ready agent can stand in for an agent this workflow names.'
        : null;

  const startRun = async () => {
    if (runDisabledReason || !workflow || !workspaceId) return;
    setBusy(true);
    const item = prefill?.workItem;
    const workItem: Record<string, string> = {};
    if (title.trim()) workItem.title = title.trim();
    if (prompt.trim()) workItem.description = prompt.trim();
    if (item?.ref) workItem.ref = item.ref;
    if (item?.url) workItem.url = item.url;
    const run = await attempt(() =>
      host.call('workflows.start', {
        workspaceId,
        workflowId: workflow.id,
        workItem,
        agentOverrides: stand.overrides,
        ...(prefill?.handOff ? { handOff: prefill.handOff } : {}),
      }),
    );
    setBusy(false);
    if (run) set({ newSession: null, tab: 'workflows', focusRunId: run.id });
  };

  const content = useMemo(() => textPrompt(prompt, prefill?.attachments ?? []), [prompt, prefill]);

  const start = async () => {
    if (startDisabledReason || !agentId || !workspaceId) return;
    setBusy(true);
    const session = await attempt(() =>
      host.call('sessions.create', {
        workspaceId,
        agentId,
        prompt: content,
        permissionProfile: profile,
        bringChanges,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(baseRef.trim() && baseRef.trim() !== 'HEAD' ? { baseRef: baseRef.trim() } : {}),
        ...(prefill?.workItem ? { workItemRef: prefill.workItem.ref } : {}),
      }),
    );
    setBusy(false);
    if (session) {
      upsert(session);
      selectSession(session.id);
      set({ newSession: null, tab: 'sessions' });
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && set({ newSession: null })}
      title="New session"
      description={
        mode === 'agent'
          ? 'One conversation with one agent, in its own worktree and branch.'
          : 'A workflow chains agent sessions with checks and gates. Nothing lands until you approve a gate.'
      }
      wide
      footer={
        mode === 'workflow' ? (
          <>
            {runDisabledReason ? (
              <span className="mr-auto self-center text-ink-muted">{runDisabledReason}</span>
            ) : null}
            <Button onClick={() => set({ newSession: null })}>Cancel</Button>
            <Button variant="primary" disabled={!!runDisabledReason || busy} onClick={() => void startRun()}>
              {busy ? 'Starting…' : 'Start run'}
            </Button>
          </>
        ) : (
          <>
            {startDisabledReason ? (
              <span className="mr-auto self-center text-ink-muted">{startDisabledReason}</span>
            ) : null}
            <Button onClick={() => set({ newSession: null })}>Cancel</Button>
            <Button variant="primary" disabled={!!startDisabledReason || busy} onClick={() => void start()}>
              {busy ? 'Starting…' : 'Start session'}
            </Button>
          </>
        )
      }
    >
      <div className="mb-4">
        <Tabs
          label="Start with"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'agent', label: 'One agent' },
            { value: 'workflow', label: 'A workflow' },
          ]}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-4">
          <Field
            label={
              mode === 'agent'
                ? 'What should the agent do?'
                : 'What is the work? (fills {{workItem.description}})'
            }
            htmlFor="ns-prompt"
          >
            <textarea
              id="ns-prompt"
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className={cx(inputClass, 'py-2.5')}
              autoFocus
            />
          </Field>
          <Field
            label={mode === 'agent' ? 'Title (optional)' : 'Title (fills {{workItem.title}})'}
            htmlFor="ns-title"
            hint={mode === 'agent' ? 'Also names the branch.' : undefined}
          >
            <input
              id="ns-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={inputClass}
            />
          </Field>
          {mode === 'workflow' && prefill?.handOff?.checkOutput ? (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-line p-3">
              <span className="text-[12px] font-semibold text-ink-muted">
                Passed to the first step as {'{{checkOutput}}'}
              </span>
              <pre className="m-0 max-h-40 overflow-auto font-mono text-[12px] whitespace-pre-wrap">
                {prefill.handOff.checkOutput}
              </pre>
            </div>
          ) : null}
          {mode === 'agent' && (prefill?.workItem || prefill?.attachments?.length) ? (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-line p-3">
              <span className="text-[12px] font-semibold text-ink-muted">What is sent</span>
              <p className="m-0 whitespace-pre-wrap">{promptPreview(content)}</p>
            </div>
          ) : null}
        </div>
        {mode === 'workflow' ? (
          <div className="flex flex-col gap-4">
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1.5 text-[12px] font-semibold text-ink-muted">Workflow</legend>
              {workflows.length === 0 ? <span className="text-ink-muted">No runnable workflows.</span> : null}
              {workflows.map((w) => (
                <label
                  key={w.id}
                  className={cx(
                    'flex min-h-11 items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5',
                    workflowId === w.id ? 'border-accent bg-accent-tint' : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="ns-workflow"
                    value={w.id}
                    checked={workflowId === w.id}
                    onChange={() => setWorkflowId(w.id)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="flex flex-1 flex-col">
                    <span>{w.name}</span>
                    <span className="text-[12px] text-ink-muted">
                      {w.source === 'template' ? 'Template' : 'This repository'} · {w.nodes.length} steps
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            <AgentOverrideFields state={stand} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
              <legend className="mb-1.5 text-[12px] font-semibold text-ink-muted">Agent</legend>
              {agents.length === 0 ? <span className="text-ink-muted">Checking agents…</span> : null}
              {agents.map((a) => (
                <label
                  key={a.id}
                  className={cx(
                    'flex min-h-11 items-center gap-2 rounded-[var(--radius)] border px-3',
                    agentId === a.id ? 'border-accent bg-accent-tint' : 'border-line',
                    a.health === 'not-installed' && 'opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="ns-agent"
                    value={a.id}
                    checked={agentId === a.id}
                    disabled={a.health === 'not-installed'}
                    onChange={() => setAgentId(a.id)}
                    className="accent-[var(--accent)]"
                  />
                  <span className="flex-1">{a.label}</span>
                  <Badge
                    tone={
                      a.health === 'ready' ? 'ok' : a.health === 'needs-sign-in' ? 'attention' : 'neutral'
                    }
                  >
                    {a.health === 'ready'
                      ? 'Ready'
                      : a.health === 'needs-sign-in'
                        ? 'Needs sign-in'
                        : 'Not installed'}
                  </Badge>
                </label>
              ))}
              {usable.length === 0 && agents.length ? (
                <span className="text-[12px] text-ink-muted">Install an agent from first-run setup.</span>
              ) : null}
            </fieldset>
            <Field label="Base branch or commit" htmlFor="ns-base">
              <input
                id="ns-base"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                className={cx(inputClass, 'font-mono')}
              />
            </Field>
            <Field
              label="Permission profile"
              htmlFor="ns-profile"
              hint={PROFILES.find((p) => p.id === profile)?.hint}
            >
              <select
                id="ns-profile"
                value={profile}
                onChange={(e) => setProfile(e.target.value as PermissionProfile)}
                className={inputClass}
              >
                {PROFILES.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.id === 'autonomous'}>
                    {PROFILE_LABELS[p.id]}
                    {p.id === 'autonomous' ? ' (needs a sandbox)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={bringChanges}
                onChange={(e) => setBringChanges(e.target.checked)}
                className="size-5 accent-[var(--accent)]"
              />
              Bring my uncommitted changes
            </label>
          </div>
        )}
      </div>
    </Modal>
  );
}
