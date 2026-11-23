import { ChevronRight, FileCode2, LoaderCircle, Pencil, Plug, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Badge, Button, cx, EmptyState } from '@ade/ui';
import type { McpCheck, McpServerEntry } from '@ade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { host, main } from '../lib/bridge.ts';
import { configFrom, draftFrom, SOURCE_LABELS, statusOf, type McpDraft } from '../lib/mcp.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

type Filter = 'all' | McpServerEntry['source'];
type Listing = Awaited<ReturnType<typeof host.call<'mcp.list'>>>;
const key = (e: Pick<McpServerEntry, 'source' | 'name'>) => `${e.source}:${e.name}`;

/**
 * CO-13: every MCP server a new session receives, in one list: the user's own, the repository's and ADE's. Each
 * shows its status and can be checked (connect and list tools), switched off, and, for personal servers, added,
 * edited or removed. Changes apply to sessions started afterwards.
 */
export function McpDialog() {
  const open = useStore((s) => s.mcpOpen);
  const set = useStore((s) => s.set);
  const workspaceId = useStore((s) => s.workspaceId);
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const [listing, setListing] = useState<Listing | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [checks, setChecks] = useState<Record<string, McpCheck>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ original: string | null; draft: McpDraft } | null>(null);
  const [yaml, setYaml] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const l = await attempt(() => host.call('mcp.list', { workspaceId: workspaceId ?? null }));
    if (l) setListing(l);
  }, [workspaceId]);

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setYaml(null);
    void reload();
  }, [open, reload]);

  const check = async (e: McpServerEntry) => {
    setChecking((c) => ({ ...c, [key(e)]: true }));
    const r = await attempt(() => host.call('mcp.check', { workspaceId: workspaceId ?? null, source: e.source, name: e.name }));
    setChecking((c) => ({ ...c, [key(e)]: false }));
    if (r) {
      setChecks((c) => ({ ...c, [key(e)]: r }));
      setExpanded(key(e));
    }
  };
  const toggle = async (e: McpServerEntry) => {
    if (await attempt(() => host.call('mcp.setEnabled', { workspaceId: workspaceId ?? null, source: e.source, name: e.name, enabled: !e.enabled }))) await reload();
  };
  const remove = (e: McpServerEntry) =>
    ask({
      title: `Remove ${e.name}?`,
      body: 'New sessions will no longer receive this server. Sessions already running keep it until they end.',
      confirmLabel: 'Remove',
      danger: true,
      onConfirm: () =>
        void attempt(() => host.call('mcp.remove', { name: e.name })).then(async (ok) => {
          if (ok) {
            toast(`Removed ${e.name}.`);
            await reload();
          }
        }),
    });

  const servers = (listing?.servers ?? []).filter((s) => filter === 'all' || s.source === filter);
  const counts = (listing?.servers ?? []).reduce<Record<string, number>>((acc, s) => ({ ...acc, [s.source]: (acc[s.source] ?? 0) + 1 }), {});
  const active = (listing?.servers ?? []).filter((s) => s.enabled && !s.missing.length).length;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => set({ mcpOpen: o })}
      wide
      icon={<Plug className="size-5 text-accent-soft" aria-hidden="true" />}
      title="MCP servers"
      description="Every server a new session receives. Changes apply to sessions started after them."
      footer={<Button onClick={() => set({ mcpOpen: false })}>Close</Button>}
    >
      {editing ? (
        <ServerForm
          initial={editing.draft}
          isNew={!editing.original}
          onCancel={() => setEditing(null)}
          onSave={async (config) => {
            const ok = await attempt(() => host.call('mcp.save', { original: editing.original, server: config }));
            if (ok) {
              toast(editing.original ? `Saved ${config.name}.` : `Added ${config.name}.`);
              setEditing(null);
              await reload();
            }
          }}
        />
      ) : yaml !== null ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="mcp-yaml" className="text-[12px] font-semibold text-ink-muted">
            Personal MCP servers (YAML)
          </label>
          <textarea id="mcp-yaml" rows={14} value={yaml} onChange={(e) => setYaml(e.target.value)} className={cx(inputClass, 'py-2 font-mono text-[12px]')} spellCheck={false} />
          <span className="text-[12px] text-ink-muted">The same shape as mcpServers in .ade/workspace.yaml. Servers you switched off stay off if they keep their name.</span>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() =>
                void attempt(() => host.call('mcp.savePersonal', { yaml })).then(async (ok) => {
                  if (!ok) return;
                  toast('Personal MCP servers saved.');
                  setYaml(null);
                  await reload();
                })
              }
            >
              Save servers
            </Button>
            <Button onClick={() => setYaml(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="dense" variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setEditing({ original: null, draft: draftFrom(null) })}>
              Add server
            </Button>
            <Button size="dense" variant="ghost" icon={<FileCode2 className="size-4" aria-hidden="true" />} onClick={() => void host.call('mcp.personal', {}).then((r) => setYaml(r.yaml))}>
              Edit personal as YAML
            </Button>
            <Button size="dense" variant="ghost" icon={<RefreshCw className="size-4" aria-hidden="true" />} onClick={() => void reload()} aria-label="Refresh">
              Refresh
            </Button>
            <span className="ml-auto text-[12px] text-ink-muted" aria-live="polite">
              {active} of {listing?.servers.length ?? 0} passed to new sessions
            </span>
          </div>
          <div role="tablist" aria-label="Show" className="flex flex-wrap gap-1">
            {(['all', 'personal', 'workspace', 'built-in'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={cx('min-h-8 rounded-[var(--radius-small)] px-3 text-[12px]', filter === f ? 'bg-accent-tint font-semibold text-ink' : 'text-ink-muted hover:bg-surface-raised hover:text-ink')}
              >
                {f === 'all' ? 'All' : SOURCE_LABELS[f]} <span className="text-ink-muted">{f === 'all' ? (listing?.servers.length ?? 0) : (counts[f] ?? 0)}</span>
              </button>
            ))}
          </div>
          {listing?.workspaceFile && (filter === 'all' || filter === 'workspace') ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-line bg-surface-sunken px-3 py-2 text-[12px] text-ink-muted">
              <span>
                Repository servers come from <span className="font-mono">.ade/workspace.yaml</span>
                {listing.workspaceFile.exists ? '' : ', which this repository does not have yet'}. Switching one off applies to this machine only.
              </span>
              {listing.workspaceFile.error ? <span className="text-danger">The file has a problem: {listing.workspaceFile.error}</span> : null}
              {listing.workspaceFile.exists ? (
                <Button size="dense" variant="ghost" className="ml-auto" onClick={() => void attempt(() => main('main.openInEditor', { path: listing.workspaceFile!.path }))}>
                  Open the file
                </Button>
              ) : null}
            </div>
          ) : null}
          {!listing ? (
            <div className="flex items-center gap-2 text-ink-muted">
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading servers…
            </div>
          ) : servers.length === 0 ? (
            <EmptyState
              icon={<Plug className="size-5" />}
              title={filter === 'workspace' ? 'No repository servers' : filter === 'personal' ? 'No personal servers yet' : 'No servers'}
              body={filter === 'workspace' ? 'Add mcpServers to .ade/workspace.yaml to share servers with everyone who works on this repository.' : 'Add a server to give every session its tools, in any repository.'}
            />
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="MCP servers">
              {servers.map((e) => {
                const k = key(e);
                const result = checks[k];
                const status = statusOf(e, result);
                const isOpen = expanded === k;
                return (
                  <li key={k} aria-label={`${e.name}, ${SOURCE_LABELS[e.source]}`} className={cx('rounded-[var(--radius)] border bg-surface', e.enabled ? 'border-line' : 'border-line opacity-75')}>
                    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={`${isOpen ? 'Hide' : 'Show'} details of ${e.name}`}
                        onClick={() => setExpanded(isOpen ? null : k)}
                        className="flex min-h-7 min-w-7 items-center justify-center rounded text-ink-muted hover:text-ink"
                      >
                        <ChevronRight className={cx('size-4 transition-transform duration-150 motion-reduce:transition-none', isOpen && 'rotate-90')} aria-hidden="true" />
                      </button>
                      <span className="font-semibold">{e.name}</span>
                      <Badge>{SOURCE_LABELS[e.source]}</Badge>
                      <Badge>{e.kind === 'http' ? 'HTTP' : 'Command'}</Badge>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      <div className="ml-auto flex items-center gap-1">
                        {e.checkable ? (
                          <Button size="dense" variant="ghost" disabled={checking[k] || !!e.missing.length} onClick={() => void check(e)} title={e.kind === 'stdio' ? 'Starts the command on this machine, lists its tools and stops it' : 'Connects, lists its tools and disconnects'}>
                            {checking[k] ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                            {checking[k] ? 'Checking…' : 'Check'}
                          </Button>
                        ) : null}
                        {e.editable ? (
                          <>
                            <Button size="dense" variant="ghost" className="w-9 px-0" aria-label={`Edit ${e.name}`} onClick={() => setEditing({ original: e.name, draft: draftFrom(e.config) })}>
                              <Pencil className="size-4" aria-hidden="true" />
                            </Button>
                            <Button size="dense" variant="ghost" className="w-9 px-0" aria-label={`Remove ${e.name}`} onClick={() => remove(e)}>
                              <Trash2 className="size-4" aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                        <Switch on={e.enabled} label={`Pass ${e.name} to new sessions`} onClick={() => void toggle(e)} />
                      </div>
                    </div>
                    {isOpen ? (
                      <div className="flex flex-col gap-2 border-t border-line px-3 py-2 text-[12px]">
                        <div className="truncate font-mono" title={e.target}>
                          {e.target}
                        </div>
                        {e.note ? <p className="m-0 text-ink-muted">{e.note}</p> : null}
                        {e.keys.length ? (
                          <p className="m-0 text-ink-muted">
                            {e.kind === 'http' ? 'Headers' : 'Environment'}: <span className="font-mono">{e.keys.join(', ')}</span> (values not shown)
                          </p>
                        ) : null}
                        {e.missing.length ? <p className="m-0 text-attention">Not passed to agents until {e.missing.join(', ')} {e.missing.length === 1 ? 'is' : 'are'} set.</p> : null}
                        {result ? (
                          result.ok ? (
                            <div className="flex flex-col gap-1">
                              <span className="text-ink-muted">
                                Checked {new Date(result.checkedAt).toLocaleTimeString('en-GB')} in {result.ms} ms. Tools:
                              </span>
                              {result.tools.length ? (
                                <ul className="m-0 flex max-h-40 list-none flex-col gap-0.5 overflow-auto p-0">
                                  {result.tools.map((t) => (
                                    <li key={t.name}>
                                      <span className="font-mono">{t.name}</span>
                                      {t.description ? <span className="text-ink-muted"> · {t.description.split('\n')[0]}</span> : null}
                                    </li>
                                  ))}
                                </ul>
                              ) : (
                                <span className="text-ink-muted">This server offers no tools.</span>
                              )}
                            </div>
                          ) : (
                            <pre className="m-0 whitespace-pre-wrap text-danger">{result.error}</pre>
                          )
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function Switch({ on, label, onClick }: { on: boolean; label: string; onClick(): void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={cx('relative ml-1 h-6 w-11 shrink-0 rounded-full border transition-colors duration-150', on ? 'border-accent bg-accent' : 'border-line-strong bg-surface-sunken')}
    >
      <span aria-hidden="true" className={cx('absolute top-0.5 size-4.5 rounded-full bg-ink transition-[left] duration-150 motion-reduce:transition-none', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function ServerForm({ initial, isNew, onCancel, onSave }: { initial: McpDraft; isNew: boolean; onCancel(): void; onSave(config: Parameters<typeof host.call<'mcp.save'>>[1]['server']): Promise<void> }) {
  const [d, setD] = useState<McpDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const label = d.kind === 'http' ? 'Headers' : 'Environment variables';
  const submit = () => {
    const r = configFrom(d);
    if (!r.ok) return setError(r.error);
    setError(null);
    void onSave(r.config);
  };
  return (
    <form
      className="flex flex-col gap-3"
      aria-label={isNew ? 'Add an MCP server' : `Edit ${initial.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label="Name" htmlFor="mcp-name" hint="Letters, digits, dashes and underscores. Agents see the tools under this name.">
        <input id="mcp-name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} className={inputClass} autoFocus />
      </Field>
      <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0">
        <legend className="mb-1.5 text-[12px] font-semibold text-ink-muted">Type</legend>
        {(
          [
            ['stdio', 'Command (stdio)'],
            ['http', 'URL (streamable HTTP)'],
          ] as const
        ).map(([kind, text]) => (
          <label key={kind} className="flex min-h-9 items-center gap-2">
            <input type="radio" name="mcp-kind" checked={d.kind === kind} onChange={() => setD({ ...d, kind })} className="size-4 accent-[var(--color-accent)]" />
            {text}
          </label>
        ))}
      </fieldset>
      {d.kind === 'stdio' ? (
        <Field label="Command" htmlFor="mcp-command" hint="Run as an argument list, never through a shell. Quote arguments with spaces.">
          <input id="mcp-command" value={d.command} onChange={(e) => setD({ ...d, command: e.target.value })} placeholder="npx -y @modelcontextprotocol/server-filesystem ." className={cx(inputClass, 'font-mono')} />
        </Field>
      ) : (
        <Field label="URL" htmlFor="mcp-url">
          <input id="mcp-url" value={d.url} onChange={(e) => setD({ ...d, url: e.target.value })} placeholder="https://mcp.example.com/mcp" className={cx(inputClass, 'font-mono')} />
        </Field>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-ink-muted">{label}</span>
        {d.pairs.map((p, i) => (
          <div key={i} className="flex gap-2">
            <input aria-label={`${label}: name ${i + 1}`} value={p.key} onChange={(e) => setD({ ...d, pairs: d.pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })} placeholder={d.kind === 'http' ? 'Authorization' : 'API_KEY'} className={cx(inputClass, 'w-48 font-mono')} />
            <input aria-label={`${label}: value ${i + 1}`} value={p.value} onChange={(e) => setD({ ...d, pairs: d.pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder={d.kind === 'http' ? 'Bearer $DOCS_TOKEN' : '$MY_API_KEY'} className={cx(inputClass, 'flex-1 font-mono')} />
            <Button variant="ghost" className="w-11 px-0" aria-label={`Remove row ${i + 1}`} onClick={() => setD({ ...d, pairs: d.pairs.filter((_, j) => j !== i) })}>
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button size="dense" variant="ghost" className="self-start" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setD({ ...d, pairs: [...d.pairs, { key: '', value: '' }] })}>
          Add {d.kind === 'http' ? 'header' : 'variable'}
        </Button>
        <span className="text-[12px] text-ink-muted">Write secrets as $VARIABLE: ADE reads them from its environment when a session starts, so they are never stored here.</span>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          {isNew ? 'Add server' : 'Save server'}
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
