import type { CommandBlock, TerminalInfo } from '@ade/contracts';

/** SM-19: a command running this long in a terminal the user is not looking at is watched for finishing. */
export const AUTO_WATCH_MS = 30_000;
export const AUTO_WATCH_SETTING = 'terminals.autoWatch';

/** The running blocks that should get an automatic "Finishes" watch now. Pure, for tests. */
export function autoWatchTargets(
  terminals: Record<string, TerminalInfo & { exited?: boolean }>,
  blocks: Record<string, CommandBlock[]>,
  opts: { active: string | null; focused: boolean; now: number; done: ReadonlySet<string> },
): { terminalId: string; blockId: string }[] {
  const out: { terminalId: string; blockId: string }[] = [];
  for (const t of Object.values(terminals)) {
    if (t.kind !== 'smart' || !t.smart || t.exited || t.watch !== null) continue;
    if (t.id === opts.active && opts.focused) continue;
    const running = (blocks[t.id] ?? []).find((b) => b.endedAt === null);
    if (!running || !running.command.trim() || opts.done.has(running.id)) continue;
    if (opts.now - running.startedAt >= AUTO_WATCH_MS) out.push({ terminalId: t.id, blockId: running.id });
  }
  return out;
}
