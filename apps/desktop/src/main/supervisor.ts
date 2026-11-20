import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';

export type ProcessName = 'host' | 'pty';
export type ProcessStatus = 'up' | 'restarting' | 'down';

interface Options {
  name: ProcessName;
  entry: string;
  env: Record<string, string>;
  onStatus: (status: ProcessStatus) => void;
  onMessage?: (message: unknown) => void;
  onReady?: () => void;
}

/**
 * Supervises one utility process (M1-T02). When it dies, it is restarted with backoff and every attached
 * renderer gets a fresh MessagePort, so the UI reconnects without a reload.
 */
export class ProcessSupervisor {
  private child: UtilityProcess | null = null;
  private readonly renderers = new Set<WebContents>();
  private restarts: number[] = [];
  private stopping = false;

  constructor(private readonly opts: Options) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    this.stopping = false;
    const child = utilityProcess.fork(this.opts.entry, [], {
      serviceName: `ADE ${this.opts.name}`,
      env: { ...process.env, ...this.opts.env } as Record<string, string>,
      stdio: 'inherit',
    });
    this.child = child;
    child.on('message', (msg: unknown) => {
      if ((msg as { type?: string })?.type === 'ready') {
        this.opts.onReady?.();
        this.opts.onStatus('up');
        for (const wc of this.renderers) this.connect(wc);
      } else this.opts.onMessage?.(msg);
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopping) {
        this.opts.onStatus('down');
        return;
      }
      console.error(`[main] ${this.opts.name} process exited with code ${code}; restarting`);
      this.opts.onStatus('restarting');
      const now = Date.now();
      this.restarts = [...this.restarts.filter((t) => now - t < 60_000), now];
      const delay = Math.min(10_000, 200 * 2 ** (this.restarts.length - 1));
      setTimeout(() => this.start(), delay);
    });
  }

  /** Gives `wc` a direct port to the process. Called on attach and again after every restart. */
  private connect(wc: WebContents): void {
    if (!this.child || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: 'renderer-port' }, [port1]);
    wc.postMessage('ade:port', { name: this.opts.name }, [port2]);
  }

  attach(wc: WebContents): void {
    this.renderers.add(wc);
    wc.once('destroyed', () => this.renderers.delete(wc));
    this.connect(wc);
  }

  /** Sends a message to the process over its parent port (main-only data such as decrypted tokens). */
  post(message: unknown): void {
    this.child?.postMessage(message);
  }

  /** Kills the process on purpose (used by "restart" and by tests of the reconnect path). */
  restart(): void {
    this.child?.kill();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: 'shutdown' });
    });
  }
}
