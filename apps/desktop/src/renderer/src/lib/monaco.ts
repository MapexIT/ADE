import { loader } from '@monaco-editor/react';
import { palette } from '@ade/ui';
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
    'editor.background': palette.surfaceSunken,
    'editor.foreground': palette.ink,
    'editorLineNumber.foreground': palette.inkFaint,
    'editorLineNumber.activeForeground': palette.accentSoft,
    'editor.selectionBackground': '#3b2a63',
    'editor.inactiveSelectionBackground': '#2a2042',
    'editor.lineHighlightBackground': palette.surface,
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': palette.accent,
    'editorIndentGuide.background1': palette.line,
    'editorIndentGuide.activeBackground1': palette.lineStrong,
    'editorWidget.background': palette.surfaceRaised,
    'editorWidget.border': palette.lineStrong,
    'editorSuggestWidget.selectedBackground': palette.accentTint,
    focusBorder: palette.accent,
    // Three colours: additions are violet, deletions are white.
    'diffEditor.insertedTextBackground': '#8b5cf640',
    'diffEditor.insertedLineBackground': palette.accentTint,
    'diffEditor.removedTextBackground': '#ffffff26',
    'diffEditor.removedLineBackground': '#1c1c21',
    'scrollbarSlider.background': '#3a3a4280',
    'scrollbarSlider.hoverBackground': '#52525b99',
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
