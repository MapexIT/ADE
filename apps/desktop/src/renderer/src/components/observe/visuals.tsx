import { cx } from '@ade/ui';
import type { ActivityPhase, PhaseSegment } from '@ade/session-core';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useId } from 'react';

/** Phase colours: shades of violet, white and grey only (three-colour palette). */
export const PHASE_STYLE: Record<ActivityPhase, { label: string; color: string; striped?: boolean }> = {
  starting: { label: 'Starting', color: '#3a3a42' },
  working: { label: 'Working', color: '#52525b' },
  thinking: { label: 'Thinking', color: '#c4b5fd' },
  writing: { label: 'Writing', color: '#fafafa' },
  tool: { label: 'Using a tool', color: '#8b5cf6' },
  command: { label: 'Running a command', color: '#6d28d9' },
  waiting: { label: 'Waiting for you', color: '#ddd6fe', striped: true },
  idle: { label: 'Idle', color: '#24242a' },
  stopped: { label: 'Stopped', color: '#24242a' },
};

const ORB_MODE: Record<ActivityPhase, 'busy' | 'waiting' | 'idle' | 'stopped'> = {
  starting: 'busy',
  working: 'busy',
  thinking: 'busy',
  writing: 'busy',
  tool: 'busy',
  command: 'busy',
  waiting: 'waiting',
  idle: 'idle',
  stopped: 'stopped',
};

/** Busy agents glow violet (the specific phase colour when it has one); idle and stopped stay grey. */
function orbColor(phase: ActivityPhase) {
  if (phase === 'working' || phase === 'starting') return '#8b5cf6';
  if (phase === 'idle' || phase === 'stopped') return '#71717a';
  return PHASE_STYLE[phase].color;
}

/** A status light: rings ripple out while the agent works, it breathes while it waits for you. */
export function Orb({ phase, size = 14 }: { phase: ActivityPhase; size?: number }) {
  const mode = ORB_MODE[phase];
  return (
    <span
      aria-hidden="true"
      className={cx('ade-orb', `ade-orb-${mode}`)}
      style={{
        width: size,
        height: size,
        ['--orb-color' as string]: orbColor(phase),
      }}
    />
  );
}

/** A number that glides to its new value instead of jumping. */
export function AnimatedNumber({
  value,
  format = (n: number) => Math.round(n).toLocaleString('en-GB'),
}: {
  value: number;
  format?: (n: number) => string;
}) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => format(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.6, ease: [0.2, 0.8, 0.2, 1] });
    return () => controls.stop();
  }, [mv, value]);
  return <motion.span className="tabular-nums">{text}</motion.span>;
}

/** Event rate over the last two minutes. The curve morphs smoothly as new buckets arrive. */
export function Sparkline({
  values,
  width = 160,
  height = 36,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  const id = useId();
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)] as const);
  // A smooth curve through the points (Catmull-Rom as cubic Béziers).
  let d = `M ${points[0]?.[0] ?? 0} ${points[0]?.[1] ?? height}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6}, ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6}, ${p2[0]} ${p2[1]}`;
  }
  const area = `${d} L ${width} ${height} L 0 ${height} Z`;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.45" />
          <stop offset="1" stopColor="#8b5cf6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path
        d={area}
        fill={`url(#${id}-fill)`}
        animate={{ d: area }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
      <motion.path
        d={d}
        fill="none"
        stroke="#a78bfa"
        strokeWidth="1.75"
        strokeLinecap="round"
        animate={{ d }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
    </svg>
  );
}

/** The session's phases laid out over time; the last segment grows live. */
export function PhaseBar({
  segments,
  now,
  height = 14,
}: {
  segments: PhaseSegment[];
  now: number;
  height?: number;
}) {
  const start = segments[0]?.start ?? now;
  const total = Math.max(1, now - start);
  return (
    <div
      className="flex w-full overflow-hidden rounded-[var(--radius-small)] bg-surface-sunken"
      style={{ height }}
      aria-hidden="true"
    >
      {segments.map((s, i) => {
        const w = (((s.end ?? now) - s.start) / total) * 100;
        const style = PHASE_STYLE[s.phase];
        return (
          <motion.div
            key={`${s.start}-${i}`}
            className={cx('h-full shrink-0', style.striped && 'ade-stripes')}
            style={{ backgroundColor: style.color, minWidth: w > 0 ? 1 : 0 }}
            initial={{ width: 0 }}
            animate={{ width: `${w}%` }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          />
        );
      })}
    </div>
  );
}

/** A tick that draws itself, shown when a turn finishes. */
export function DrawnCheck({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <motion.circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="#8b5cf6"
        strokeWidth="2"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      />
      <motion.path
        d="M7.5 12.5 L10.5 15.5 L16.5 9"
        fill="none"
        stroke="#fafafa"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.35, delay: 0.35, ease: 'easeOut' }}
      />
    </svg>
  );
}
