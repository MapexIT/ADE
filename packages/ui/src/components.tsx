import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'attention';
type Size = 'dense' | 'normal';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink font-semibold border border-accent hover:brightness-110',
  secondary: 'bg-surface text-ink border border-line hover:border-line-strong hover:bg-surface-raised',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:text-ink hover:bg-surface-raised',
  danger: 'bg-surface text-danger border border-danger-line hover:bg-danger-tint',
  attention: 'bg-attention-tint text-attention font-semibold border border-attention-line hover:brightness-110',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

/** Real `button` elements only (accessibility rule). Dense toolbars use 36 px, elsewhere 44 px. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'normal', icon, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-3 text-[13px] whitespace-nowrap',
        'transition-[background-color,border-color,filter] duration-[var(--motion-fast)] ease-[var(--ease)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'dense' ? 'min-h-9' : 'min-h-11',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

type Tone = 'neutral' | 'accent' | 'attention' | 'danger' | 'ok';
const TONES: Record<Tone, string> = {
  neutral: 'border border-line text-ink-muted',
  accent: 'border border-accent text-accent-soft bg-accent-tint',
  attention: 'bg-attention-tint text-attention border border-attention-line',
  danger: 'bg-danger-tint text-danger border border-danger-line',
  ok: 'bg-ok-tint text-ok border border-transparent',
};

/** A status pill. Always carries a word, never colour alone. */
export function Badge({ tone = 'neutral', className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] leading-5 whitespace-nowrap', TONES[tone], className)} {...rest}>
      {children}
    </span>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('rounded-[var(--radius-card)] border border-line bg-surface', className)} {...rest} />;
}

export function SectionLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('text-[11px] font-semibold tracking-[0.06em] uppercase text-ink-muted', className)} {...rest} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">{children}</kbd>;
}

/** Empty states say what the area is for and offer the one obvious next action (UI rule). */
export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-[16px] font-semibold text-ink">{title}</div>
      <p className="max-w-md text-ink-muted">{body}</p>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-ink-muted">
      <span aria-hidden="true" className="inline-block size-3 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </span>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  size = 'normal',
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  label: string;
  size?: Size;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b border-line">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cx(
            'border-b-2 px-3 text-[13px]',
            size === 'dense' ? 'min-h-9' : 'min-h-11',
            value === it.value ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
