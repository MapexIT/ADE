import type { PermissionRule, SessionEvent, ToolKind } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import {
  agentsText,
  CAVEAT_TEXT,
  evidenceCount,
  evidenceText,
  foldDecisions,
  heldBackText,
  hintText,
  rehearsalText,
  rehearse,
  RISK_WORDS,
  suggest,
  UNUSED_TEXT,
  unseenText,
  usage,
  usageText,
  type Decided,
} from '../src/rule-advice.ts';

const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'allow-always', name: 'Allow for this session', kind: 'allow_always' as const },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' as const },
];

let seq = 0;
let clock = Date.parse('2026-11-01T10:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();

/** Events for one request and its decision. */
function pair(command: string, optionId: string | null, decidedBy = 'user', opts: { sessionId?: string; kind?: ToolKind | null } = {}): SessionEvent[] {
  const sessionId = opts.sessionId ?? 's1';
  const requestId = `r${++seq}`;
  const requested: SessionEvent = {
    sessionId,
    seq: seq * 2,
    ts: tick(),
    type: 'permission.requested',
    requestId,
    toolCallId: `t${seq}`,
    title: `Run ${command}`,
    kind: opts.kind === undefined ? 'execute' : opts.kind,
    detail: command,
    options: OPTIONS,
  };
  const decided: SessionEvent = {
    sessionId,
    seq: seq * 2 + 1,
    ts: tick(),
    type: 'permission.decided',
    requestId,
    decision: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' },
    decidedBy,
    note: null,
  };
  return [requested, decided];
}

const META: Record<string, { title: string; agentId: string }> = {
  s1: { title: 'First task', agentId: 'claude-code' },
  s2: { title: 'Second task', agentId: 'codex' },
  s3: { title: 'Third task', agentId: 'opencode' },
};
const meta = (id: string) => META[id] ?? null;
const history = (...events: SessionEvent[][]): Decided[] => foldDecisions(events.flat(), meta);
const allow = (c: string, s = 's1') => pair(c, 'allow-once', 'user', { sessionId: s });
const reject = (c: string, s = 's1') => pair(c, 'reject-once', 'user', { sessionId: s });
const times = (n: number, f: () => SessionEvent[]) => Array.from({ length: n }, f);
const settings = { enabled: true, threshold: 3 };
const rule = (id: string, decision: 'allow' | 'deny', pattern: string): PermissionRule => ({ id, decision, kind: 'execute', pattern });

describe('foldDecisions', () => {
  it('pairs by request id, maps option kinds and reads who decided', () => {
    const h = history(
      allow('a'),
      pair('b', 'allow-always'),
      reject('c'),
      pair('d', 'allow-once', 'rule:x'),
      pair('e', 'allow-once', 'profile:autonomous'),
      pair('f', 'reject-once', 'system'),
    );
    expect(h.map((d) => [d.req.detail, d.outcome, d.by])).toEqual([
      ['a', 'allowed', 'user'],
      ['b', 'allowed', 'user'],
      ['c', 'rejected', 'user'],
      ['d', 'allowed', { rule: 'x' }],
      ['e', 'allowed', 'other'],
      ['f', 'rejected', 'other'],
    ]);
    expect(h[0]).toMatchObject({ sessionTitle: 'First task', agentId: 'claude-code' });
  });

  it('drops cancelled, undecided and question requests', () => {
    const undecided = pair('u', 'allow-once').slice(0, 1);
    expect(history(pair('c', null), undecided, pair('q', 'allow-once', 'user', { kind: 'think' }), pair('x', 'unknown'))).toEqual([]);
  });
});

describe('suggest', () => {
  it('needs the threshold', () => {
    expect(suggest(history(allow('npm test'), allow('npm test')), [], {}, settings)).toEqual([]);
  });

  it('offers the exact text with a wider pattern after three identical approvals', () => {
    const [s] = suggest(history(allow('npm test'), allow('npm test', 's2'), allow('npm test')), [], {}, settings);
    expect(s).toMatchObject({
      key: 'allow:npm test',
      decision: 'allow',
      pattern: 'npm test',
      wider: 'npm test *',
      risk: 'project',
      caveats: ['repo-script', 'not-a-sandbox'],
      evidence: { allowed: 3, rejected: 0, sessions: 2, agents: ['claude-code', 'codex'] },
      rehearsal: { considered: 3, wouldAnswer: 3, agree: 3, conflict: 0 },
    });
  });

  it('offers the stem with any arguments after different argument lists', () => {
    const [s] = suggest(history(allow('git status'), allow('git status -s'), allow('git status --short')), [], {}, settings);
    expect(s).toMatchObject({ pattern: 'git status *', wider: null, risk: 'read' });
  });

  it('includes the script name for run commands', () => {
    const [s] = suggest(history(allow('npm run lint'), allow('npm run lint -- --fix'), allow('npm run lint')), [], {}, settings);
    expect(s!.pattern).toBe('npm run lint *');
  });

  it('is blocked by a rejection the pattern covers', () => {
    expect(suggest(history(allow('git status'), allow('git status -s'), allow('git status -b'), reject('git status --porcelain')), [], {}, settings)).toEqual([]);
  });

  it('keeps the exact pattern but drops the wider one when another command was rejected', () => {
    const [s] = suggest(history(...times(3, () => allow('npm test')), reject('npm test -- --watch')), [], {}, settings);
    expect(s).toMatchObject({ pattern: 'npm test', wider: null, evidence: { allowed: 3, rejected: 1 } });
  });

  it('never offers an allow rule for risky commands, but offers deny after two rejections', () => {
    expect(suggest(history(...times(3, () => allow('rm -rf build'))), [], {}, settings)).toEqual([]);
    const [s] = suggest(history(reject('git push origin main'), reject('git push origin main')), [], {}, settings);
    expect(s).toMatchObject({ key: 'deny:git push', decision: 'deny', pattern: 'git push *', risk: 'never', wider: null });
    expect(suggest(history(reject('git push origin main')), [], {}, settings)).toEqual([]);
    // An approval the deny pattern would cover blocks it.
    expect(suggest(history(reject('git push origin main'), reject('git push origin main'), allow('git push origin feature')), [], {}, settings)).toEqual([]);
  });

  it('keeps exact commands exact', () => {
    const [s] = suggest(history(...times(3, () => allow('node scripts/check.js'))), [], {}, settings);
    expect(s).toMatchObject({ pattern: 'node scripts/check.js', wider: null, risk: 'exact' });
    expect(suggest(history(allow('node a.js'), allow('node b.js'), allow('node c.js')), [], {}, settings)).toEqual([]);
  });

  it('is suppressed by a rule that already answers it', () => {
    expect(suggest(history(...times(3, () => allow('npm test'))), [rule('x', 'allow', 'npm *')], {}, settings)).toEqual([]);
  });

  it('counts a chain for each of its steps and an opaque request for none', () => {
    const h = history(allow('cd app && npm test'), allow('npm test'), allow('npm test && npm run lint'), ...times(3, () => allow('npm test > out.txt')));
    const s = suggest(h, [], {}, settings);
    expect(s.map((x) => x.key)).toEqual(['allow:npm test']);
    expect(s[0]!.evidence.allowed).toBe(3);
  });

  it('drops a pattern with a secret in it', () => {
    const cmd = 'deploy --token=abcdefgh12345678';
    expect(suggest(history(...times(3, () => allow(cmd))), [], {}, settings)).toEqual([]);
  });

  it('respects dismissals until the evidence grows by the threshold, and for good', () => {
    const three = times(3, () => allow('npm test'));
    expect(suggest(history(...three), [], { 'allow:npm test': { forever: false, at: 3 } }, settings)).toEqual([]);
    const five = [...three, allow('npm test'), allow('npm test')];
    expect(suggest(history(...five), [], { 'allow:npm test': { forever: false, at: 3 } }, settings)).toEqual([]);
    const six = [...five, allow('npm test')];
    expect(suggest(history(...six), [], { 'allow:npm test': { forever: false, at: 3 } }, settings)).toHaveLength(1);
    expect(suggest(history(...six), [], { 'allow:npm test': { forever: true, at: 3 } }, settings)).toEqual([]);
    expect(evidenceCount(history(...six), 'allow:npm test')).toBe(6);
  });

  it('does not count answers by rules, profiles or the system', () => {
    const h = history(allow('npm test'), pair('npm test', 'allow-once', 'rule:x'), pair('npm test', 'allow-once', 'profile:autonomous'), pair('npm test', 'allow-once', 'system'));
    expect(suggest(h, [], {}, settings)).toEqual([]);
  });

  it('sorts by how much it would answer and keeps ten', () => {
    const many = Array.from({ length: 12 }, (_, i) => times(3 + (i % 3), () => allow(`node tool${i}.js`))).flat();
    const s = suggest(history(...many), [], {}, settings);
    expect(s).toHaveLength(10);
    expect(s[0]!.rehearsal.wouldAnswer).toBe(5);
    expect(s.map((x) => x.rehearsal.wouldAnswer)).toEqual([...s.map((x) => x.rehearsal.wouldAnswer)].sort((a, b) => b - a));
  });

  it('uses the threshold from the settings', () => {
    expect(suggest(history(allow('npm test'), allow('npm test')), [], {}, { enabled: true, threshold: 2 })).toHaveLength(1);
  });
});

describe('rehearse', () => {
  it('counts answers, agreement, conflicts, covered commands, held-back requests and agents', () => {
    const h = history(
      allow('npm test'),
      allow('npm run build', 's2'),
      reject('npm publish', 's3'),
      allow('npm test && rm -rf build'),
      allow('git status'),
      pair('npm test', 'allow-once', 'rule:x'),
    );
    const r = rehearse(rule('c', 'allow', 'npm *'), [], h);
    expect(r).toMatchObject({ considered: 5, wouldAnswer: 3, agree: 2, conflict: 1, heldBack: 1, moreCovers: 0, agents: ['claude-code', 'codex', 'opencode'] });
    expect(r.conflicts).toEqual([{ text: 'npm publish', ts: expect.any(String), sessionTitle: 'Third task', decided: 'rejected' }]);
    expect(r.covers.map((c) => c.text).sort()).toEqual(['npm publish', 'npm run build', 'npm test']);
  });

  it('keeps the newest five conflicts and ten covered commands', () => {
    const h = history(...Array.from({ length: 12 }, (_, i) => reject(`npm run s${i}`)));
    const r = rehearse(rule('c', 'allow', 'npm *'), [], h);
    expect(r.conflict).toBe(12);
    expect(r.conflicts.map((c) => c.text)).toEqual(['npm run s11', 'npm run s10', 'npm run s9', 'npm run s8', 'npm run s7']);
    expect(r.covers).toHaveLength(10);
    expect(r.moreCovers).toBe(2);
  });

  it('replaces a rule with the same id and is shadowed by a deny rule', () => {
    const h = history(allow('npm test'), allow('npm run build'));
    expect(rehearse(rule('a', 'allow', 'npm test'), [rule('a', 'allow', 'npm *')], h).wouldAnswer).toBe(1);
    expect(rehearse(rule('a', 'allow', 'npm *'), [rule('d', 'deny', 'npm run *')], h).wouldAnswer).toBe(1);
  });

  it('credits the candidate when another allow rule answers the same request', () => {
    const h = history(allow('npm test'), allow('npm test'));
    expect(rehearse(rule('c', 'allow', 'npm *'), [rule('a', 'allow', 'npm test')], h).wouldAnswer).toBe(2);
  });

  it('rehearses a deny rule against approvals', () => {
    const r = rehearse(rule('d', 'deny', 'git push *'), [], history(reject('git push'), allow('git push origin x')));
    expect(r).toMatchObject({ wouldAnswer: 2, agree: 1, conflict: 1 });
  });
});

describe('usage', () => {
  const now = Date.parse('2026-12-31T10:00:00.000Z');
  it('counts answers and lists what the rule answered that was never approved by hand', () => {
    const h = history(allow('git status'), pair('git status', 'allow-once', 'rule:g'), pair('git status -s', 'allow-once', 'rule:g'));
    const [u] = usage([rule('g', 'allow', 'git status *')], h, { g: null }, now);
    expect(u).toMatchObject({ ruleId: 'g', answered: 2, unused: false, unseen: [{ text: 'git status -s', count: 1 }] });
    expect(u!.lastTs).toBe(h.at(-1)!.ts);
    expect(usage([rule('d', 'deny', 'git status *')], history(pair('git status -s', 'reject-once', 'rule:d')), {}, now)[0]!.unseen).toEqual([]);
  });

  it('marks a rule unused only when its age is known and over 30 days', () => {
    const r = [rule('g', 'allow', 'git status *')];
    expect(usage(r, [], { g: '2026-12-20T10:00:00.000Z' }, now)[0]!.unused).toBe(false);
    expect(usage(r, [], { g: '2026-11-01T10:00:00.000Z' }, now)[0]!.unused).toBe(true);
    expect(usage(r, [], { g: null }, now)[0]!.unused).toBe(false);
    expect(usage(r, [], {}, now)[0]!.unused).toBe(false);
    // Answered recently: not unused.
    const recent = history(pair('git status', 'allow-once', 'rule:g'));
    expect(usage(r, recent, { g: '2026-01-01T10:00:00.000Z' }, Date.parse(recent[0]!.ts) + 1000)[0]!.unused).toBe(false);
  });
});

describe('copy', () => {
  const evidence = { allowed: 3, rejected: 0, sessions: 1, agents: [], lastTs: '', lastRequestId: '' };
  it('writes the hint', () => {
    expect(hintText({ pattern: 'npm test', decision: 'allow', evidence })).toBe('You have allowed npm test 3 times in this repository.');
    expect(hintText({ pattern: 'git push *', decision: 'deny', evidence: { ...evidence, rejected: 2 } })).toBe('You have rejected git push 2 times in this repository.');
    expect(hintText({ pattern: 'ls', decision: 'allow', evidence: { ...evidence, allowed: 1 } })).toBe('You have allowed ls 1 time in this repository.');
  });

  it('names risks and caveats', () => {
    expect([RISK_WORDS.read, RISK_WORDS.project, RISK_WORDS.exact]).toEqual(['Reads only', 'Runs project code', 'Exact command only']);
    expect(CAVEAT_TEXT['repo-script']).toBe('Runs code from the repository, which an agent can change.');
    expect(CAVEAT_TEXT['not-a-sandbox']).toBe('A rule matches the words of a request. It is not a sandbox.');
  });

  it('writes the rehearsal lines', () => {
    expect(rehearsalText({ considered: 212, wouldAnswer: 0, conflict: 0 })).toBe('Would not have answered any of your last 212 requests.');
    expect(rehearsalText({ considered: 212, wouldAnswer: 14, conflict: 0 })).toBe('Would have answered 14 of your last 212 requests, each the way you decided.');
    expect(rehearsalText({ considered: 212, wouldAnswer: 14, conflict: 1 })).toBe('Would have answered 14 of your last 212 requests, 1 against your decision.');
    expect(rehearsalText({ considered: 1, wouldAnswer: 1, conflict: 0 })).toBe('Would have answered 1 of your last 1 request, the way you decided.');
    expect(rehearsalText({ considered: 0, wouldAnswer: 0, conflict: 0 })).toBe('There are no requests you decided yourself in this repository yet.');
    expect(heldBackText(3)).toBe('3 more matched, but had extra steps or shell syntax, so ADE would still ask.');
  });

  it('names agents', () => {
    const label = (id: string) => ({ 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })[id] ?? id;
    expect(agentsText(['claude-code', 'codex'], label)).toBe('From Claude Code and Codex.');
    expect(agentsText(['claude-code', 'codex', 'opencode'], label)).toBe('From Claude Code, Codex and OpenCode.');
    expect(agentsText(['codex'], label)).toBe('From Codex.');
    expect(agentsText([], label)).toBe('');
  });

  it('writes evidence and usage lines', () => {
    expect(evidenceText({ allowed: 5, rejected: 0, sessions: 3 }, 'allow')).toBe('Allowed 5 times, never rejected, in 3 sessions.');
    expect(evidenceText({ allowed: 0, rejected: 2, sessions: 1 }, 'deny')).toBe('Rejected 2 times, never allowed, in 1 session.');
    expect(evidenceText({ allowed: 3, rejected: 1, sessions: 1 }, 'allow')).toBe('Allowed 3 times, rejected 1 time, in 1 session.');
    expect(usageText({ answered: 9, lastTs: '2026-11-24T12:00:00.000Z' })).toBe('Answered 9 requests, last on 24 November.');
    expect(usageText({ answered: 1, lastTs: '2026-11-24T12:00:00.000Z' })).toBe('Answered 1 request, last on 24 November.');
    expect(usageText({ answered: 0, lastTs: null })).toBe('Has not answered a request yet.');
    expect(UNUSED_TEXT).toBe('Not used in 30 days.');
    expect(unseenText(2)).toBe('Answered 2 commands you never approved yourself');
    expect(unseenText(1)).toBe('Answered 1 command you never approved yourself');
  });
});
