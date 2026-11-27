import * as Popover from '@radix-ui/react-popover';
import { CircleAlert, CircleCheck, CircleDashed, Download, RefreshCw, SquareTerminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AgentId, AgentStatus } from '@ade/contracts';
import { Button, cx, Waiting } from '@ade/ui';
import { followInstalls, installAgent, useInstalls } from '../lib/agent-install.ts';
import { useStore } from '../lib/store.ts';

const COMMANDS: Partial<Record<AgentId, string>> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode' };
const MANAGER_LABEL = { winget: 'winget', pacman: 'pacman', zypper: 'zypper', npm: 'npm' } as const;

const healthText = (a: AgentStatus) => (a.health === 'ready' ? 'Ready' : a.health === 'needs-sign-in' ? 'Needs sign-in' : 'Not installed');

/** ST-01, ST-07: the coding CLIs button in the top bar; it opens their status, with Install for the missing ones. */
export function CliStatus() {
  const agents = useStore((s) => s.agents);
  const refreshAgents = useStore((s) => s.refreshAgents);
  const loadPlans = useInstalls((s) => s.loadPlans);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => followInstalls(), []);
  useEffect(() => {
    if (open) void loadPlans();
  }, [open, loadPlans]);

  const real = agents.filter((a) => a.id !== 'fake');
  if (!real.length) return null;
  const ready = real.filter((a) => a.health === 'ready').length;

  const recheck = async () => {
    setChecking(true);
    await refreshAgents(true).catch(() => undefined);
    await loadPlans();
    setChecking(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          size="dense"
          variant="secondary"
          aria-label={`Coding CLIs: ${ready} of ${real.length} ready`}
          icon={<SquareTerminal className={cx('size-4', ready ? 'text-accent-soft' : 'text-ink-muted')} aria-hidden="true" />}
        >
          <span>
            {ready}/{real.length}
            <span className="hidden 2xl:inline"> CLIs</span>
            <span className="hidden lg:inline"> ready</span>
          </span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="ade-pop z-50 flex w-[22rem] flex-col gap-1 rounded-[var(--radius)] border border-line bg-[var(--surface-glass)] p-2 shadow-[var(--shadow-pop)] backdrop-blur-xl"
          aria-label="Coding CLIs"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <h2 className="m-0 text-[13px] font-semibold">Coding CLIs</h2>
            <Button size="dense" variant="ghost" busy={checking} onClick={() => void recheck()} icon={<RefreshCw className="size-3.5" aria-hidden="true" />}>
              Check again
            </Button>
          </div>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {real.map((a) => (
              <CliRow key={a.id} agent={a} />
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function CliRow({ agent: a }: { agent: AgentStatus }) {
  const plan = useInstalls((s) => s.plans.find((p) => p.agentId === a.id));
  const state = useInstalls((s) => s.states[a.id]);
  const [error, setError] = useState<string | null>(null);
  const Icon = a.health === 'ready' ? CircleCheck : a.health === 'needs-sign-in' ? CircleAlert : CircleDashed;
  const running = state?.state === 'running';
  const missing = a.health === 'not-installed';

  return (
    <li className="flex flex-col gap-2 rounded-[var(--radius-small)] border border-line bg-surface/60 px-3 py-2" data-testid={`cli-${a.id}`}>
      <div className="flex items-center gap-2">
        <Icon className={cx('size-4 shrink-0', a.health === 'ready' ? 'text-accent-soft' : 'text-ink-muted')} aria-hidden="true" />
        <span className="font-semibold">{a.label}</span>
        <span className="text-[12px] text-ink-muted">{healthText(a)}</span>
        {a.version ? <span className="ml-auto truncate font-mono text-[11px] text-ink-muted">{a.version}</span> : null}
      </div>
      {a.health === 'needs-sign-in' ? (
        <p className="m-0 text-[12px] text-ink-muted">
          Run <code className="font-mono">{COMMANDS[a.id]}</code> in a terminal and sign in there; ADE never handles agent credentials.
        </p>
      ) : null}
      {missing && !running && state?.state !== 'done' ? (
        plan?.manager ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Button
                size="dense"
                variant="primary"
                icon={<Download className="size-4" aria-hidden="true" />}
                onClick={async () => setError(await installAgent(a.id))}
              >
                Install with {MANAGER_LABEL[plan.manager]}
              </Button>
              {plan.elevated ? <span className="text-[12px] text-ink-muted">Asks for your password</span> : null}
            </div>
            <code className="block truncate font-mono text-[11px] text-ink-muted" title={plan.command ?? undefined}>
              {plan.command}
            </code>
          </div>
        ) : plan?.problem ? (
          <p className="m-0 text-[12px] text-ink-muted">{plan.problem}</p>
        ) : null
      ) : null}
      {running ? <Waiting className="text-[12px]">Installing with {state.manager}…</Waiting> : null}
      {state?.state === 'done' ? <p className="m-0 text-[12px] text-ink-muted">{a.health === 'not-installed' ? 'Installed, but ADE cannot find it yet. Restart ADE so it sees the new PATH.' : 'Installed.'}</p> : null}
      {state?.state === 'failed' ? (
        <p role="alert" className="m-0 text-[12px] font-semibold text-ink">
          {state.error ?? 'The install failed.'}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-[12px] font-semibold text-ink">
          {error}
        </p>
      ) : null}
      {state && state.output && state.state !== 'done' ? (
        <pre aria-label="Installer output" className="m-0 max-h-32 overflow-auto rounded-[var(--radius-small)] bg-surface-sunken p-2 font-mono text-[11px] whitespace-pre-wrap text-ink-muted">
          {state.output.split('\n').slice(-12).join('\n')}
        </pre>
      ) : null}
    </li>
  );
}
