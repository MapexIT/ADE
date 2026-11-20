import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  agent,
  RequestError,
  type AgentContext,
  type ContentBlock,
  type PermissionOption,
  type SessionNotification,
  type SessionUpdate,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk';
import { parseScript, type Step } from './script.ts';

interface FakeSession {
  id: string;
  cwd: string;
  modeId: string;
  modelId: string;
  history: SessionUpdate[];
  cancel: (() => void) | null;
  cancelled: boolean;
}

const MODES = [
  { id: 'build', name: 'Build', description: 'Make changes' },
  { id: 'plan', name: 'Plan', description: 'Read only, propose a plan' },
];

const MODELS = [
  { value: 'fake-small', name: 'Fake small' },
  { value: 'fake-large', name: 'Fake large' },
];
const modelOption = (current: string) => [{ id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const, currentValue: current, options: MODELS }];

const COMMANDS = [
  { name: 'review', description: 'Review the current changes' },
  { name: 'test', description: 'Run the tests' },
];

export interface FakeAgentOptions {
  /** Folder for persisted transcripts so `session/load` works across processes. */
  stateDir?: string;
  /** Delay between streamed chunks, in milliseconds. */
  chunkDelayMs?: number;
}

const promptText = (blocks: ContentBlock[]) =>
  blocks
    .map((b) => (b.type === 'text' ? b.text : b.type === 'resource' && 'text' in b.resource ? b.resource.text : ''))
    .join('\n');

/** Builds the fake ACP agent app. Connect it to a stream (stdio) or directly to a client app in tests. */
export function createFakeAgent(options: FakeAgentOptions = {}) {
  const sessions = new Map<string, FakeSession>();
  const chunkDelay = options.chunkDelayMs ?? 1;
  const transcriptPath = (id: string) => (options.stateDir ? join(options.stateDir, `${id}.json`) : null);

  const persist = (s: FakeSession) => {
    const p = transcriptPath(s.id);
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ cwd: s.cwd, modeId: s.modeId, history: s.history }));
  };

  const send = async (client: AgentContext, s: FakeSession, update: SessionUpdate) => {
    s.history.push(update);
    const params: SessionNotification = { sessionId: s.id, update };
    await client.notify('session/update', params);
  };

  const sleep = (s: FakeSession, ms: number) =>
    new Promise<void>((done) => {
      const t = setTimeout(done, ms);
      s.cancel = () => {
        clearTimeout(t);
        done();
      };
    });

  const inside = (s: FakeSession, p: string) => {
    const full = isAbsolute(p) ? p : resolve(s.cwd, p);
    const rel = relative(s.cwd, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new RequestError(-32602, `Path outside the session: ${p}`);
    return full;
  };

  async function stream(client: AgentContext, s: FakeSession, kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string) {
    const messageId = randomUUID();
    const parts = text.match(/.{1,8}/gs) ?? [text];
    for (const part of parts) {
      if (s.cancelled) return;
      await send(client, s, { sessionUpdate: kind, messageId, content: { type: 'text', text: part } });
      if (chunkDelay) await sleep(s, chunkDelay);
    }
  }

  async function run(client: AgentContext, s: FakeSession, steps: Step[]): Promise<StopReason> {
    if (steps.length === 0) steps = parseScript('say Hello from the fake agent.');
    for (const step of steps) {
      if (s.cancelled) return 'cancelled';
      switch (step.op) {
        case 'say':
          await stream(client, s, 'agent_message_chunk', step.text);
          break;
        case 'whichmodel':
          await stream(client, s, 'agent_message_chunk', `Model: ${s.modelId}`);
          break;
        case 'think':
          await stream(client, s, 'agent_thought_chunk', step.text);
          break;
        case 'read': {
          const toolCallId = randomUUID();
          await send(client, s, { sessionUpdate: 'tool_call', toolCallId, title: `Read ${step.path}`, kind: 'read', status: 'pending', locations: [{ path: step.path }] });
          await send(client, s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
          break;
        }
        case 'edit': {
          const toolCallId = randomUUID();
          const full = inside(s, step.path);
          const oldText = existsSync(full) ? readFileSync(full, 'utf8') : null;
          await send(client, s, { sessionUpdate: 'tool_call', toolCallId, title: `Edit ${step.path}`, kind: 'edit', status: 'in_progress', locations: [{ path: step.path }] });
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, step.content);
          await send(client, s, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'completed',
            content: [{ type: 'diff', path: step.path, oldText, newText: step.content }],
          });
          break;
        }
        case 'delete': {
          const toolCallId = randomUUID();
          rmSync(inside(s, step.path), { force: true });
          await send(client, s, { sessionUpdate: 'tool_call', toolCallId, title: `Delete ${step.path}`, kind: 'delete', status: 'completed', locations: [{ path: step.path }] });
          break;
        }
        case 'ask': {
          const toolCallId = randomUUID();
          await send(client, s, {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: `Run ${step.command}`,
            kind: 'execute',
            status: 'pending',
            rawInput: { command: step.command },
          });
          const res = await client.request('session/request_permission', {
            sessionId: s.id,
            toolCall: { toolCallId, title: `Run ${step.command}`, kind: 'execute', rawInput: { command: step.command } },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow-always', name: 'Allow for this session', kind: 'allow_always' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          });
          if (res.outcome.outcome === 'cancelled') return 'cancelled';
          const allowed = res.outcome.optionId.startsWith('allow');
          await send(client, s, {
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: allowed ? 'completed' : 'failed',
            content: [{ type: 'content', content: { type: 'text', text: allowed ? `$ ${step.command}\nok` : 'Rejected by the user' } }],
          });
          break;
        }
        case 'question': {
          const toolCallId = randomUUID();
          const res = await client.request('session/request_permission', {
            sessionId: s.id,
            toolCall: { toolCallId, title: step.text, kind: 'think' },
            options: step.answers.map((a, i): PermissionOption => ({ optionId: `answer-${i}`, name: a, kind: 'allow_once' })),
          });
          if (res.outcome.outcome === 'cancelled') return 'cancelled';
          const picked = step.answers[Number(res.outcome.optionId.split('-')[1])] ?? 'unknown';
          await stream(client, s, 'agent_message_chunk', `You chose ${picked}. `);
          break;
        }
        case 'plan':
          await send(client, s, {
            sessionUpdate: 'plan',
            entries: step.entries.map((content, i) => ({ content, priority: 'medium', status: i === 0 ? 'in_progress' : 'pending' })),
          });
          break;
        case 'fail':
          throw new RequestError(-32603, step.message);
        case 'hang':
          await new Promise<void>((done) => {
            s.cancel = done;
          });
          return 'cancelled';
        case 'sleep':
          await sleep(s, step.ms);
          break;
        case 'env':
          await stream(client, s, 'agent_message_chunk', `${step.name} is ${process.env[step.name] === undefined ? 'absent' : 'present'}.`);
          break;
        case 'usage':
          await send(client, s, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
          break;
        case 'mode':
          s.modeId = step.id;
          await send(client, s, { sessionUpdate: 'current_mode_update', currentModeId: step.id });
          break;
      }
    }
    return s.cancelled ? 'cancelled' : 'end_turn';
  }

  return agent({ name: 'ade-fake-agent' })
    .onRequest('initialize', ({ params }) => ({
      protocolVersion: Math.min(params.protocolVersion, 1),
      agentCapabilities: {
        loadSession: Boolean(options.stateDir),
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: { name: 'ade-fake-agent', title: 'Fake agent', version: '0.1.0' },
    }))
    .onRequest('authenticate', () => ({}))
    .onRequest('session/new', async ({ params, client }) => {
      const s: FakeSession = { id: randomUUID(), cwd: params.cwd, modeId: 'build', modelId: 'fake-small', history: [], cancel: null, cancelled: false };
      sessions.set(s.id, s);
      setTimeout(() => {
        void client.notify('session/update', {
          sessionId: s.id,
          update: { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS },
        });
      }, 0);
      return { sessionId: s.id, modes: { currentModeId: s.modeId, availableModes: MODES }, configOptions: modelOption(s.modelId) };
    })
    .onRequest('session/load', async ({ params, client }) => {
      const p = transcriptPath(params.sessionId);
      if (!p || !existsSync(p)) throw new RequestError(-32002, `Unknown session ${params.sessionId}`);
      const saved = JSON.parse(readFileSync(p, 'utf8')) as { cwd: string; modeId: string; history: SessionUpdate[] };
      const s: FakeSession = { id: params.sessionId, cwd: params.cwd, modeId: saved.modeId, modelId: 'fake-small', history: [], cancel: null, cancelled: false };
      sessions.set(s.id, s);
      for (const update of saved.history) await send(client, s, update);
      return { modes: { currentModeId: s.modeId, availableModes: MODES }, configOptions: modelOption(s.modelId) };
    })
    .onRequest('session/set_mode', async ({ params, client }) => {
      const s = sessions.get(params.sessionId);
      if (!s) throw new RequestError(-32002, 'Unknown session');
      if (!MODES.some((m) => m.id === params.modeId)) throw new RequestError(-32602, 'Unknown mode');
      s.modeId = params.modeId;
      await send(client, s, { sessionUpdate: 'current_mode_update', currentModeId: s.modeId });
      return {};
    })
    .onRequest('session/set_config_option', async ({ params }) => {
      const s = sessions.get(params.sessionId);
      if (!s) throw new RequestError(-32002, 'Unknown session');
      if (params.configId !== 'model' || !MODELS.some((m) => m.value === params.value)) throw new RequestError(-32602, 'Unknown option value');
      s.modelId = String(params.value);
      return { configOptions: modelOption(s.modelId) };
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const s = sessions.get(params.sessionId);
      if (!s) throw new RequestError(-32002, 'Unknown session');
      s.cancelled = false;
      for (const block of params.prompt) s.history.push({ sessionUpdate: 'user_message_chunk', content: block });
      try {
        const stopReason = await run(client, s, parseScript(promptText(params.prompt)));
        return { stopReason };
      } finally {
        s.cancel = null;
        persist(s);
      }
    })
    .onNotification('session/cancel', ({ params }) => {
      const s = sessions.get(params.sessionId);
      if (!s) return;
      s.cancelled = true;
      s.cancel?.();
    });
}

export function serveStdio(stream: Stream, options?: FakeAgentOptions) {
  return createFakeAgent(options).connect(stream);
}
