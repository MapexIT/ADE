import { Trash2 } from 'lucide-react';
import { Button, cx } from '@ade/ui';
import { useEffect, useState } from 'react';

/**
 * HI-13: the shared "clear history" control. The first press arms it; a second press within 4 seconds deletes.
 * `confirmLabel` names exactly what goes, for example "Delete all runs".
 */
export function ClearHistoryButton({ label = 'Clear history', confirmLabel, onConfirm, className }: { label?: string; confirmLabel: string; onConfirm: () => void | Promise<void>; className?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      size="dense"
      variant={armed ? 'attention' : 'ghost'}
      className={cx(className)}
      icon={<Trash2 className="size-4" aria-hidden="true" />}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        void onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

/** HI-13: a small trash button that deletes one history entry at once. */
export function DeleteEntryButton({ label, onDelete }: { label: string; onDelete: () => void }) {
  return (
    <Button size="dense" variant="ghost" className="w-9 shrink-0 px-0" aria-label={label} title={label} onClick={onDelete}>
      <Trash2 className="size-4" aria-hidden="true" />
    </Button>
  );
}
