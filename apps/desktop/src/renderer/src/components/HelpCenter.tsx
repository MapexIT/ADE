import { Badge, Button, cx, Kbd, Logo } from '@ade/ui';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Code2,
  Eye,
  FolderGit2,
  GitCompareArrows,
  Hand,
  Keyboard,
  Layers,
  ListTodo,
  MessagesSquare,
  Play,
  Rocket,
  Search,
  ShieldCheck,
  SquareTerminal,
  TerminalSquare,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import featuresDoc from '../../../../../../docs/FEATURES.md?raw';
import { buildCommands } from '../lib/commands.ts';
import { parseFeatures, searchFeatures, shippedAreas, tabFor, type HelpFeature } from '../lib/help.ts';
import { useStore, type Tab } from '../lib/store.ts';
import { inputClass, Modal } from './Modal.tsx';

const AREA_ICONS: Record<string, LucideIcon> = {
  ST: Rocket,
  WA: Eye,
  SR: MessagesSquare,
  CN: ShieldCheck,
  AP: Hand,
  RV: GitCompareArrows,
  PL: Layers,
  TM: SquareTerminal,
  SM: TerminalSquare,
  CR: Play,
  CO: ListTodo,
  WF: Workflow,
  ED: Code2,
};

const TAB_LABELS: Record<Tab, string> = {
  sessions: 'Sessions',
  'work-items': 'Work items',
  workflows: 'Workflows',
  skills: 'Skills',
  terminals: 'Terminals',
  run: 'Run',
  review: 'Review',
  observe: 'Observe',
  git: 'Git',
};

const START_STEPS = [
  {
    title: 'Open a repository',
    body: 'Ctrl O, or the workspace switcher in the top bar. ADE never writes to your checkout.',
  },
  {
    title: 'Start a session',
    body: 'Ctrl N. Pick an agent and a permission profile; the session gets its own worktree and branch.',
  },
  {
    title: 'Answer what needs you',
    body: 'Approvals and questions appear in the timeline and in the Needs-you inbox (Ctrl I).',
  },
  {
    title: 'Review and land',
    body: 'The Review tab shows the diff against the base. Nothing lands until you choose to.',
  },
];

type Section = 'start' | 'shortcuts' | string;

/** Every feature ADE ships, read from docs/FEATURES.md, with search and a way to jump to it. */
export function HelpCenter() {
  const open = useStore((s) => s.helpOpen);
  const set = useStore((s) => s.set);
  const setTab = useStore((s) => s.setTab);
  const areas = useMemo(() => shippedAreas(parseFeatures(featuresDoc)), []);
  const [section, setSection] = useState<Section>('start');
  const [query, setQuery] = useState('');
  const total = areas.reduce((n, a) => n + a.features.length, 0);

  const shown: HelpFeature[] | null = query.trim()
    ? searchFeatures(areas, query)
    : (areas.find((a) => a.title === section)?.features ?? null);

  const go = (tab: Tab) => {
    set({ helpOpen: false });
    setTab(tab);
  };

  const navItem = (key: Section, label: string, Icon: LucideIcon, count?: number) => (
    <button
      key={key}
      type="button"
      aria-current={!query.trim() && section === key ? 'true' : undefined}
      onClick={() => {
        setQuery('');
        setSection(key);
      }}
      className={cx(
        'flex min-h-9 w-full items-center gap-2.5 rounded-[var(--radius-small)] px-3 text-left',
        !query.trim() && section === key
          ? 'bg-accent-tint font-semibold text-ink'
          : 'text-ink-muted hover:bg-surface-raised hover:text-ink',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined ? <span className="text-[11px] text-ink-muted">{count}</span> : null}
    </button>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(o) => set({ helpOpen: o })}
      title="Help centre"
      icon={<Logo size={36} />}
      description={`Everything ADE can do: ${total} features in ${areas.length} areas.`}
      wide
    >
      <div className="flex flex-col gap-4">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
            aria-hidden="true"
          />
          <label htmlFor="help-search" className="sr-only">
            Search features
          </label>
          <input
            id="help-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search features, for example: approve, worktree, terminal"
            className={cx(inputClass, 'w-full pl-9')}
          />
        </div>
        <div className="grid min-h-0 grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
          <nav aria-label="Help sections" className="flex max-h-[56vh] flex-col gap-0.5 overflow-auto">
            {navItem('start', 'Getting started', BookOpen)}
            {navItem('shortcuts', 'Keyboard shortcuts', Keyboard)}
            <div className="my-2 h-px bg-line" />
            {areas.map((a) =>
              navItem(a.title, a.title, AREA_ICONS[a.prefixes[0] ?? ''] ?? FolderGit2, a.features.length),
            )}
          </nav>
          <div className="flex max-h-[56vh] min-w-0 flex-col gap-2 overflow-auto">
            {shown ? (
              shown.length ? (
                shown.map((f) => <FeatureCard key={f.id} feature={f} onGo={go} />)
              ) : (
                <p className="m-0 p-4 text-center text-ink-muted">No feature matches “{query}”.</p>
              )
            ) : section === 'shortcuts' ? (
              <Shortcuts />
            ) : (
              <ol className="m-0 flex list-none flex-col gap-2 p-0">
                {START_STEPS.map((s, i) => (
                  <li
                    key={s.title}
                    className="flex gap-3 rounded-[var(--radius)] border border-line bg-surface-raised/40 p-4"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-small)] bg-accent-tint text-[12px] font-semibold text-accent-soft">
                      {i + 1}
                    </span>
                    <div className="flex flex-col gap-1">
                      <span className="font-semibold text-ink">{s.title}</span>
                      <span className="text-ink-muted">{s.body}</span>
                    </div>
                  </li>
                ))}
                <li className="flex items-center gap-2 p-1 text-ink-muted">
                  <Bot className="size-4 text-accent-soft" aria-hidden="true" />
                  ADE has no agent of its own: it supervises Codex, Claude Code and OpenCode, signed in
                  through their own flows.
                </li>
              </ol>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function FeatureCard({ feature: f, onGo }: { feature: HelpFeature; onGo: (tab: Tab) => void }) {
  const tab = tabFor(f.id);
  return (
    <article className="flex flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface-raised/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{f.name}</span>
        <Badge className="font-mono">{f.id}</Badge>
        {f.phase === 'v1' ? <Badge tone="accent">v1</Badge> : null}
        {tab ? (
          <Button
            size="dense"
            variant="ghost"
            className="ml-auto"
            onClick={() => onGo(tab)}
            icon={<ArrowRight className="size-4" aria-hidden="true" />}
          >
            Open {TAB_LABELS[tab]}
          </Button>
        ) : null}
      </div>
      {f.description ? <p className="m-0 text-ink-muted">{f.description}</p> : null}
      <span className="text-[12px] text-ink-muted">{f.area}</span>
    </article>
  );
}

function Shortcuts() {
  const rows = buildCommands()
    .filter((c) => c.shortcut)
    .map((c) => ({ title: c.title, keys: c.shortcut! }));
  return (
    <div className="flex flex-col divide-y divide-line rounded-[var(--radius)] border border-line">
      {rows.map((r) => (
        <div key={r.title} className="flex min-h-11 items-center justify-between gap-3 px-4">
          <span>{r.title}</span>
          <Kbd>{r.keys}</Kbd>
        </div>
      ))}
    </div>
  );
}
