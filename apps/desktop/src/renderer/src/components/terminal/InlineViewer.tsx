import { Image } from 'lucide-react';
import { Badge, Button } from '@ade/ui';
import type { CommandBlock } from '@ade/contracts';
import { useMemo, useState, type ReactNode } from 'react';
import { host } from '../../lib/bridge.ts';
import { joinPath } from '../../lib/format.ts';
import { attempt } from '../../lib/store.ts';
import { inlineViewFor } from '../../lib/terminal-intel.ts';

/** Inline Markdown: `code`, **bold** and *italic*, as React text (never HTML). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={m.index} className="rounded bg-surface px-1">{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = (m.index ?? 0) + t.length;
  }
  out.push(text.slice(last));
  return out;
}

/** A small, safe Markdown renderer: headings, lists, code blocks and paragraphs. */
function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith('```')) code.push(lines[i]!);
      blocks.push(<pre key={i} className="m-0 overflow-auto rounded bg-surface p-2">{code.join('\n')}</pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const level = /^#+/.exec(line)![0].length;
      blocks.push(<p key={i} className={level <= 2 ? 'm-0 text-[14px] font-semibold text-ink' : 'm-0 font-semibold text-ink'}>{inline(line.replace(/^#+\s/, ''))}</p>);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[i]!); i++) items.push(lines[i]!.replace(/^\s*([-*]|\d+\.)\s/, ''));
      i--;
      blocks.push(<ul key={i} className="m-0 pl-5">{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>);
    } else if (line.trim()) blocks.push(<p key={i} className="m-0">{inline(line)}</p>);
  }
  return <div className="flex flex-col gap-1.5 font-sans text-[13px] text-ink">{blocks}</div>;
}

function Json({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || typeof value !== 'object') return <span className="text-accent-soft">{JSON.stringify(value)}</span>;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  return (
    <details open={depth < 1} className="pl-3">
      <summary className="cursor-pointer text-ink-muted">{Array.isArray(value) ? `Array (${entries.length})` : `Object (${entries.length})`}</summary>
      {entries.slice(0, 200).map(([k, v]) => (
        <div key={k}>
          <span className="text-ink">{k}</span>: <Json value={v} depth={depth + 1} />
        </div>
      ))}
    </details>
  );
}

/** SM-12: images, Markdown, JSON, CSV and test results shown inside a finished block. */
export function InlineViewer({ block, cwd }: { block: CommandBlock; cwd: string | null }) {
  const view = useMemo(() => inlineViewFor(block.command, block.output), [block.command, block.output]);
  const [image, setImage] = useState<string | null>(null);
  if (!view) return null;
  const frame = (label: string, body: ReactNode) => (
    <div className="flex flex-col gap-1 rounded-[var(--radius-small)] border border-line bg-surface p-2" aria-label={label}>
      <span className="font-sans text-[11px] font-semibold text-ink-muted uppercase">{label}</span>
      {body}
    </div>
  );
  switch (view.kind) {
    case 'json':
      return frame('JSON', <div className="max-h-72 overflow-auto"><Json value={view.value} /></div>);
    case 'markdown':
      return frame('Markdown', <div className="max-h-96 overflow-auto"><Markdown source={view.source} /></div>);
    case 'csv':
      return frame(
        'Table',
        <div className="max-h-72 overflow-auto">
          <table className="border-collapse text-[12px]">
            <tbody>
              {view.rows.map((row, i) => (
                <tr key={i} className={i === 0 ? 'font-semibold text-ink' : ''}>
                  {row.map((cell, j) => (
                    <td key={j} className="border border-line px-2 py-0.5">{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    case 'tests': {
      const t = view.summary;
      return frame(
        `Test results · ${t.framework}`,
        <div className="flex flex-col gap-1 font-sans text-[13px]">
          <div className="flex gap-2">
            <Badge tone={t.failed ? 'danger' : 'ok'}>{t.failed} failed</Badge>
            <Badge tone="ok">{t.passed} passed</Badge>
            {t.skipped ? <Badge>{t.skipped} skipped</Badge> : null}
          </div>
          {t.failures.length ? (
            <ul className="m-0 pl-5 font-mono text-[12px] text-danger">
              {t.failures.slice(0, 50).map((f) => <li key={f}>{f}</li>)}
            </ul>
          ) : null}
        </div>,
      );
    }
    case 'image':
      return frame(
        'Image',
        image ? (
          <img src={image} alt={view.path} className="max-h-80 max-w-full self-start rounded" />
        ) : cwd ? (
          <Button icon={<Image className="size-4" aria-hidden="true" />} size="dense" className="self-start" onClick={() => void attempt(() => host.call('files.readImage', { path: /^([A-Za-z]:|\/)/.test(view.path) ? view.path : joinPath(cwd, view.path) })).then((r) => r && setImage(r.dataUrl))}>
            Show {view.path}
          </Button>
        ) : null,
      );
  }
}
