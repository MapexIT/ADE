import { Button, cx, SectionLabel } from '@ade/ui';
import type { SyncSettings } from '@ade/contracts';
import { useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { attempt, useStore } from '../lib/store.ts';
import { inputClass } from './Modal.tsx';

const EMPTY: SyncSettings = { moveOnStart: null, moveOnPullRequest: null, moveOnMerge: null, progressNotes: false, closeIssues: false };

/** CO-05 and CO-08: what ADE may change on a session's work item. Everything is off until chosen. */
export function WorkItemSyncSettings({ workspaceId }: { workspaceId: string }) {
  const toast = useStore((s) => s.toast);
  const [settings, setSettings] = useState<SyncSettings>(EMPTY);
  const [states, setStates] = useState<{ id: number; name: string; type: string }[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void host.call('sync.settings', { workspaceId }).then(setSettings);
  }, [workspaceId]);

  const loadStates = async () => {
    setProblem(null);
    try {
      setStates(await host.call('connectors.shortcutStates', {}));
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  const save = async () => {
    if (await attempt(() => host.call('sync.save', { workspaceId, settings }))) toast('Work item sync saved.');
  };
  const stateSelect = (key: 'moveOnStart' | 'moveOnPullRequest' | 'moveOnMerge', label: string) => (
    <label className="flex flex-col gap-1 text-[12px] font-semibold text-ink-muted">
      {label}
      <select
        value={settings[key] ?? ''}
        onChange={(e) => setSettings({ ...settings, [key]: e.target.value ? Number(e.target.value) : null })}
        className={cx(inputClass, 'min-h-9')}
      >
        <option value="">Leave it</option>
        {(states ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {settings[key] !== null && !states?.some((s) => s.id === settings[key]) ? <option value={settings[key]!}>State {settings[key]}</option> : null}
      </select>
    </label>
  );

  return (
    <section className="flex flex-col gap-2" aria-label="Work item sync">
      <SectionLabel>Work item sync</SectionLabel>
      <p className="m-0 text-[12px] text-ink-muted">For sessions started from a work item in this repository. Off until you choose. Failures show in the session and never stop it.</p>
      <div className="flex flex-wrap items-end gap-2">
        {states ? null : (
          <Button size="dense" onClick={() => void loadStates()}>
            Load Shortcut states
          </Button>
        )}
        {stateSelect('moveOnStart', 'Move the story when a session starts')}
        {stateSelect('moveOnPullRequest', 'When it opens a pull request')}
        {stateSelect('moveOnMerge', 'When the pull request is merged')}
      </div>
      {problem ? <span className="text-[12px] text-danger">{problem}</span> : null}
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={settings.progressNotes} onChange={(e) => setSettings({ ...settings, progressNotes: e.target.checked })} className="size-5 accent-[var(--accent)]" />
        Post a progress note (summary and pull request link) to the story or issue
      </label>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={settings.closeIssues} onChange={(e) => setSettings({ ...settings, closeIssues: e.target.checked })} className="size-5 accent-[var(--accent)]" />
        Close GitHub issues when their pull request is merged
      </label>
      <Button size="dense" variant="primary" className="self-start" onClick={() => void save()}>
        Save sync
      </Button>
    </section>
  );
}

/** CO-10: MCP servers of the user's own that every session receives, in any repository. */
export function PersonalMcpSettings() {
  const toast = useStore((s) => s.toast);
  const [yaml, setYaml] = useState('');
  useEffect(() => {
    void host.call('mcp.personal', {}).then((r) => setYaml(r.yaml));
  }, []);
  const save = async () => {
    if (await attempt(() => host.call('mcp.savePersonal', { yaml }))) toast('Personal MCP servers saved.');
  };
  return (
    <section className="flex flex-col gap-2" aria-label="Personal MCP servers">
      <SectionLabel>Personal MCP servers</SectionLabel>
      <p className="m-0 text-[12px] text-ink-muted">Every session in every repository receives these, next to the repository's own. Write secrets as $VARIABLE; ADE reads them from its environment.</p>
      <label htmlFor="mcp-personal" className="sr-only">
        Personal MCP servers (YAML)
      </label>
      <textarea
        id="mcp-personal"
        rows={5}
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        placeholder={'- name: notes\n  command: ["npx", "-y", "my-notes-mcp"]\n- name: docs\n  url: https://mcp.example.com/mcp\n  headers:\n    Authorization: Bearer $DOCS_TOKEN'}
        className={cx(inputClass, 'py-2 font-mono text-[12px]')}
      />
      <Button size="dense" variant="primary" className="self-start" onClick={() => void save()}>
        Save servers
      </Button>
    </section>
  );
}
