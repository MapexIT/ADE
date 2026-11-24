import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createApiClient,
  createPublisher,
  createSubscriber,
  defineApi,
  defineTopics,
  emitterPort,
  hostApi,
  LoopSettings,
  method,
  RpcError,
  serveApi,
  SessionEvent,
} from '../src/index.ts';

const api = defineApi({
  add: method(z.object({ a: z.number(), b: z.number() }), z.number()),
  fail: method(z.object({}), z.never()),
});

const channels: MessageChannel[] = [];
function pair() {
  const ch = new MessageChannel();
  channels.push(ch);
  return { a: emitterPort(ch.port1, (e) => e), b: emitterPort(ch.port2, (e) => e) };
}
afterEach(() => {
  for (const ch of channels.splice(0)) {
    ch.port1.close();
    ch.port2.close();
  }
});

describe('rpc', () => {
  it('round-trips a valid request', async () => {
    const { a, b } = pair();
    serveApi(api, { add: ({ a: x, b: y }) => x + y, fail: () => { throw new Error('nope'); } }, a);
    const client = createApiClient(api, b);
    await expect(client.call('add', { a: 2, b: 3 })).resolves.toBe(5);
  });

  it('rejects an invalid payload before it reaches the handler', async () => {
    const { a, b } = pair();
    let called = false;
    serveApi(api, { add: () => { called = true; return 0; }, fail: () => 0 as never }, a);
    const client = createApiClient(api, b);
    const err = await client.call('add', { a: 'x' as unknown as number, b: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe('invalid_payload');
    expect(called).toBe(false);
  });

  it('reports handler errors and unknown methods', async () => {
    const { a, b } = pair();
    serveApi(api, { add: () => 0, fail: () => { throw new Error('boom'); } }, a);
    const client = createApiClient(api, b);
    await expect(client.call('fail', {})).rejects.toMatchObject({ code: 'handler_failed', message: 'boom' });
    const anyClient = client as unknown as { call(m: string, i: unknown): Promise<unknown> };
    await expect(anyClient.call('nope', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('rejects host requests that violate the contract', () => {
    const result = hostApi['sessions.create'].input.safeParse({ workspaceId: 'w', agentId: 'gpt', prompt: [], permissionProfile: 'ask' });
    expect(result.success).toBe(false);
  });

  it('drops invalid topic payloads and delivers valid ones', async () => {
    const { a, b } = pair();
    const topics = defineTopics({ 'session.event': SessionEvent });
    const publish = createPublisher(topics, a);
    const sub = createSubscriber(topics, b);
    const got: unknown[] = [];
    sub.on('session.event', (e) => got.push(e));
    a.postMessage({ kind: 'evt', topic: 'session.event', payload: { type: 'bogus' } });
    publish('session.event', { type: 'notice', sessionId: 's', seq: 1, ts: 'now', level: 'info', text: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
  });
});

describe('WA-10 loop watch contracts', () => {
  it('parses both loop events and gives loop settings their defaults', () => {
    const base = { sessionId: 's', seq: 1, ts: '2026-11-24T10:00:00.000Z' };
    const detected = { ...base, type: 'loop.detected', turnId: 't', pattern: 'repeated-action', subject: 'Read a', count: 4, level: 'warning', detail: null };
    expect(SessionEvent.parse(detected).type).toBe('loop.detected');
    expect(SessionEvent.parse({ ...base, type: 'loop.dismissed', turnId: 't' }).type).toBe('loop.dismissed');
    expect(() => SessionEvent.parse({ ...detected, pattern: 'other' })).toThrow();
    expect(LoopSettings.parse({})).toEqual({ enabled: true, stopTurn: false });
    expect(LoopSettings.parse({ stopTurn: true })).toEqual({ enabled: true, stopTurn: true });
  });
});
