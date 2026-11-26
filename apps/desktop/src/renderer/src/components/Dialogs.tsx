import { Bot, Check, CircleAlert, CircleHelp, CirclePause, Download, FolderGit2, FolderOpen, Gauge, GitPullRequest, Hand, Info, MessagesSquare, Navigation, Repeat, RefreshCw, Save, ShieldQuestion, SquareTerminal, Trash2, Unplug, type LucideIcon } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Badge, Button, cx, Kbd, Logo, SectionLabel } from '@ade/ui';
import { LoopSettings, ReceiptSettings, type ContainmentStatus, type ProtocolMessage } from '@ade/contracts';
import { Command } from 'cmdk';
import { useEffect, useMemo, useState } from 'react';
import { buildCommands, pickAndOpenWorkspace } from '../lib/commands.ts';
import { host, main, pty } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { useTerminals } from '../lib/terminals.ts';
import { Field, inputClass, Modal } from './Modal.tsx';
import { TelegramSettings } from './TelegramSettings.tsx';
import { SANDBOX_SCOPE } from './NewSessionDialog.tsx';
import { WorkspaceRules } from './WorkspaceRules.tsx';
import { PersonalMcpSettings, WorkItemSyncSettings } from './ConnectorSettings.tsx';
import { ExportAuditButton, InstructionFiles } from './HistoryTools.tsx';

/** CN-07: one line describing the host sandbox on this machine. */
export function sandboxSummary(s: ContainmentStatus | null): string {
  if (!s) return 'Checking…';
  if (!s.available) return s.reason ?? 'Not available on this machine.';
  return `${s.kind === 'wsl' ? `WSL2 (${s.distro}) with bubblewrap` : 'bubblewrap'}. ${SANDBOX_SCOPE}`;
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  Workspace: FolderGit2,
  Session: MessagesSquare,
  Navigate: Navigation,
  Terminal: SquareTerminal,
  App: Bot,
};

function PaletteIcon({ group }: { group: string }) {
  const Icon = GROUP_ICONS[group] ?? Bot;
  return <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const set = useStore((s) => s.set);
  const commands = useMemo(() => (open ? buildCommands() : []), [open]);
  const groups = [...new Set(commands.map((c) => c.group))];
  return (
    <Modal open={open} onOpenChange={(o) => set({ paletteOpen: o })} title="Search and commands">
      <Command label="Command palette" className="flex flex-col gap-2">
        <Command.Input autoFocus placeholder="Type a command" className={inputClass} />
        <Command.List className="max-h-96 overflow-auto">
          <Command.Empty className="p-3 text-ink-muted">No matching command.</Command.Empty>
          {groups.map((g) => (
            <Command.Group key={g} heading={g} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-muted [&_[cmdk-group-heading]]:uppercase">
              {commands
                .filter((c) => c.group === g)
                .map((c) => (
                  <Command.Item
                    key={c.id}
                    value={`${c.group} ${c.title}`}
                    onSelect={() => {
                      set({ paletteOpen: false });
                      void c.run();
                    }}
                    className="flex min-h-9 cursor-pointer items-center gap-3 rounded-[var(--radius-small)] px-3 data-[selected=true]:bg-accent-tint"
                  >
                    <PaletteIcon group={c.group} />
                    <span className="flex-1">{c.title}</span>
                    {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : null}
                  </Command.Item>
                ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </Modal>
  );
}

/** AP-04: one keyboard-driven list of everything waiting on the user. */
const KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  question: { label: 'Question', icon: CircleHelp },
  permission: { label: 'Approval', icon: ShieldQuestion },
  terminal: { label: 'Terminal', icon: SquareTerminal },
  'setup-failed': { label: 'Setup failed', icon: CircleAlert },
  interrupted: { label: 'Interrupted', icon: Unplug },
  limit: { label: 'Limit reached', icon: Gauge },
  gate: { label: 'Workflow gate', icon: Hand },
  paused: { label: 'Workflow paused', icon: CirclePause },
  loop: { label: 'May be looping', icon: Repeat },
  review: { label: 'Review requested', icon: GitPullRequest },
};

export function InboxDialog() {
  const open = useStore((s) => s.inboxOpen);
  const inbox = useStore((s) => s.inbox);
  const set = useStore((s) => s.set);
  const selectSession = useStore((s) => s.selectSession);
  const views = useStore((s) => s.views);
  const waitingTerminals = useTerminals(useShallow((t) => Object.values(t.terminals).filter((x) => x.agentState === 'waiting')));
  const [index, setIndex] = useState(0);
  const items = [
    ...inbox.map((i) => ({ key: i.id, sessionId: i.sessionId, title: i.title, sub: i.sessionTitle, kind: i.kind, runId: i.runId ?? null, url: i.url ?? null, requestId: i.kind === 'permission' || i.kind === 'question' ? i.id : null })),
    ...waitingTerminals.map((t) => ({ key: t.id, sessionId: t.sessionId, title: `${t.title} is waiting for you`, sub: 'Agent terminal', kind: 'terminal' as const, runId: null, url: null, requestId: null })),
  ];
  const go = (sessionId: string | null, runId: string | null = null, url: string | null = null) => {
    // AP-07: a pull request waiting on your review opens on GitHub.
    if (url) return void attempt(() => main('main.openExternal', { url }));
    if (runId) return set({ inboxOpen: false, tab: 'workflows', focusRunId: runId });
    if (sessionId) selectSession(sessionId);
    set({ inboxOpen: false, tab: 'sessions' });
  };
  const answer = (sessionId: string, requestId: string, kind: 'allow' | 'reject') => {
    const view = views[sessionId];
    const item = view?.items.find((i) => i.kind === 'permission' && i.requestId === requestId);
    const option = item?.kind === 'permission' ? item.options.find((o) => o.kind.startsWith(kind === 'allow' ? 'allow' : 'reject')) : undefined;
    if (!option) return go(sessionId);
    void attempt(() => host.call('sessions.answerPermission', { sessionId, requestId, optionId: option.optionId }));
  };
  return (
    <Modal open={open} onOpenChange={(o) => set({ inboxOpen: o })} title="Needs you" description="Arrow keys move, Enter opens (pull requests open on GitHub), A allows once, R rejects.">
      <ul
        role="listbox"
        aria-label="Needs you"
        tabIndex={0}
        autoFocus
        className="m-0 flex list-none flex-col gap-2 p-0 outline-none"
        onKeyDown={(e) => {
          const cur = items[index];
          if (e.key === 'ArrowDown') setIndex((i) => Math.min(items.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setIndex((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter' && cur) go(cur.sessionId, cur.runId, cur.url);
          else if ((e.key === 'a' || e.key === 'r') && cur?.requestId && cur.sessionId) answer(cur.sessionId, cur.requestId, e.key === 'a' ? 'allow' : 'reject');
          else return;
          e.preventDefault();
        }}
      >
        {items.length === 0 ? <li className="p-2 text-ink-muted">Nothing is waiting on you.</li> : null}
        {items.map((it, i) => {
          const kind = KINDS[it.kind] ?? { label: it.kind, icon: Info };
          const Icon = kind.icon;
          return (
            <li key={it.key} role="option" aria-selected={i === index} data-kind={it.kind}>
              <button
                type="button"
                onClick={() => go(it.sessionId, it.runId, it.url)}
                className={cx('flex w-full items-start gap-3 rounded-[var(--radius)] border px-3 py-2 text-left', i === index ? 'border-attention-line bg-attention-tint' : 'border-line')}
              >
                <Icon className={cx('mt-0.5 size-4 shrink-0', it.kind === 'review' ? 'text-accent-soft' : 'text-ink-muted')} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-semibold">{it.title}</span>
                  <span className="truncate text-ink-muted">{it.sub}</span>
                </span>
                <Badge tone={it.kind === 'review' ? 'accent' : 'neutral'} className="shrink-0">
                  {kind.label}
                </Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

/** HI-05: agents, workspace setup, notifications, retention, external editor, connectors. No telemetry setting. */
export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const set = useStore((s) => s.set);
  const workspaceId = useStore((s) => s.workspaceId);
  const toast = useStore((s) => s.toast);
  const [cap, setCap] = useState(3);
  const [limits, setLimits] = useState({ maxTurns: 50, maxTurnMinutes: 60 });
  const [setupFile, setSetupFile] = useState<{ exists: boolean; content: string } | null>(null);
  const [creds, setCreds] = useState<{ available: boolean; backend: string; stored: string[] } | null>(null);
  const [token, setToken] = useState({ shortcut: '', github: '' });
  const [share, setShare] = useState(false);
  const [autoTriggers, setAutoTriggers] = useState(false);
  const [containment, setContainment] = useState<ContainmentStatus | null>(null);
  const [sandboxByDefault, setSandboxByDefault] = useState(true);
  const [runInPlace, setRunInPlace] = useState(false);
  const [keepRunning, setKeepRunning] = useState(true);
  const [loops, setLoops] = useState<LoopSettings>({ enabled: true, stopTurn: false });
  const [receipts, setReceipts] = useState<ReceiptSettings>({ enabled: true, notify: true });

  useEffect(() => {
    if (!open) return;
    void attempt(() => host.call('containment.status', { refresh: true })).then((s) => setContainment(s ?? null));
    void host.call('settings.get', { key: 'sandbox.byDefault' }).then((v) => setSandboxByDefault(v.value !== false));
    void host.call('settings.get', { key: 'sessions.runInPlace' }).then((v) => setRunInPlace(v.value === true));
    void host.call('settings.get', { key: 'app.keepRunningInBackground' }).then((v) => setKeepRunning(v.value !== false));
    void host.call('settings.get', { key: 'concurrencyCap' }).then((v) => setCap(typeof v.value === 'number' ? v.value : 3));
    void host.call('settings.get', { key: 'limits' }).then((v) => v.value && setLimits(v.value as typeof limits));
    void host.call('settings.get', { key: 'loops' }).then((v) => {
      const parsed = LoopSettings.safeParse(v.value ?? {});
      setLoops(parsed.success ? parsed.data : { enabled: true, stopTurn: false });
    });
    void host.call('settings.get', { key: 'receipts' }).then((v) => {
      const parsed = ReceiptSettings.safeParse(v.value ?? {});
      setReceipts(parsed.success ? parsed.data : { enabled: true, notify: true });
    });
    void main('main.credentials.status', {}).then(setCreds);
    void host.call('settings.get', { key: 'connectors.shareWithAgents' }).then((v) => setShare(v.value === true));
    void host.call('settings.get', { key: 'workflows.autoTriggers' }).then((v) => setAutoTriggers(v.value === true));
    if (workspaceId) void host.call('workspace.setupFile', { workspaceId }).then(setSetupFile);
  }, [open, workspaceId]);

  const save = async () => {
    await attempt(() => host.call('settings.set', { key: 'concurrencyCap', value: Math.max(1, Math.min(10, cap)) }));
    await attempt(() => host.call('settings.set', { key: 'limits', value: limits }));
    await attempt(() => host.call('settings.set', { key: 'loops', value: loops }));
    await attempt(() => host.call('settings.set', { key: 'receipts', value: receipts }));
    await attempt(() => host.call('settings.set', { key: 'connectors.shareWithAgents', value: share }));
    await attempt(() => host.call('settings.set', { key: 'workflows.autoTriggers', value: autoTriggers }));
    await attempt(() => host.call('settings.set', { key: 'sandbox.byDefault', value: sandboxByDefault }));
    await attempt(() => host.call('settings.set', { key: 'sessions.runInPlace', value: runInPlace }));
    await attempt(() => host.call('settings.set', { key: 'app.keepRunningInBackground', value: keepRunning }));
    toast('Settings saved.');
    set({ settingsOpen: false });
  };

  return (
    <Modal open={open} onOpenChange={(o) => set({ settingsOpen: o })} title="Settings" wide footer={<><Button onClick={() => set({ settingsOpen: false })}>Close</Button><Button icon={<Save className="size-4" aria-hidden="true" />} variant="primary" onClick={() => void save()}>Save</Button></>}>
      <div className="grid gap-6 md:grid-cols-2">
        <section className="flex flex-col gap-3">
          <SectionLabel>Sessions</SectionLabel>
          <Field label="Sessions running at once" htmlFor="set-cap" hint="Extra sessions wait as Queued.">
            <input id="set-cap" type="number" min={1} max={10} value={cap} onChange={(e) => setCap(Number(e.target.value))} className={inputClass} />
          </Field>
          <Field label="Maximum turns per session" htmlFor="set-turns">
            <input id="set-turns" type="number" min={1} value={limits.maxTurns} onChange={(e) => setLimits({ ...limits, maxTurns: Number(e.target.value) })} className={inputClass} />
          </Field>
          <Field label="Maximum minutes per turn" htmlFor="set-mins">
            <input id="set-mins" type="number" min={1} value={limits.maxTurnMinutes} onChange={(e) => setLimits({ ...limits, maxTurnMinutes: Number(e.target.value) })} className={inputClass} />
          </Field>
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={loops.enabled} onChange={(e) => setLoops({ ...loops, enabled: e.target.checked })} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Warn when an agent goes round in circles
              <span className="block text-[12px] text-ink-muted">The same step repeated, the same command failing, or a file switched back and forth, within one turn.</span>
            </span>
          </label>
          <label className={cx('flex min-h-11 items-start gap-2', !loops.enabled && 'opacity-60')}>
            <input type="checkbox" checked={loops.stopTurn} disabled={!loops.enabled} onChange={(e) => setLoops({ ...loops, stopTurn: e.target.checked })} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Stop the turn if it carries on
              <span className="block text-[12px] text-ink-muted">ADE cancels the turn at twice the warning level. Nothing is undone and nothing lands.</span>
            </span>
          </label>
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={receipts.enabled} onChange={(e) => setReceipts({ ...receipts, enabled: e.target.checked })} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Check what agents say against what they did
              <span className="block text-[12px] text-ink-muted">After each turn ADE compares the agent&apos;s closing message with the commands it ran and the files Git says changed.</span>
            </span>
          </label>
          <label className={cx('flex min-h-11 items-start gap-2', !receipts.enabled && 'opacity-60')}>
            <input type="checkbox" checked={receipts.notify} disabled={!receipts.enabled} onChange={(e) => setReceipts({ ...receipts, notify: e.target.checked })} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>Notify me when a finished turn has something to check</span>
          </label>
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={keepRunning} onChange={(e) => setKeepRunning(e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Keep sessions running when the window is closed
              <span className="block text-[12px] text-ink-muted">ADE stays in the system tray while a session is working and notifies you when it needs you.</span>
            </span>
          </label>
          <p className="m-0 text-ink-muted">Discarded sessions keep their final patch for 30 days. Notifications appear when a session needs you, finishes or fails, while ADE is in the background. The external editor comes from the ADE_EDITOR environment variable, or your system default.</p>
        </section>
        <section className="flex flex-col gap-3">
          <SectionLabel>Workspace setup</SectionLabel>
          <p className="m-0 text-ink-muted">Setup commands, files to copy and MCP servers every session receives live in .ade/workspace.yaml, versioned with your code. Write secrets as $VARIABLE; ADE reads them from its environment.</p>
          <pre className="m-0 max-h-40 overflow-auto rounded-[var(--radius)] border border-line bg-surface-sunken p-2.5 font-mono text-[12px]">{setupFile?.exists ? setupFile.content : 'setup:\n  - ["pnpm", "install"]\ncopy:\n  - .env.local\nmcpServers:\n  - name: docs\n    command: ["npx", "-y", "my-docs-mcp"]\n    env:\n      API_KEY: $DOCS_API_KEY'}</pre>
          {!setupFile?.exists ? <span className="text-[12px] text-ink-muted">No file yet; the example above shows the format.</span> : null}
          <SectionLabel className="mt-2">Connectors</SectionLabel>
          {creds && !creds.available ? <p className="m-0 text-danger">No secure credential store is available ({creds.backend}). Install and unlock a keyring to connect.</p> : null}
          {(['shortcut', 'github'] as const).map((k) => (
            <div key={k} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="font-semibold">{k === 'shortcut' ? 'Shortcut' : 'GitHub'}</span>
                <Badge tone={creds?.stored.includes(k) ? 'ok' : 'neutral'}>{creds?.stored.includes(k) ? 'Connected' : 'Not connected'}</Badge>
              </div>
              <div className="flex gap-2">
                <label htmlFor={`tok-${k}`} className="sr-only">
                  {k} token
                </label>
                <input id={`tok-${k}`} type="password" autoComplete="off" value={token[k]} onChange={(e) => setToken({ ...token, [k]: e.target.value })} placeholder="Read-only token" className={`${inputClass} flex-1`} disabled={!creds?.available} />
                <Button icon={<Save className="size-4" aria-hidden="true" />}
                  disabled={!token[k] || !creds?.available}
                  onClick={() =>
                    void attempt(() => main('main.credentials.set', { key: k, secret: token[k] })).then(async () => {
                      setToken({ ...token, [k]: '' });
                      setCreds(await main('main.credentials.status', {}));
                    })
                  }
                >
                  Save
                </Button>
                {creds?.stored.includes(k) ? (
                  <Button icon={<Trash2 className="size-4" aria-hidden="true" />} variant="ghost" onClick={() => void attempt(() => main('main.credentials.delete', { key: k })).then(async () => setCreds(await main('main.credentials.status', {})))}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          <p className="m-0 text-[12px] text-ink-muted">Tokens are encrypted by your operating system's credential store and never written to the database, logs or prompts.</p>
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Give new sessions the Shortcut connector as an MCP server
              <span className="block text-[12px] text-ink-muted">The agent then holds your Shortcut token. Off by default; only agents that support HTTP MCP receive it.</span>
            </span>
          </label>
        </section>
        <TelegramSettings available={!!creds?.available} stored={creds?.stored ?? []} onStoredChange={async () => setCreds(await main('main.credentials.status', {}))} />
        <section className="flex flex-col gap-2" aria-label="Workflows">
          <SectionLabel>Workflows</SectionLabel>
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={autoTriggers} onChange={(e) => setAutoTriggers(e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Let workflows start on events
              <span className="block text-[12px] text-ink-muted">
                Workflows in .ade/workflows/ with the trigger ready-session or failed-check start by themselves when a session finishes a turn or a run fails. Templates never do. Nothing lands without your approval at a gate.
              </span>
            </span>
          </label>
        </section>
        <section className="flex flex-col gap-2" aria-label="Containment">
          <SectionLabel>Containment</SectionLabel>
          <div className="flex items-center gap-2">
            <span className="font-semibold">Host sandbox</span>
            <Badge tone={containment?.available ? 'ok' : 'attention'}>{containment?.available ? 'Available' : 'Not available'}</Badge>
          </div>
          <p className="m-0 text-[12px] text-ink-muted">{sandboxSummary(containment)}</p>
          {containment?.kind === 'bubblewrap' ? (
            <label className="flex min-h-11 items-start gap-2">
              <input type="checkbox" checked={sandboxByDefault} onChange={(e) => setSandboxByDefault(e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
              <span>
                Run new sessions in the sandbox
                <span className="block text-[12px] text-ink-muted">You can still turn it off for one session when you start it.</span>
              </span>
            </label>
          ) : null}
          {containment?.kind === 'wsl' ? (
            <p className="m-0 text-[12px] text-ink-muted">Choose "Run inside WSL" when you start a session. Each agent's ACP adapter must be installed inside the distribution.</p>
          ) : null}
          <label className="flex min-h-11 items-start gap-2">
            <input type="checkbox" checked={runInPlace} onChange={(e) => setRunInPlace(e.target.checked)} className="mt-1 size-5 accent-[var(--accent)]" />
            <span>
              Let one session at a time work in my checkout
              <span className="block text-[12px] text-ink-muted">
                The agent then edits your real files instead of a worktree. ADE takes a snapshot first; Discard puts every file back. Off by default.
              </span>
            </span>
          </label>
        </section>
        {workspaceId ? <WorkspaceRules workspaceId={workspaceId} /> : null}
        {workspaceId ? <WorkItemSyncSettings workspaceId={workspaceId} /> : null}
        {workspaceId ? <InstructionFiles workspaceId={workspaceId} /> : null}
        {workspaceId ? (
          <section aria-label="Audit log" className="flex flex-col gap-2">
            <SectionLabel>Audit log</SectionLabel>
            <ExportAuditButton workspaceId={workspaceId} />
          </section>
        ) : null}
        <PersonalMcpSettings />
      </div>
    </Modal>
  );
}

/** PK-02: one screen with Git, shells, agents and their sign-in state, connectors and sandbox state. */
export function FirstRunDialog() {
  const open = useStore((s) => s.firstRunOpen);
  const set = useStore((s) => s.set);
  const agents = useStore((s) => s.agents);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const workspaces = useStore((s) => s.workspaces);
  const shells = useTerminals((t) => t.shells);
  const [info, setInfo] = useState<{ platform: string } | null>(null);
  const [creds, setCreds] = useState<{ available: boolean; backend: string } | null>(null);
  const [containment, setContainment] = useState<ContainmentStatus | null>(null);
  useEffect(() => {
    if (!open) return;
    void attempt(() => host.call('containment.status', {})).then((s) => setContainment(s ?? null));
    void main('main.info', {}).then(setInfo);
    void main('main.credentials.status', {}).then(setCreds);
    void pty.call('pty.shells', {}).then((s) => useTerminals.setState({ shells: s }));
  }, [open]);
  const finish = () => {
    void host.call('settings.set', { key: 'firstRunDone', value: true });
    set({ firstRunOpen: false });
  };
  const row = (label: string, ok: boolean, detail: string) => (
    <div className="flex items-center gap-3 rounded-[var(--radius)] border border-line px-3 py-2">
      <span className="w-40 font-semibold">{label}</span>
      <span className="flex-1 text-ink-muted">{detail}</span>
      <Badge tone={ok ? 'ok' : 'attention'}>{ok ? 'Ready' : 'Needs attention'}</Badge>
    </div>
  );
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && finish()}
      title="Welcome to ADE"
      icon={<Logo size={44} />}
      description="ADE supervises the coding agents you already use. Nothing leaves this machine except what agents and connectors send themselves."
      wide
      footer={
        <>
          <Button icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={() => void refreshAgents(true)}>Check again</Button>
          {workspaces.length === 0 ? (
            <Button icon={<FolderOpen className="size-4" aria-hidden="true" />} variant="primary" onClick={() => void pickAndOpenWorkspace().then(finish)}>
              Open a repository
            </Button>
          ) : null}
          <Button icon={<Check className="size-4" aria-hidden="true" />} variant={workspaces.length ? 'primary' : 'secondary'} onClick={finish}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <SectionLabel>This machine</SectionLabel>
        {row('Shells', shells.length > 0, shells.map((s) => s.label).join(', ') || 'No supported shell found')}
        {row('Host sandbox', !!containment?.available, sandboxSummary(containment))}
        {row('Credential store', !!creds?.available, creds ? `${creds.backend}${creds.available ? '' : ' · install a keyring to connect Shortcut or GitHub'}` : 'Checking…')}
        <SectionLabel className="mt-3">Agents</SectionLabel>
        {agents
          .filter((a) => a.id !== 'fake')
          .map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-line px-3 py-2">
              <span className="w-40 font-semibold">{a.label}</span>
              <span className="flex-1 text-ink-muted">{a.health === 'not-installed' ? a.reason : `${a.version ?? 'version unknown'}${a.path ? ` · ${a.path}` : ' · runs through the bundled adapter'}`}</span>
              {containment?.available && containment.agents.includes(a.id) ? (
                <Badge tone="ok" title={SANDBOX_SCOPE}>
                  {containment.kind === 'wsl' ? 'Can run sandboxed in WSL' : 'Runs sandboxed'}
                </Badge>
              ) : (
                <Badge tone="attention" title="Shown honestly: nothing is labelled sandboxed unless the operating system enforces it">
                  Not sandboxed{info?.platform === 'win32' ? ' on Windows' : ''}
                </Badge>
              )}
              <Badge tone={a.health === 'ready' ? 'ok' : 'attention'}>{a.health === 'ready' ? 'Ready' : a.health === 'needs-sign-in' ? 'Needs sign-in' : 'Not installed'}</Badge>
              {a.health === 'not-installed' ? (
                <Button icon={<Download className="size-4" aria-hidden="true" />} size="dense" onClick={() => void main('main.openExternal', { url: a.id === 'opencode' ? 'https://opencode.ai/docs/' : a.id === 'codex' ? 'https://developers.openai.com/codex/cli' : 'https://code.claude.com/docs/en/setup' })}>
                  Get {a.label}
                </Button>
              ) : null}
            </div>
          ))}
        <p className="m-0 mt-2 text-[12px] text-ink-muted">Sign-in always happens in each agent's own flow: start its terminal UI from a session and sign in there. ADE never reads or stores agent credentials.</p>
      </div>
    </Modal>
  );
}

/** WA-05: raw ACP messages for a session, with search. Credentials are redacted in the host. */
export function ProtocolDialog() {
  const sessionId = useStore((s) => s.protocolSessionId);
  const set = useStore((s) => s.set);
  const [messages, setMessages] = useState<ProtocolMessage[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    void attempt(() => host.call('sessions.protocol', { sessionId })).then((m) => setMessages(m ?? []));
  }, [sessionId]);
  const shown = messages.filter((m) => !q || m.body.toLowerCase().includes(q.toLowerCase())).slice(-500);
  return (
    <Modal open={!!sessionId} onOpenChange={(o) => !o && set({ protocolSessionId: null })} title="Protocol messages" description="Messages exchanged with the agent while it ran in this app session." wide>
      <div className="flex flex-col gap-2">
        <label htmlFor="proto-search" className="sr-only">
          Search messages
        </label>
        <input id="proto-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className={inputClass} />
        {shown.length === 0 ? <p className="m-0 text-ink-muted">No messages. The log covers the agent process started in this run of ADE.</p> : null}
        <div className="flex max-h-[60vh] flex-col gap-1 overflow-auto font-mono text-[11.5px]">
          {shown.map((m, i) => (
            <div key={i} className="rounded border border-line p-1.5">
              <span className={m.direction === 'out' ? 'text-accent-soft' : 'text-attention'}>{m.direction === 'out' ? 'ADE → agent' : 'agent → ADE'}</span> <span className="text-ink-muted">{m.ts.slice(11, 23)}</span>
              <div className="break-all whitespace-pre-wrap">{m.body.length > 4000 ? `${m.body.slice(0, 4000)}…` : m.body}</div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === 'danger' ? 'alert' : 'status'} className={cx('ade-toast pointer-events-auto flex max-w-md items-center gap-2.5 rounded-[var(--radius)] border p-3 shadow-[var(--shadow-pop)] backdrop-blur-xl', t.tone === 'danger' ? 'border-danger-line bg-danger-tint text-danger' : 'border-line bg-[var(--surface-glass)] text-ink')}>
          {t.tone === 'danger' ? <CircleAlert className="size-4 shrink-0" aria-hidden="true" /> : <Info className="size-4 shrink-0 text-accent-soft" aria-hidden="true" />}
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ReconnectBanner() {
  const connection = useStore((s) => s.connection);
  const down = [!connection.host && 'host', !connection.pty && 'terminal'].filter(Boolean);
  if (!down.length) return null;
  return (
    <div role="status" className="flex items-center gap-2 border-b border-attention-line bg-attention-tint px-4 py-1.5 text-attention">
      <span className="inline-block size-2 animate-pulse rounded-full bg-attention" aria-hidden="true" />
      Reconnecting to the {down.join(' and ')} process… Running sessions that were mid-turn will show as Interrupted.
    </div>
  );
}
