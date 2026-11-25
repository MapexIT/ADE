import { Waiting } from '@ade/ui';
import { DiffEditor, type DiffEditorProps } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

/**
 * Monaco's diff editor with a safe unmount. @monaco-editor/react disposes the two text models before the diff editor
 * that still shows them, which Monaco reports as "TextModel got disposed before DiffEditorWidget model got reset". Here
 * the library keeps its models; after a real unmount the editor lets go of them and only then are they disposed.
 */
export function SafeDiffEditor({ onMount, ...props }: DiffEditorProps) {
  const editor = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const ed = editor.current;
      const model = ed?.getModel() ?? null;
      // StrictMode runs this cleanup and mounts again at once: only a real unmount disposes anything.
      queueMicrotask(() => {
        if (mounted.current || !ed) return;
        try {
          ed.setModel(null);
        } catch {
          // The library may already have disposed the editor; the models are still ours to dispose.
        }
        model?.original.dispose();
        model?.modified.dispose();
      });
    };
  }, []);
  return (
    <DiffEditor
      loading={<Waiting>Loading the editor…</Waiting>}
      {...props}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(ed, monaco) => {
        editor.current = ed;
        onMount?.(ed, monaco);
      }}
    />
  );
}
