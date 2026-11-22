import { Check, ChevronDown, PanelsTopLeft, RotateCcw } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Button } from '@ade/ui';
import { useState, useSyncExternalStore } from 'react';
import { closePanel, defaultLayout, PANELS, showPanel, workspaceLayout } from '../lib/layout.ts';

const itemClass =
  'flex min-h-9 cursor-pointer items-center gap-2 rounded px-3 outline-none data-[highlighted]:bg-accent-tint';

/** Shows or hides each panel of the sessions workspace, and resets the layout. */
export function PanelsMenu() {
  const [open, setOpen] = useState(false);
  // Re-render on every layout change so the ticks follow panels closed from their tabs.
  useSyncExternalStore(
    workspaceLayout.subscribe,
    () => workspaceLayout.api?.panels.map((p) => p.id).join(',') ?? '',
  );
  const api = workspaceLayout.api;
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <Button size="dense" variant="secondary" disabled={!api} aria-label="Panels" icon={<PanelsTopLeft className="size-4" aria-hidden="true" />}>
          <span className="hidden xl:inline">Panels</span>
          <ChevronDown className="size-3.5 text-ink-muted" aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          sideOffset={6}
          align="end"
          className="z-50 min-w-48 rounded-[var(--radius)] ade-pop border border-line bg-[var(--surface-glass)] p-1 shadow-[var(--shadow-pop)] backdrop-blur-xl"
        >
          {PANELS.map((p) => {
            const shown = !!api?.getPanel(p.id);
            return (
              <Menu.CheckboxItem
                key={p.id}
                checked={shown}
                onCheckedChange={(on) => api && (on ? showPanel(api, p.id) : closePanel(api, p.id))}
                className={itemClass}
              >
                <span aria-hidden="true" className="flex size-4 items-center justify-center text-accent">
                  {shown ? <Check className="size-4" /> : null}
                </span>
                {p.title}
              </Menu.CheckboxItem>
            );
          })}
          <Menu.Separator className="my-1 h-px bg-line" />
          <Menu.Item onSelect={() => api && defaultLayout(api)} className={itemClass}>
            <RotateCcw className="size-4 text-ink-muted" aria-hidden="true" />
            Reset layout
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
