import { z } from 'zod';

/**
 * A tiny typed RPC layer over anything that can post messages (Electron MessagePort, MessagePortMain,
 * Node worker ports, utilityProcess parentPort). Requests are validated with zod on the receiving side,
 * so a malformed payload never reaches a handler (rule 9 in CLAUDE.md).
 */

export interface PortLike {
  postMessage(message: unknown): void;
  /** Subscribe to incoming messages. Returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void;
}

export interface MethodDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  input: I;
  output: O;
}

export type ApiDef = Record<string, MethodDef>;
export type TopicDef = Record<string, z.ZodType>;

export const defineApi = <T extends ApiDef>(api: T): T => api;
export const defineTopics = <T extends TopicDef>(topics: T): T => topics;
export const method = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O): MethodDef<I, O> => ({
  input,
  output,
});

export type InputOf<A extends ApiDef, M extends keyof A> = z.input<A[M]['input']>;
export type ParsedInputOf<A extends ApiDef, M extends keyof A> = z.output<A[M]['input']>;
export type OutputOf<A extends ApiDef, M extends keyof A> = z.output<A[M]['output']>;
export type PayloadOf<T extends TopicDef, K extends keyof T> = z.output<T[K]>;

export type Handlers<A extends ApiDef> = {
  [M in keyof A]: (input: ParsedInputOf<A, M>) => Promise<OutputOf<A, M>> | OutputOf<A, M>;
};

const RequestMessage = z.object({
  kind: z.literal('req'),
  id: z.number().int(),
  method: z.string(),
  params: z.unknown(),
});
const ResponseMessage = z.union([
  z.object({ kind: z.literal('res'), id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({
    kind: z.literal('res'),
    id: z.number().int(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
const EventMessage = z.object({ kind: z.literal('evt'), topic: z.string(), payload: z.unknown() });

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RpcError';
  }
}

/** Serves `api` on `port`. Unknown methods and invalid payloads are answered with an error, never thrown. */
export function serveApi<A extends ApiDef>(api: A, handlers: Handlers<A>, port: PortLike): () => void {
  return port.onMessage(async (raw) => {
    const parsed = RequestMessage.safeParse(raw);
    if (!parsed.success) return;
    const { id, method: name, params } = parsed.data;
    const reply = (msg: z.input<typeof ResponseMessage>) => port.postMessage(msg);
    const def = Object.hasOwn(api, name) ? api[name] : undefined;
    if (!def) {
      reply({ kind: 'res', id, ok: false, error: { code: 'unknown_method', message: `Unknown method ${name}` } });
      return;
    }
    const input = def.input.safeParse(params);
    if (!input.success) {
      reply({
        kind: 'res',
        id,
        ok: false,
        error: { code: 'invalid_payload', message: z.prettifyError(input.error) },
      });
      return;
    }
    try {
      const handler = handlers[name as keyof A] as (i: unknown) => unknown;
      const result = await handler(input.data);
      reply({ kind: 'res', id, ok: true, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : 'handler_failed';
      const message = err instanceof Error ? err.message : String(err);
      reply({ kind: 'res', id, ok: false, error: { code, message } });
    }
  });
}

export interface ApiClient<A extends ApiDef> {
  call<M extends keyof A & string>(name: M, input: InputOf<A, M>): Promise<OutputOf<A, M>>;
  /** Rejects every pending call, for example when the remote process died. */
  dispose(reason?: string): void;
}

export function createApiClient<A extends ApiDef>(_api: A, port: PortLike, timeoutMs = 120_000): ApiClient<A> {
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const off = port.onMessage((raw) => {
    const parsed = ResponseMessage.safeParse(raw);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.id);
    if (!entry) return;
    pending.delete(parsed.data.id);
    clearTimeout(entry.timer);
    if (parsed.data.ok) entry.resolve(parsed.data.result);
    else entry.reject(new RpcError(parsed.data.error.code, parsed.data.error.message));
  });
  return {
    call(name, input) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RpcError('timeout', `${name} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        port.postMessage({ kind: 'req', id, method: name, params: input });
      });
    },
    dispose(reason = 'disconnected') {
      off();
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new RpcError('disconnected', reason));
        pending.delete(id);
      }
    },
  };
}

/** Publisher side of a topic stream. Payloads are validated before they leave the process. */
export function createPublisher<T extends TopicDef>(topics: T, port: PortLike) {
  return <K extends keyof T & string>(topic: K, payload: PayloadOf<T, K>): void => {
    const checked = topics[topic]!.parse(payload);
    port.postMessage({ kind: 'evt', topic, payload: checked });
  };
}

/** Subscriber side of a topic stream (Observer). Invalid payloads are dropped. */
export function createSubscriber<T extends TopicDef>(topics: T, port: PortLike) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const off = port.onMessage((raw) => {
    const parsed = EventMessage.safeParse(raw);
    if (!parsed.success) return;
    const schema = Object.hasOwn(topics, parsed.data.topic) ? topics[parsed.data.topic] : undefined;
    if (!schema) return;
    const payload = schema.safeParse(parsed.data.payload);
    if (!payload.success) return;
    for (const listener of listeners.get(parsed.data.topic) ?? []) listener(payload.data);
  });
  return {
    on<K extends keyof T & string>(topic: K, listener: (payload: PayloadOf<T, K>) => void): () => void {
      const set = listeners.get(topic) ?? new Set();
      set.add(listener as (payload: unknown) => void);
      listeners.set(topic, set);
      return () => set.delete(listener as (payload: unknown) => void);
    },
    dispose: off,
  };
}

/** Adapts a DOM / Node `MessagePort`-style object that uses `addEventListener('message')`. */
export function domPort(port: {
  postMessage(m: unknown): void;
  addEventListener(type: 'message', l: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', l: (e: { data: unknown }) => void): void;
  start?(): void;
}): PortLike {
  port.start?.();
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage(handler) {
      const l = (e: { data: unknown }) => handler(e.data);
      port.addEventListener('message', l);
      return () => port.removeEventListener('message', l);
    },
  };
}

/** Adapts an emitter-style port (`on('message')`), such as Electron's MessagePortMain or parentPort. */
export function emitterPort(
  port: {
    postMessage(m: unknown): void;
    on(type: 'message', l: (e: unknown) => void): unknown;
    off?(type: 'message', l: (e: unknown) => void): unknown;
    removeListener?(type: 'message', l: (e: unknown) => void): unknown;
    start?(): void;
  },
  unwrap: (e: unknown) => unknown = (e) => (e as { data: unknown }).data,
): PortLike {
  port.start?.();
  return {
    postMessage: (m) => port.postMessage(m),
    onMessage(handler) {
      const l = (e: unknown) => handler(unwrap(e));
      port.on('message', l);
      return () => {
        if (port.off) port.off('message', l);
        else port.removeListener?.('message', l);
      };
    },
  };
}
