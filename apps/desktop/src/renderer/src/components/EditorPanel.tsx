import Editor from '@monaco-editor/react';
import { Badge, Button, EmptyState } from '@ade/ui';
import { useCallback, useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
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

  const load = useCallback(async () => {
    if (!editor) return;
    const file = await attempt(() => host.call('files.read', { path: editor.path }));
    if (file) {
      setContent(file.content);
      setSaved(file.content);
      setMtime(file.mtimeMs);
    }
  }, [editor]);

  useEffect(() => {
    setContent(null);
    void load();
  }, [load]);

  const save = useCallback(
    async (force = false) => {
      if (!editor || content === null) return;
      const res = await attempt(() =>
        host.call('files.write', { path: editor.path, content, expectedMtimeMs: force ? null : mtime, ...(editor.sessionId ? { sessionId: editor.sessionId } : {}) }),
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
      setSaved(content);
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
        <EmptyState title="Editor" body="Open a file from the Files tab in the inspector, or go to a file by name." action={root ? <Button onClick={() => setGoTo(true)}>Go to file (Ctrl P)</Button> : undefined} />
        {picker}
      </>
    );
  }
  const dirty = content !== null && content !== saved;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={editor.path}>
          {editor.path}
        </span>
        {editor.sessionId ? <Badge tone="accent">Session worktree</Badge> : <Badge>Your checkout</Badge>}
        {dirty ? <Badge tone="attention">Unsaved</Badge> : null}
        <Button size="dense" onClick={() => setGoTo(true)}>
          Go to file
        </Button>
        <Button size="dense" variant="primary" disabled={!dirty} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {content === null ? null : (
          <Editor theme="ade-dark" path={editor.path} value={content} language={languageOf(editor.path)} onChange={(v) => setContent(v ?? '')} options={EDITOR_OPTIONS} />
        )}
      </div>
      {picker}
    </div>
  );
}
