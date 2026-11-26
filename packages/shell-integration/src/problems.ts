import type { Problem, ProblemTool } from '@ade/contracts';
import { stripAnsi } from './parser.ts';

/**
 * SM-18: problems in a finished command block, and what changed since the previous run of the same command.
 *
 * Pure: no DOM, no IPC and no `node:` import, because the renderer runs it (through the `./problems` export, so it
 * does not pull in `shells.ts`). Built-in matchers only, English tool output only. Every regex is anchored at the
 * start of a line and has no nested quantifier; lines longer than `maxLine` are skipped.
 */

export type { Problem, ProblemTool };
export type ProblemSeverity = Problem['severity'];

export const PROBLEM_LIMITS = {
  /** Problems kept per block; the rest set `cut`. */
  maxProblems: 500,
  /** Longer lines are skipped (minified bundles, base64). */
  maxLine: 2000,
  /** The normalised message used for identity when there is no code. */
  messageCut: 160,
  /** The stored message (the contract's limit). */
  storedMessage: 500,
  /** Rows in the text sent to an agent. */
  agentRows: 100,
  /** The built-in matchers, in the order they are tried on each line. */
  matchers: ['tsc', 'msbuild', 'eslint', 'rustc', 'cc', 'python', 'pytest', 'jstest', 'gotest'] as readonly ProblemTool[],
} as const;

export interface PathContext {
  /** Directory the command ran in (the block's cwd), as the shell reported it. */
  cwd: string | null;
  /** Worktree root for a session terminal, the workspace root otherwise. */
  root: string | null;
}

export type ProblemState = 'new' | 'still' | 'first';
export interface ProblemRow {
  problem: Problem;
  state: ProblemState;
}
export interface TaggedRow extends ProblemRow {
  /** The file is in the session's change set. */
  changed: boolean;
  /** The same problem is in the checkout's latest run of the command. */
  inCheckout: boolean;
}
export interface ProblemCounts {
  total: number;
  new: number;
  still: number;
  fixed: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Paths

const DRIVE = /^[A-Za-z]:\//;

/** `\` to `/`, Git Bash `/c/...` to `C:/...` (only when the other side is a drive path), `.` and `..` resolved. */
function normalise(path: string, drive: boolean): string {
  let p = path.replace(/\\/g, '/');
  const bash = /^\/([A-Za-z])(\/|$)/.exec(p);
  if (drive && bash) p = `${bash[1]!.toUpperCase()}:/${p.slice(3)}`;
  if (/^[A-Za-z]:$/.test(p)) p += '/';
  const prefix = DRIVE.test(p) ? p.slice(0, 3) : p.startsWith('/') ? '/' : '';
  const out: string[] = [];
  for (const seg of p.slice(prefix.length).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!prefix) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return prefix + out.join('/');
}

const isAbsolute = (p: string) => DRIVE.test(p) || p.startsWith('/');

/**
 * A printed path, made relative to the root when it lies inside it. Relative paths resolve against the block's own
 * cwd. A path that cannot be placed (no cwd or root, or outside the root) comes back as printed, with `inside: false`.
 */
export function toRelative(printed: string, ctx: PathContext): { path: string; inside: boolean } {
  const raw = printed.trim().replace(/^(['"`])(.*)\1$/, '$2');
  if (!ctx.root || !raw) return { path: raw, inside: false };
  const drive = /^[A-Za-z]:/.test(ctx.root);
  const root = normalise(ctx.root, drive).replace(/\/$/, '');
  let full = normalise(raw, drive);
  if (!isAbsolute(full)) {
    if (!ctx.cwd) return { path: raw, inside: false };
    const cwd = normalise(ctx.cwd, drive);
    if (!isAbsolute(cwd)) return { path: raw, inside: false };
    full = normalise(`${cwd}/${full}`, drive);
  }
  const a = drive ? full.toLowerCase() : full;
  const b = drive ? root.toLowerCase() : root;
  if (a.startsWith(`${b}/`) && full.length > root.length + 1) return { path: full.slice(root.length + 1), inside: true };
  return { path: raw, inside: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Identity

/** The message as used for identity: whitespace, the root, durations, addresses and positions do not count. */
export function normaliseMessage(message: string, root: string | null = null): string {
  let m = message.trim().replace(/\s+/g, ' ');
  if (root) {
    const r = root.replace(/[\\/]+$/, '');
    for (const form of new Set([r, r.replace(/\\/g, '/'), r.replace(/\//g, '\\')])) if (form) m = m.split(form).join('');
  }
  return m
    .replace(/\b0x[0-9a-fA-F]+\b/g, '#')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '#')
    .replace(/\bline \d+/g, 'line #')
    .replace(/:\d+(?::\d+)?\b/g, ':#')
    .slice(0, PROBLEM_LIMITS.messageCut);
}

/** Tool, path and code; the normalised message only when there is no code. The line is never part of it. */
export function fingerprint(p: Pick<Problem, 'tool' | 'path' | 'code' | 'message'>, root: string | null = null): string {
  return `${p.tool}|${p.path ?? ''}|${p.code ?? normaliseMessage(p.message, root)}`.slice(0, 1500);
}

/** The baseline key: the command text, trimmed, inner whitespace collapsed, case kept. */
export function commandKey(command: string): string {
  return command.trim().replace(/\s+/g, ' ').slice(0, 500);
}

// ---------------------------------------------------------------------------------------------------------------
// Matchers

interface Raw {
  tool: ProblemTool;
  severity: ProblemSeverity;
  path: string | null;
  line: number | null;
  column: number | null;
  code: string | null;
  message: string;
  /** Resolve the path against this folder (relative to the block's cwd) instead of the cwd itself. */
  base?: string;
}
interface Hit {
  found: Raw[];
  /** Index of the first line not consumed. */
  next: number;
}
interface Scan {
  lines: string[];
  /** The test file the jest/vitest output is currently about. */
  testFile: string | null;
  /** jest/vitest failures already reported (path and last name segment), so the summary does not repeat them. */
  testSeen: Set<string>;
  ctx: PathContext;
}
type Matcher = (s: Scan, i: number) => Hit | null;

const num = (v: string | undefined) => (v ? Number(v) : null);
const sev = (word: string): ProblemSeverity => (word.toLowerCase().includes('warn') ? 'warning' : 'error');

// tsc: `src/a.ts(1,2): error TS2322: msg`, optionally behind a pnpm -r prefix (`packages/x typecheck: `).
const TSC = /^(?:(\S+) [\w:.-]+: )?(\S[^()]*)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
// tsc --pretty: `src/a.ts:1:2 - error TS2322: msg`.
const TSC_PRETTY = /^(?:(\S+) [\w:.-]+: )?((?:[A-Za-z]:)?[^:\s][^:]*):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/;
const tsc: Matcher = (s, i) => {
  const m = TSC.exec(s.lines[i]!) ?? TSC_PRETTY.exec(s.lines[i]!);
  if (!m) return null;
  const raw: Raw = { tool: 'tsc', severity: sev(m[5]!), path: m[2]!, line: num(m[3]), column: num(m[4]), code: m[6]!, message: m[7]! };
  if (m[1]) raw.base = m[1];
  return { found: [raw], next: i + 1 };
};

// MSBuild and .NET: `C:\x\a.cs(3,7): error CS1002: ; expected [C:\x\a.csproj]`, also with a `12>` node prefix.
const MSBUILD = /^(?:\s*\d+>)?((?:[A-Za-z]:)?[^():]+)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\): (error|warning) ((?:CS|FS|VB|BC|MSB|NU|NETSDK|CA|IDE)\d+): (.*)$/;
const msbuild: Matcher = (s, i) => {
  const m = MSBUILD.exec(s.lines[i]!);
  if (!m) return null;
  const message = m[6]!.replace(/\s+\[[^\]]+\]$/, '');
  return { found: [{ tool: 'msbuild', severity: sev(m[4]!), path: m[1]!.trim(), line: num(m[2]), column: num(m[3]), code: m[5]!, message }], next: i + 1 };
};

// ESLint stylish: a line that is only a file path, then `  12:5  error  message  rule` rows until a blank line.
const ESLINT_FILE = /^((?:[A-Za-z]:)?[^\s:][^:]*\.[A-Za-z0-9]{1,8})$/;
const ESLINT_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*)$/;
const ESLINT_RULE = /^(.*\S)\s{2,}(@?[\w-]+(?:\/[\w-]+)*)$/;
const eslint: Matcher = (s, i) => {
  const file = ESLINT_FILE.exec(s.lines[i]!);
  if (!file || !ESLINT_ROW.test(s.lines[i + 1] ?? '')) return null;
  const found: Raw[] = [];
  let j = i + 1;
  for (; j < s.lines.length; j++) {
    const row = ESLINT_ROW.exec(s.lines[j]!);
    if (!row) break;
    const rule = ESLINT_RULE.exec(row[4]!);
    found.push({ tool: 'eslint', severity: sev(row[3]!), path: file[1]!, line: num(row[1]), column: num(row[2]), code: rule ? rule[2]! : null, message: (rule ? rule[1]! : row[4]!).trim() });
  }
  return { found, next: j };
};

// rustc and cargo: `error[E0308]: msg` or `warning: msg`, then `  --> src/main.rs:4:5` within 6 lines.
const RUST_HEAD = /^(error|warning)(?:\[([A-Z]\d{4})\])?: (.+)$/;
const RUST_AT = /^\s*--> ((?:[A-Za-z]:)?[^:]+):(\d+):(\d+)$/;
const rustc: Matcher = (s, i) => {
  const head = RUST_HEAD.exec(s.lines[i]!);
  if (!head) return null;
  for (let j = i + 1; j <= i + 6 && j < s.lines.length; j++) {
    const at = RUST_AT.exec(s.lines[j]!);
    if (at) return { found: [{ tool: 'rustc', severity: sev(head[1]!), path: at[1]!, line: num(at[2]), column: num(at[3]), code: head[2] ?? null, message: head[3]! }], next: j + 1 };
    if (RUST_HEAD.test(s.lines[j]!)) break;
  }
  return null;
};

// gcc, clang and tools that copy them: `src/a.c:3:5: error: msg [-Wflag]`. The severity word is required.
// The path has no spaces, so a log line such as `2024-01-01 12:30:45: warning: x` is not taken for a file.
const CC = /^((?:[A-Za-z]:)?[^:\s]+):(\d+):(?:(\d+):)? (fatal error|error|warning): (.*)$/;
const CC_FLAG = /^(.*?)\s*\[(-W[\w=+-]+)\]$/;
const cc: Matcher = (s, i) => {
  const m = CC.exec(s.lines[i]!);
  if (!m) return null;
  const flag = CC_FLAG.exec(m[5]!);
  return { found: [{ tool: 'cc', severity: sev(m[4]!), path: m[1]!, line: num(m[2]), column: num(m[3]), code: flag ? flag[2]! : null, message: flag ? flag[1]! : m[5]! }], next: i + 1 };
};

// Python: a traceback; the last frame inside the root wins, the final `Name: message` line gives code and message.
const PY_START = /^Traceback \(most recent call last\):$/;
const PY_FRAME = /^\s+File "([^"]+)", line (\d+)/;
const PY_END = /^([A-Za-z_][\w.]*)(?:: (.*))?$/;
const python: Matcher = (s, i) => {
  if (!PY_START.test(s.lines[i]!)) return null;
  const frames: { path: string; line: number }[] = [];
  for (let j = i + 1; j < s.lines.length && j < i + 400; j++) {
    const line = s.lines[j]!;
    const frame = PY_FRAME.exec(line);
    if (frame) {
      frames.push({ path: frame[1]!, line: Number(frame[2]) });
      continue;
    }
    if (/^\s/.test(line) || line === '') continue;
    const end = PY_END.exec(line);
    if (!end || !frames.length) return { found: [], next: j };
    const inside = [...frames].reverse().find((f) => toRelative(f.path, s.ctx).inside);
    const at = inside ?? frames[frames.length - 1]!;
    return { found: [{ tool: 'python', severity: 'error', path: at.path, line: at.line, column: null, code: end[1]!, message: end[2] ?? end[1]! }], next: j + 1 };
  }
  return null;
};

// pytest short summary: `FAILED tests/test_a.py::test_x - assert 1 == 2` and `ERROR tests/test_b.py - ImportError`.
const PYTEST_FAILED = /^FAILED (\S+\.py)::(\S+)(?: - (.*))?$/;
const PYTEST_ERROR = /^ERROR (\S+\.py)(?:::(\S+))?(?: - (.*))?$/;
const pytest: Matcher = (s, i) => {
  const f = PYTEST_FAILED.exec(s.lines[i]!);
  if (f) return { found: [{ tool: 'pytest', severity: 'failure', path: f[1]!, line: null, column: null, code: f[2]!, message: f[3] ?? 'failed' }], next: i + 1 };
  const e = PYTEST_ERROR.exec(s.lines[i]!);
  if (e) return { found: [{ tool: 'pytest', severity: 'error', path: e[1]!, line: null, column: null, code: e[2] ?? null, message: e[3] ?? 'error' }], next: i + 1 };
  return null;
};

// vitest and jest. A file header names the test file; failures are `FAIL file > name`, `×`/`✗` rows or jest's `●`.
const JS_FILE = String.raw`(\S+\.[cm]?[jt]sx?)`;
const JS_FAIL = new RegExp(String.raw`^\s*FAIL\s+${JS_FILE}(?:\s+>\s+(.+))?$`);
const JS_HEADER = new RegExp(String.raw`^\s*(?:PASS|❯|✓|›)\s+${JS_FILE}(?:\s|$)`);
const JS_CROSS = /^\s*[×✗]\s+(.+)$/;
const JS_BULLET = /^\s*●\s+(.+)$/;
const JS_DURATION = /\s+\d+(?:\.\d+)?\s?m?s$/;
const jsName = (name: string) => name.replace(JS_DURATION, '').replace(/\s+›\s+/g, ' > ').trim();
const jstest: Matcher = (s, i) => {
  const line = s.lines[i]!;
  const report = (path: string | null, name: string): Hit => {
    const clean = jsName(name);
    const key = `${path ?? ''}|${clean.split(' > ').pop()}`;
    if (s.testSeen.has(key)) return { found: [], next: i + 1 };
    s.testSeen.add(key);
    return { found: [{ tool: 'jstest', severity: 'failure', path, line: null, column: null, code: clean.slice(0, 200), message: 'failed' }], next: i + 1 };
  };
  const fail = JS_FAIL.exec(line);
  if (fail) {
    s.testFile = fail[1]!;
    return fail[2] ? report(fail[1]!, fail[2]) : { found: [], next: i + 1 };
  }
  const header = JS_HEADER.exec(line);
  if (header) {
    s.testFile = header[1]!;
    return { found: [], next: i + 1 };
  }
  if (!s.testFile) return null; // `×` and `●` mean something else outside test output (systemctl, maths)
  const cross = JS_CROSS.exec(line) ?? JS_BULLET.exec(line);
  if (!cross || /^Console$/.test(cross[1]!.trim())) return null;
  return report(s.testFile, cross[1]!);
};

// go test: `--- FAIL: TestX (0.00s)`, then an indented `x_test.go:12: msg` before the next test.
const GO_FAIL = /^\s*--- FAIL: (\S+)/;
const GO_AT = /^\s+(\S+\.go):(\d+): (.*)$/;
const gotest: Matcher = (s, i) => {
  const m = GO_FAIL.exec(s.lines[i]!);
  if (!m) return null;
  for (let j = i + 1; j < s.lines.length && j <= i + 20; j++) {
    const at = GO_AT.exec(s.lines[j]!);
    if (at) return { found: [{ tool: 'gotest', severity: 'failure', path: at[1]!, line: num(at[2]), column: null, code: m[1]!, message: at[3]! }], next: i + 1 };
    if (/^\s*(?:---|===) /.test(s.lines[j]!) || /^(?:FAIL|ok|PASS)\b/.test(s.lines[j]!)) break;
  }
  return { found: [{ tool: 'gotest', severity: 'failure', path: null, line: null, column: null, code: m[1]!, message: 'failed' }], next: i + 1 };
};

const MATCHERS: Record<ProblemTool, Matcher> = { tsc, msbuild, eslint, rustc, cc, python, pytest, jstest, gotest };

/** Lines as a terminal shows them: CRLF and LF alike, a carriage return overwrites (progress bars), long lines skipped. */
function screenLines(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((l) => {
      const line = l.replace(/\r+$/, '');
      const cr = line.lastIndexOf('\r');
      const shown = cr === -1 ? line : line.slice(cr + 1);
      return shown.length > PROBLEM_LIMITS.maxLine ? '' : shown;
    });
}

function finish(raw: Raw, ctx: PathContext): Problem {
  const placed = raw.path === null ? null : toRelative(raw.path, raw.base && ctx.cwd ? { ...ctx, cwd: `${ctx.cwd.replace(/[\\/]+$/, '')}/${raw.base}` } : ctx);
  const message = raw.message.trim().slice(0, PROBLEM_LIMITS.storedMessage);
  const p = {
    tool: raw.tool,
    severity: raw.severity,
    path: placed ? placed.path.slice(0, 1024) : null,
    inside: placed?.inside ?? false,
    line: raw.line && raw.line > 0 ? raw.line : null,
    column: raw.column && raw.column > 0 ? raw.column : null,
    code: raw.code ? raw.code.slice(0, 200) : null,
    message,
  };
  return { ...p, fingerprint: fingerprint(p, ctx.root) };
}

/** Every recognised problem in a block's output, in output order. `cut` when the cap was reached. */
export function extractProblems(output: string, ctx: PathContext): { problems: Problem[]; cut: boolean } {
  const scan: Scan = { lines: screenLines(output), testFile: null, testSeen: new Set(), ctx };
  const problems: Problem[] = [];
  let i = 0;
  while (i < scan.lines.length) {
    if (!scan.lines[i]) {
      i++;
      continue;
    }
    let hit: Hit | null = null;
    for (const name of PROBLEM_LIMITS.matchers) {
      hit = MATCHERS[name](scan, i);
      if (hit) break;
    }
    if (!hit) {
      i++;
      continue;
    }
    for (const raw of hit.found) {
      if (problems.length >= PROBLEM_LIMITS.maxProblems) return { problems, cut: true };
      problems.push(finish(raw, ctx));
    }
    i = Math.max(i + 1, hit.next);
  }
  return { problems, cut: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparison

/**
 * Multiset comparison per fingerprint. With `p` earlier and `c` current occurrences, the first `min(p, c)` current
 * rows are "still", the rest "new", and `p - c` earlier ones are fixed. Without an earlier run every row is "first".
 */
export function diffProblems(previous: Problem[] | null, current: Problem[]): { rows: ProblemRow[]; fixed: Problem[] } {
  if (previous === null) return { rows: current.map((problem) => ({ problem, state: 'first' })), fixed: [] };
  const before = new Map<string, number>();
  for (const p of previous) before.set(p.fingerprint, (before.get(p.fingerprint) ?? 0) + 1);
  const used = new Map<string, number>();
  const rows = current.map((problem): ProblemRow => {
    const k = used.get(problem.fingerprint) ?? 0;
    used.set(problem.fingerprint, k + 1);
    return { problem, state: k < (before.get(problem.fingerprint) ?? 0) ? 'still' : 'new' };
  });
  const seen = new Map<string, number>();
  const fixed = previous.filter((p) => {
    const k = (seen.get(p.fingerprint) ?? 0) + 1;
    seen.set(p.fingerprint, k);
    return k > (used.get(p.fingerprint) ?? 0);
  });
  return { rows, fixed };
}

/** Adds "in a file this session changed" and "also in your checkout". `changedPaths` are worktree-relative. */
export function tagProblems(rows: ProblemRow[], opts: { changedPaths: ReadonlySet<string>; checkout: Problem[] | null }): TaggedRow[] {
  const inCheckout = new Set((opts.checkout ?? []).map((p) => p.fingerprint));
  return rows.map((r) => ({
    ...r,
    changed: r.problem.inside && r.problem.path !== null && opts.changedPaths.has(r.problem.path),
    inCheckout: inCheckout.has(r.problem.fingerprint),
  }));
}

export function countRows(rows: ProblemRow[], fixed: Problem[]): ProblemCounts {
  return {
    total: rows.length,
    new: rows.filter((r) => r.state === 'new').length,
    still: rows.filter((r) => r.state === 'still').length,
    fixed: fixed.length,
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const CUT_NOTE = 'Output was cut, so this comparison may be incomplete.';

/**
 * The one-line summary. `previousAt` is the earlier run's time as shown to the user (null on a first run);
 * `previousTurn` and `turn` are the session's turn counts then and now; `partial` when either output was cut.
 */
export function summaryLine(
  counts: ProblemCounts,
  opts: { previousAt: string | null; previousTurn: number | null; turn: number | null; partial: boolean },
): string {
  if (opts.previousAt === null) {
    const base = counts.total ? plural(counts.total, 'problem') : 'No problems';
    return opts.partial ? `${base}. Output was cut, so this list may be incomplete.` : `${base}.`;
  }
  const since = `since ${opts.previousAt}${opts.turn !== null && opts.previousTurn !== null && opts.turn !== opts.previousTurn ? ` (before turn ${opts.previousTurn + 1})` : ''}`;
  if (opts.partial) {
    if (!counts.total) return `No problems found. ${CUT_NOTE}`;
    return `${counts.new} new, ${counts.still} still there ${since}. ${CUT_NOTE}`;
  }
  if (!counts.total) return counts.fixed ? `No problems now. ${counts.fixed} fixed ${since}.` : 'No problems now.';
  return `${counts.new} new, ${counts.fixed} fixed, ${counts.still} still there ${since}.`;
}

const location = (p: Problem) => `${p.path ?? '(no file)'}${p.line ? `:${p.line}${p.column ? `:${p.column}` : ''}` : ''}`;

/** A compact list for an agent: heading, command, exit code, then problems grouped by file, at most 100 rows. */
export function problemsAsText(command: string, exitCode: number | null, problems: Problem[], heading: string): string {
  const groups = new Map<string, Problem[]>();
  for (const p of problems) groups.set(p.path ?? '', [...(groups.get(p.path ?? '') ?? []), p]);
  const rows: string[] = [];
  for (const list of groups.values()) for (const p of list) rows.push([location(p), p.code, p.severity === 'error' ? null : p.severity, p.message].filter(Boolean).join('  '));
  const shown = rows.slice(0, PROBLEM_LIMITS.agentRows);
  const more = rows.length - shown.length;
  return [heading, `Command: ${command}`, `Exit code: ${exitCode ?? 'unknown'}`, '', ...shown, ...(more > 0 ? [`and ${more} more`] : [])].join('\n');
}
