import Editor from '@monaco-editor/react';
import { Badge, Button, EmptyState } from '@ade/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Monaco from 'monaco-editor';
import { interpreterFor } from '../lib/runner.ts';
import { startRun } from '../lib/runs.ts';
import { host, main } from '../lib/bridge.ts';
import { basename, languageOf } from '../lib/format.ts';
import { EDITOR_OPTIONS } from '../lib/monaco.ts';
import { attempt, currentWorkspace, selectedSession, useStore } from '../lib/store.ts';
import { FilePicker } from './FilePicker.tsx';

/** ED-01: Monaco with go to file and save; saving detects external changes. */
export function EditorPanel() {
  const editor = useStore((s) => s.editor);
  const openEditor = useStore((s) => s.openEditor);
  const workspace = useStore(currentWorkspace);
  const session = useStore(selectedSession);
  const ask = useStore((s) => s.ask);
  const toast = useStore((s) => s.toast);
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [goTo, setGoTo] = useState(false);
  const [missing, setMissing] = useState(false);
  const monacoRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [platform, setPlatform] = useState('linux');
  useEffect(() => {
    void main('main.info', {}).then((i) => setPlatform(i.platform)).catch(() => undefined);
  }, []);
  const follow = useStore((s) => s.follow);
  const set = useStore((s) => s.set);
  const followButton = (
    <Button size="dense" variant={follow ? 'primary' : 'secondary'} aria-pressed={follow} onClick={() => set({ follow: !follow })} title="WA-06: open the file the agent is working on">
      Follow agent
    </Button>
  );

  const load = useCallback(async () => {
    if (!editor) return;
    // Follow mode can open a file the agent has not written yet; that is not an error.
    const file = await host.call('files.read', { path: editor.path }).catch(() => null);
    setMissing(!file);
    if (file) {
      setContent(file.content);
      setSaved(file.content);
      setMtime(file.mtimeMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.path, editor?.rev]);

  useEffect(() => {
    setContent(null);
    void load();
  }, [load]);

  const dirtyNow = content !== null && content !== saved;
  useEffect(() => {
    set({ editorDirty: dirtyNow });
  }, [dirtyNow, set]);

  const save = useCallback(
    async (force = false) => {
      if (!editor || content === null) return;
      // Read the text from the editor itself: a save right after typing must not miss the last keystrokes.
      const text = monacoRef.current?.getValue() ?? content;
      const res = await attempt(() =>
        host.call('files.write', { path: editor.path, content: text, expectedMtimeMs: force ? null : mtime, ...(editor.sessionId ? { sessionId: editor.sessionId } : {}) }),
      );
      if (!res) return;
      if (!res.ok) {
        ask({
          title: 'The file changed on disk',
          body: `${basename(editor.path)} was changed outside the editor after you opened it. Saving now replaces those changes with yours.`,
          confirmLabel: 'Save anyway',
          danger: true,
          onConfirm: () => void save(true),
        });
        return;
      }
      setContent(text);
      setSaved(text);
      setMtime(res.mtimeMs);
      toast(`Saved ${basename(editor.path)}.`);
    },
    [editor, content, mtime, ask, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setGoTo(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const root = session?.worktreePath ?? workspace?.rootPath ?? null;
  const picker = goTo && root ? (
    <FilePicker
      root={root}
      title="Go to file"
      onClose={() => setGoTo(false)}
      onPick={(rel) => {
        setGoTo(false);
        openEditor(`${root.replace(/[\\/]+$/, '')}/${rel}`, session?.worktreePath ? session.id : null);
      }}
    />
  ) : null;

  if (!editor) {
    return (
      <>
        <EmptyState
          title="Editor"
          body="Open a file from the Files tab in the inspector, go to a file by name, or follow the agent."
          action={
            <div className="flex gap-2">
              {root ? <Button onClick={() => setGoTo(true)}>Go to file (Ctrl P)</Button> : null}
              {followButton}
            </div>
          }
        />
        {picker}
      </>
    );
  }
  const dirty = content !== null && content !== saved;
  const runner = interpreterFor(editor.path, platform);
  const folder = editor.path.replace(/[\\/][^\\/]*$/, '');
  /** CR-05: the saved file, or the selection written to a temporary file, with the right interpreter. */
  const runFile = async () => {
    if (!runner) return;
    if (dirty) await save();
    await startRun({ command: [...runner, editor.path], cwd: folder, sessionId: editor.sessionId, label: basename(editor.path) });
  };
  const runSelection = async () => {
    const ed = monacoRef.current;
    const range = ed?.getSelection();
    const text = range && !range.isEmpty() ? (ed?.getModel()?.getValueInRange(range) ?? '') : '';
    if (!runner || !text.trim()) return toast('Select some code first.', 'danger');
    const ext = /\.([A-Za-z0-9]+)$/.exec(editor.path)?.[1]?.toLowerCase() ?? 'txt';
    const file = await attempt(() => host.call('scratch.write', { extension: ext, content: text }));
    if (file) await startRun({ command: [...runner, file.path], cwd: folder, sessionId: editor.sessionId, label: `Selection of ${basename(editor.path)}` });
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={editor.path}>
          {editor.path}
        </span>
        {editor.sessionId ? <Badge tone="accent">Session worktree</Badge> : <Badge>Your checkout</Badge>}
        {dirty ? <Badge tone="attention">Unsaved</Badge> : null}
        {followButton}
        {runner ? (
          <>
            <Button size="dense" onClick={() => void runFile()} title={`Runs with ${runner.join(' ')}`}>
              Run file
            </Button>
            <Button size="dense" onClick={() => void runSelection()}>
              Run selection
            </Button>
          </>
        ) : null}
        <Button size="dense" onClick={() => setGoTo(true)}>
          Go to file
        </Button>
        <Button size="dense" variant="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {missing ? <p className="m-3 text-ink-muted">This file does not exist yet.</p> : null}
        {content === null ? null : (
          <Editor theme="ade-dark" path={editor.path} value={content} language={languageOf(editor.path)} onChange={(v) => setContent(v ?? '')} onMount={(e) => (monacoRef.current = e)} options={EDITOR_OPTIONS} />
        )}
      </div>
      {picker}
    </div>
  );
}
