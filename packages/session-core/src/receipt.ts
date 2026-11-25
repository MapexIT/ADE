import {
  redactSecrets,
  type ClaimStatus,
  type FileChange,
  type ReceiptCheck,
  type ReceiptClaim,
  type ReceiptFacts,
  type ReceiptFinding,
  type SessionEvent,
  type SessionEventOf,
  type ToolContent,
  type ToolKind,
  type VerifyCategory,
} from '@ade/contracts';
import { contentHash, normaliseLoopText } from './loops.ts';

/**
 * RV-16: turn receipt. When a turn ends, sets what the agent said it did (its closing statement) against what ADE
 * saw it do (the ACP events) and what Git says changed (the turn's two checkpoints). Pure and agent-neutral, with
 * no model call. The host folds every event through `applyEvidence`, reads the state at `turn.ended`, adds the Git
 * facts and records `buildReceipt`'s result as `receipt.issued`. The copy helpers are shared with the renderer.
 */

// ------------------------------------------------------------------------------------------------ evidence fold

export interface CommandSeen {
  command: string;
  categories: VerifyCategory[];
  ok: boolean;
  /** "exit 1", "stopped", "completed", ... */
  result: string;
  seq: number;
}

/** A reported edit: content hashes, or `absent` (no file) or `unknown` (reported without content). */
export interface EditSeen {
  firstOld: string;
  lastNew: string;
  seq: number;
}

interface ToolSeen {
  kind: ToolKind;
  title: string;
  terminal: boolean;
  done: boolean;
  /** Paths whose diff was already folded for this call. */
  paths: string[];
  locations: string[];
}

export interface EvidenceState {
  turnId: string | null;
  turnIndex: number;
  /** The agent's messages since its last action in the turn (the closing statement). */
  closing: { messageId: string; text: string }[];
  /** At most 200, newest kept. */
  commands: CommandSeen[];
  /** Terminal id to command text. */
  running: Record<string, string>;
  /** Edit-kind and execute calls by tool call id. */
  tools: Record<string, ToolSeen>;
  /** Key: the reported path with `\` replaced by `/`. At most 500. */
  edits: Record<string, EditSeen>;
  lastEditSeq: number | null;
}

export const emptyEvidence = (): EvidenceState => ({
  turnId: null,
  turnIndex: 0,
  closing: [],
  commands: [],
  running: {},
  tools: {},
  edits: {},
  lastEditSeq: null,
});

const MAX_COMMANDS = 200;
const MAX_EDITS = 500;
const MAX_TOOLS = 200;
const ABSENT = 'absent';
const UNKNOWN = 'unknown';
const REMEMBERED: ReadonlySet<ToolKind> = new Set(['edit', 'delete', 'move', 'execute']);

/** Forward slashes, without a leading `./`. */
const slashes = (path: string) => path.replace(/\\/g, '/');
/** `mapSessionUpdate` appends `:<line>` to a location; the path is what counts here. */
const stripLine = (location: string) => location.replace(/:\d+$/, '');

function cap(record: Record<string, unknown>, max: number) {
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length - max; i++) delete record[keys[i]!];
}

function reportEdit(s: EvidenceState, path: string, before: string, after: string, seq: number) {
  const key = slashes(path);
  const prev = s.edits[key];
  delete s.edits[key];
  s.edits[key] = { firstOld: prev ? prev.firstOld : before, lastNew: after, seq };
  cap(s.edits, MAX_EDITS);
  s.lastEditSeq = seq;
}

function pushCommand(s: EvidenceState, command: string, ok: boolean, result: string, seq: number) {
  s.commands.push({ command, categories: classifyCommand(command), ok, result, seq });
  if (s.commands.length > MAX_COMMANDS) s.commands.splice(0, s.commands.length - MAX_COMMANDS);
}

/** Rules 4 and 6: diff and terminal content of a remembered call. */
function content(s: EvidenceState, tool: ToolSeen | undefined, items: ToolContent[], seq: number) {
  for (const c of items) {
    if (c.type === 'terminal' && tool) tool.terminal = true;
    if (c.type !== 'diff') continue;
    if (tool) {
      if (tool.paths.includes(c.path)) continue;
      tool.paths.push(c.path);
    }
    reportEdit(s, c.path, c.oldText === null ? ABSENT : contentHash(c.oldText), contentHash(c.newText), seq);
  }
}

/** Rules 5 and 8: a final status for a remembered call. */
function finish(s: EvidenceState, tool: ToolSeen, status: 'completed' | 'failed', seq: number) {
  if (tool.done) return;
  tool.done = true;
  if (tool.kind === 'execute') {
    if (!tool.terminal) pushCommand(s, tool.title, status === 'completed', status, seq);
    return;
  }
  if (status !== 'completed' || tool.paths.length) return;
  for (const location of tool.locations) {
    const path = stripLine(location);
    if (!path) continue;
    if (tool.kind === 'delete') reportEdit(s, path, UNKNOWN, ABSENT, seq);
    else reportEdit(s, path, UNKNOWN, UNKNOWN, seq);
  }
}

/**
 * Folds one event into the turn's evidence. Returns the next state; the input is not changed.
 *
 * 1. `turn.started` starts fresh. Events outside an ADE turn (such as `session/load` replay) are ignored.
 *    `turn.ended` does not reset: the host reads the state at that moment.
 * 2. `agent.message` replaces the closing entry with the same message id, else is added. Chunks are ignored.
 * 3. A `tool.call` other than `think` and `switch_mode` clears the closing statement; edit-kind and execute
 *    calls are remembered.
 * 4. Diff content (once per path per call) is a reported edit: the first old hash is kept, the new one replaced.
 * 5. A completed delete without a diff reports its locations as absent; a completed edit or move without a diff
 *    reports its locations with unknown content.
 * 6. Terminal content marks the call as run through ADE.
 * 7. `command.started` clears the closing statement; `command.exited` records the command with its exit code.
 * 8. A final status of an `execute` call that did not run through ADE records the command by its title.
 * 9. Everything else (including `receipt.*` and `loop.*`) leaves the state as it was.
 */
export function applyEvidence(prev: EvidenceState, e: SessionEvent): EvidenceState {
  if (e.type === 'turn.started') return { ...emptyEvidence(), turnId: e.turnId, turnIndex: e.index };
  if (prev.turnId === null) return prev;
  switch (e.type) {
    case 'agent.message': {
      const s = structuredClone(prev);
      const at = s.closing.findIndex((m) => m.messageId === e.messageId);
      if (at === -1) s.closing.push({ messageId: e.messageId, text: e.text });
      else s.closing[at] = { messageId: e.messageId, text: e.text };
      return s;
    }
    case 'tool.call': {
      if (e.kind === 'think' || e.kind === 'switch_mode') return prev;
      const s = structuredClone(prev);
      s.closing = [];
      let tool: ToolSeen | undefined;
      if (REMEMBERED.has(e.kind)) {
        tool = { kind: e.kind, title: normaliseLoopText(e.title), terminal: false, done: false, paths: [], locations: [...e.locations] };
        delete s.tools[e.toolCallId];
        s.tools[e.toolCallId] = tool;
        cap(s.tools, MAX_TOOLS);
      }
      content(s, tool, e.content, e.seq);
      if (tool && (e.status === 'completed' || e.status === 'failed')) finish(s, tool, e.status, e.seq);
      return s;
    }
    case 'tool.update': {
      const known = prev.tools[e.toolCallId];
      const diffs = e.content?.some((c) => c.type === 'diff' || c.type === 'terminal') ?? false;
      if (!known && !diffs) return prev;
      const s = structuredClone(prev);
      const tool = s.tools[e.toolCallId];
      if (e.content) content(s, tool, e.content, e.seq);
      if (tool && (e.status === 'completed' || e.status === 'failed')) finish(s, tool, e.status, e.seq);
      return s;
    }
    case 'command.started': {
      const s = structuredClone(prev);
      s.closing = [];
      s.running[e.terminalId] = normaliseLoopText(e.command);
      return s;
    }
    case 'command.exited': {
      const command = prev.running[e.terminalId];
      if (command === undefined) return prev;
      const s = structuredClone(prev);
      delete s.running[e.terminalId];
      const ok = e.exitCode === 0 && !e.killed;
      const result = e.killed ? 'stopped' : e.exitCode !== null ? `exit ${e.exitCode}` : `stopped by ${e.signal ?? 'a signal'}`;
      pushCommand(s, command, ok, result, e.seq);
      return s;
    }
    default:
      return prev;
  }
}

// ------------------------------------------------------------------------------------------------ commands

const TOOLS = 'npm|pnpm|yarn|bun|deno|cargo|go|dotnet|gradle|gradlew|mvn|mvnw|make|just|mix|swift|flutter|dart|rake|nx|turbo';
/** A tool followed, in the same simple command (no `;`, `&` or pipe in between), by one of `words`. */
const toolThen = (words: string) => new RegExp(`\\b(?:${TOOLS})\\b[^;&|\\n]*?\\b(?:${words})\\b`, 'i');

const COMMAND_PATTERNS: [Exclude<VerifyCategory, 'verified'>, RegExp[]][] = [
  [
    'tests',
    [
      /\b(?:vitest|jest|mocha|ava|pytest|unittest|rspec|phpunit|ctest|tox|nox)\b/i,
      /\bplaywright\s+test\b/i,
      /\bcypress\s+run\b/i,
      /\bnode(?:\.exe)?\b[^;&|\n]*?\s--test\b/i,
      toolThen('test|tests|e2e|spec|verify'),
    ],
  ],
  [
    'build',
    [
      /\btsc\b(?![^;&|\n]*--noEmit)/i,
      /\b(?:webpack|rollup|esbuild|msbuild|ninja)\b/i,
      /\bcmake\s+--build\b/i,
      /\bcargo\s+check\b/i,
      toolThen('build|compile|assemble|package'),
    ],
  ],
  ['lint', [/\b(?:lint|linter|linting|eslint|biome|ruff|flake8|pylint|clippy|golangci-lint|stylelint|rubocop|ktlint|shellcheck)\b/i]],
  ['types', [/\b(?:tsc|mypy|pyright|typecheck|type-check|check-types)\b/i]],
];

/**
 * The categories a command proves when it passes (never `verified`). A chained command gets every category it
 * matches: ADE cannot tell which part failed, so a failure counts against all of them.
 */
export function classifyCommand(command: string): VerifyCategory[] {
  return COMMAND_PATTERNS.filter(([, res]) => res.some((re) => re.test(command))).map(([c]) => c);
}

// ------------------------------------------------------------------------------------------------ claims

const CATEGORY_ORDER: VerifyCategory[] = ['tests', 'build', 'lint', 'types', 'verified'];
const HEDGE =
  /\b(?:not|never|cannot|unable|should|would|will|once|if|please|ensure|todo|expect|expected|likely|probably|may|might|try)\b|n't\b|\bwithout running\b|\bwhen you\b|\byou can\b|\byou may\b|\bmake sure\b|\bto verify\b|\bto confirm\b|\bneeds? to\b/i;
const CLAIM_PATTERNS: [Exclude<VerifyCategory, 'verified'>, RegExp[]][] = [
  [
    'tests',
    [
      /\b(?:tests?|test suite|specs?)\b[^.]{0,40}\b(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|successful(?:ly)?)\b/i,
      /\b\d+\s+(?:tests?\s+)?(?:passed|passing)\b/i,
    ],
  ],
  ['build', [/\b(?:builds?|compil(?:es|ed|ation))\b[^.]{0,40}\b(?:succe\w+|pass(?:es|ed)?|clean(?:ly)?|without errors?|green)\b/i]],
  [
    'lint',
    [
      /\b(?:lint(?:er|ing)?|eslint)\b[^.]{0,40}\b(?:pass(?:es|ed)?|clean|green|no (?:errors?|warnings?|issues?))\b/i,
      /\bno lint(?:ing)? (?:errors?|warnings?|issues?)\b/i,
    ],
  ],
  [
    'types',
    [
      /\b(?:type[ -]?check(?:s|ing|er)?|tsc|typescript)\b[^.]{0,40}\b(?:pass(?:es|ed)?|clean|green|succe\w+|no errors?)\b/i,
      /\bno type errors?\b/i,
    ],
  ],
];
const VERIFIED = [
  /\b(?:i|i've|i have|we|we've|we have)\s+(?:also\s+|now\s+)?(?:verified|confirmed|tested|checked)\b/i,
  /\b(?:verified|confirmed) that\b/i,
  /\bworks? (?:as expected|correctly)\b/i,
];

/** One sentence without Markdown markers, check marks or symbols, with white space collapsed. */
function clean(sentence: string): string {
  return sentence
    .replace(/[‘’]/g, "'")
    .replace(/^\s*(?:[-+*•]|\d+[.)])\s+/, '')
    .replace(/\[[ xX]\]/g, ' ')
    .replace(/[*`#>~]/g, ' ')
    .replace(/(^|[\s(])_+|_+(?=[\s).,!?:;]|$)/g, '$1')
    .replace(/️/g, '')
    .replace(/[←-⯿\u{1F000}-\u{1FAFF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Claims in the agent's closing statement, at most one per category, in category order. Only plain statements
 * count: a question, or a sentence with a hedge or negation ("should pass", "I have not run"), never does.
 */
export function extractClaims(text: string): { category: VerifyCategory; quote: string }[] {
  const body = text.slice(-20_000).replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '\n');
  const found = new Map<VerifyCategory, string>();
  for (const raw of body.split(/\r?\n|;|(?<=[.!?])\s+/)) {
    const sentence = clean(raw);
    // "works as expected" is a claim, not a hedge.
    if (!sentence || sentence.length > 400 || sentence.endsWith('?') || HEDGE.test(sentence.replace(/\bas expected\b/gi, ''))) continue;
    let matched = false;
    for (const [category, res] of CLAIM_PATTERNS) {
      if (!res.some((re) => re.test(sentence))) continue;
      matched = true;
      if (!found.has(category)) found.set(category, sentence);
    }
    if (!matched && !found.has('verified') && VERIFIED.some((re) => re.test(sentence))) found.set('verified', sentence);
  }
  return CATEGORY_ORDER.filter((c) => found.has(c)).map((category) => ({ category, quote: redactSecrets(found.get(category)!).slice(0, 240) }));
}

const evidenceOf = (run: CommandSeen) => redactSecrets(`${run.command} (${run.result})`).slice(0, 300);

/** Rule of order: a passing run counts only when no reported edit came after it. */
export function judgeClaim(category: VerifyCategory, ev: Pick<EvidenceState, 'commands' | 'lastEditSeq'>): { status: ClaimStatus; evidence: string | null } {
  const runs = category === 'verified' ? ev.commands : ev.commands.filter((c) => c.categories.includes(category));
  if (!runs.length) return { status: 'unseen', evidence: null };
  const last = runs.reduce((a, b) => (b.seq > a.seq ? b : a));
  const evidence = evidenceOf(last);
  if (!last.ok) return { status: 'contradicted', evidence };
  if (ev.lastEditSeq !== null && ev.lastEditSeq > last.seq) return { status: 'stale', evidence };
  return { status: 'supported', evidence };
}

/** Categories whose latest run in the turn passed after the last reported edit. */
export function passedCategories(ev: Pick<EvidenceState, 'commands' | 'lastEditSeq'>): VerifyCategory[] {
  return (['tests', 'build', 'lint', 'types'] as const).filter((c) => judgeClaim(c, ev).status === 'supported');
}

// ------------------------------------------------------------------------------------------------ Git

export type ChangeSeen = Pick<FileChange, 'path' | 'oldPath' | 'status' | 'additions' | 'deletions'>;

export interface GitTurn {
  /** `changedFiles` between the turn's start and end checkpoints; null when either is missing. */
  changed: ChangeSeen[] | null;
  /** Repository paths among `phantomCandidates` that Git ignores. */
  ignored: string[];
  /** Unified diff of the changed test files ('' when none). */
  testPatch: string;
  /** The worktree folder as the agent may have written it: `worktreePath` and its real path. */
  roots: string[];
}

const DRIVE = /^[A-Za-z]:\//;

/**
 * A reported path relative to the worktree, with forward slashes; null when it lies outside every root (ADE
 * cannot judge it). Roots that start with a drive letter compare without regard to case.
 */
export function repoPath(reported: string, roots: string[]): string | null {
  const p = slashes(reported);
  if (!p.startsWith('/') && !DRIVE.test(p)) {
    const rel = p.replace(/^(?:\.\/)+/, '');
    return rel === '..' || rel.startsWith('../') || !rel ? null : rel;
  }
  for (const root of roots) {
    const r = slashes(root).replace(/\/+$/, '');
    if (!r) continue;
    const insensitive = DRIVE.test(`${r}/`);
    const [a, b] = insensitive ? [p.toLowerCase(), r.toLowerCase()] : [p, r];
    if (a.startsWith(`${b}/`)) return p.slice(r.length + 1) || null;
  }
  return null;
}

/** Reported edits that changed content (by the agent's own report) inside the worktree and that Git does not show. */
export function phantomCandidates(ev: Pick<EvidenceState, 'edits'>, changed: GitTurn['changed'], roots: string[]): string[] {
  if (!changed) return [];
  const seen = new Set(changed.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path])));
  const out: string[] = [];
  for (const [path, edit] of Object.entries(ev.edits)) {
    if (edit.lastNew === UNKNOWN || edit.lastNew === edit.firstOld) continue;
    const rel = repoPath(path, roots);
    if (rel === null || seen.has(rel) || out.includes(rel)) continue;
    out.push(rel);
  }
  return out;
}

const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']);
const TEST_FILES = [/\.(?:test|spec)\.[cm]?[jt]sx?$/i, /_test\.(?:go|py)$/i, /^test_.*\.py$/i, /_spec\.rb$/i, /Test\.java$/, /Tests\.cs$/, /Test\.kt$/];

export function isTestPath(path: string): boolean {
  const parts = slashes(path).split('/').filter(Boolean);
  const name = parts.pop() ?? '';
  return parts.some((p) => TEST_FOLDERS.has(p.toLowerCase())) || TEST_FILES.some((re) => re.test(name));
}

const SKIP_MARKER =
  /\b(?:it|test|describe|context)\.(?:skip|only|todo)\(|\b(?:xit|xdescribe|xtest|fit|fdescribe)\(|@pytest\.mark\.(?:skip|skipif|xfail)|@unittest\.skip|\[(?:Ignore|Skip)\b|\bSkip\s*=|@(?:Disabled|Ignore)\b|\bt\.Skip(?:f|Now)?\(|#\[ignore\]/;

/** Skip and only markers per file of a unified diff: added minus removed lines that carry one. */
export function skipMarkers(patch: string): { path: string; added: number }[] {
  const counts = new Map<string, number>();
  let path: string | null = null;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      path = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      path = target === '/dev/null' ? null : target.replace(/^"?b\//, '').replace(/"$/, '');
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (inHunk && path && (line.startsWith('+') || line.startsWith('-')) && SKIP_MARKER.test(line.slice(1))) {
      counts.set(path, (counts.get(path) ?? 0) + (line.startsWith('+') ? 1 : -1));
    }
  }
  return [...counts].map(([p, added]) => ({ path: p, added }));
}

/** The `receipt.issued` event without `type`, `sessionId`, `seq` and `ts`. */
export type ReceiptDraft = Omit<SessionEventOf<'receipt.issued'>, 'type' | 'sessionId' | 'seq' | 'ts'>;

const MAX_PATHS = 20;
const finding = (kind: ReceiptFinding['kind'], level: ReceiptFinding['level'], paths: string[], detail: string | null): ReceiptFinding => ({
  kind,
  level,
  paths: paths.slice(0, MAX_PATHS).map((p) => p.slice(0, 400)),
  more: Math.max(0, paths.length - MAX_PATHS),
  detail,
});

/** The receipt for one turn; null when there is nothing to say (a pure chat turn). */
export function buildReceipt(ev: EvidenceState, git: GitTurn): ReceiptDraft | null {
  const claims: ReceiptClaim[] = extractClaims(ev.closing.map((m) => m.text).join('\n')).map((c) => ({ ...c, ...judgeClaim(c.category, ev) }));
  const findings: ReceiptFinding[] = [];
  const changed = git.changed;
  if (changed) {
    const ignored = new Set(git.ignored);
    const phantom = phantomCandidates(ev, changed, git.roots).filter((p) => !ignored.has(p));
    if (phantom.length) findings.push(finding('phantom-edit', 'warning', phantom, null));
    const markers = skipMarkers(git.testPatch).filter((m) => m.added > 0);
    if (markers.length) {
      const n = markers.reduce((sum, m) => sum + m.added, 0);
      findings.push(finding('tests-skipped', 'warning', markers.map((m) => m.path), `${n} marker${n === 1 ? '' : 's'} added`));
    }
    const deleted = changed.filter((c) => c.status === 'deleted' && isTestPath(c.path)).map((c) => c.path);
    if (deleted.length) findings.push(finding('tests-deleted', 'warning', deleted, null));
    const reported = Object.keys(ev.edits).map((k) => slashes(k).replace(/^(?:\.\/)+/, ''));
    const matches = (p: string | null) => !!p && reported.some((r) => r === p || r.endsWith(`/${p}`));
    const unreported = changed.filter((c) => !matches(c.path) && !matches(c.oldPath)).map((c) => c.path);
    if (unreported.length) {
      const n = ev.commands.length;
      const detail = n > 0 ? `${n} command${n === 1 ? '' : 's'} ran in this turn; one of them may have written these files.` : 'No edit or command was reported for these files.';
      findings.push(finding('unreported-change', 'note', unreported, detail));
    }
  }
  const facts: ReceiptFacts = {
    filesChanged: changed ? changed.length : null,
    additions: changed ? changed.reduce((n, c) => n + c.additions, 0) : 0,
    deletions: changed ? changed.reduce((n, c) => n + c.deletions, 0) : 0,
    editsReported: Object.keys(ev.edits).length,
    commands: ev.commands.length,
    commandsFailed: ev.commands.filter((c) => !c.ok).length,
  };
  if (!claims.length && !findings.length && !facts.commands && !facts.filesChanged) return null;
  return { turnId: ev.turnId ?? '', turnIndex: ev.turnIndex, facts, claims: claims.slice(0, 8), findings, passed: passedCategories(ev) };
}

// ------------------------------------------------------------------------------------------------ across turns

/** One receipt as the projection and the host keep it. */
export interface ReceiptState {
  turnId: string;
  turnIndex: number;
  facts: ReceiptFacts;
  claims: ReceiptClaim[];
  findings: ReceiptFinding[];
  passed: VerifyCategory[];
  acknowledged: boolean;
  checks: ReceiptCheck[] | null;
}

export type ClaimVerdict =
  | { status: ClaimStatus }
  | { status: 'confirmed' | 'refuted'; check: string; exitCode: number | null }
  | { status: 'superseded' };

export interface OpenItem {
  turnId: string;
  turnIndex: number;
  /** The line shown in the card, the Review section, the land warning and the notification. */
  text: string;
  /** The same item as a sentence to the agent, for "Ask for proof". */
  ask: string;
}

/** The receipt `receipt.checked` attaches to: the latest at or before the checks' turn. */
export function checkedTarget<T extends Pick<ReceiptState, 'turnIndex'>>(list: readonly T[], turnIndex: number): T | null {
  let best: T | null = null;
  for (const r of list) if (r.turnIndex <= turnIndex && (!best || r.turnIndex > best.turnIndex)) best = r;
  return best;
}

export function receiptFromEvent(e: SessionEventOf<'receipt.issued'>): ReceiptState {
  return { turnId: e.turnId, turnIndex: e.turnIndex, facts: e.facts, claims: e.claims, findings: e.findings, passed: e.passed, acknowledged: false, checks: null };
}

/** Folds receipt events into the list of receipts, in turn order. Other events leave it as it was. */
export function applyReceiptEvent(list: ReceiptState[], e: SessionEvent): ReceiptState[] {
  switch (e.type) {
    case 'receipt.issued': {
      const next = list.filter((r) => r.turnId !== e.turnId);
      next.push(receiptFromEvent(e));
      return next.sort((a, b) => a.turnIndex - b.turnIndex);
    }
    case 'receipt.checked': {
      const target = checkedTarget(list, e.turnIndex);
      return target ? list.map((r) => (r === target ? { ...r, checks: e.checks } : r)) : list;
    }
    case 'receipt.acknowledged':
      return list.map((r) => (r.turnId === e.turnId ? { ...r, acknowledged: true } : r));
    default:
      return list;
  }
}

export const receiptsFrom = (events: readonly SessionEvent[]): ReceiptState[] => events.reduce(applyReceiptEvent, []);

/** A claim's status now: ADE's own checks and later turns can confirm, contradict or close it. */
export function claimVerdict(receipts: readonly ReceiptState[], receipt: Pick<ReceiptState, 'turnIndex'>, claim: Pick<ReceiptClaim, 'category' | 'status'>): ClaimVerdict {
  if (claim.status === 'supported') return { status: 'supported' };
  const attached = receipts.filter((r) => r.turnIndex >= receipt.turnIndex && r.checks).sort((a, b) => b.turnIndex - a.turnIndex);
  for (const r of attached) {
    const relevant = claim.category === 'verified' ? r.checks! : r.checks!.filter((c) => c.categories.includes(claim.category));
    if (!relevant.length) continue;
    const failed = relevant.find((c) => c.exitCode !== 0);
    if (failed) return { status: 'refuted', check: failed.name, exitCode: failed.exitCode };
    return { status: 'confirmed', check: relevant[0]!.name, exitCode: relevant[0]!.exitCode };
  }
  const later = receipts.some((r) => r.turnIndex > receipt.turnIndex && (claim.category === 'verified' ? r.passed.length > 0 : r.passed.includes(claim.category)));
  if (later) return { status: 'superseded' };
  return { status: claim.status };
}

const OPEN_VERDICTS: ReadonlySet<ClaimVerdict['status']> = new Set(['unseen', 'stale', 'contradicted', 'refuted']);
export const isOpenVerdict = (v: ClaimVerdict) => OPEN_VERDICTS.has(v.status);

/** What still needs the user's eye in one receipt: open claims, then warning findings. */
export function receiptOpenItems(receipts: readonly ReceiptState[], r: ReceiptState): OpenItem[] {
  if (r.acknowledged) return [];
  const items: OpenItem[] = [];
  for (const claim of r.claims) {
    const verdict = claimVerdict(receipts, r, claim);
    if (!isOpenVerdict(verdict)) continue;
    items.push({ turnId: r.turnId, turnIndex: r.turnIndex, text: `${claimLead(claim.category)} ${verdictSentence(claim, verdict)}`, ask: askLine(claim, verdict) });
  }
  for (const f of r.findings) {
    if (f.level !== 'warning') continue;
    items.push({ turnId: r.turnId, turnIndex: r.turnIndex, text: findingLine(f), ask: findingAsk(f) });
  }
  return items;
}

/** Every open item across the session's receipts, in turn order. */
export function openItems(receipts: readonly ReceiptState[]): OpenItem[] {
  return [...receipts].sort((a, b) => a.turnIndex - b.turnIndex).flatMap((r) => receiptOpenItems(receipts, r));
}

// ------------------------------------------------------------------------------------------------ copy

const LEAD: Record<VerifyCategory, string> = {
  tests: 'Says the tests pass.',
  build: 'Says the build succeeds.',
  lint: 'Says lint is clean.',
  types: 'Says the type check passes.',
  verified: 'Says it verified the change.',
};
const PHRASE: Record<VerifyCategory, string> = {
  tests: 'the tests pass',
  build: 'the build succeeds',
  lint: 'lint is clean',
  types: 'the type check passes',
  verified: 'you verified the change',
};
const NOUN: Record<VerifyCategory, string> = {
  tests: 'test command',
  build: 'build command',
  lint: 'lint command',
  types: 'type-check command',
  verified: 'command',
};

export const claimLead = (category: VerifyCategory) => LEAD[category];

const exitText = (code: number | null) => (code === null ? 'no exit code' : `exit ${code}`);

/** The sentence after the lead: what ADE saw. */
export function verdictSentence(claim: Pick<ReceiptClaim, 'category' | 'evidence'>, verdict: ClaimVerdict): string {
  switch (verdict.status) {
    case 'unseen':
      return `ADE saw no ${NOUN[claim.category]} in this turn.`;
    case 'stale':
      return `Files changed after the last run: ${claim.evidence ?? ''}.`;
    case 'contradicted':
      return `The last run failed: ${claim.evidence ?? ''}.`;
    case 'supported':
      return `${claim.evidence ?? 'The command'} passed after the last change.`;
    case 'confirmed':
      return `Confirmed by ADE's check ${verdict.check}.`;
    case 'refuted':
      return `Contradicted by ADE's check ${verdict.check} (${exitText(verdict.exitCode)}).`;
    case 'superseded':
      return 'Passed in a later turn.';
  }
}

/** The badge word for a verdict. */
export function statusWord(status: ClaimVerdict['status']): string {
  switch (status) {
    case 'supported':
      return 'Supported';
    case 'stale':
      return 'Out of date';
    case 'contradicted':
    case 'refuted':
      return 'Contradicted';
    case 'unseen':
      return 'Not seen';
    case 'confirmed':
      return 'Confirmed';
    case 'superseded':
      return 'Passed later';
  }
}

const pathList = (f: Pick<ReceiptFinding, 'paths' | 'more'>) => {
  if (!f.more) return f.paths.length > 1 ? `${f.paths.slice(0, -1).join(', ')} and ${f.paths[f.paths.length - 1]}` : (f.paths[0] ?? '');
  return `${f.paths.join(', ')} and ${f.more} more`;
};

/** One line per finding, e.g. "Reported an edit that Git does not see: a.ts, b.ts and 3 more". */
export function findingLine(f: Pick<ReceiptFinding, 'kind' | 'paths' | 'more' | 'detail'>): string {
  switch (f.kind) {
    case 'phantom-edit':
      return `Reported an edit that Git does not see: ${pathList(f)}`;
    case 'unreported-change':
      return `Changed without a reported edit: ${pathList(f)}`;
    case 'tests-skipped':
      return `Tests switched off or narrowed: ${pathList(f)}${f.detail ? ` (${f.detail})` : ''}`;
    case 'tests-deleted':
      return `Test files deleted: ${pathList(f)}`;
  }
}

function askLine(claim: Pick<ReceiptClaim, 'category' | 'evidence'>, verdict: ClaimVerdict): string {
  const said = `You said ${PHRASE[claim.category]}`;
  switch (verdict.status) {
    case 'stale':
      return `${said}, but files changed after the last run (${claim.evidence ?? ''}).`;
    case 'contradicted':
      return `${said}, but the last run failed (${claim.evidence ?? ''}).`;
    case 'refuted':
      return `${said}, but ADE's check ${verdict.check} failed (${exitText(verdict.exitCode)}).`;
    default:
      return `${said}, but no ${NOUN[claim.category]} ran in this turn.`;
  }
}

function findingAsk(f: Pick<ReceiptFinding, 'kind' | 'paths' | 'more'>): string {
  switch (f.kind) {
    case 'phantom-edit':
      return `You reported editing ${pathList(f)}, but Git shows no change there.`;
    case 'tests-skipped':
      return `Tests were switched off or narrowed in ${pathList(f)}.`;
    case 'tests-deleted':
      return `Test files were deleted: ${pathList(f)}.`;
    case 'unreported-change':
      return `${pathList(f)} changed without a reported edit.`;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The receipt's first line, e.g. "3 files changed, 2 commands (1 failed)." */
export function receiptFactsLine(facts: ReceiptFacts): string {
  const files = facts.filesChanged === null ? 'Files changed not known' : plural(facts.filesChanged, 'file') + ' changed';
  const commands = facts.commands ? `${plural(facts.commands, 'command')}${facts.commandsFailed ? ` (${facts.commandsFailed} failed)` : ''}` : 'no commands';
  return `${files}, ${commands}.`;
}

/** "2 things to check." / "1 thing to check." / "Nothing to flag." */
export function toCheckLine(open: number): string {
  return open === 0 ? 'Nothing to flag.' : `${plural(open, 'thing')} to check.`;
}

/** The suggested message for "Ask for proof". The user edits it and sends it themselves. */
export function proofPrompt(items: readonly Pick<OpenItem, 'ask'>[]): string {
  return [
    'Before I review this, back up what you reported.',
    ...items.map((i) => `- ${i.ask}`),
    'Run the commands now and show each command with its full output. Do not change any code first; if something fails, say so.',
  ].join('\n');
}
