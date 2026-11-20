import {
  createApiClient,
  createSubscriber,
  domPort,
  hostApi,
  hostTopics,
  type mainApi,
  mainTopics,
  ptyApi,
  ptyTopics,
  type ApiDef,
  type InputOf,
  type OutputOf,
  type PayloadOf,
  type TopicDef,
} from '@ade/contracts';

interface AdeBridge {
  main(method: string, input: unknown): Promise<unknown>;
  onMainEvent(listener: (event: { topic: string; payload: unknown }) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    ade: AdeBridge;
  }
}

type ConnectionListener = (connected: boolean) => void;

/**
 * A reconnecting connection to one utility process (host or pty). Each restart delivers a new MessagePort;
 * calls wait for a port, and topic listeners survive reconnects (Proxy + Observer).
 */
class ProcessConnection<A extends ApiDef, T extends TopicDef> {
  private client: ReturnType<typeof createApiClient<A>> | null = null;
  private subscriber: ReturnType<typeof createSubscriber<T>> | null = null;
  private waiters: (() => void)[] = [];
  private readonly listeners = new Map<string, Set<(p: unknown) => void>>();
  private readonly offs: (() => void)[] = [];
  private readonly connectionListeners = new Set<ConnectionListener>();
  connected = false;

  constructor(
    readonly name: 'host' | 'pty',
    private readonly api: A,
    private readonly topics: T,
  ) {}

  attach(port: MessagePort) {
    this.client?.dispose('reconnected');
    this.subscriber?.dispose();
    for (const off of this.offs.splice(0)) off();
    const p = domPort(port);
    this.client = createApiClient(this.api, p);
    this.subscriber = createSubscriber(this.topics, p);
    for (const [topic, set] of this.listeners) {
      this.offs.push(this.subscriber.on(topic as keyof T & string, (payload) => set.forEach((l) => l(payload))));
    }
    this.setConnected(true);
    for (const w of this.waiters.splice(0)) w();
  }

  setConnected(v: boolean) {
    this.connected = v;
    for (const l of this.connectionListeners) l(v);
  }

  onConnection(l: ConnectionListener) {
    this.connectionListeners.add(l);
    return () => {
      this.connectionListeners.delete(l);
    };
  }

  private ready(): Promise<void> {
    if (this.client) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  async call<M extends keyof A & string>(method: M, input: InputOf<A, M>): Promise<OutputOf<A, M>> {
    await this.ready();
    return this.client!.call(method, input);
  }

  on<K extends keyof T & string>(topic: K, listener: (payload: PayloadOf<T, K>) => void): () => void {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(listener as (p: unknown) => void);
    this.listeners.set(topic, set);
    if (this.subscriber && set.size === 1) {
      this.offs.push(this.subscriber.on(topic, (payload) => set.forEach((l) => l(payload))));
    }
    return () => {
      set.delete(listener as (p: unknown) => void);
    };
  }
}

export const host = new ProcessConnection('host', hostApi, hostTopics);
export const pty = new ProcessConnection('pty', ptyApi, ptyTopics);

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; name?: string } | null;
  if (event.source !== window || data?.type !== 'ade-port' || !event.ports[0]) return;
  if (data.name === 'host') host.attach(event.ports[0]);
  if (data.name === 'pty') pty.attach(event.ports[0]);
});

/** Calls into main. Inputs are validated again in main with the same schemas. */
export function main<M extends keyof typeof mainApi & string>(method: M, input: InputOf<typeof mainApi, M>): Promise<OutputOf<typeof mainApi, M>> {
  return window.ade.main(method, input) as Promise<OutputOf<typeof mainApi, M>>;
}

export function onMain<K extends keyof typeof mainTopics & string>(topic: K, listener: (payload: PayloadOf<typeof mainTopics, K>) => void) {
  return window.ade.onMainEvent((e) => {
    if (e.topic !== topic) return;
    const parsed = mainTopics[topic].safeParse(e.payload);
    if (parsed.success) listener(parsed.data as PayloadOf<typeof mainTopics, K>);
  });
}

onMain('process.status', ({ which, status }) => {
  const conn = which === 'host' ? host : pty;
  if (status !== 'up') conn.setConnected(false);
});

export const platform = () => window.ade?.platform ?? 'linux';
