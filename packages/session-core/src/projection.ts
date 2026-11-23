import { TRANSIENT_EVENTS } from '@ade/contracts';
import type {
  AvailableCommand,
  PermissionDecision,
  PermissionOption,
  PlanEntry,
  PromptBlock,
  ReasoningMethod,
  SessionEvent,
  SessionMode,
  ToolContent,
  ToolKind,
  ToolStatus,
  Usage,
} from '@ade/contracts';

export type TimelineItem =
  | { kind: 'user'; key: string; content: PromptBlock[] }
  | { kind: 'agent-message'; key: string; messageId: string; text: string; streaming: boolean }
  | { kind: 'agent-thought'; key: string; messageId: string; text: string; streaming: boolean }
  | {
      kind: 'tool-call';
      key: string;
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolStatus;
      content: ToolContent[];
      locations: string[];
    }
  | {
      kind: 'permission';
      key: string;
      requestId: string;
      title: string;
      detail: string | null;
      toolKind: ToolKind | null;
      options: PermissionOption[];
      decision: PermissionDecision | null;
      decidedBy: string | null;
      note: string | null;
    }
  | { kind: 'turn'; key: string; turnId: string; index: number; stopReason: string | null }
  | { kind: 'notice'; key: string; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'screenshot'; key: string; url: string; file: string }
  /** GN-01: a reasoning run before a turn, with its graph of steps. */
  | {
      kind: 'reasoning';
      key: string;
      runId: string;
      method: ReasoningMethod;
      plannedCalls: number;
      steps: ReasoningStepView[];
      outcome: 'sent' | 'cancelled' | 'failed' | null;
      approach: string | null;
      calls: number;
    }
  /** TM-04: a command the agent runs through ADE; `output` grows live until it exits. */
  | {
      kind: 'command';
      key: string;
      terminalId: string;
      command: string;
      cwd: string;
      output: string;
      truncated: boolean;
      running: boolean;
      exitCode: number | null;
      signal: string | null;
      killed: boolean;
    };

export interface ReasoningStepView {
  stepId: string;
  phase: string;
  label: string;
  parents: string[];
  status: 'running' | 'done' | 'failed';
  score: number | null;
  detail: string | null;
}

/** Live output kept per command in the view; the stored tail replaces it when the command exits. */
export const COMMAND_OUTPUT_LIMIT = 200_000;

export interface SessionView {
  items: TimelineItem[];
  plan: PlanEntry[];
  commands: AvailableCommand[];
  modeId: string | null;
  modes: SessionMode[];
  turnCount: number;
  activeTurnId: string | null;
  pendingPermissions: string[];
  usage: Usage | null;
  /** GN-01: the reasoning run in progress, if any. */
  reasoningRunId: string | null;
  lastSeq: number;
}

export const emptyView = (): SessionView => ({
  items: [],
  plan: [],
  commands: [],
  modeId: null,
  modes: [],
  turnCount: 0,
  activeTurnId: null,
  pendingPermissions: [],
  usage: null,
  reasoningRunId: null,
  lastSeq: -1,
});

function replaceWhere(items: TimelineItem[], pred: (i: TimelineItem) => boolean, map: (i: TimelineItem) => TimelineItem) {
  // Search from the end: updates almost always target recent items.
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i]!)) {
      const copy = items.slice();
      copy[i] = map(items[i]!);
      return copy;
    }
  }
  return null;
}

function upsertText(
  items: TimelineItem[],
  kind: 'agent-message' | 'agent-thought',
  messageId: string,
  text: string,
  mode: 'append' | 'final',
): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind && last.messageId === messageId) {
    const copy = items.slice();
    copy[copy.length - 1] = { ...last, text: mode === 'append' ? last.text + text : text, streaming: mode === 'append' };
    return copy;
  }
  const updated = replaceWhere(
    items,
    (i) => i.kind === kind && i.messageId === messageId,
    (i) => ({ ...(i as Extract<TimelineItem, { kind: typeof kind }>), text: mode === 'append' ? (i as { text: string }).text + text : text, streaming: mode === 'append' }),
  );
  if (updated) return updated;
  return [...items, { kind, key: `${kind}:${messageId}`, messageId, text, streaming: mode === 'append' }];
}

/**
 * Reducer from session events to the view the UI renders. Pure and incremental: the UI calls it for every
 * live event, and on start-up folds the stored events through it to rebuild the timeline (WA-01).
 */
export function applyEvent(view: SessionView, event: SessionEvent): SessionView {
  const transient = TRANSIENT_EVENTS.has(event.type);
  if (!transient && event.seq <= view.lastSeq) return view; // already applied
  const v: SessionView = { ...view, lastSeq: transient ? view.lastSeq : event.seq };
  switch (event.type) {
    case 'user.message':
      v.items = [...v.items, { kind: 'user', key: `user:${event.seq}`, content: event.content }];
      return v;
    case 'turn.started':
      v.turnCount = Math.max(v.turnCount, event.index + 1);
      v.activeTurnId = event.turnId;
      v.items = [...v.items, { kind: 'turn', key: `turn:${event.turnId}`, turnId: event.turnId, index: event.index, stopReason: null }];
      return v;
    case 'turn.ended': {
      v.activeTurnId = null;
      if (event.usage) v.usage = event.usage;
      const updated = replaceWhere(
        v.items,
        (i) => i.kind === 'turn' && i.turnId === event.turnId,
        (i) => ({ ...(i as Extract<TimelineItem, { kind: 'turn' }>), stopReason: event.stopReason }),
      );
      v.items = (updated ?? v.items).map((i) =>
        (i.kind === 'agent-message' || i.kind === 'agent-thought') && i.streaming ? { ...i, streaming: false } : i,
      );
      return v;
    }
    case 'agent.message.chunk':
      v.items = upsertText(v.items, 'agent-message', event.messageId, event.text, 'append');
      return v;
    case 'agent.thought.chunk':
      v.items = upsertText(v.items, 'agent-thought', event.messageId, event.text, 'append');
      return v;
    case 'agent.message':
      v.items = upsertText(v.items, 'agent-message', event.messageId, event.text, 'final');
      return v;
    case 'agent.thought':
      v.items = upsertText(v.items, 'agent-thought', event.messageId, event.text, 'final');
      return v;
    case 'tool.call': {
      const item: TimelineItem = {
        kind: 'tool-call',
        key: `tool:${event.toolCallId}`,
        toolCallId: event.toolCallId,
        title: event.title,
        toolKind: event.kind,
        status: event.status,
        content: event.content,
        locations: event.locations,
      };
      const updated = replaceWhere(v.items, (i) => i.kind === 'tool-call' && i.toolCallId === event.toolCallId, () => item);
      v.items = updated ?? [...v.items, item];
      return v;
    }
    case 'tool.update': {
      const updated = replaceWhere(
        v.items,
        (i) => i.kind === 'tool-call' && i.toolCallId === event.toolCallId,
        (i) => {
          const t = i as Extract<TimelineItem, { kind: 'tool-call' }>;
          return {
            ...t,
            title: event.title ?? t.title,
            status: event.status ?? t.status,
            content: event.content ?? t.content,
          };
        },
      );
      if (updated) v.items = updated;
      return v;
    }
    case 'plan.updated':
      v.plan = event.entries;
      return v;
    case 'command.started': {
      const item: TimelineItem = {
        kind: 'command',
        key: `cmd:${event.terminalId}`,
        terminalId: event.terminalId,
        command: event.command,
        cwd: event.cwd,
        output: '',
        truncated: false,
        running: true,
        exitCode: null,
        signal: null,
        killed: false,
      };
      v.items = replaceWhere(v.items, (i) => i.kind === 'command' && i.terminalId === event.terminalId, () => item) ?? [...v.items, item];
      return v;
    }
    case 'command.output': {
      const updated = replaceWhere(
        v.items,
        (i) => i.kind === 'command' && i.terminalId === event.terminalId,
        (i) => {
          const c = i as Extract<TimelineItem, { kind: 'command' }>;
          if (!c.running) return c;
          const output = c.output + event.chunk;
          const over = output.length > COMMAND_OUTPUT_LIMIT;
          return { ...c, output: over ? output.slice(output.length - COMMAND_OUTPUT_LIMIT) : output, truncated: c.truncated || over };
        },
      );
      if (updated) v.items = updated;
      return v;
    }
    case 'command.exited': {
      const updated = replaceWhere(
        v.items,
        (i) => i.kind === 'command' && i.terminalId === event.terminalId,
        (i) => ({
          ...(i as Extract<TimelineItem, { kind: 'command' }>),
          output: event.output,
          truncated: event.truncated,
          running: false,
          exitCode: event.exitCode,
          signal: event.signal,
          killed: event.killed,
        }),
      );
      if (updated) v.items = updated;
      return v;
    }
    case 'permission.requested':
      v.pendingPermissions = [...v.pendingPermissions, event.requestId];
      v.items = [
        ...v.items,
        {
          kind: 'permission',
          key: `perm:${event.requestId}`,
          requestId: event.requestId,
          title: event.title,
          detail: event.detail,
          toolKind: event.kind,
          options: event.options,
          decision: null,
          decidedBy: null,
          note: null,
        },
      ];
      return v;
    case 'permission.decided': {
      v.pendingPermissions = v.pendingPermissions.filter((id) => id !== event.requestId);
      const updated = replaceWhere(
        v.items,
        (i) => i.kind === 'permission' && i.requestId === event.requestId,
        (i) => ({ ...(i as Extract<TimelineItem, { kind: 'permission' }>), decision: event.decision, decidedBy: event.decidedBy, note: event.note }),
      );
      if (updated) v.items = updated;
      return v;
    }
    case 'commands.available':
      v.commands = event.commands;
      return v;
    case 'mode.changed':
      v.modeId = event.modeId;
      if (event.available) v.modes = event.available;
      return v;
    case 'notice':
      v.items = [...v.items, { kind: 'notice', key: `notice:${event.seq}`, level: event.level, text: event.text }];
      return v;
    case 'preview.screenshot':
      v.items = [...v.items, { kind: 'screenshot', key: `shot:${event.seq}`, url: event.url, file: event.file }];
      return v;
    case 'reasoning.started':
      v.reasoningRunId = event.runId;
      v.items = [
        ...v.items,
        { kind: 'reasoning', key: `reasoning:${event.runId}`, runId: event.runId, method: event.method, plannedCalls: event.plannedCalls, steps: [], outcome: null, approach: null, calls: 0 },
      ];
      return v;
    case 'reasoning.step': {
      const { stepId, phase, label, parents, status, score, detail } = event;
      const step: ReasoningStepView = { stepId, phase, label, parents, status, score, detail };
      v.items =
        replaceWhere(
          v.items,
          (i) => i.kind === 'reasoning' && i.runId === event.runId,
          (i) => {
            const r = i as Extract<TimelineItem, { kind: 'reasoning' }>;
            const at = r.steps.findIndex((x) => x.stepId === stepId);
            const steps = at === -1 ? [...r.steps, step] : r.steps.map((x, n) => (n === at ? step : x));
            return { ...r, steps, calls: steps.filter((x) => x.phase !== 'select' && x.phase !== 'resample').length };
          },
        ) ?? v.items;
      return v;
    }
    case 'reasoning.finished':
      if (v.reasoningRunId === event.runId) v.reasoningRunId = null;
      v.items =
        replaceWhere(
          v.items,
          (i) => i.kind === 'reasoning' && i.runId === event.runId,
          (i) => ({ ...(i as Extract<TimelineItem, { kind: 'reasoning' }>), outcome: event.outcome, approach: event.approach, calls: event.calls }),
        ) ?? v.items;
      return v;
    case 'checkpoint.created':
    case 'session.state_changed':
    case 'session.landed':
    case 'session.discarded':
    case 'run.finished':
      return v;
  }
}

export const projectSession = (events: readonly SessionEvent[]): SessionView => events.reduce(applyEvent, emptyView());
