import { DockviewReact, themeDark, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useEffect, useRef } from 'react';
import { host } from '../lib/bridge.ts';
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

function defaultLayout(api: DockviewApi) {
  api.addPanel({ id: 'session', component: 'session', title: 'Session' });
  api.addPanel({ id: 'sessions', component: 'sessions', title: 'Sessions', position: { referencePanel: 'session', direction: 'left' }, initialWidth: 280 });
  api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: 'session', direction: 'right' }, initialWidth: 320 });
  api.addPanel({ id: 'terminal', component: 'terminal', title: 'Terminal', position: { referencePanel: 'session', direction: 'below' }, initialHeight: 240 });
}

/** Screen 1 as a Dockview workspace. The layout is saved in the host and survives a restart (M1-T04). */
export function SessionsWorkspace() {
  const apiRef = useRef<DockviewApi | null>(null);
  const editor = useStore((s) => s.editor);

  const onReady = (event: DockviewReadyEvent) => {
    apiRef.current = event.api;
    void host
      .call('settings.get', { key: LAYOUT_KEY })
      .then(({ value }) => {
        try {
          if (value) event.api.fromJSON(value as Parameters<DockviewApi['fromJSON']>[0]);
          else defaultLayout(event.api);
        } catch {
          event.api.clear();
          defaultLayout(event.api);
        }
      })
      .catch(() => defaultLayout(event.api));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const persist = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void host.call('settings.set', { key: LAYOUT_KEY, value: event.api.toJSON() });
    };
    event.api.onDidLayoutChange(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, 150);
    });
    // A change made just before quitting is still saved.
    window.addEventListener('beforeunload', () => timer && persist());
  };

  // Opening a file shows the editor panel next to the session, and remembers its place.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !editor) return;
    const existing = api.getPanel('editor');
    if (existing) existing.api.setActive();
    else api.addPanel({ id: 'editor', component: 'editor', title: 'Editor', position: { referencePanel: 'session', direction: 'within' } });
  }, [editor]);

  return <DockviewReact className="h-full" components={components} onReady={onReady} theme={theme} />;
}
