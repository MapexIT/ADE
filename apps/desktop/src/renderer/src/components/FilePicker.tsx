import { Waiting } from '@ade/ui';
import type { FileEntry } from '@ade/contracts';
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { attempt } from '../lib/store.ts';
import { Modal } from './Modal.tsx';

/** Go to file / attach file: fuzzy search over the tracked and untracked files of a root. */
export function FilePicker({ root, onPick, onClose, title = 'Choose a file' }: { root: string; onPick: (relPath: string) => void; onClose: () => void; title?: string }) {
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  useEffect(() => {
    void attempt(() => host.call('files.list', { root })).then((f) => setFiles((f ?? []).filter((x) => !x.isDir)));
  }, [root]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={title}>
      <Command label={title} className="flex flex-col gap-2">
        <Command.Input autoFocus placeholder="Type to search files" className="min-h-11 rounded-[var(--radius)] border border-line bg-bg px-3 text-ink focus:border-accent focus:outline-none" />
        <Command.List className="max-h-80 overflow-auto">
          <Command.Empty className="p-3 text-ink-muted">{files ? 'No matching files.' : <Waiting>Loading files…</Waiting>}</Command.Empty>
          {(files ?? []).slice(0, 5000).map((f) => (
            <Command.Item key={f.path} value={f.path} onSelect={() => onPick(f.path)} className="cursor-pointer rounded px-2 py-1.5 font-mono text-[12px] data-[selected=true]:bg-accent-tint">
              {f.path}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </Modal>
  );
}
