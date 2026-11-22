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
  icon,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Shown before the title, e.g. the logo on the welcome screen. */
  icon?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ade-overlay fixed inset-0 z-40 bg-black/60 backdrop-blur-[3px]" />
        <Dialog.Content
          className={cx(
            'ade-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-pop)]',
            wide ? 'max-w-4xl' : 'max-w-xl',
          )}
        >
          <div className="flex items-center gap-4 border-b border-line p-5">
            {icon}
            <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title className="m-0 text-[16px] font-semibold tracking-[-0.01em]">{title}</Dialog.Title>
            {description ? <Dialog.Description className="m-0 text-ink-muted">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line p-5">{footer}</div> : null}
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
  'min-h-11 rounded-[var(--radius)] border border-line bg-surface-sunken px-3 text-[13px] text-ink placeholder:text-ink-muted transition-[border-color,box-shadow] duration-[var(--motion)] ease-[var(--ease)] hover:border-line-strong focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)] focus:outline-none';
