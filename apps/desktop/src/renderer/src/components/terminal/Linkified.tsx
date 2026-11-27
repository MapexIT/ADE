import type { ReactNode } from 'react';
import { main } from '../../lib/bridge.ts';
import { joinPath } from '../../lib/format.ts';
import { attempt, useStore } from '../../lib/store.ts';

const LINK = /(https?:\/\/[^\s'"<>]+)|((?:[A-Za-z]:)?[\w./\\-]+\.[A-Za-z0-9]{1,8}):(\d+)(?::(\d+))?/g;

/** SM-07: file paths with line numbers open in the editor; links open in the browser. */
export function Linkified({ text, cwd, sessionId }: { text: string; cwd: string | null; sessionId: string | null }) {
  const openEditor = useStore((s) => s.openEditor);
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const idx = m.index ?? 0;
    out.push(text.slice(last, idx));
    if (m[1]) {
      const url = m[1];
      out.push(
        <a key={idx} href={url} className="text-accent underline" onClick={(e) => (e.preventDefault(), void attempt(() => main('main.openExternal', { url })))}>
          {url}
        </a>,
      );
    } else if (m[2] && cwd) {
      const path = /^([A-Za-z]:|\/)/.test(m[2]) ? m[2] : joinPath(cwd, m[2]);
      out.push(
        <button key={idx} type="button" className="text-accent underline" onClick={() => openEditor(path, sessionId, Number(m[3]))}>
          {m[0]}
        </button>,
      );
    } else out.push(m[0]);
    last = idx + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}
