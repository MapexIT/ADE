import type { CommandBlock, Problem } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { BlockBuilder, MAX_OUTPUT } from '../src/blocks.ts';
import {
  commandKey,
  countRows,
  diffProblems,
  extractProblems,
  fingerprint,
  problemsAsText,
  summaryLine,
  tagProblems,
  toRelative,
  type PathContext,
} from '../src/problems.ts';

const WIN: PathContext = { cwd: 'C:/Users/dev/repo', root: 'C:\\Users\\dev\\repo' };
const POSIX: PathContext = { cwd: '/home/dev/repo', root: '/home/dev/repo' };
const brief = (ps: Problem[]) => ps.map((p) => [p.tool, p.severity, p.path, p.line, p.column, p.code, p.message]);

describe('extraction', () => {
  it('1. tsc, classic form (real output of tsc 6.0 with --pretty false)', () => {
    const out = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\r\nsrc/a.ts(2,18): error TS2304: Cannot find name 'foo'.\r\n";
    expect(brief(extractProblems(out, WIN).problems)).toEqual([
      ['tsc', 'error', 'src/a.ts', 1, 7, 'TS2322', "Type 'string' is not assignable to type 'number'."],
      ['tsc', 'error', 'src/a.ts', 2, 18, 'TS2304', "Cannot find name 'foo'."],
    ]);
  });

  it('1b. tsc behind a pnpm -r prefix resolves against the package folder', () => {
    const out = 'packages/contracts typecheck: src/ipc.ts(3,1): error TS1005: ; expected.\n';
    const [p] = extractProblems(out, POSIX).problems;
    expect(p).toMatchObject({ path: 'packages/contracts/src/ipc.ts', inside: true, code: 'TS1005' });
  });

  it('2. tsc, pretty form after ANSI codes are removed (real output)', () => {
    const out =
      '\x1b[96msrc/a.ts\x1b[0m:\x1b[93m1\x1b[0m:\x1b[93m7\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2322: \x1b[0mType \'string\' is not assignable to type \'number\'.\r\n\r\n' +
      '\x1b[7m1\x1b[0m const a: number = "x";\r\n\x1b[7m \x1b[0m \x1b[91m      ~\x1b[0m\r\n\r\n' +
      'Found 2 errors in the same file, starting at: src/a.ts\x1b[90m:1\x1b[0m\r\n';
    expect(brief(extractProblems(out, WIN).problems)).toEqual([['tsc', 'error', 'src/a.ts', 1, 7, 'TS2322', "Type 'string' is not assignable to type 'number'."]]);
  });

  it('3. MSBuild error and warning with the project suffix and a node prefix', () => {
    const out = [
      'C:\\Users\\dev\\repo\\App\\Program.cs(5,21): error CS0029: Cannot implicitly convert type \'string\' to \'int\' [C:\\Users\\dev\\repo\\App\\App.csproj]',
      '  3>C:\\Users\\dev\\repo\\App\\Program.cs(5,37): warning CS0168: The variable \'unused\' is declared but never used [C:\\Users\\dev\\repo\\App\\App.csproj]',
      'Build FAILED.',
    ].join('\r\n');
    expect(brief(extractProblems(out, WIN).problems)).toEqual([
      ['msbuild', 'error', 'App/Program.cs', 5, 21, 'CS0029', "Cannot implicitly convert type 'string' to 'int'"],
      ['msbuild', 'warning', 'App/Program.cs', 5, 37, 'CS0168', "The variable 'unused' is declared but never used"],
    ]);
  });

  it('4. ESLint stylish with two files and a summary line (real output of eslint 9)', () => {
    const out = [
      '',
      'C:\\Users\\dev\\repo\\src\\b.js',
      '  1:1   warning  Unexpected var, use let or const instead  no-var',
      "  1:5   error    'x' is assigned a value but never used    no-unused-vars",
      "  2:12  error    'a' is defined but never used             no-unused-vars",
      '',
      'C:\\Users\\dev\\repo\\src\\c.js',
      '  1:1  warning  Unexpected var, use let or const instead  no-var',
      '',
      '✖ 4 problems (2 errors, 2 warnings)',
      '  0 errors and 2 warnings potentially fixable with the `--fix` option.',
      '',
    ].join('\n');
    expect(brief(extractProblems(out, WIN).problems)).toEqual([
      ['eslint', 'warning', 'src/b.js', 1, 1, 'no-var', 'Unexpected var, use let or const instead'],
      ['eslint', 'error', 'src/b.js', 1, 5, 'no-unused-vars', "'x' is assigned a value but never used"],
      ['eslint', 'error', 'src/b.js', 2, 12, 'no-unused-vars', "'a' is defined but never used"],
      ['eslint', 'warning', 'src/c.js', 1, 1, 'no-var', 'Unexpected var, use let or const instead'],
    ]);
  });

  it('5. rustc error with --> and a warning', () => {
    const out = [
      '   Compiling demo v0.1.0 (/home/dev/repo)',
      'error[E0308]: mismatched types',
      ' --> src/main.rs:2:18',
      '  |',
      '2 |     let x: i32 = "a";',
      '  |            ---   ^^^ expected `i32`, found `&str`',
      '',
      'warning: unused variable: `y`',
      ' --> src/lib.rs:4:9',
      '  |',
      'error: could not compile `demo` (bin "demo") due to 1 previous error; 1 warning emitted',
    ].join('\n');
    expect(brief(extractProblems(out, POSIX).problems)).toEqual([
      ['rustc', 'error', 'src/main.rs', 2, 18, 'E0308', 'mismatched types'],
      ['rustc', 'warning', 'src/lib.rs', 4, 9, null, 'unused variable: `y`'],
    ]);
  });

  it('6. gcc and clang: error, warning, fatal error, with and without a column', () => {
    const out = [
      "src/a.c: In function 'main':",
      "src/a.c:3:5: error: 'x' undeclared (first use in this function)",
      'src/a.c:4:9: warning: unused variable \'y\' [-Wunused-variable]',
      'src/b.c:1:10: fatal error: missing.h: No such file or directory',
      'src/c.c:7: error: expected expression',
      'compilation terminated.',
    ].join('\n');
    expect(brief(extractProblems(out, POSIX).problems)).toEqual([
      ['cc', 'error', 'src/a.c', 3, 5, null, "'x' undeclared (first use in this function)"],
      ['cc', 'warning', 'src/a.c', 4, 9, '-Wunused-variable', "unused variable 'y'"],
      ['cc', 'error', 'src/b.c', 1, 10, null, 'missing.h: No such file or directory'],
      ['cc', 'error', 'src/c.c', 7, null, null, 'expected expression'],
    ]);
  });

  it('7. Python traceback: the frame inside the root wins over the standard library (real output of Python 3.15)', () => {
    const out = [
      'Traceback (most recent call last):',
      '  File "C:\\Users\\dev\\repo\\src\\u.py", line 2, in <module>',
      '    json.loads("{")',
      '    ~~~~~~~~~~^^^^^',
      '  File "C:\\Users\\dev\\AppData\\Local\\Python\\pythoncore-3.15-64\\Lib\\json\\__init__.py", line 371, in loads',
      '    return _default_decoder.decode(s)',
      '  File "C:\\Users\\dev\\AppData\\Local\\Python\\pythoncore-3.15-64\\Lib\\json\\decoder.py", line 374, in raw_decode',
      '    obj, end = self.scan_once(s, idx)',
      'json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 1 column 2 (char 1)',
    ].join('\r\n');
    expect(brief(extractProblems(out, WIN).problems)).toEqual([
      ['python', 'error', 'src/u.py', 2, null, 'json.decoder.JSONDecodeError', 'Expecting property name enclosed in double quotes: line 1 column 2 (char 1)'],
    ]);
  });

  it('8. pytest FAILED and ERROR lines', () => {
    const out = [
      '=========================== short test summary info ============================',
      'FAILED tests/test_math.py::test_add - assert 2 == 3',
      'FAILED tests/test_math.py::TestDiv::test_zero',
      'ERROR tests/test_io.py - ModuleNotFoundError: No module named \'yaml\'',
      '==================== 2 failed, 3 passed, 1 error in 0.12s =====================',
    ].join('\n');
    expect(brief(extractProblems(out, POSIX).problems)).toEqual([
      ['pytest', 'failure', 'tests/test_math.py', null, null, 'test_add', 'assert 2 == 3'],
      ['pytest', 'failure', 'tests/test_math.py', null, null, 'TestDiv::test_zero', 'failed'],
      ['pytest', 'error', 'tests/test_io.py', null, null, null, "ModuleNotFoundError: No module named 'yaml'"],
    ]);
  });

  it('9. vitest: × rows and FAIL lines name each failure once (real output of vitest 5.1)', () => {
    const out = [
      ' RUN  v5.1.1 C:/Users/dev/repo',
      '',
      ' ❯ src/a.test.ts (2 tests | 1 failed) 6ms',
      '   ❯ math (2)',
      '     × adds 4ms',
      '',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ' FAIL  src/a.test.ts > math > adds',
      'AssertionError: expected 2 to be 3 // Object.is equality',
      ' ❯ src/a.test.ts:3:36',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed | 1 passed (2)',
    ].join('\n');
    expect(brief(extractProblems(out, WIN).problems)).toEqual([['jstest', 'failure', 'src/a.test.ts', null, null, 'adds', 'failed']]);
  });

  it('10. jest ● lines under a FAIL header', () => {
    const out = [
      'FAIL src/sum.test.js',
      '  ● math › adds',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '  ● math › subtracts',
      'PASS src/ok.test.js',
      '',
      'Tests:       2 failed, 1 passed, 3 total',
    ].join('\n');
    expect(brief(extractProblems(out, POSIX).problems)).toEqual([
      ['jstest', 'failure', 'src/sum.test.js', null, null, 'math > adds', 'failed'],
      ['jstest', 'failure', 'src/sum.test.js', null, null, 'math > subtracts', 'failed'],
    ]);
  });

  it('11. go test --- FAIL with a file line', () => {
    const out = ['=== RUN   TestAdd', '--- FAIL: TestAdd (0.00s)', '    math_test.go:12: got 2, want 3', '--- FAIL: TestQuiet (0.00s)', 'FAIL', 'FAIL\texample.com/demo\t0.002s'].join('\n');
    expect(brief(extractProblems(out, POSIX).problems)).toEqual([
      ['gotest', 'failure', 'math_test.go', 12, null, 'TestAdd', 'got 2, want 3'],
      ['gotest', 'failure', null, null, null, 'TestQuiet', 'failed'],
    ]);
  });

  it('12. a mixed log keeps output order', () => {
    const out = ['/home/dev/repo/src/x.ts', '  1:1  error  Bad  no-bad', '', 'src/y.ts(2,2): error TS1005: x expected.'].join('\n');
    expect(extractProblems(out, POSIX).problems.map((p) => [p.tool, p.path])).toEqual([
      ['eslint', 'src/x.ts'],
      ['tsc', 'src/y.ts'],
    ]);
  });

  it('13. grep -n, git status, URLs with ports and a Windows path without a severity word produce nothing', () => {
    const out = [
      'src/a.ts:12:const error = 1;',
      'src/a.ts:13: error handling is here',
      'On branch main',
      '\tmodified:   src/a.ts',
      'http://localhost:5173: ready',
      '  ➜  Local:   http://localhost:5173/',
      'C:\\repo\\src\\a.ts(3,1): see this line',
      '2024-01-01 12:30:45: warning: disk almost full',
      '× 2 = 4',
      '● nginx.service - A high performance web server',
      'error: something went wrong',
    ].join('\n');
    expect(extractProblems(out, WIN).problems).toEqual([]);
  });

  it('14. CRLF input equals LF input', () => {
    const lf = 'src/a.ts(1,1): error TS1: a.\nsrc/b.c:2:3: error: b\n';
    expect(extractProblems(lf.replace(/\n/g, '\r\n'), POSIX)).toEqual(extractProblems(lf, POSIX));
  });

  it('15. a carriage return overwrites what came before on the line', () => {
    const out = 'building 10%\rbuilding 90%\rsrc/a.ts(1,1): error TS1: a.\r\n';
    expect(extractProblems(out, POSIX).problems.map((p) => p.code)).toEqual(['TS1']);
  });

  it('16. a line longer than 2 000 characters is skipped', () => {
    const out = `src/a.ts(1,1): error TS1: ${'x'.repeat(3000)}\nsrc/b.ts(1,1): error TS2: short.`;
    expect(extractProblems(out, POSIX).problems.map((p) => p.code)).toEqual(['TS2']);
  });

  it('17. 600 problems give 500 and cut', () => {
    const out = Array.from({ length: 600 }, (_, i) => `src/a.ts(${i + 1},1): error TS${i}: x.`).join('\n');
    const res = extractProblems(out, POSIX);
    expect(res.problems).toHaveLength(500);
    expect(res.cut).toBe(true);
    expect(extractProblems('src/a.ts(1,1): error TS1: x.', POSIX).cut).toBe(false);
  });

  it('18. a 256 KiB single line and a 20 000-line log finish well under a second', () => {
    const t0 = performance.now();
    extractProblems('a'.repeat(256 * 1024), POSIX);
    extractProblems(`${'(('.repeat(1000)}: error TS1:`.repeat(100), POSIX);
    const log = Array.from({ length: 20_000 }, (_, i) => (i % 7 ? `  at Object.<anonymous> (src/x.ts:${i}:1) error: warning: ${'('.repeat(40)}` : `src/x.ts(${i},1): error TS2: m.`)).join('\n');
    const res = extractProblems(log, POSIX);
    expect(res.problems.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('paths', () => {
  it('19. relative to a cwd that is a subfolder of the root', () => {
    expect(toRelative('src/a.ts', { cwd: '/home/dev/repo/packages/ui', root: '/home/dev/repo' })).toEqual({ path: 'packages/ui/src/a.ts', inside: true });
  });

  it('20. ./ and ..', () => {
    expect(toRelative('./src/a.ts', POSIX)).toEqual({ path: 'src/a.ts', inside: true });
    expect(toRelative('../ui/x.ts', { cwd: '/home/dev/repo/packages/core', root: '/home/dev/repo' })).toEqual({ path: 'packages/ui/x.ts', inside: true });
    expect(toRelative('../../elsewhere.ts', POSIX)).toEqual({ path: '../../elsewhere.ts', inside: false });
  });

  it('21. absolute inside and outside the root', () => {
    expect(toRelative('/home/dev/repo/src/a.ts', POSIX)).toEqual({ path: 'src/a.ts', inside: true });
    expect(toRelative('/usr/include/stdio.h', POSIX)).toEqual({ path: '/usr/include/stdio.h', inside: false });
    expect(toRelative('/home/dev/repository/a.ts', POSIX).inside).toBe(false);
  });

  it('22. backslash and drive-letter paths, case-insensitive on Windows', () => {
    expect(toRelative('C:\\repo\\src\\a.ts', { cwd: 'C:/repo', root: 'C:/repo' })).toEqual({ path: 'src/a.ts', inside: true });
    expect(toRelative('C:\\repo\\src\\a.ts', { cwd: 'C:/repo', root: 'c:\\Repo' })).toEqual({ path: 'src/a.ts', inside: true });
    expect(toRelative('src\\a.ts', { cwd: 'C:\\repo', root: 'C:\\repo\\' })).toEqual({ path: 'src/a.ts', inside: true });
  });

  it('23. Git Bash /c/ paths', () => {
    expect(toRelative('/c/repo/x.ts', { cwd: '/c/repo', root: 'C:\\repo' })).toEqual({ path: 'x.ts', inside: true });
    expect(toRelative('x.ts', { cwd: '/c/repo/sub', root: 'C:\\repo' })).toEqual({ path: 'sub/x.ts', inside: true });
  });

  it('23b. an 8.3 short name in the root matches the long name the shell reports (Windows only)', () => {
    const root = 'C:\\Users\\ABCDEF~1\\AppData\\Local\\Temp\\ade\\worktrees\\s1';
    expect(toRelative('src/b.ts', { cwd: 'C:/Users/Ábcdéfgh/AppData/Local/Temp/ade/worktrees/s1', root })).toEqual({ path: 'src/b.ts', inside: true });
    expect(toRelative('C:\\Users\\Ábcdéfgh\\AppData\\Local\\Temp\\ade\\worktrees\\s1\\a.ts', { cwd: null, root })).toEqual({ path: 'a.ts', inside: true });
    expect(toRelative('a.ts', { cwd: 'C:/Users/Ábcdéfgh/AppData/Local/Temp/ade/worktrees/s2', root }).inside).toBe(false);
    expect(toRelative('/home/ABCDEF~1/repo/a.ts', { cwd: null, root: '/home/abcdefgh/repo' }).inside).toBe(false);
  });

  it('24. a POSIX root is case-sensitive', () => {
    expect(toRelative('/home/dev/Repo/a.ts', POSIX).inside).toBe(false);
  });

  it('25. no cwd or no root leaves the path as printed', () => {
    expect(toRelative('src/a.ts', { cwd: null, root: '/home/dev/repo' })).toEqual({ path: 'src/a.ts', inside: false });
    expect(toRelative('/home/dev/repo/a.ts', { cwd: '/home/dev/repo', root: null })).toEqual({ path: '/home/dev/repo/a.ts', inside: false });
  });

  it('26. quoted paths and paths with spaces', () => {
    expect(toRelative('"src/my file.ts"', POSIX)).toEqual({ path: 'src/my file.ts', inside: true });
    expect(toRelative("'C:\\My Repo\\a b.ts'", { cwd: 'C:/My Repo', root: 'C:/My Repo' })).toEqual({ path: 'a b.ts', inside: true });
  });
});

const P = (over: Partial<Problem>): Problem => {
  const p = { tool: 'tsc' as const, severity: 'error' as const, path: 'src/a.ts', inside: true, line: 1, column: 1, code: 'TS1', message: 'm', ...over };
  return { ...p, fingerprint: fingerprint(p) };
};

describe('identity and diff', () => {
  it('27. the same problem at another line is still there', () => {
    const { rows, fixed } = diffProblems([P({ line: 2 })], [P({ line: 9 })]);
    expect(rows.map((r) => r.state)).toEqual(['still']);
    expect(fixed).toEqual([]);
  });

  it('28. a different code in the same file is new', () => {
    const { rows, fixed } = diffProblems([P({ code: 'TS1' })], [P({ code: 'TS2' })]);
    expect(rows.map((r) => r.state)).toEqual(['new']);
    expect(fixed.map((p) => p.code)).toEqual(['TS1']);
  });

  it('29. without a code the message decides, with durations, addresses and positions normalised', () => {
    const a = fingerprint({ tool: 'cc', path: 'x.c', code: null, message: 'took 12ms at 0xdeadbeef in x.c:3:4, line 9' });
    const b = fingerprint({ tool: 'cc', path: 'x.c', code: null, message: '  took 1.5s at   0x00ff in x.c:8:1, line 30 ' });
    expect(a).toBe(b);
    expect(fingerprint({ tool: 'cc', path: 'x.c', code: null, message: 'other' })).not.toBe(a);
    expect(fingerprint({ tool: 'python', path: null, code: null, message: 'C:\\repo\\a.py broke' }, 'C:/repo')).toBe(
      fingerprint({ tool: 'python', path: null, code: null, message: '\\a.py broke' }),
    );
  });

  it('30. two then three identical problems: exactly one is new', () => {
    const { rows } = diffProblems([P({}), P({})], [P({}), P({}), P({})]);
    expect(rows.map((r) => r.state)).toEqual(['still', 'still', 'new']);
  });

  it('31. three then one: two are fixed', () => {
    const { rows, fixed } = diffProblems([P({ line: 1 }), P({ line: 2 }), P({ line: 3 })], [P({ line: 5 })]);
    expect(rows.map((r) => r.state)).toEqual(['still']);
    expect(fixed.map((p) => p.line)).toEqual([2, 3]);
  });

  it('32. without an earlier snapshot every row is first', () => {
    expect(diffProblems(null, [P({}), P({ code: 'TS2' })]).rows.map((r) => r.state)).toEqual(['first', 'first']);
  });

  it('33. an empty current run with an earlier snapshot: all fixed', () => {
    expect(diffProblems([P({}), P({ code: 'TS2' })], [])).toEqual({ rows: [], fixed: [P({}), P({ code: 'TS2' })] });
  });

  it('34. rows keep output order', () => {
    const current = [P({ code: 'TS3' }), P({ code: 'TS1' }), P({ code: 'TS2' })];
    expect(diffProblems([P({ code: 'TS1' })], current).rows.map((r) => [r.problem.code, r.state])).toEqual([
      ['TS3', 'new'],
      ['TS1', 'still'],
      ['TS2', 'new'],
    ]);
  });
});

describe('tags and text', () => {
  it('35. in a file this session changed', () => {
    const rows = diffProblems(null, [P({ path: 'src/a.ts' }), P({ path: 'src/b.ts' }), P({ path: 'src/b.ts', inside: false })]).rows;
    expect(tagProblems(rows, { changedPaths: new Set(['src/b.ts']), checkout: null }).map((r) => r.changed)).toEqual([false, true, false]);
  });

  it('36. also in your checkout, by fingerprint', () => {
    const rows = diffProblems(null, [P({ code: 'TS1', line: 4 }), P({ code: 'TS2' })]).rows;
    expect(tagProblems(rows, { changedPaths: new Set(), checkout: [P({ code: 'TS1', line: 80 })] }).map((r) => r.inCheckout)).toEqual([true, false]);
    expect(tagProblems(rows, { changedPaths: new Set(), checkout: null }).map((r) => r.inCheckout)).toEqual([false, false]);
  });

  it('37. summary lines', () => {
    const at = { previousAt: '14:02', previousTurn: 3, turn: 4, partial: false };
    const c = (total: number, n: number, still: number, fixed: number) => ({ total, new: n, still, fixed });
    expect(summaryLine(c(7, 0, 0, 0), { ...at, previousAt: null })).toBe('7 problems.');
    expect(summaryLine(c(1, 0, 0, 0), { ...at, previousAt: null })).toBe('1 problem.');
    expect(summaryLine(c(2, 0, 0, 0), { ...at, previousAt: null, partial: true })).toBe('2 problems. Output was cut, so this list may be incomplete.');
    expect(summaryLine(c(5, 2, 3, 4), at)).toBe('2 new, 4 fixed, 3 still there since 14:02 (before turn 4).');
    expect(summaryLine(c(5, 2, 3, 4), { ...at, turn: 3 })).toBe('2 new, 4 fixed, 3 still there since 14:02.');
    expect(summaryLine(c(5, 2, 3, 4), { ...at, turn: null, previousTurn: null })).toBe('2 new, 4 fixed, 3 still there since 14:02.');
    expect(summaryLine(c(0, 0, 0, 7), { ...at, turn: 3 })).toBe('No problems now. 7 fixed since 14:02.');
    expect(summaryLine(c(0, 0, 0, 1), { ...at, turn: 3 })).toBe('No problems now. 1 fixed since 14:02.');
    expect(summaryLine(c(5, 2, 3, 4), { ...at, partial: true })).toBe('2 new, 3 still there since 14:02 (before turn 4). Output was cut, so this comparison may be incomplete.');
    expect(summaryLine(c(0, 0, 0, 4), { ...at, partial: true })).toBe('No problems found. Output was cut, so this comparison may be incomplete.');
  });

  it('38. text for an agent is grouped by file and cut at 100 rows', () => {
    const ps = [P({ path: 'b.ts', code: 'TS2', line: 3, column: null }), P({ path: 'a.ts', message: 'one' }), P({ path: 'b.ts', code: 'TS9', severity: 'warning', message: 'w' })];
    expect(problemsAsText('pnpm tsc', 2, ps, 'New problems')).toBe(
      ['New problems', 'Command: pnpm tsc', 'Exit code: 2', '', 'b.ts:3  TS2  m', 'b.ts:1:1  TS9  warning  w', 'a.ts:1:1  TS1  one'].join('\n'),
    );
    const many = Array.from({ length: 130 }, (_, i) => P({ line: i + 1 }));
    const text = problemsAsText('x', null, many, 'Problems').split('\n');
    expect(text[2]).toBe('Exit code: unknown');
    expect(text).toHaveLength(4 + 100 + 1);
    expect(text.at(-1)).toBe('and 30 more');
  });

  it('39. commandKey collapses whitespace and keeps case', () => {
    expect(commandKey('  pnpm   run\tTest  ')).toBe('pnpm run Test');
    expect(commandKey('pnpm test')).not.toBe(commandKey('pnpm run test'));
    expect(commandKey('x'.repeat(900))).toHaveLength(500);
  });

  it('counts rows by state', () => {
    const { rows, fixed } = diffProblems([P({ code: 'A' }), P({ code: 'B' })], [P({ code: 'A' }), P({ code: 'C' })]);
    expect(countRows(rows, fixed)).toEqual({ total: 2, new: 1, still: 1, fixed: 1 });
  });
});

describe('block builder', () => {
  const feed = (text: string) => {
    const done: CommandBlock[] = [];
    const b = new BlockBuilder((x) => x.endedAt !== null && done.push(x));
    b.push({ type: 'output-start' });
    b.push({ type: 'command-line', command: 'x' });
    b.push({ type: 'text', text });
    b.push({ type: 'command-end', exitCode: 0 });
    return done[0]!;
  };

  it('40. a block under the limit is not truncated', () => {
    expect(feed('hello\n').truncated).toBe(false);
  });

  it('41. a block over the limit is truncated and keeps the tail', () => {
    const block = feed(`${'a'.repeat(MAX_OUTPUT)}TAIL`);
    expect(block.truncated).toBe(true);
    expect(block.output).toHaveLength(MAX_OUTPUT);
    expect(block.output.endsWith('TAIL')).toBe(true);
  });
});
