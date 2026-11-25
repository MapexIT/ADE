import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'attention';
type Size = 'dense' | 'normal';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-accent-strong text-accent-ink font-semibold border border-accent shadow-[0_1px_0_rgb(255_255_255/0.12)_inset,0_6px_18px_-6px_var(--accent-glow)] hover:bg-accent hover:shadow-[0_1px_0_rgb(255_255_255/0.16)_inset,0_8px_24px_-6px_var(--accent-glow)]',
  secondary:
    'bg-surface-raised/60 text-ink border border-line hover:border-line-strong hover:bg-surface-raised',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:text-ink hover:bg-surface-raised',
  danger: 'bg-transparent text-danger font-semibold border border-danger-line hover:bg-danger-tint',
  attention:
    'bg-attention-tint text-attention font-semibold border border-attention-line hover:bg-accent-tint hover:shadow-[0_6px_18px_-6px_var(--accent-glow)]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  /** While true the icon becomes a spinner and the button ignores clicks (WA-11). */
  busy?: boolean;
}

/** Real `button` elements only (accessibility rule). Dense toolbars use 36 px, elsewhere 44 px. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'normal', icon, busy = false, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius)] px-3 text-[13px] whitespace-nowrap select-none',
        'transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--motion)] ease-[var(--ease)]',
        'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
        size === 'dense' ? 'min-h-9' : 'min-h-11',
        VARIANTS[variant],
        busy && 'pointer-events-none',
        className,
      )}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

/** WA-11: a small turning arc for something that is working. Static under reduced motion. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx('ade-spinner size-4 shrink-0', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="11 27" />
    </svg>
  );
}

/**
 * WA-11: a waiting line: three softly breathing dots and what ADE is waiting for. It fades in after a moment, so a
 * quick load never flashes it.
 */
export function Waiting({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span role="status" className={cx('ade-waiting inline-flex items-center gap-2 text-ink-muted', className)}>
      <span className="ade-dots inline-flex gap-[3px]" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{children}</span>
    </span>
  );
}

type Tone = 'neutral' | 'accent' | 'attention' | 'danger' | 'ok';
const TONES: Record<Tone, string> = {
  neutral: 'border border-line bg-surface-raised/50 text-ink-muted',
  accent: 'border border-accent/60 text-accent-soft bg-accent-tint',
  attention: 'bg-attention-tint text-attention font-semibold border border-attention-line',
  danger: 'bg-danger-tint text-danger font-semibold border border-danger-line',
  ok: 'bg-ok-tint text-ok border border-accent/30',
};

/** A status pill. Always carries a word, never colour alone. */
export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-small)] px-2 py-0.5 text-[12px] leading-5 whitespace-nowrap transition-colors duration-[var(--motion)]',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-soft)] transition-[border-color,box-shadow] duration-[var(--motion)] ease-[var(--ease)]',
        className,
      )}
      {...rest}
    />
  );
}

export function SectionLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx('text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-muted', className)}
      {...rest}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[var(--radius-small)] border border-line border-b-line-strong bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
      {children}
    </kbd>
  );
}

/** Empty states say what the area is for and offer the one obvious next action (UI rule). */
export function EmptyState({ title, body, action, icon }: { title: string; body: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 p-8 text-center">
      {icon ? (
        <div aria-hidden="true" className="flex size-11 items-center justify-center rounded-[var(--radius-card)] border border-line bg-accent-tint text-accent-soft">
          {icon}
        </div>
      ) : null}
      <div className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{title}</div>
      <p className="max-w-md text-ink-muted">{body}</p>
      {action}
    </div>
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
            'relative px-3 text-[13px] transition-colors duration-[var(--motion)] ease-[var(--ease)]',
            "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent after:transition-transform after:duration-[var(--motion-slow)] after:ease-[var(--ease)] after:content-['']",
            size === 'dense' ? 'min-h-9' : 'min-h-11',
            value === it.value
              ? 'font-semibold text-ink after:scale-x-100'
              : 'text-ink-muted after:scale-x-0 hover:text-ink',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
