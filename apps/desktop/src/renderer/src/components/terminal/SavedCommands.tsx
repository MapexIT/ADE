import { Bookmark, Plus, Save, Trash2 } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Button, cx } from '@ade/ui';
import type { SavedCommand } from '@ade/contracts';
import { useCallback, useEffect, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { attempt, useStore } from '../../lib/store.ts';
import { runInTerminal } from '../../lib/guards.ts';
import { inputClass, Modal } from '../Modal.tsx';

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 36);

/** TM-07: named commands for this workspace, typed into the active terminal with one click. */
export function SavedCommands({ terminalId, disabled }: { terminalId: string; disabled: boolean }) {
  const workspaceId = useStore((s) => s.workspaceId);
  const toast = useStore((s) => s.toast);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [editing, setEditing] = useState<SavedCommand[] | null>(null);

  const load = useCallback(() => {
    if (workspaceId) void attempt(() => host.call('commands.list', { workspaceId })).then((c) => setCommands(c ?? []));
  }, [workspaceId]);
  useEffect(load, [load]);

  if (!workspaceId) return null;
  const run = (c: SavedCommand) => runInTerminal(terminalId, c.command);
  const save = async () => {
    if (!editing) return;
    const valid = editing.filter((c) => c.name.trim() && c.command.trim());
    if (await attempt(() => host.call('commands.save', { workspaceId, commands: valid }))) {
      setCommands(valid);
      setEditing(null);
      toast('Saved commands updated.');
    }
  };
  const patch = (id: string, change: Partial<SavedCommand>) => setEditing((list) => list?.map((c) => (c.id === id ? { ...c, ...change } : c)) ?? null);

  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button icon={<Bookmark className="size-4" aria-hidden="true" />} size="dense" variant="ghost" disabled={disabled}>
            Saved commands
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content sideOffset={6} className="z-50 min-w-64 rounded-[var(--radius)] ade-pop border border-line bg-[var(--surface-glass)] p-1 shadow-[var(--shadow-pop)] backdrop-blur-xl">
            {commands.length === 0 ? <div className="px-3 py-2 text-ink-muted">No saved commands yet.</div> : null}
            {commands.map((c) => (
              <Menu.Item key={c.id} onSelect={() => run(c)} className="flex min-h-9 cursor-pointer flex-col justify-center rounded px-3 py-1 outline-none data-[highlighted]:bg-accent-tint">
                <span>{c.name}</span>
                <span className="font-mono text-[11.5px] text-ink-muted">{c.command}</span>
              </Menu.Item>
            ))}
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item onSelect={() => setEditing(commands.length ? commands : [{ id: newId(), name: '', command: '' }])} className="flex min-h-9 cursor-pointer items-center rounded px-3 outline-none data-[highlighted]:bg-accent-tint">
              Edit saved commands
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Modal
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Saved commands"
        description="Named commands for this repository. Choosing one types it into the active terminal and presses Enter."
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button icon={<Save className="size-4" aria-hidden="true" />} variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {(editing ?? []).map((c, i) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2">
              <label htmlFor={`cmd-name-${c.id}`} className="sr-only">
                Command {i + 1} name
              </label>
              <input id={`cmd-name-${c.id}`} value={c.name} placeholder="Name" onChange={(e) => patch(c.id, { name: e.target.value })} className={cx(inputClass, 'w-36')} />
              <label htmlFor={`cmd-text-${c.id}`} className="sr-only">
                Command {i + 1}
              </label>
              <input id={`cmd-text-${c.id}`} value={c.command} placeholder="pnpm test" onChange={(e) => patch(c.id, { command: e.target.value })} className={cx(inputClass, 'min-w-40 flex-1 font-mono')} />
              <Button icon={<Trash2 className="size-4" aria-hidden="true" />} size="dense" variant="ghost" aria-label={`Remove command ${i + 1}`} onClick={() => setEditing((list) => list?.filter((x) => x.id !== c.id) ?? null)}>
                Remove
              </Button>
            </div>
          ))}
          <Button icon={<Plus className="size-4" aria-hidden="true" />} size="dense" className="self-start" onClick={() => setEditing((list) => [...(list ?? []), { id: newId(), name: '', command: '' }])}>
            Add command
          </Button>
        </div>
      </Modal>
    </>
  );
}
