import * as Dialog from '@radix-ui/react-dialog';
import { Button, cx } from '@ade/ui';
import type { ReactNode } from 'react';
import { useStore } from '../lib/store.ts';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50 data-[state=open]:animate-in" />
        <Dialog.Content
          className={cx(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-[var(--radius-card)] border border-line bg-surface shadow-2xl',
            wide ? 'max-w-4xl' : 'max-w-xl',
          )}
        >
          <div className="flex flex-col gap-1 border-b border-line px-5 py-4">
            <Dialog.Title className="m-0 text-[16px] font-semibold">{title}</Dialog.Title>
            {description ? <Dialog.Description className="m-0 text-ink-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Every destructive action asks first and says what will be lost (UI rule). */
export function ConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const set = useStore((s) => s.set);
  const close = () => set({ confirm: null });
  return (
    <Modal
      open={!!confirm}
      onOpenChange={(o) => !o && close()}
      title={confirm?.title ?? ''}
      footer={
        <>
          <Button onClick={close}>Keep it</Button>
          <Button
            variant={confirm?.danger ? 'danger' : 'primary'}
            onClick={async () => {
              const c = confirm;
              close();
              await c?.onConfirm();
            }}
          >
            {confirm?.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="m-0 text-ink">{confirm?.body}</p>
    </Modal>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[12px] font-semibold text-ink-muted">
        {label}
      </label>
      {children}
      {hint ? <span className="text-[12px] text-ink-muted">{hint}</span> : null}
    </div>
  );
}

export const inputClass =
  'min-h-11 rounded-[var(--radius)] border border-line bg-bg px-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-accent focus:outline-none';
