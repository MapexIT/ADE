import type { DistributiveOmit, NewSessionEvent, SessionEvent } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { applyEvent, ChunkCoalescer, emptyView, projectSession } from '../src/index.ts';

let seq = 0;
const ev = (e: DistributiveOmit<NewSessionEvent, 'sessionId'>): SessionEvent =>
  ({ sessionId: 's1', seq: seq++, ts: '2026-01-01T00:00:00Z', ...e }) as SessionEvent;

describe('agent commands (TM-04)', () => {
  it('grows output live and takes the stored tail when the command exits', () => {
    seq = 0;
    let v = applyEvent(emptyView(), ev({ type: 'command.started', terminalId: 'x', command: 'npm test', cwd: '/w' }));
    // Transient chunks reuse the last stored seq and must still apply.
    v = applyEvent(v, { sessionId: 's1', seq: 0, ts: '', type: 'command.output', terminalId: 'x', chunk: 'one\n' });
    v = applyEvent(v, { sessionId: 's1', seq: 0, ts: '', type: 'command.output', terminalId: 'x', chunk: 'two\n' });
    expect(v.items[0]).toMatchObject({ kind: 'command', running: true, output: 'one\ntwo\n' });
    v = applyEvent(v, ev({ type: 'command.exited', terminalId: 'x', exitCode: 1, signal: null, output: 'one\ntwo\nfailed\n', truncated: false, killed: false }));
    expect(v.items[0]).toMatchObject({ running: false, exitCode: 1, output: 'one\ntwo\nfailed\n' });
    // A late chunk after the exit changes nothing.
    v = applyEvent(v, { sessionId: 's1', seq: 1, ts: '', type: 'command.output', terminalId: 'x', chunk: 'late' });
    expect(v.items[0]).toMatchObject({ output: 'one\ntwo\nfailed\n' });
  });
});

describe('projectSession', () => {
  it('rebuilds a timeline from stored events', () => {
    seq = 0;
    const events = [
      ev({ type: 'user.message', content: [{ type: 'text', text: 'hi' }], queued: false }),
      ev({ type: 'turn.started', turnId: 't1', index: 0 }),
      ev({ type: 'tool.call', toolCallId: 'c1', title: 'Read a.ts', kind: 'read', status: 'pending', content: [], locations: ['a.ts'] }),
      ev({ type: 'tool.update', toolCallId: 'c1', title: null, status: 'completed', content: null }),
      ev({
        type: 'permission.requested',
        requestId: 'p1',
        toolCallId: 'c2',
        title: 'Run tests',
        kind: 'execute',
        detail: 'npm test',
        options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
      }),
      ev({ type: 'permission.decided', requestId: 'p1', decision: { outcome: 'selected', optionId: 'a' }, decidedBy: 'user', note: null }),
      ev({ type: 'agent.message', messageId: 'm1', text: 'Done.' }),
      ev({ type: 'plan.updated', entries: [{ content: 'Step', priority: 'high', status: 'completed' }] }),
      ev({ type: 'turn.ended', turnId: 't1', stopReason: 'end_turn', usage: null }),
    ];
    const view = projectSession(events);
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'turn', 'tool-call', 'permission', 'agent-message']);
    const tool = view.items[2];
    expect(tool?.kind === 'tool-call' && tool.status).toBe('completed');
    expect(view.pendingPermissions).toEqual([]);
    expect(view.plan).toHaveLength(1);
    expect(view.turnCount).toBe(1);
    expect(view.activeTurnId).toBeNull();
  });

  it('appends streamed chunks to the last item and finalises them', () => {
    seq = 0;
    let v = emptyView();
    v = applyEvent(v, ev({ type: 'turn.started', turnId: 't1', index: 0 }));
    v = applyEvent(v, { sessionId: 's1', seq: 0, ts: '', type: 'agent.message.chunk', messageId: 'm1', text: 'Hel' });
    v = applyEvent(v, { sessionId: 's1', seq: 0, ts: '', type: 'agent.message.chunk', messageId: 'm1', text: 'lo' });
    expect(v.items.at(-1)).toMatchObject({ kind: 'agent-message', text: 'Hello', streaming: true });
    v = applyEvent(v, ev({ type: 'agent.message', messageId: 'm1', text: 'Hello' }));
    expect(v.items).toHaveLength(2);
    expect(v.items.at(-1)).toMatchObject({ text: 'Hello', streaming: false });
  });

  it('ignores events it has already applied', () => {
    seq = 0;
    const e = ev({ type: 'notice', level: 'info', text: 'x' });
    const v = applyEvent(applyEvent(emptyView(), e), e);
    expect(v.items).toHaveLength(1);
  });
});

describe('ChunkCoalescer', () => {
  it('joins chunks per message in order', () => {
    const c = new ChunkCoalescer();
    c.push('thought', 't', 'think ');
    c.push('message', 'm', 'a');
    c.push('thought', 't', 'more');
    c.push('message', 'm', 'b');
    expect(c.flushExcept('m')).toEqual([{ kind: 'thought', messageId: 't', text: 'think more' }]);
    expect(c.flush()).toEqual([{ kind: 'message', messageId: 'm', text: 'ab' }]);
    expect(c.size).toBe(0);
  });
});
