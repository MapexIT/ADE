import { useId } from 'react';

/**
 * The ADE mark: three agents (the nodes at the base) whose branches meet in one supervising node, forming an
 * "A". White on a violet tile; resources/icon.svg is the same drawing for the app icon.
 */
export function Logo({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#6d28d9" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${id}-g)`} />
      <g stroke="#ffffff" strokeWidth="4" strokeLinecap="round" fill="none">
        <path d="M18 46 L32 19" />
        <path d="M46 46 L32 19" />
        <path d="M32 46 L32 27" />
        <path d="M24.5 35.5 H39.5" strokeOpacity="0.55" />
      </g>
      <circle cx="32" cy="17" r="5.5" fill="#ffffff" />
      <g fill="#6d28d9" stroke="#ffffff" strokeWidth="3">
        <circle cx="18" cy="47" r="4" />
        <circle cx="32" cy="47" r="4" />
        <circle cx="46" cy="47" r="4" />
      </g>
    </svg>
  );
}
