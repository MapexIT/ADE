/**
 * M5-T07: ADE checks its own installation when started with `ADE_SMOKE_TEST_RESULT=<file>`. Each part reports
 * its checks (the host: database, adapters, a session; the pty process: a real shell; main: the window), the
 * result is written as JSON and the app exits with 0 only when every check passed. Electron-free and pure
 * apart from the callbacks, so it is unit-tested.
 */
export interface SmokeCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type SmokePart = 'host' | 'pty' | 'window';
const PARTS: readonly SmokePart[] = ['host', 'pty', 'window'];

export interface SmokeReport {
  ok: boolean;
  version: string;
  platform: string;
  checks: SmokeCheck[];
}

export class SmokeRun {
  private readonly ready = new Set<SmokePart>();
  private readonly results = new Map<SmokePart, SmokeCheck[]>();
  private requested = false;
  private finished = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly opts: {
      version: string;
      platform: string;
      /** Asks the host and pty processes for their checks once everything is up. */
      request: () => void;
      finish: (report: SmokeReport) => void;
      timeoutMs: number;
    },
  ) {
    this.timer = setTimeout(() => this.complete(true), opts.timeoutMs);
  }

  /** A part started (the process said ready, or the window loaded). */
  markReady(part: SmokePart) {
    this.ready.add(part);
    if (!this.requested && this.ready.has('host') && this.ready.has('pty')) {
      this.requested = true;
      this.opts.request();
    }
  }

  add(part: SmokePart, checks: SmokeCheck[]) {
    if (this.finished) return;
    this.results.set(part, checks);
    if (PARTS.every((p) => this.results.has(p))) this.complete(false);
  }

  private complete(timedOut: boolean) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    const checks = PARTS.flatMap((p) => this.results.get(p) ?? []);
    for (const p of PARTS) {
      if (!this.results.has(p)) checks.push({ name: p, ok: false, detail: timedOut ? `No answer before the time limit (${this.ready.has(p) ? 'started' : 'never started'}).` : 'No answer.' });
    }
    this.opts.finish({ ok: checks.length > 0 && checks.every((c) => c.ok), version: this.opts.version, platform: this.opts.platform, checks });
  }
}
