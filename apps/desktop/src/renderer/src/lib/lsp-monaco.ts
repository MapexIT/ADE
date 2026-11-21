import * as monaco from 'monaco-editor';
import type { LspDiagnostic } from '@ade/contracts';
import { host } from './bridge.ts';
import { useStore } from './store.ts';

/** ED-03: which file and session each Monaco model shows, so providers can ask the host. */
const models = new Map<string, { path: string; sessionId: string | null }>();

export function trackModel(model: monaco.editor.ITextModel, path: string, sessionId: string | null) {
  models.set(model.uri.toString(), { path, sessionId });
}

const SEVERITY: Record<LspDiagnostic['severity'], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

export function showDiagnostics(model: monaco.editor.ITextModel, diagnostics: LspDiagnostic[]) {
  monaco.editor.setModelMarkers(
    model,
    'lsp',
    diagnostics.map((d) => ({
      startLineNumber: d.line + 1,
      startColumn: d.character + 1,
      endLineNumber: d.endLine + 1,
      endColumn: d.endCharacter + 1,
      severity: SEVERITY[d.severity],
      message: d.message,
      ...(d.source ? { source: d.source } : {}),
    })),
  );
}

let registered = false;
/** Hover and go to definition from the host's language servers, for the languages it knows. */
export function registerLspProviders() {
  if (registered) return;
  registered = true;
  const languages = ['typescript', 'javascript', 'python', 'go', 'rust', 'c', 'cpp', 'csharp'];
  for (const language of languages) {
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const m = models.get(model.uri.toString());
        if (!m) return null;
        const res = await host.call('lsp.hover', { path: m.path, line: position.lineNumber - 1, character: position.column - 1 }).catch(() => null);
        return res ? { contents: [{ value: res.contents }] } : null;
      },
    });
    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        const m = models.get(model.uri.toString());
        if (!m) return null;
        const targets = await host.call('lsp.definition', { path: m.path, line: position.lineNumber - 1, character: position.column - 1 }).catch(() => []);
        return targets.map((t) => {
          const uri = t.path === m.path ? model.uri : monaco.Uri.file(t.path);
          if (t.path !== m.path) models.set(uri.toString(), { path: t.path, sessionId: m.sessionId });
          return { uri, range: new monaco.Range(t.line + 1, t.character + 1, t.line + 1, t.character + 1) };
        });
      },
    });
  }
  // A definition in another file opens it in ADE's editor.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource) => {
      const m = models.get(resource.toString());
      if (!m) return false;
      useStore.getState().openEditor(m.path, m.sessionId);
      return true;
    },
  });
}
