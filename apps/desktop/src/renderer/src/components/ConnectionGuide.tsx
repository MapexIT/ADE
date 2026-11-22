import { Check, Copy, ExternalLink, GitBranch, KeyRound, ListTodo, RefreshCw, Settings, SquareTerminal } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import type { ConnectionStatus } from '@ade/contracts';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { host, main, platform } from '../lib/bridge.ts';
import { gitIdentityCommands } from '../lib/connections.ts';
import { attempt, useStore } from '../lib/store.ts';

type Source = 'github' | 'shortcut';
type Creds = { available: boolean; backend: string };

/** Reads the connection status (CO-11) and the credential store, and re-reads both on demand. */
function useConnection(onChecked?: () => void) {
  const workspaceId = useStore((s) => s.workspaceId);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [creds, setCreds] = useState<Creds | null>(null);
  const [checking, setChecking] = useState(false);
  // The latest callback, without re-running the check when the parent passes a new function.
  const notify = useRef(onChecked);
  notify.current = onChecked;
  const check = useCallback(async (byUser: boolean) => {
    setChecking(true);
    const [s, c] = await Promise.all([
      attempt(() => host.call('connectors.status', { workspaceId })),
      main('main.credentials.status', {}).catch(() => null),
    ]);
    setStatus(s ?? null);
    setCreds(c);
    setChecking(false);
    // Only a check the user asked for refreshes the parent; the first, automatic one would loop with it.
    if (byUser) notify.current?.();
  }, [workspaceId]);
  useEffect(() => {
    void check(false);
  }, [check]);
  return { status, creds, checking, check };
}

/** A command to run in a terminal, with a copy button. */
function Command({ text }: { text: string }) {
  const toast = useStore((s) => s.toast);
  return (
    <div className="flex items-center gap-2 rounded-[var(--radius-small)] border border-line bg-surface-sunken py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[12px] whitespace-nowrap text-ink">{text}</code>
      <Button
        size="dense"
        variant="ghost"
        aria-label={`Copy ${text}`}
        onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast('Could not copy.'))}
      >
        <Copy className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** One numbered step. Done steps show a tick; the first open step is highlighted. */
function Step({ n, title, done, current, status, children }: { n: number; title: string; done: boolean; current: boolean; status?: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3" aria-current={current ? 'step' : undefined}>
      <span
        aria-hidden="true"
        className={cx(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold transition-colors duration-200',
          done ? 'border-accent bg-accent text-white' : current ? 'border-accent text-accent-soft' : 'border-line text-ink-muted',
        )}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={cx('m-0 text-[14px] font-semibold', done ? 'text-ink-muted' : 'text-ink')}>{title}</h3>
          <span className="sr-only">{done ? '(done)' : '(to do)'}</span>
        </div>
        {status ? <div className="text-[12px] text-ink-muted">{status}</div> : null}
        {done ? null : children}
      </div>
    </li>
  );
}

function Shell({ icon, title, body, checking, onCheck, children }: { icon: ReactNode; title: string; body: string; checking: boolean; onCheck: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className="mx-auto flex w-full max-w-2xl flex-col gap-5 py-4">
      <header className="flex items-start gap-3">
        <div aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-card)] border border-line bg-accent-tint text-accent-soft">
          {icon}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
          <p className="m-0 text-ink-muted">{body}</p>
        </div>
        <Button size="dense" disabled={checking} onClick={onCheck}>
          <RefreshCw className={cx('size-3.5', checking && 'animate-spin')} aria-hidden="true" />
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </header>
      <ol className="m-0 flex list-none flex-col p-0">{children}</ol>
    </section>
  );
}

const openUrl = (url: string) => void attempt(() => main('main.openExternal', { url }));

function GitHubGuide({ status, checking, check }: { status: ConnectionStatus | null; checking: boolean; check: () => void }) {
  const set = useStore((s) => s.set);
  const gh = status?.github;
  const git = status?.git;
  const installed = !!gh?.cli.installed;
  const signedIn = !!gh?.account;
  const identity = !!(git?.name && git.email);
  const win = platform() === 'win32';
  const first = !installed ? 1 : !signedIn ? 2 : !identity ? 3 : 0;
  return (
    <Shell
      icon={<GitBranch className="size-5" />}
      title="Connect GitHub"
      body="ADE lists the issues assigned to you through the GitHub CLI and your own sign-in. It never sees your password, and reads only."
      checking={checking}
      onCheck={check}
    >
      <Step
        n={1}
        title="Install the GitHub CLI"
        done={installed}
        current={first === 1}
        status={installed ? `Found gh${gh?.cli.version ? ` ${gh.cli.version}` : ''}.` : status ? 'gh was not found on your PATH.' : 'Checking…'}
      >
        {win ? <Command text="winget install --id GitHub.cli" /> : <p className="m-0">Install it with your package manager; the official page lists the commands for each distribution.</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="dense" variant="ghost" onClick={() => openUrl('https://cli.github.com/')}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Installation instructions
          </Button>
        </div>
        <p className="m-0 text-[12px] text-ink-muted">Restart ADE afterwards so it finds gh.</p>
      </Step>
      <Step
        n={2}
        title="Sign in to GitHub"
        done={signedIn}
        current={first === 2}
        status={
          signedIn ? (
            <>
              Signed in as <span className="font-semibold text-ink">@{gh!.account!.login}</span>
              {gh!.account!.name ? ` (${gh!.account!.name})` : ''}
              {gh!.tokenStored ? ' with the token stored in ADE.' : ' through gh.'}
            </>
          ) : gh?.problem ? (
            <>gh says: {gh.problem}</>
          ) : undefined
        }
      >
        <p className="m-0">Run this in a terminal and follow the prompts: choose GitHub.com, then sign in with your browser.</p>
        <Command text="gh auth login" />
        <div className="flex flex-wrap gap-2">
          <Button size="dense" onClick={() => set({ tab: 'terminals' })}>
            <SquareTerminal className="size-3.5" aria-hidden="true" />
            Open Terminals
          </Button>
          <Button size="dense" variant="ghost" onClick={() => set({ settingsOpen: true })}>
            <KeyRound className="size-3.5" aria-hidden="true" />
            Use a token instead
          </Button>
        </div>
        <p className="m-0 text-[12px] text-ink-muted">A read-only token in Settings works too; it is kept in your system's credential store.</p>
      </Step>
      <Step
        n={3}
        title="Check your Git identity"
        done={identity}
        current={first === 3}
        status={
          identity ? (
            <>
              Commits you land are made as <span className="font-semibold text-ink">{git!.name}</span> &lt;{git!.email}&gt;.
            </>
          ) : git && !git.installed ? (
            'Git was not found on your PATH.'
          ) : git ? (
            `Git does not know your ${!git.name && !git.email ? 'name or email' : !git.name ? 'name' : 'email'} yet.`
          ) : undefined
        }
      >
        <p className="m-0">
          Commits made when you land a session use this name and email.{' '}
          {gh?.account ? 'These commands are filled in from your GitHub account, so your commits link to it.' : 'Use an email of your GitHub account so commits link to it.'}
        </p>
        {git ? gitIdentityCommands(git, gh?.account ?? null).map((c) => <Command key={c} text={c} />) : null}
      </Step>
    </Shell>
  );
}

function ShortcutGuide({ status, creds, checking, check }: { status: ConnectionStatus | null; creds: Creds | null; checking: boolean; check: () => void }) {
  const set = useStore((s) => s.set);
  const stored = !!status?.shortcut.tokenStored;
  const storeOk = creds?.available !== false;
  return (
    <Shell
      icon={<ListTodo className="size-5" />}
      title="Connect Shortcut"
      body="ADE lists the stories assigned to you through Shortcut's MCP server, with a personal API token you create."
      checking={checking}
      onCheck={check}
    >
      <Step n={1} title="Create an API token in Shortcut" done={stored} current={!stored}>
        <p className="m-0">In Shortcut, open Settings, then Your Account, then API Tokens. Generate a token and name it ADE so you can recognise it later.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="dense" variant="ghost" onClick={() => openUrl('https://app.shortcut.com/')}>
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Open Shortcut
          </Button>
        </div>
      </Step>
      <Step
        n={2}
        title="Save the token in ADE"
        done={stored}
        current={false}
        status={stored ? 'A Shortcut token is stored in your credential store.' : !storeOk ? `No credential store is available (${creds?.backend ?? 'unknown'}). Install a keyring such as GNOME Keyring or KWallet, then restart ADE.` : undefined}
      >
        <p className="m-0">Open Settings, paste it into the Shortcut token field under Connectors and choose Save. It is encrypted by your system's credential store and never written to the database, logs or prompts.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="dense" variant="primary" disabled={!storeOk} onClick={() => set({ settingsOpen: true })}>
            <Settings className="size-3.5" aria-hidden="true" />
            Open settings
          </Button>
        </div>
      </Step>
      <Step n={3} title="Come back and check" done={false} current={stored}>
        <p className="m-0">Choose Check again. Your open stories appear here, grouped by state.</p>
      </Step>
    </Shell>
  );
}

/** CO-11: step by step, what is missing to connect a work item source, read from this machine. */
export function ConnectionGuide({ source, onChecked }: { source: Source; onChecked?: () => void }) {
  const { status, creds, checking, check } = useConnection(onChecked);
  return source === 'github' ? (
    <GitHubGuide status={status} checking={checking} check={() => void check(true)} />
  ) : (
    <ShortcutGuide status={status} creds={creds} checking={checking} check={() => void check(true)} />
  );
}
