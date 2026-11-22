import * as RadixTooltip from '@radix-ui/react-tooltip';
import { Kbd } from '@ade/ui';
import type { ReactNode } from 'react';

export const TooltipProvider = RadixTooltip.Provider;

/**
 * A short label shown on hover and keyboard focus. The trigger keeps its own accessible name; the tooltip
 * only repeats and extends it, so nothing depends on seeing it.
 */
export function Tooltip({
  label,
  description,
  shortcut,
  side = 'bottom',
  children,
}: {
  label: string;
  description?: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          collisionPadding={8}
          className="ade-tip z-50 flex max-w-64 flex-col gap-1 rounded-[var(--radius)] border border-line bg-[var(--surface-glass)] px-3 py-2 text-[12px] shadow-[var(--shadow-pop)] backdrop-blur-xl"
        >
          <span className="flex items-center justify-between gap-3 font-semibold text-ink">
            {label}
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </span>
          {description ? <span className="text-ink-muted">{description}</span> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
