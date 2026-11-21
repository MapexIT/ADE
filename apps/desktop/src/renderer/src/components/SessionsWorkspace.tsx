import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IWatermarkPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Button } from '@ade/ui';
import { useEffect, useRef } from 'react';
import { host } from '../lib/bridge.ts';
import { defaultLayout, PANELS, showPanel, workspaceLayout } from '../lib/layout.ts';
import { useStore } from '../lib/store.ts';
import { EditorPanel } from './EditorPanel.tsx';
import { Inspector } from './Inspector.tsx';
import { SessionsList } from './SessionsList.tsx';
import { SessionView } from './session/SessionView.tsx';
import { TerminalPanel } from './terminal/TerminalsScreen.tsx';

const LAYOUT_KEY = 'layout.sessions.v1';

const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  sessions: () => <SessionsList />,
  session: () => <SessionView />,
  inspector: () => <Inspector />,
  terminal: () => <TerminalPanel />,
  editor: () => <EditorPanel />,
};

const theme = { ...themeDark, name: 'ade', className: `${themeDark.className} dockview-theme-ade` };

/** Shown when every panel is closed, so the user is never left with an empty screen. */
function EmptyDock({ containerApi }: IWatermarkPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-ink-muted">All panels are closed.</p>
      <div className="flex flex-wrap justify-center gap-2">
        {PANELS.map((p) => (
          <Button key={p.id} size="dense" variant="secondary" onClick={() => showPanel(containerApi, p.id)}>
            Show {p.title.toLowerCase()}
          </Button>
        ))}
        <Button size="dense" variant="primary" onClick={() => defaultLayout(containerApi)}>
          Reset layout
        </Button>
      </div>
    </div>
  );
}

/** Screen 1 as a Dockview workspace. The layout is saved in the host and survives a restart (M1-T04). */
export function SessionsWorkspace() {
  const apiRef = useRef<DockviewApi | null>(null);
  const editor = useStore((s) => s.editor);

  // Dockview keeps its instance across React's StrictMode remount and calls onReady only once, so the effect
  // attaches again after the simulated unmount instead of relying on onReady.
  useEffect(() => {
    if (apiRef.current) workspaceLayout.attach(apiRef.current);
    return () => workspaceLayout.attach(null);
  }, []);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    workspaceLayout.attach(event.api);
    void host
      .call('settings.get', { key: LAYOUT_KEY })
      .then(({ value }) => {
        try {
          if (value) event.api.fromJSON(value as Parameters<DockviewApi['fromJSON']>[0]);
          else defaultLayout(event.api);
        } catch {
          defaultLayout(event.api);
        }
      })
      .catch(() => defaultLayout(event.api))
      // A file opened before the saved layout loaded still gets its editor.
      .finally(() => {
        if (useStore.getState().editor) showPanel(event.api, 'editor');
      });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void host.call('settings.set', { key: LAYOUT_KEY, value: event.api.toJSON() });
    };
    event.api.onDidLayoutChange(() => {
      workspaceLayout.changed();
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 150);
    });
    // A change made just before quitting is still saved.
    window.addEventListener('beforeunload', () => timer && persist());
  };

  // Opening a file shows the editor panel, next to whatever panels are still open.
  useEffect(() => {
    const api = apiRef.current;
    if (api && editor) showPanel(api, 'editor');
  }, [editor]);

  return <DockviewReact className="h-full" components={components} onReady={onReady} theme={theme} watermarkComponent={EmptyDock} />;
}
