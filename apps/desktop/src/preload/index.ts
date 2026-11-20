/**
 * Typed bridge (Facade) between the sandboxed renderer and main. The renderer gets:
 *  - `ade.main(method, input)` for the few things only main may do (validated in main with zod)
 *  - `ade.onMainEvent(listener)` for process status and notification clicks
 * MessagePorts to the host and pty processes are forwarded with window.postMessage, the pattern Electron
 * documents for context-isolated pages; the renderer receives them as `ade-port` messages.
 */
import { contextBridge, ipcRenderer } from 'electron';

ipcRenderer.on('ade:port', (event, data: { name: string }) => {
  window.postMessage({ type: 'ade-port', name: data.name }, window.location.origin === 'null' ? '*' : window.location.origin, event.ports);
});

const api = {
  main: async (method: string, input: unknown): Promise<unknown> => {
    const res = (await ipcRenderer.invoke('ade:main', { method, input })) as
      | { ok: true; result: unknown }
      | { ok: false; error: { code: string; message: string } };
    if (res.ok) return res.result;
    const err = new Error(res.error.message) as Error & { code: string };
    err.code = res.error.code;
    throw err;
  },
  onMainEvent: (listener: (event: { topic: string; payload: unknown }) => void): (() => void) => {
    const l = (_e: unknown, msg: { topic: string; payload: unknown }) => listener(msg);
    ipcRenderer.on('ade:main-event', l);
    return () => ipcRenderer.removeListener('ade:main-event', l);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('ade', api);

export type AdeBridge = typeof api;
