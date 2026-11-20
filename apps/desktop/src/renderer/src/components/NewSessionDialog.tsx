import { Badge, Button, cx } from '@ade/ui';
import type { AgentId, PermissionProfile } from '@ade/contracts';
import { useEffect, useMemo, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { PROFILE_LABELS, promptPreview, textPrompt } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

const PROFILES: { id: PermissionProfile; hint: string }[] = [
  { id: 'ask', hint: 'Ask before edits and commands.' },
  { id: 'auto-edit', hint: 'File edits are approved automatically; commands still ask.' },
  { id: 'read-only', hint: 'Edits and commands are refused automatically.' },
  { id: 'autonomous', hint: 'Nothing asks. Only for sandboxed sessions.' },
];

/** ST-02 composer for a new session; CO-02 shows exactly what is sent before sending. */
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

  useEffect(() => {
    if (!open) return;
    const item = prefill?.workItem;
    setPrompt(prefill?.prompt ?? (item ? `${item.title}\n\n${item.description}`.trim() : ''));
    setTitle(prefill?.title ?? item?.title ?? '');
    setBaseRef('HEAD');
    setProfile('ask');
    setBringChanges(false);
  }, [open, prefill]);

  // Pick a ready agent when the list arrives; never reset the typed fields (the list refreshes in the background).
  useEffect(() => {
    if (!open) return;
    const fallback = agents.find((a) => a.health === 'ready' && a.id !== 'fake') ?? agents.find((a) => a.health === 'ready');
    setAgentId((current) => (current && agents.some((a) => a.id === current && a.health === 'ready') ? current : (fallback?.id ?? '')));
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
      description="One conversation with one agent, in its own worktree and branch."
      wide
      footer={
        <>
          {startDisabledReason ? <span className="mr-auto self-center text-ink-muted">{startDisabledReason}</span> : null}
          <Button onClick={() => set({ newSession: null })}>Cancel</Button>
          <Button variant="primary" disabled={!!startDisabledReason || busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start session'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-4">
          <Field label="What should the agent do?" htmlFor="ns-prompt">
            <textarea id="ns-prompt" rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} className={cx(inputClass, 'py-2.5')} autoFocus />
          </Field>
          <Field label="Title (optional)" htmlFor="ns-title" hint="Also names the branch.">
            <input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </Field>
          {prefill?.workItem || prefill?.attachments?.length ? (
            <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-dashed border-line p-3">
              <span className="text-[12px] font-semibold text-ink-muted">What is sent</span>
              <p className="m-0 whitespace-pre-wrap">{promptPreview(content)}</p>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 text-[12px] font-semibold text-ink-muted">Agent</legend>
            {agents.length === 0 ? <span className="text-ink-muted">Checking agents…</span> : null}
            {agents.map((a) => (
              <label key={a.id} className={cx('flex min-h-11 items-center gap-2 rounded-[var(--radius)] border px-3', agentId === a.id ? 'border-accent bg-accent-tint' : 'border-line', a.health === 'not-installed' && 'opacity-60')}>
                <input type="radio" name="ns-agent" value={a.id} checked={agentId === a.id} disabled={a.health === 'not-installed'} onChange={() => setAgentId(a.id)} className="accent-[var(--accent)]" />
                <span className="flex-1">{a.label}</span>
                <Badge tone={a.health === 'ready' ? 'ok' : a.health === 'needs-sign-in' ? 'attention' : 'neutral'}>
                  {a.health === 'ready' ? 'Ready' : a.health === 'needs-sign-in' ? 'Needs sign-in' : 'Not installed'}
                </Badge>
              </label>
            ))}
            {usable.length === 0 && agents.length ? <span className="text-[12px] text-ink-muted">Install an agent from first-run setup.</span> : null}
          </fieldset>
          <Field label="Base branch or commit" htmlFor="ns-base">
            <input id="ns-base" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} className={cx(inputClass, 'font-mono')} />
          </Field>
          <Field label="Permission profile" htmlFor="ns-profile" hint={PROFILES.find((p) => p.id === profile)?.hint}>
            <select id="ns-profile" value={profile} onChange={(e) => setProfile(e.target.value as PermissionProfile)} className={inputClass}>
              {PROFILES.map((p) => (
                <option key={p.id} value={p.id} disabled={p.id === 'autonomous'}>
                  {PROFILE_LABELS[p.id]}
                  {p.id === 'autonomous' ? ' (needs a sandbox)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={bringChanges} onChange={(e) => setBringChanges(e.target.checked)} className="size-5 accent-[var(--accent)]" />
            Bring my uncommitted changes
          </label>
        </div>
      </div>
    </Modal>
  );
}
