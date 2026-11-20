import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

// Monaco is bundled locally: no CDN, no remote content (rule 9).
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

monaco.editor.defineTheme('ade-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0B0E13',
    'editor.foreground': '#E6EAF0',
    'editorLineNumber.foreground': '#5C6878',
    'editorLineNumber.activeForeground': '#9AA7B6',
    'editor.selectionBackground': '#1E2A40',
    'editor.lineHighlightBackground': '#161B22',
    'editorCursor.foreground': '#7FA6F5',
    'editorWidget.background': '#161B22',
    'editorWidget.border': '#2A3441',
    // Three hues: additions use the accent, deletions use danger.
    'diffEditor.insertedTextBackground': '#7FA6F533',
    'diffEditor.insertedLineBackground': '#1E2A40',
    'diffEditor.removedTextBackground': '#FF9B9B33',
    'diffEditor.removedLineBackground': '#3A1A1A',
    'scrollbarSlider.background': '#3A465680',
  },
});

export const EDITOR_OPTIONS = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12.5,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: 'selection',
  automaticLayout: true,
} as const;
