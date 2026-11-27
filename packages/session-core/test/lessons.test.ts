import type { MessageOrigin, SessionEvent } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import {
  applyLessonsBlock,
  commandsOf,
  correctionText,
  foldCorrections,
  groupCorrections,
  importsAgents,
  isLessonLike,
  lessonEvidence,
  lessonHintText,
  lessonPatternMatches,
  lessonRehearsalText,
  lessonUnused,
  lessonWords,
  LESSONS_END,
  LESSONS_START,
  notFollowedText,
  overlap,
  promptText,
  rehearseLesson,
  splitSentences,
  standingNotesBlock,
  STANDING_NOTES_HEADING,
  suggestLessons,
  timesWord,
  type Correction,
} from '../src/lessons.ts';

let seq = 0;
let clock = Date.parse('2026-11-01T10:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();
const ev = (sessionId: string, body: Record<string, unknown>): SessionEvent => ({ sessionId, seq: ++seq, ts: tick(), ...body }) as SessionEvent;
const user = (sessionId: string, text: string, origin?: MessageOrigin) =>
  ev(sessionId, { type: 'user.message', content: [{ type: 'text', text }], queued: false, ...(origin ? { origin } : {}) });
const ended = (sessionId: string, stopReason: string) => ev(sessionId, { type: 'turn.ended', turnId: `t${seq}`, stopReason, usage: null });
const decided = (sessionId: string, note: string | null, decidedBy = 'user') =>
  ev(sessionId, { type: 'permission.decided', requestId: `r${seq + 1}`, decision: { outcome: 'selected', optionId: 'reject-once' }, decidedBy, note });
const notice = (sessionId: string, text: string) => ev(sessionId, { type: 'notice', level: 'info', text });

const META: Record<string, { title: string; agentId: string }> = {
  s1: { title: 'First', agentId: 'codex' },
  s2: { title: 'Second', agentId: 'claude-code' },
  s3: { title: 'Third', agentId: 'codex' },
};
const meta = (id: string) => META[id] ?? null;

const corr = (sessionId: string, text: string, origin: MessageOrigin = 'interrupt', agentId = META[sessionId]?.agentId ?? 'codex'): Correction => ({
  sessionId,
  sessionTitle: META[sessionId]?.title ?? sessionId,
  agentId,
  ts: tick(),
  origin,
  text,
  itemKey: `user:${++seq}`,
});

describe('ED-05 normalisation', () => {
  it('lower-cases, drops punctuation and stop words, and makes "don\'t" and "do not" agree', () => {
    expect(lessonWords('Use pnpm, not npm!')).toEqual(['use', 'pnpm', 'not', 'npm']);
    expect(lessonWords("Please don't use npm.")).toEqual(['not', 'use', 'npm']);
    expect(lessonWords('Do not use npm')).toEqual(['not', 'use', 'npm']);
    expect(lessonWords('Run the tests with `pnpm test`')).toEqual(['run', 'tests', 'pnpm', 'test']);
    expect(lessonWords('Keep src/lib.ts tidy.')).toEqual(['keep', 'src/lib.ts', 'tidy']);
  });

  it('splits sentences at ends, semicolons and line breaks, and removes list markers', () => {
    expect(splitSentences('Use pnpm. Never npm!\n- Keep it short; add tests\n2) Commit nothing')).toEqual(['Use pnpm.', 'Never npm!', 'Keep it short;', 'add tests', 'Commit nothing']);
    expect(splitSentences('  \n ')).toEqual([]);
  });

  it('measures overlap as shared words over all words', () => {
    expect(overlap(['use', 'pnpm'], ['use', 'pnpm'])).toBe(1);
    expect(overlap(['use', 'pnpm', 'npm'], ['use', 'pnpm', 'not', 'npm'])).toBe(0.75);
    expect(overlap([], ['a'])).toBe(0);
    expect(overlap(new Set(['a', 'b']), new Set(['c']))).toBe(0);
  });
});

describe('ED-05 line-bound comments', () => {
  it('keeps standing instructions', () => {
    for (const s of ['Use pnpm, not npm', 'Do not use npm', "Don't run the whole test suite", 'Never commit generated files', 'Always add a test for a bug fix', 'Please keep functions small']) {
      expect(isLessonLike(s), s).toBe(true);
    }
  });

  it('leaves out remarks about one spot, questions, single words and long paragraphs', () => {
    for (const s of ['rename this', 'Rename this to fooBar', 'Move that into utils', "Don't do that", 'fix it', 'Put it here', 'Remove these lines', 'Why did you use npm?', 'What is this', 'ok', 'Thanks', `Use ${'very '.repeat(40)}long words`]) {
      expect(isLessonLike(s), s).toBe(false);
    }
  });
});

describe('ED-05 recognising corrections', () => {
  it('reads review comments: the single form and the batch form, without the headers', () => {
    expect(correctionText('review-comment', 'Review comment on src/a.ts:12\nUse pnpm, not npm')).toBe('Use pnpm, not npm');
    expect(correctionText('review-comment', 'Review of your changes (2 comments). Address each one.\n\nsrc/a.ts\n- line 3: rename this\n- line 9: Use pnpm, not npm')).toBe('rename this\nUse pnpm, not npm');
    expect(correctionText('review-comment', 'Plain text')).toBe('Plain text');
    expect(correctionText('interrupt', '  Stop  ')).toBe('Stop');
  });

  it('collects reject notes, interrupts, review comments, loop redirects and after-undo prompts; not ordinary prompts', () => {
    const events = [
      user('s1', 'Build the thing', 'composer'),
      decided('s1', 'Use pnpm, not npm'),
      user('s1', 'Use pnpm, not npm', 'reject-note'),
      decided('s1', null),
      decided('s1', 'by a rule', 'rule:x'),
      user('s1', 'Stop and use pnpm', 'interrupt'),
      user('s1', 'Review comment on a.ts:1\nKeep it small', 'review-comment'),
      user('s1', 'Look elsewhere', 'loop-redirect'),
      notice('s1', 'Undid turn 2 and every change after it.'),
      user('s1', 'Try again without npm', 'composer'),
      user('s1', 'Thanks', 'composer'),
    ];
    const out = foldCorrections(events, meta);
    expect(out.map((c) => [c.origin, c.text])).toEqual([
      ['reject-note', 'Use pnpm, not npm'],
      ['interrupt', 'Stop and use pnpm'],
      ['review-comment', 'Keep it small'],
      ['loop-redirect', 'Look elsewhere'],
      ['after-undo', 'Try again without npm'],
    ]);
    expect(out[0]).toMatchObject({ sessionId: 's1', sessionTitle: 'First', agentId: 'codex', itemKey: `perm:r${events[1]!.seq}` });
    expect(out[1]!.itemKey).toBe(`user:${events[5]!.seq}`);
  });

  it('infers an interrupt from a cancelled turn and skips the note message for events stored before origins', () => {
    const events = [
      user('s1', 'Build it'),
      ended('s1', 'cancelled'),
      user('s1', 'Use pnpm instead'),
      ended('s1', 'end_turn'),
      user('s1', 'Carry on'),
      decided('s1', 'No npm please'),
      ended('s1', 'end_turn'),
      user('s1', 'No npm please'),
      notice('s1', 'Undid turn 1 and every change after it.'),
      user('s1', 'Again, with pnpm'),
    ];
    expect(foldCorrections(events, meta).map((c) => [c.origin, c.text])).toEqual([
      ['interrupt', 'Use pnpm instead'],
      ['reject-note', 'No npm please'],
      ['after-undo', 'Again, with pnpm'],
    ]);
  });

  it('does not infer an interrupt when the message says it came from the composer', () => {
    expect(foldCorrections([user('s1', 'go'), ended('s1', 'cancelled'), user('s1', 'Use pnpm instead', 'composer')], meta)).toEqual([]);
  });

  it('ignores the standing notes block of a first prompt', () => {
    expect(promptText([{ type: 'text', text: 'Do it' }, { type: 'text', text: standingNotesBlock(['Use pnpm'])! }])).toBe('Do it');
    expect(promptText([{ type: 'text', text: `Do it\n\n${STANDING_NOTES_HEADING}\n- x` }])).toBe('Do it');
    expect(promptText([{ type: 'image', data: '', mimeType: 'image/png' }])).toBe('');
  });
});

describe('ED-05 grouping and the threshold', () => {
  it('one occasion produces nothing', () => {
    expect(suggestLessons([corr('s1', 'Use pnpm, not npm')], [], {})).toEqual([]);
  });

  it('the same correction twice in one session to one agent produces nothing', () => {
    expect(suggestLessons([corr('s1', 'Use pnpm, not npm'), corr('s1', 'Use pnpm not npm.')], [], {})).toEqual([]);
  });

  it('two sessions produce one suggestion listing both occasions, newest first', () => {
    const a = corr('s1', 'Use pnpm, not npm', 'reject-note');
    const b = corr('s3', 'Use pnpm instead of npm.', 'interrupt');
    const [s, ...rest] = suggestLessons([a, b], [], {});
    expect(rest).toEqual([]);
    expect(s).toMatchObject({ key: 'not npm pnpm use', text: 'Use pnpm instead of npm.', count: 2, sessions: 2, agents: ['codex'] });
    expect(s!.occasions.map((o) => [o.sessionId, o.origin])).toEqual([
      ['s3', 'interrupt'],
      ['s1', 'reject-note'],
    ]);
    expect(s!.anchors).toEqual([
      { sessionId: 's3', itemKey: b.itemKey },
      { sessionId: 's1', itemKey: a.itemKey },
    ]);
  });

  it('two agents in one session (after a hand-off) produce a suggestion', () => {
    const out = suggestLessons([corr('s1', 'Use pnpm, not npm', 'interrupt', 'codex'), corr('s1', 'Use pnpm, not npm', 'interrupt', 'claude-code')], [], {});
    expect(out).toHaveLength(1);
    expect(out[0]!.sessions).toBe(1);
  });

  it('keeps different sentences apart and splits a correction into its sentences', () => {
    const groups = groupCorrections([corr('s1', 'Use pnpm, not npm. Keep functions small.'), corr('s2', 'Keep the functions small'), corr('s3', 'Add a changelog entry')]);
    expect(groups.map((g) => g.members.length)).toEqual([1, 2, 1]);
    const out = suggestLessons([corr('s1', 'Use pnpm, not npm. Keep functions small.'), corr('s2', 'Keep the functions small')], [], {});
    expect(out.map((s) => s.text)).toEqual(['Keep the functions small']);
  });

  it('never suggests line-bound comments, even repeated', () => {
    expect(suggestLessons([corr('s1', 'rename this', 'review-comment'), corr('s2', 'rename this', 'review-comment')], [], {})).toEqual([]);
  });

  it('skips what a lesson already says, and honours Not now and Never suggest this', () => {
    const cs = [corr('s1', 'Use pnpm, not npm'), corr('s2', 'Use pnpm, not npm')];
    expect(suggestLessons(cs, [{ text: 'use pnpm not npm' }], {})).toEqual([]);
    const key = 'not npm pnpm use';
    expect(suggestLessons(cs, [], { [key]: { forever: true, at: 2 } })).toEqual([]);
    expect(suggestLessons(cs, [], { [key]: { forever: false, at: 2 } })).toEqual([]);
    expect(suggestLessons([...cs, corr('s3', 'Use pnpm, not npm')], [], { [key]: { forever: false, at: 2 } })).toEqual([]);
    expect(suggestLessons([...cs, corr('s3', 'Use pnpm, not npm'), corr('s3', 'use pnpm not npm')], [], { [key]: { forever: false, at: 2 } })).toHaveLength(1);
  });

  it('redacts secrets in what it offers', () => {
    const out = suggestLessons([corr('s1', 'Never print token=abcdefghijkl1234 again'), corr('s2', 'Never print token=abcdefghijkl1234 again')], [], {});
    expect(out[0]!.text).toBe('Never print token=[redacted] again');
    expect(out[0]!.occasions.every((o) => !o.text.includes('abcdefghijkl1234'))).toBe(true);
  });

  it('reports the evidence behind a key', () => {
    const cs = [corr('s1', 'Use pnpm, not npm'), corr('s2', 'Use pnpm not npm')];
    expect(lessonEvidence(cs, 'not npm pnpm use').count).toBe(2);
    expect(lessonEvidence(cs, 'nothing').count).toBe(0);
  });
});

describe('ED-05 standing notes', () => {
  it('builds the block after the user\'s words, one line per lesson', () => {
    expect(standingNotesBlock(['Use pnpm, not npm', '  Keep\nit short  ', ''])).toBe(`\n\n${STANDING_NOTES_HEADING}\n- Use pnpm, not npm\n- Keep it short`);
    expect(standingNotesBlock([])).toBeNull();
    expect(standingNotesBlock(['  '])).toBeNull();
  });
});

describe('ED-05 the AGENTS.md block', () => {
  const block = (eol: string, ...lines: string[]) => [LESSONS_START, 'Standing notes from the user, kept by ADE (Settings, Lessons):', ...lines.map((l) => `- ${l}`), LESSONS_END].join(eol);

  it('appends a block to a file with LF and keeps the rest byte for byte', () => {
    const before = '# Agents\n\nRun pnpm test.\n';
    const after = applyLessonsBlock(before, ['Use pnpm, not npm'])!;
    expect(after).toBe(`${before}\n${block('\n', 'Use pnpm, not npm')}\n`);
    expect(after.startsWith(before)).toBe(true);
    expect(after.includes('\r')).toBe(false);
  });

  it('keeps CRLF files CRLF', () => {
    const before = '# Agents\r\n\r\nRun pnpm test.\r\n';
    const after = applyLessonsBlock(before, ['Use pnpm'])!;
    expect(after).toBe(`${before}\r\n${block('\r\n', 'Use pnpm')}\r\n`);
    expect(after.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('adds a blank line when the file does not end with a line break, and creates a missing file', () => {
    expect(applyLessonsBlock('# A', ['x'])).toBe(`# A\n\n${block('\n', 'x')}\n`);
    expect(applyLessonsBlock(null, ['x'])).toBe(`${block('\n', 'x')}\n`);
    expect(applyLessonsBlock('', ['x'])).toBe(`${block('\n', 'x')}\n`);
    expect(applyLessonsBlock(null, [])).toBeNull();
    expect(applyLessonsBlock('# A\n', [])).toBe('# A\n');
  });

  it('replaces only inside the markers and is idempotent', () => {
    const file = `# A\r\n\r\n${block('\r\n', 'old')}\r\n\r\n## After\r\nkeep me\r\n`;
    const once = applyLessonsBlock(file, ['new one', 'second'])!;
    expect(once).toBe(`# A\r\n\r\n${block('\r\n', 'new one', 'second')}\r\n\r\n## After\r\nkeep me\r\n`);
    expect(applyLessonsBlock(once, ['new one', 'second'])).toBe(once);
  });

  it('removes the block when no lessons are left, putting the file back as it was', () => {
    for (const original of ['# A\n', '# A\r\n\r\nB\r\n', '']) {
      const added = applyLessonsBlock(original, ['x'])!;
      expect(applyLessonsBlock(added, [])).toBe(original);
    }
    const middle = `# A\n\n${block('\n', 'x')}\n\n## B\n`;
    expect(applyLessonsBlock(middle, [])).toBe('# A\n\n## B\n');
  });

  it('knows when CLAUDE.md imports AGENTS.md', () => {
    expect(importsAgents('See @AGENTS.md for details')).toBe(true);
    expect(importsAgents('# Claude')).toBe(false);
  });
});

describe('ED-05 watch patterns', () => {
  const cmd = (c: string) => ({ kind: 'execute' as const, title: c, detail: c });

  it('matches the workspace-rule syntax against the whole command or one of its steps', () => {
    expect(lessonPatternMatches('npm *', cmd('npm --version'))).toBe(true);
    expect(lessonPatternMatches('npm *', cmd('npm'))).toBe(true);
    expect(lessonPatternMatches('npm *', cmd('cd web && npm install'))).toBe(true);
    expect(lessonPatternMatches('npm *', cmd('pnpm install'))).toBe(false);
    expect(lessonPatternMatches('  ', cmd('npm'))).toBe(false);
  });

  it('rehearses over past commands from command and permission events', () => {
    const events = [
      ev('s1', { type: 'command.started', terminalId: 't', command: 'npm --version', cwd: '/w' }),
      ev('s1', { type: 'permission.requested', requestId: 'r', toolCallId: 'c', title: 'npm install', kind: 'execute', detail: 'npm install', options: [] }),
      ev('s1', { type: 'permission.requested', requestId: 'r2', toolCallId: 'c', title: 'Edit a.ts', kind: 'edit', detail: null, options: [] }),
      ev('s2', { type: 'command.started', terminalId: 't', command: 'pnpm test', cwd: '/w' }),
      ev('s2', { type: 'command.started', terminalId: 't', command: 'npm install', cwd: '/w' }),
    ];
    const commands = commandsOf(events);
    expect(commands).toHaveLength(4);
    const r = rehearseLesson('npm *', commands);
    expect(r).toEqual({ considered: 4, matched: 3, examples: [{ text: 'npm install', count: 2 }, { text: 'npm --version', count: 1 }] });
    expect(lessonRehearsalText(r)).toBe('Matches 3 of the last 4 commands agents ran or asked to run here.');
    expect(lessonRehearsalText({ considered: 0, matched: 0 })).toBe('Agents have not run any commands in this repository yet.');
    expect(lessonRehearsalText({ considered: 1, matched: 0 })).toBe('Matches none of the last 1 command agents ran or asked to run here.');
  });
});

describe('ED-05 copy and age', () => {
  it('says how often and to whom', () => {
    const label = (id: string) => ({ codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode' })[id] ?? id;
    expect(lessonHintText({ count: 3, agents: ['codex', 'claude-code'], sessions: 2 }, label)).toBe('You have said this 3 times, to Codex and Claude Code.');
    expect(lessonHintText({ count: 2, agents: ['codex'], sessions: 2 }, label)).toBe('You have said this twice, in 2 sessions with Codex.');
    expect(lessonHintText({ count: 4, agents: ['codex', 'claude-code', 'opencode'], sessions: 3 }, label)).toBe('You have said this 4 times, to Codex, Claude Code and OpenCode.');
    expect(timesWord(1)).toBe('once');
    expect(notFollowedText('Use pnpm,\nnot npm')).toBe('Lesson not followed: Use pnpm, not npm');
  });

  it('marks a first-prompt lesson not sent in 30 days', () => {
    const now = Date.parse('2026-11-30T00:00:00Z');
    const base = { route: 'first-prompt' as const, enabled: true, createdAt: '2026-10-01T00:00:00Z', lastSentAt: null };
    expect(lessonUnused(base, now)).toBe(true);
    expect(lessonUnused({ ...base, lastSentAt: '2026-11-20T00:00:00Z' }, now)).toBe(false);
    expect(lessonUnused({ ...base, route: 'instruction-files' }, now)).toBe(false);
    expect(lessonUnused({ ...base, enabled: false }, now)).toBe(false);
  });
});
