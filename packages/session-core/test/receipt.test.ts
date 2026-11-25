import type { NewSessionEvent, ReceiptClaim, ReceiptFinding, SessionEvent, ToolContent, ToolKind, ToolStatus } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../src/loops.ts';
import {
  applyEvidence,
  applyReceiptEvent,
  buildReceipt,
  claimLead,
  claimVerdict,
  classifyCommand,
  emptyEvidence,
  extractClaims,
  findingLine,
  isTestPath,
  judgeClaim,
  openItems,
  phantomCandidates,
  proofPrompt,
  receiptFactsLine,
  receiptsFrom,
  repoPath,
  skipMarkers,
  statusWord,
  toCheckLine,
  verdictSentence,
  type ChangeSeen,
  type EvidenceState,
  type GitTurn,
  type ReceiptState,
} from '../src/receipt.ts';

type DistributiveNew = NewSessionEvent extends infer T ? (T extends unknown ? Omit<T, 'sessionId'> : never) : never;
let seq = 0;
const ev = (e: DistributiveNew): SessionEvent => ({ ...e, sessionId: 's1', seq: seq++, ts: '2026-11-25T10:00:00.000Z' }) as SessionEvent;

let ids = 0;
const call = (kind: ToolKind, title: string, locations: string[] = [], status: ToolStatus = 'pending', content: ToolContent[] = [], id = `c${ids++}`) =>
  ev({ type: 'tool.call', toolCallId: id, title, kind, status, content, locations });
const update = (id: string, status: ToolStatus | null, content: ToolContent[] | null = null) => ev({ type: 'tool.update', toolCallId: id, title: null, status, content });
const edit = (path: string, oldText: string | null, newText: string): SessionEvent[] => {
  const id = `e${ids++}`;
  return [call('edit', `Edit ${path}`, [path], 'in_progress', [], id), update(id, 'completed', [{ type: 'diff', path, oldText, newText }])];
};
const started = (turnId = 't1', index = 0) => ev({ type: 'turn.started', turnId, index });
const say = (text: string, messageId = `m${ids++}`) => ev({ type: 'agent.message', messageId, text });
const run = (command: string, exitCode: number | null, killed = false): SessionEvent[] => {
  const terminalId = `term${ids++}`;
  return [
    ev({ type: 'command.started', terminalId, command, cwd: '/w' }),
    ev({ type: 'command.exited', terminalId, exitCode, signal: null, output: '', truncated: false, killed }),
  ];
};
/** An `execute` call that does not run through ADE: completes or fails by its status. */
const ask = (command: string, status: 'completed' | 'failed' = 'completed'): SessionEvent[] => {
  const id = `x${ids++}`;
  return [call('execute', `Run ${command}`, [], 'pending', [], id), update(id, status)];
};
const fold = (events: SessionEvent[], from: EvidenceState = emptyEvidence()) => events.reduce(applyEvidence, from);
const noGit: GitTurn = { changed: null, ignored: [], testPatch: '', roots: [] };
const change = (path: string, status: ChangeSeen['status'] = 'modified', oldPath: string | null = null): ChangeSeen => ({ path, oldPath, status, additions: 1, deletions: 0 });
const git = (changed: ChangeSeen[] | null, extra: Partial<GitTurn> = {}): GitTurn => ({ ...noGit, changed, roots: ['/w'], ...extra });

describe('classifyCommand', () => {
  it.each([
    ['npx vitest run', ['tests']],
    ['jest --ci', ['tests']],
    ['pytest -q', ['tests']],
    ['npx playwright test e2e', ['tests']],
    ['cypress run', ['tests']],
    ['node --test math.test.js', ['tests']],
    ['C:\\Program Files\\nodejs\\node.exe --test math.test.js', ['tests']],
    ['pnpm test', ['tests']],
    ['cargo test --all', ['tests']],
    ['go test ./...', ['tests']],
    ['./gradlew test', ['tests']],
    ['mvn verify', ['tests']],
    ['npm run build', ['build']],
    ['webpack --mode production', ['build']],
    ['cmake --build out', ['build']],
    ['cargo check', ['build']],
    ['dotnet build', ['build']],
    ['npm run lint', ['lint']],
    ['eslint .', ['lint']],
    ['ruff check', ['lint']],
    ['cargo clippy', ['lint']],
    ['tsc --noEmit', ['types']],
    ['tsc -p tsconfig.json', ['build', 'types']],
    ['mypy src', ['types']],
    ['pnpm typecheck', ['types']],
  ])('%s', (command, categories) => {
    expect(classifyCommand(command)).toEqual(categories);
  });

  it('gives a chained command every category, matches without regard to case, ignores unrelated commands', () => {
    expect(classifyCommand('pnpm typecheck && pnpm lint && pnpm test')).toEqual(['tests', 'lint', 'types']);
    expect(classifyCommand('NPM TEST')).toEqual(['tests']);
    expect(classifyCommand('Run npm test')).toEqual(['tests']);
    expect(classifyCommand('ls -la')).toEqual([]);
    // A tool and a word in different simple commands do not match.
    expect(classifyCommand('npm install; echo test')).toEqual([]);
    expect(classifyCommand('ls')).toEqual([]);
  });
});

describe('extractClaims', () => {
  const cats = (text: string) => extractClaims(text).map((c) => c.category);

  it('finds each category', () => {
    expect(extractClaims('All tests pass.')).toEqual([{ category: 'tests', quote: 'All tests pass.' }]);
    expect(cats('12 passed')).toEqual(['tests']);
    expect(cats('The build succeeds.')).toEqual(['build']);
    expect(cats('Lint is clean.')).toEqual(['lint']);
    expect(cats('No lint errors.')).toEqual(['lint']);
    expect(cats('The type check passes.')).toEqual(['types']);
    expect(cats('No type errors.')).toEqual(['types']);
    expect(cats('I verified the change in the browser.')).toEqual(['verified']);
    expect(cats('It works as expected.')).toEqual(['verified']);
  });

  it('takes several categories from one sentence and one claim per category', () => {
    expect(cats('All tests pass and the build succeeds.')).toEqual(['tests', 'build']);
    const claims = extractClaims('All tests pass. The test suite is green.');
    expect(claims).toEqual([{ category: 'tests', quote: 'All tests pass.' }]);
  });

  it('strips Markdown and check marks and ignores fenced code', () => {
    expect(extractClaims('- ✅ **All tests pass**')).toEqual([{ category: 'tests', quote: 'All tests pass' }]);
    expect(extractClaims('## Summary\n`pnpm test`: tests pass')).toEqual([{ category: 'tests', quote: 'pnpm test : tests pass' }]);
    expect(cats('```\nAll tests pass\n```\nDone.')).toEqual([]);
  });

  it('never takes a hedged, negated or questioning sentence', () => {
    expect(cats('The tests should pass.')).toEqual([]);
    expect(cats('I have not run the tests, but they pass locally for me.')).toEqual([]);
    expect(cats("Tests don't pass yet.")).toEqual([]);
    expect(cats('Run the tests to make sure they pass.')).toEqual([]);
    expect(cats('Do the tests pass?')).toEqual([]);
    expect(cats('Once you run it, the build succeeds.')).toEqual([]);
  });

  it('does not add verified when a category matched in the same sentence', () => {
    expect(cats('I verified that all tests pass.')).toEqual(['tests']);
  });

  it('cuts the quote at 240 characters and redacts secrets', () => {
    const long = `All tests pass ${'and more words '.repeat(20)}`.trim();
    expect(extractClaims(long)[0]!.quote).toHaveLength(240);
    const quote = extractClaims('All tests pass with token=abcdefghijkl1234.')[0]!.quote;
    expect(quote).toContain('[redacted]');
    expect(quote).not.toContain('abcdefghijkl1234');
  });
});

describe('applyEvidence', () => {
  it('ignores events before turn.started and keeps the turn index', () => {
    const s = fold([say('All tests pass.'), ...edit('a.txt', null, 'x')]);
    expect(s).toEqual(emptyEvidence());
    const t = fold([started('t2', 3)]);
    expect(t).toMatchObject({ turnId: 't2', turnIndex: 3 });
  });

  it('keeps only the messages after the last tool call or command as the closing statement', () => {
    const s = fold([started(), say('First.'), call('read', 'Read README.md', ['README.md']), say('All tests pass.')]);
    expect(s.closing.map((m) => m.text)).toEqual(['All tests pass.']);
    const t = fold([started(), say('All tests pass.'), ...run('ls', 0), say('Done.')]);
    expect(t.closing.map((m) => m.text)).toEqual(['Done.']);
    // A thought-like call is not an action.
    const u = fold([started(), say('Done.'), call('think', 'Thinking')]);
    expect(u.closing.map((m) => m.text)).toEqual(['Done.']);
  });

  it('replaces a message with the same id', () => {
    const s = fold([started(), say('All tests', 'm'), say('All tests pass.', 'm')]);
    expect(s.closing).toEqual([{ messageId: 'm', text: 'All tests pass.' }]);
  });

  it('keeps the first old hash of a file and the latest new one', () => {
    const s = fold([started(), ...edit('src\\a.ts', 'one', 'two'), ...edit('src\\a.ts', 'two', 'three')]);
    expect(s.edits['src/a.ts']).toMatchObject({ firstOld: contentHash('one'), lastNew: contentHash('three') });
    expect(s.lastEditSeq).toBe(s.edits['src/a.ts']!.seq);
    const n = fold([started(), ...edit('n.ts', null, 'x')]);
    expect(n.edits['n.ts']!.firstOld).toBe('absent');
  });

  it('records deletes and diff-less edits by their locations', () => {
    const s = fold([started(), call('delete', 'Delete old.ts', ['old.ts'], 'completed'), call('edit', 'Edit b.ts', ['b.ts:12'], 'completed')]);
    expect(s.edits['old.ts']).toMatchObject({ firstOld: 'unknown', lastNew: 'absent' });
    expect(s.edits['b.ts']).toMatchObject({ firstOld: 'unknown', lastNew: 'unknown' });
    expect(s.lastEditSeq).not.toBeNull();
  });

  it('uses the exit code of commands run through ADE and the status of other execute calls, once', () => {
    const id = 'x-term';
    const s = fold([
      started(),
      call('execute', 'Run npm test', [], 'in_progress', [], id),
      update(id, null, [{ type: 'terminal', terminalId: 'term-a' }]),
      ev({ type: 'command.started', terminalId: 'term-a', command: 'npm test', cwd: '/w' }),
      ev({ type: 'command.exited', terminalId: 'term-a', exitCode: 1, signal: null, output: '', truncated: false, killed: false }),
      update(id, 'failed'),
      ...ask('npm run lint'),
    ]);
    expect(s.commands.map((c) => [c.command, c.ok, c.result])).toEqual([
      ['npm test', false, 'exit 1'],
      ['Run npm run lint', true, 'completed'],
    ]);
    const twice = fold([started(), call('execute', 'Run x', [], 'pending', [], 'y'), update('y', 'completed'), update('y', 'completed')]);
    expect(twice.commands).toHaveLength(1);
  });

  it('counts a killed command as not ok with the result "stopped"', () => {
    const s = fold([started(), ...run('npm test', null, true)]);
    expect(s.commands[0]).toMatchObject({ ok: false, result: 'stopped', categories: ['tests'] });
  });

  it('does not change its input and ignores receipt events', () => {
    const before = fold([started(), say('Hello.')]);
    const copy = structuredClone(before);
    fold([...edit('a.txt', null, 'x'), ...run('npm test', 0), say('Done.')], before);
    expect(before).toEqual(copy);
    const r = ev({ type: 'receipt.acknowledged', turnId: 't1' });
    expect(applyEvidence(before, r)).toBe(before);
  });
});

describe('judgeClaim', () => {
  it('unseen, contradicted, stale and supported', () => {
    expect(judgeClaim('tests', fold([started()]))).toEqual({ status: 'unseen', evidence: null });
    expect(judgeClaim('tests', fold([started(), ...run('npm test', 0), ...run('npm test', 1)]))).toEqual({ status: 'contradicted', evidence: 'npm test (exit 1)' });
    expect(judgeClaim('tests', fold([started(), ...run('npm test', 0), ...edit('a.ts', 'a', 'b')]))).toEqual({ status: 'stale', evidence: 'npm test (exit 0)' });
    expect(judgeClaim('tests', fold([started(), ...edit('a.ts', 'a', 'b'), ...run('npm test', 0)]))).toEqual({ status: 'supported', evidence: 'npm test (exit 0)' });
  });

  it('uses any command for "verified"', () => {
    expect(judgeClaim('verified', fold([started(), ...run('node script.js', 0)])).status).toBe('supported');
    expect(judgeClaim('tests', fold([started(), ...run('node script.js', 0)])).status).toBe('unseen');
  });
});

describe('repoPath', () => {
  it('relative, ./, backslashes, under a root, drive letter case, outside', () => {
    expect(repoPath('src/a.ts', ['/w'])).toBe('src/a.ts');
    expect(repoPath('./src/a.ts', ['/w'])).toBe('src/a.ts');
    expect(repoPath('src\\a.ts', ['/w'])).toBe('src/a.ts');
    expect(repoPath('/w/src/a.ts', ['/w'])).toBe('src/a.ts');
    expect(repoPath('/w/src/a.ts', ['/w/'])).toBe('src/a.ts');
    expect(repoPath('c:\\Work\\Repo\\src\\a.ts', ['C:\\work\\repo'])).toBe('src/a.ts');
    expect(repoPath('/W/src/a.ts', ['/w'])).toBeNull();
    expect(repoPath('/other/a.ts', ['/w'])).toBeNull();
    expect(repoPath('../a.ts', ['/w'])).toBeNull();
  });
});

describe('buildReceipt', () => {
  it('returns null for a pure chat turn', () => {
    expect(buildReceipt(fold([started(), say('Hello.')]), git([]))).toBeNull();
    expect(buildReceipt(fold([started(), say('Hello.')]), noGit)).toBeNull();
  });

  it('judges claims and lists the passed categories', () => {
    const s = fold([started('t1', 2), ...edit('a.ts', 'a', 'b'), ...run('npm test', 0), say('All tests pass and the build succeeds.')]);
    const r = buildReceipt(s, git([change('a.ts')]))!;
    expect(r).toMatchObject({ turnId: 't1', turnIndex: 2, passed: ['tests'] });
    expect(r.claims).toEqual([
      { category: 'tests', quote: 'All tests pass and the build succeeds.', status: 'supported', evidence: 'npm test (exit 0)' },
      { category: 'build', quote: 'All tests pass and the build succeeds.', status: 'unseen', evidence: null },
    ]);
    expect(r.facts).toEqual({ filesChanged: 1, additions: 1, deletions: 0, editsReported: 1, commands: 1, commandsFailed: 0 });
    expect(r.findings).toEqual([]);
  });

  it('flags an edit Git does not see, but not when ignored, reverted or of unknown content', () => {
    const s = fold([started(), ...edit('b.txt', null, 'x'), say('Done.')]);
    expect(phantomCandidates(s, [], ['/w'])).toEqual(['b.txt']);
    expect(buildReceipt(s, git([]))!.findings).toEqual([{ kind: 'phantom-edit', level: 'warning', paths: ['b.txt'], more: 0, detail: null }]);
    expect(buildReceipt(s, git([], { ignored: ['b.txt'] }))).toBeNull();
    const reverted = fold([started(), ...edit('c.txt', 'one', 'two'), ...edit('c.txt', 'two', 'one'), say('Done.')]);
    expect(buildReceipt(reverted, git([]))).toBeNull();
    const unknown = fold([started(), call('edit', 'Edit d.txt', ['d.txt'], 'completed'), say('Done.')]);
    expect(buildReceipt(unknown, git([]))).toBeNull();
    // Outside the worktree: ADE cannot judge it.
    const outside = fold([started(), ...edit('/elsewhere/e.txt', null, 'x')]);
    expect(phantomCandidates(outside, [], ['/w'])).toEqual([]);
  });

  it('notes files changed without a reported edit, with and without commands', () => {
    const quiet = buildReceipt(fold([started(), say('Done.')]), git([change('c.txt', 'added')]))!;
    expect(quiet.findings).toEqual([
      { kind: 'unreported-change', level: 'note', paths: ['c.txt'], more: 0, detail: 'No edit or command was reported for these files.' },
    ]);
    const busy = buildReceipt(fold([started(), ...run('npm install', 0)]), git([change('package-lock.json')]))!;
    expect(busy.findings[0]!.detail).toBe('1 command ran in this turn; one of them may have written these files.');
  });

  it('matches absolute reported paths by suffix and renames by either path', () => {
    const s = fold([started(), ...edit('/mnt/c/repo/src/a.ts', 'a', 'b'), ...edit('old.ts', 'x', 'y')]);
    const r = buildReceipt(s, git([change('src/a.ts'), change('new.ts', 'renamed', 'old.ts')]))!;
    expect(r.findings).toEqual([]);
  });

  it('flags deleted test files and switched-off tests, with markers added and removed cancelling out', () => {
    const r = buildReceipt(fold([started(), say('Done.')]), git([change('test/old.test.ts', 'deleted'), change('src/a.ts', 'deleted')]))!;
    expect(r.findings.find((f) => f.kind === 'tests-deleted')).toEqual({ kind: 'tests-deleted', level: 'warning', paths: ['test/old.test.ts'], more: 0, detail: null });
    const patch = [
      'diff --git a/math.test.js b/math.test.js',
      '--- a/math.test.js',
      '+++ b/math.test.js',
      '@@ -1,2 +1,2 @@',
      "-it('adds', () => {})",
      "+it.skip('adds', () => {})",
      "+it.only('subtracts', () => {})",
      'diff --git a/other.test.js b/other.test.js',
      '--- a/other.test.js',
      '+++ b/other.test.js',
      '@@ -1 +1 @@',
      "-it.skip('a', () => {})",
      "+it.skip('b', () => {})",
    ].join('\n');
    expect(skipMarkers(patch)).toEqual([
      { path: 'math.test.js', added: 2 },
      { path: 'other.test.js', added: 0 },
    ]);
    const s = fold([started(), ...edit('math.test.js', 'x', 'y'), ...edit('other.test.js', 'x', 'y')]);
    const skipped = buildReceipt(s, git([change('math.test.js'), change('other.test.js')], { testPatch: patch }))!;
    expect(skipped.findings).toEqual([{ kind: 'tests-skipped', level: 'warning', paths: ['math.test.js'], more: 0, detail: '2 markers added' }]);
  });

  it.each([
    "describe.only('x', () => {})",
    "xit('x', () => {})",
    "fdescribe('x', () => {})",
    '@pytest.mark.skip(reason="slow")',
    '@unittest.skip("x")',
    '[Ignore("flaky")]',
    '[Fact(Skip = "x")]',
    '@Disabled',
    't.Skip("later")',
    '#[ignore]',
    "test.todo('x')",
  ])('knows the marker %s', (line) => {
    expect(skipMarkers(`+++ b/x_test.go\n@@ -1 +1 @@\n+${line}`)).toEqual([{ path: 'x_test.go', added: 1 }]);
  });

  it('caps the listed paths at 20 and counts the rest', () => {
    const changed = Array.from({ length: 23 }, (_, i) => change(`f${i}.txt`));
    const r = buildReceipt(fold([started()]), git(changed))!;
    expect(r.findings[0]!.paths).toHaveLength(20);
    expect(r.findings[0]!.more).toBe(3);
  });

  it('skips the Git findings without checkpoints but still judges claims', () => {
    const r = buildReceipt(fold([started(), ...edit('b.txt', null, 'x'), say('All tests pass.')]), noGit)!;
    expect(r.findings).toEqual([]);
    expect(r.facts.filesChanged).toBeNull();
    expect(r.claims[0]!.status).toBe('unseen');
  });
});

describe('isTestPath', () => {
  it.each([
    ['test/a.js', true],
    ['src/__tests__/a.js', true],
    ['e2e/flow.ts', true],
    ['src/a.test.ts', true],
    ['src/a.spec.tsx', true],
    ['pkg/a_test.go', true],
    ['test_a.py', true],
    ['spec/models/user_spec.rb', true],
    ['src/UserTest.java', true],
    ['src/UserTests.cs', true],
    ['src/a.ts', false],
    ['src/contest.ts', false],
  ])('%s', (path, yes) => {
    expect(isTestPath(path)).toBe(yes);
  });
});

describe('verdicts and open items', () => {
  const facts = { filesChanged: 1, additions: 1, deletions: 0, editsReported: 1, commands: 0, commandsFailed: 0 };
  const claim = (category: ReceiptClaim['category'], status: ReceiptClaim['status'] = 'unseen', evidence: string | null = null): ReceiptClaim => ({ category, quote: 'q', status, evidence });
  const issued = (turnId: string, turnIndex: number, claims: ReceiptClaim[], passed: ReceiptState['passed'] = [], findings: ReceiptFinding[] = []) =>
    ev({ type: 'receipt.issued', turnId, turnIndex, facts, claims, findings, passed });
  const checked = (turnIndex: number, checks: { name: string; categories: ReceiptClaim['category'][]; exitCode: number | null }[]) =>
    ev({ type: 'receipt.checked', turnId: `t${turnIndex}`, turnIndex, checks });

  it('confirms with a passing check and contradicts with a failing one', () => {
    const list = receiptsFrom([issued('t0', 0, [claim('tests')]), checked(0, [{ name: 'Unit tests', categories: ['tests'], exitCode: 0 }])]);
    expect(claimVerdict(list, list[0]!, list[0]!.claims[0]!)).toEqual({ status: 'confirmed', check: 'Unit tests', exitCode: 0 });
    const bad = receiptsFrom([issued('t0', 0, [claim('tests')]), checked(0, [{ name: 'Unit tests', categories: ['tests'], exitCode: 1 }])]);
    expect(claimVerdict(bad, bad[0]!, bad[0]!.claims[0]!)).toEqual({ status: 'refuted', check: 'Unit tests', exitCode: 1 });
    // A check of another category says nothing about the claim.
    const other = receiptsFrom([issued('t0', 0, [claim('tests')]), checked(0, [{ name: 'Lint', categories: ['lint'], exitCode: 0 }])]);
    expect(claimVerdict(other, other[0]!, other[0]!.claims[0]!)).toEqual({ status: 'unseen' });
  });

  it('lets the newest attachment decide and attaches checks to the latest receipt at or before their turn', () => {
    const list = receiptsFrom([
      issued('t0', 0, [claim('tests')]),
      checked(0, [{ name: 'A', categories: ['tests'], exitCode: 1 }]),
      issued('t2', 2, []),
      checked(3, [{ name: 'B', categories: ['tests'], exitCode: 0 }]),
    ]);
    expect(list.map((r) => r.checks?.[0]?.name ?? null)).toEqual(['A', 'B']);
    expect(claimVerdict(list, list[0]!, list[0]!.claims[0]!)).toMatchObject({ status: 'confirmed', check: 'B' });
    expect(applyReceiptEvent([], checked(0, []))).toEqual([]);
  });

  it('closes a claim when a later receipt passed its category', () => {
    const list = receiptsFrom([issued('t0', 0, [claim('tests'), claim('build')]), issued('t1', 1, [claim('tests', 'supported', 'npm test (completed)')], ['tests'])]);
    expect(claimVerdict(list, list[0]!, list[0]!.claims[0]!)).toEqual({ status: 'superseded' });
    expect(claimVerdict(list, list[0]!, list[0]!.claims[1]!)).toEqual({ status: 'unseen' });
    expect(openItems(list).map((i) => i.text)).toEqual(['Says the build succeeds. ADE saw no build command in this turn.']);
  });

  it('ignores acknowledged receipts and notes', () => {
    const note: ReceiptFinding = { kind: 'unreported-change', level: 'note', paths: ['a'], more: 0, detail: null };
    const warn: ReceiptFinding = { kind: 'phantom-edit', level: 'warning', paths: ['b.txt'], more: 0, detail: null };
    const list = receiptsFrom([issued('t0', 0, [claim('tests')], [], [note, warn]), issued('t1', 1, [claim('lint', 'stale', 'eslint . (exit 0)')])]);
    expect(openItems(list).map((i) => [i.turnIndex, i.text])).toEqual([
      [0, 'Says the tests pass. ADE saw no test command in this turn.'],
      [0, 'Reported an edit that Git does not see: b.txt'],
      [1, 'Says lint is clean. Files changed after the last run: eslint . (exit 0).'],
    ]);
    const acked = applyReceiptEvent(list, ev({ type: 'receipt.acknowledged', turnId: 't0' }));
    expect(openItems(acked).map((i) => i.turnIndex)).toEqual([1]);
  });

  it('replaces a second receipt for the same turn', () => {
    const list = receiptsFrom([issued('t0', 0, [claim('tests')]), issued('t0', 0, [])]);
    expect(list).toHaveLength(1);
    expect(list[0]!.claims).toEqual([]);
  });
});

describe('copy', () => {
  it('claim leads', () => {
    expect(['tests', 'build', 'lint', 'types', 'verified'].map((c) => claimLead(c as ReceiptClaim['category']))).toEqual([
      'Says the tests pass.',
      'Says the build succeeds.',
      'Says lint is clean.',
      'Says the type check passes.',
      'Says it verified the change.',
    ]);
  });

  it('verdict sentences', () => {
    const c = (category: ReceiptClaim['category'], evidence: string | null = null) => ({ category, evidence });
    expect(verdictSentence(c('tests'), { status: 'unseen' })).toBe('ADE saw no test command in this turn.');
    expect(verdictSentence(c('types'), { status: 'unseen' })).toBe('ADE saw no type-check command in this turn.');
    expect(verdictSentence(c('verified'), { status: 'unseen' })).toBe('ADE saw no command in this turn.');
    expect(verdictSentence(c('tests', 'npm test (exit 0)'), { status: 'stale' })).toBe('Files changed after the last run: npm test (exit 0).');
    expect(verdictSentence(c('tests', 'npm test (exit 1)'), { status: 'contradicted' })).toBe('The last run failed: npm test (exit 1).');
    expect(verdictSentence(c('tests', 'npm test (exit 0)'), { status: 'supported' })).toBe('npm test (exit 0) passed after the last change.');
    expect(verdictSentence(c('tests'), { status: 'confirmed', check: 'Unit', exitCode: 0 })).toBe("Confirmed by ADE's check Unit.");
    expect(verdictSentence(c('tests'), { status: 'refuted', check: 'Unit', exitCode: 2 })).toBe("Contradicted by ADE's check Unit (exit 2).");
    expect(verdictSentence(c('tests'), { status: 'superseded' })).toBe('Passed in a later turn.');
  });

  it('status words', () => {
    expect((['supported', 'stale', 'contradicted', 'unseen', 'confirmed', 'refuted', 'superseded'] as const).map(statusWord)).toEqual([
      'Supported',
      'Out of date',
      'Contradicted',
      'Not seen',
      'Confirmed',
      'Contradicted',
      'Passed later',
    ]);
  });

  it('finding lines', () => {
    expect(findingLine({ kind: 'phantom-edit', paths: ['a.ts', 'b.ts'], more: 3, detail: null })).toBe('Reported an edit that Git does not see: a.ts, b.ts and 3 more');
    expect(findingLine({ kind: 'unreported-change', paths: ['a.ts', 'b.ts'], more: 0, detail: null })).toBe('Changed without a reported edit: a.ts and b.ts');
    expect(findingLine({ kind: 'tests-skipped', paths: ['x.test.ts'], more: 0, detail: '2 markers added' })).toBe('Tests switched off or narrowed: x.test.ts (2 markers added)');
    expect(findingLine({ kind: 'tests-deleted', paths: ['x.test.ts'], more: 0, detail: null })).toBe('Test files deleted: x.test.ts');
  });

  it('headline', () => {
    expect(receiptFactsLine({ filesChanged: 3, additions: 0, deletions: 0, editsReported: 0, commands: 2, commandsFailed: 1 })).toBe('3 files changed, 2 commands (1 failed).');
    expect(receiptFactsLine({ filesChanged: 1, additions: 0, deletions: 0, editsReported: 0, commands: 0, commandsFailed: 0 })).toBe('1 file changed, no commands.');
    expect(receiptFactsLine({ filesChanged: null, additions: 0, deletions: 0, editsReported: 0, commands: 1, commandsFailed: 0 })).toBe('Files changed not known, 1 command.');
    expect([2, 1, 0].map(toCheckLine)).toEqual(['2 things to check.', '1 thing to check.', 'Nothing to flag.']);
  });

  it('proof prompt', () => {
    const list = receiptsFrom([
      ev({
        type: 'receipt.issued',
        turnId: 't0',
        turnIndex: 0,
        facts: { filesChanged: 1, additions: 1, deletions: 0, editsReported: 1, commands: 0, commandsFailed: 0 },
        claims: [{ category: 'tests', quote: 'q', status: 'unseen', evidence: null }],
        findings: [{ kind: 'phantom-edit', level: 'warning', paths: ['b.txt'], more: 0, detail: null }],
        passed: [],
      }),
    ]);
    expect(proofPrompt(openItems(list))).toBe(
      [
        'Before I review this, back up what you reported.',
        '- You said the tests pass, but no test command ran in this turn.',
        '- You reported editing b.txt, but Git shows no change there.',
        'Run the commands now and show each command with its full output. Do not change any code first; if something fails, say so.',
      ].join('\n'),
    );
  });
});
