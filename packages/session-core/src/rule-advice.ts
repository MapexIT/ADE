import {
  redactSecrets,
  type PermissionRule,
  type RuleAdviceSettings,
  type RuleCaveat,
  type RuleConflict,
  type RuleExample,
  type RuleRehearsal,
  type RuleRisk,
  type RuleSuggestion,
  type RuleUsage,
  type SessionEvent,
  type ToolKind,
} from '@ade/contracts';

/**
 * AP-06 / AP-09: workspace rules. Pure and agent-neutral: it reads only the text of ACP permission requests, so one
 * rule serves every agent. Holds the command anatomy, the chain-safe matcher the host answers requests with, and the
 * shapes and risk classes rule suggestions are built from.
 */

export const RULE_LIMITS = {
  /** Longer command texts are opaque. */
  inputMax: 4_000,
} as const;

/** The parts of a permission request rules look at. */
export interface RequestText {
  kind: ToolKind | null;
  title: string;
  detail: string | null;
}

export interface Anatomy {
  /** One token list per step; empty when `opaque`. */
  steps: string[][];
  /** Shell syntax ADE will not reason about. */
  opaque: boolean;
  /** A shell wrapper (`bash -lc`, `pwsh -Command`, `cmd /c`) was unwrapped. */
  wrapped: boolean;
}

interface Tok {
  text: string;
  quoted: boolean;
}

const opaque = (): Anatomy => ({ steps: [], opaque: true, wrapped: false });

/** Characters a backslash escapes outside quotes. Anything else keeps the backslash (Windows paths). */
const ESCAPABLE = new Set([' ', '\t', '\n', '"', "'", '\\', '$', '`', ';', '&', '|', '<', '>', '(', ')', '*', '?', '{', '}', '#', '!', '[', ']', '~']);
const WORD_END = new Set([' ', '\t', '\n', '\r', ';', '|', '&', '<', '>', '(', ')']);
const NULL_TARGETS = new Set(['/dev/null', 'nul', '$null']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'foreach', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'select', 'switch', 'try', 'trap']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'fish', 'dash', 'ksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const PS_SWITCHES = new Set(['-noprofile', '-nop', '-nologo', '-nol', '-noninteractive', '-noni']);
const PS_VALUED = new Set(['-executionpolicy', '-ep']);

/**
 * Rule 3: a redirection starting just after a `>`. Returns the index after it when it is harmless (`>&N`, or a
 * null device), or -1.
 */
function harmlessRedirect(text: string, k: number): number {
  if (text[k] === '>') return -1; // `>>` appends to a file
  if (text[k] === '&') {
    let j = k + 1;
    while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++;
    return j > k + 1 && (j === text.length || WORD_END.has(text[j]!)) ? j : -1;
  }
  let j = k;
  while (text[j] === ' ' || text[j] === '\t') j++;
  const start = j;
  while (j < text.length && !WORD_END.has(text[j]!)) j++;
  return NULL_TARGETS.has(text.slice(start, j).toLowerCase()) ? j : -1;
}

/** Rules 1 to 4 (the lexical part): tokens per step, or null when the text is opaque. */
function tokenise(text: string): Tok[][] | null {
  const steps: Tok[][] = [];
  let cur: Tok[] = [];
  let buf = '';
  let has = false;
  let quoted = false;
  const flush = () => {
    if (has) cur.push({ text: buf, quoted });
    buf = '';
    has = false;
    quoted = false;
  };
  const endStep = () => {
    flush();
    if (cur.length) steps.push(cur);
    cur = [];
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    // Rule 1: quotes and escapes.
    if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) return null;
      buf += text.slice(i + 1, j);
      has = quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      i++;
      has = quoted = true;
      while (i < n && text[i] !== '"') {
        const ch = text[i]!;
        if (ch === '\\' && i + 1 < n && '"\\$`\n'.includes(text[i + 1]!)) {
          buf += text[i + 1];
          i += 2;
          continue;
        }
        // Rule 4: substitution inside double quotes.
        if (ch === '`' || (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{'))) return null;
        buf += ch;
        i++;
      }
      if (i >= n) return null;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        if (next !== '\n') {
          buf += next;
          has = true;
        }
        i += 2;
        continue;
      }
      buf += c;
      has = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t') {
      flush();
      i++;
      continue;
    }
    // Rule 2: step separators.
    if (c === '\n' || c === '\r' || c === ';') {
      endStep();
      i++;
      continue;
    }
    if (c === '|') {
      endStep();
      i += text[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (text[i + 1] === '&') {
        endStep();
        i += 2;
        continue;
      }
      if (text[i + 1] === '>') {
        flush();
        const end = harmlessRedirect(text, i + 2);
        if (end < 0) return null;
        i = end;
        continue;
      }
      return null; // background, or PowerShell's call operator
    }
    // Rule 3: redirections. A lone digit or `*` before `>` is the stream it redirects.
    if (c === '>') {
      if (has && !quoted && /^(\d|\*)$/.test(buf)) {
        buf = '';
        has = false;
      } else flush();
      const end = harmlessRedirect(text, i + 1);
      if (end < 0) return null;
      i = end;
      continue;
    }
    // Rule 4: substitution, here-documents, subshells, blocks, brace expansion, comments.
    if (c === '<' || c === '`' || c === '(' || c === ')' || c === '}') return null;
    if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) return null;
    if (c === '{') {
      const after = text[i + 2];
      if (!has && text[i + 1] === '}' && (after === undefined || WORD_END.has(after))) {
        buf += '{}';
        has = true;
        i += 2;
        continue;
      }
      return null;
    }
    if (c === '#' && !has) return null;
    buf += c;
    has = true;
    i++;
  }
  endStep();
  return steps;
}

/** Rule 7: the program's base name, lower-cased, without `.exe`, `.cmd`, `.bat` or `.ps1`. */
export function programName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

const DURATION = /^\d+(\.\d+)?[smhd]?$/;

/** Rule 6: strips `time`, `timeout <n>`, `nice`, `nohup` and `command`. */
function stripPrefixes(toks: Tok[]): Tok[] {
  let t = toks;
  for (;;) {
    if (!t.length) return t;
    const p = programName(t[0]!.text);
    if (p === 'time' || p === 'nohup') {
      t = t.slice(p === 'time' && t[1]?.text === '-p' ? 2 : 1);
    } else if (p === 'nice') {
      t = t.slice(t[1]?.text === '-n' ? 3 : /^-\d+$/.test(t[1]?.text ?? '') ? 2 : 1);
    } else if (p === 'timeout') {
      let i = 1;
      while (i < t.length && t[i]!.text.startsWith('-')) i += ['-s', '-k', '--signal', '--kill-after'].includes(t[i]!.text) ? 2 : 1;
      if (i < t.length && DURATION.test(t[i]!.text)) t = t.slice(i + 1);
      else return t;
    } else if (p === 'command') {
      if (t[1] && !t[1].text.startsWith('-')) t = t.slice(1);
      else return t;
    } else return t;
  }
}

/** Rule 5: the script of a shell wrapper, or null when the step is not one. */
function unwrapShell(toks: Tok[]): Tok[] | null {
  const p = programName(toks[0]!.text);
  const at = (i: number) => toks[i]?.text.toLowerCase();
  if (POSIX_SHELLS.has(p)) {
    if (at(1) === '-c' || at(1) === '-lc' || at(1) === '-cl') return toks.slice(2);
    if ((at(1) === '-l' || at(1) === '--login') && at(2) === '-c') return toks.slice(3);
    return null;
  }
  if (POWERSHELLS.has(p)) {
    let i = 1;
    for (;;) {
      const a = at(i);
      if (a !== undefined && PS_SWITCHES.has(a)) i++;
      else if (a !== undefined && PS_VALUED.has(a)) i += 2;
      else break;
    }
    return at(i) === '-command' || at(i) === '-c' ? toks.slice(i + 1) : null;
  }
  if (p === 'cmd') {
    let i = 1;
    while (at(i) === '/s' || at(i) === '/d' || at(i) === '/q') i++;
    return at(i) === '/c' ? toks.slice(i + 1) : null;
  }
  return null;
}

/** Rule 4 (the parts that look at a step's first word). */
const startsOpaque = (t: Tok) => !t.quoted && (ASSIGNMENT.test(t.text) || t.text.startsWith('$') || KEYWORDS.has(t.text.toLowerCase()));

function analyse(text: string, depth: number): Anatomy {
  // Rule 8.
  if (text.length > RULE_LIMITS.inputMax) return opaque();
  const raw = tokenise(text);
  if (!raw) return opaque();
  const out: Anatomy = { steps: [], opaque: false, wrapped: false };
  const step = (input: Tok[], level: number): boolean => {
    if (!input.length || startsOpaque(input[0]!)) return false;
    const toks = stripPrefixes(input);
    if (!toks.length || startsOpaque(toks[0]!)) return false;
    const script = level === 0 ? unwrapShell(toks) : null;
    if (!script) {
      out.steps.push(toks.map((t) => t.text));
      return true;
    }
    out.wrapped = true;
    if (!script.length) return false;
    if (script.length === 1) {
      const inner = analyse(script[0]!.text, level + 1);
      if (inner.opaque) return false;
      out.steps.push(...inner.steps);
      return true;
    }
    // `bash -c 'script' arg`: positional arguments ADE does not follow.
    if (script[0]!.quoted) return false;
    // An argument array joined with spaces lost its quotes, so the rest are the script's own words.
    return step(script, level + 1);
  };
  for (const s of raw) if (!step(s, depth)) return opaque();
  return out;
}

/** AP-09 section 6.2: splits a command text into steps, or calls it opaque. Pure. */
export function commandAnatomy(text: string): Anatomy {
  return analyse(text.trim(), 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Matching (section 6.3)

const regexCache = new Map<string, RegExp>();

/**
 * `*` matches anything; everything else is literal. The whole text must match, ignoring case. A pattern that ends
 * in ` *` also matches the text without that tail (`git status *` matches `git status`). Pure.
 */
export function ruleRegExp(pattern: string): RegExp {
  const cached = regexCache.get(pattern);
  if (cached) return cached;
  const p = pattern.trim();
  const escape = (s: string) =>
    s
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
  const tail = p.length > 2 && p.endsWith(' *');
  const body = tail ? `${escape(p.slice(0, -2))}(?: .*)?` : escape(p);
  const re = new RegExp(`^${body}$`, 'is');
  if (regexCache.size > 1_000) regexCache.clear();
  regexCache.set(pattern, re);
  return re;
}

const fits = (rule: PermissionRule, kind: ToolKind | null) => rule.kind === 'any' || rule.kind === kind;

/** Whether a rule's kind fits and its pattern matches the whole text. */
export function ruleMatchesText(rule: PermissionRule, kind: ToolKind | null, text: string): boolean {
  return fits(rule, kind) && ruleRegExp(rule.pattern).test(text.trim());
}

/** The texts rules are matched against: the request's title and its command. */
export function requestTexts(req: RequestText): string[] {
  return [req.title, req.detail].flatMap((t) => (t && t.trim() ? [t.trim()] : []));
}

/** Commands, and requests whose kind the agent did not say, get the chain rules. */
const chainSafe = (kind: ToolKind | null) => kind === 'execute' || kind === null;

const anatomyCache = new Map<string, Anatomy>();
function anatomyOf(text: string): Anatomy {
  const hit = anatomyCache.get(text);
  if (hit) return hit;
  const a = commandAnatomy(text);
  if (anatomyCache.size > 5_000) anatomyCache.clear();
  anatomyCache.set(text, a);
  return a;
}

const joinedCache = new WeakMap<Anatomy, string[]>();
/** Each step's tokens joined with single spaces, which is what rules match a step against. */
function stepTexts(a: Anatomy): string[] {
  let joined = joinedCache.get(a);
  if (!joined) {
    joined = a.steps.map((s) => s.join(' '));
    joinedCache.set(a, joined);
  }
  return joined;
}

/** Whether a rule matches any whole text of the request or, for commands, any step. Cheap; used to skip work. */
export function ruleTouches(rule: PermissionRule, req: RequestText): boolean {
  if (!fits(rule, req.kind)) return false;
  const re = ruleRegExp(rule.pattern);
  for (const text of requestTexts(req)) {
    if (re.test(text)) return true;
    if (!chainSafe(req.kind)) continue;
    const a = anatomyOf(text);
    if (!a.opaque && stepTexts(a).some((s) => re.test(s))) return true;
  }
  return false;
}

export type Coverage = 'answers' | 'held-back' | 'no-match';
const RANK: Record<Coverage, number> = { 'no-match': 0, 'held-back': 1, answers: 2 };

/**
 * Whether the allow rules answer a request. A rule without `*` that equals a whole text answers it. For commands, a
 * wildcard rule answers one plain step; a command of several steps is answered only when every step is matched by
 * some allow rule; opaque shell syntax is never answered by a wildcard (`held-back`). Other kinds match as in AP-06.
 */
export function allowCoverage(rules: PermissionRule[], req: RequestText): { coverage: Coverage; rule: PermissionRule | null } {
  const allows = rules.filter((r) => r.decision === 'allow' && fits(r, req.kind));
  let best: { coverage: Coverage; rule: PermissionRule | null } = { coverage: 'no-match', rule: null };
  const offer = (coverage: Coverage, rule: PermissionRule) => {
    if (RANK[coverage] > RANK[best.coverage]) best = { coverage, rule };
  };
  if (!allows.length) return best;
  for (const text of requestTexts(req)) {
    const matching = allows.filter((r) => ruleRegExp(r.pattern).test(text));
    const exact = matching.find((r) => !r.pattern.includes('*'));
    if (exact) {
      offer('answers', exact);
      continue;
    }
    const whole = matching[0] ?? null;
    if (!chainSafe(req.kind)) {
      if (whole) offer('answers', whole);
      continue;
    }
    const a = anatomyOf(text);
    if (a.opaque) {
      if (whole) offer('held-back', whole);
      continue;
    }
    if (whole && a.steps.length === 1 && !a.wrapped) {
      offer('answers', whole);
      continue;
    }
    const stepRules = stepTexts(a).map((joined) => allows.find((r) => ruleRegExp(r.pattern).test(joined)) ?? null);
    if (a.steps.length && stepRules.every((r) => r !== null)) offer('answers', whole ?? stepRules[0]!);
    else if (whole) offer('held-back', whole);
  }
  return best;
}

/** The first deny rule that matches a whole text or, for commands that are not opaque, any one step. */
export function denyMatch(rules: PermissionRule[], req: RequestText): PermissionRule | null {
  const denies = rules.filter((r) => r.decision === 'deny' && fits(r, req.kind));
  if (!denies.length) return null;
  const texts = requestTexts(req);
  for (const rule of denies) {
    const re = ruleRegExp(rule.pattern);
    for (const text of texts) {
      if (re.test(text)) return rule;
      if (!chainSafe(req.kind)) continue;
      const a = anatomyOf(text);
      if (!a.opaque && stepTexts(a).some((s) => re.test(s))) return rule;
    }
  }
  return null;
}

/** AP-06 with AP-09's chain rule: deny first (any step), then an allow that covers the whole request. */
export function decideByRules(rules: PermissionRule[], req: RequestText): { decision: 'allow' | 'deny'; rule: PermissionRule } | null {
  const deny = denyMatch(rules, req);
  if (deny) return { decision: 'deny', rule: deny };
  const allow = allowCoverage(rules, req);
  return allow.coverage === 'answers' && allow.rule ? { decision: 'allow', rule: allow.rule } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Shapes and risk (section 6.4)

export interface Shape {
  /** Lower-cased program and stem words; for `exact` shapes the whole normalised step. */
  key: string;
  /** The stem as written, e.g. ['git', 'status'], ['npm', 'run', 'lint'], ['ls']. */
  stem: string[];
  risk: RuleRisk;
  caveats: RuleCaveat[];
}

const set = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

/** Programs never offered as allow rules (a deny suggestion is fine). */
export const NEVER_PROGRAMS = set(`
  rm rmdir del erase rd remove-item ri mv move move-item ren rename-item dd mkfs format shutdown restart-computer stop-computer
  kill taskkill pkill killall stop-process sudo su doas runas chmod chown chgrp icacls takeown
  curl wget invoke-webrequest iwr irm invoke-restmethod nc ncat netcat telnet ssh scp sftp rsync ftp
  eval exec source . export set setx declare typeset alias unalias env xargs iex invoke-expression invoke-command
  start-process saps npx bunx pnpx uvx pipx docker podman kubectl helm terraform
  bash sh zsh fish dash ksh pwsh powershell cmd`);
const NEVER_GIT = set(`push reset clean checkout restore switch rebase merge commit stash config remote gc filter-branch
  filter-repo update-ref worktree submodule apply am cherry-pick revert tag pull fetch clone init rm mv prune notes replace`);
const PACKAGE_MANAGERS = set('npm pnpm yarn bun');
const PACKAGE_NEVER = set(`publish install i ci add remove rm uninstall un update up upgrade link unlink login logout adduser
  config set exec x dlx create init pack deprecate dist-tag owner token access unpublish`);
const PACKAGE_PROJECT = set('test t lint typecheck build');
const PY_MANAGERS = set('pip pip3 uv poetry');
const PY_NEVER = set('install add remove publish uninstall sync lock');
const GH_READ = new Set(['pr view', 'pr list', 'pr status', 'pr diff', 'pr checks', 'issue view', 'issue list', 'run view', 'run list', 'repo view']);
export const READ_PROGRAMS = set(`ls dir pwd cd cat type head tail wc which where whoami rg grep tree stat file basename dirname
  date echo get-childitem gci get-content gc get-location gl select-string sls test-path`);
const READ_GIT = set('status diff log show rev-parse ls-files blame grep describe shortlog');
const PROJECT_PROGRAMS = set('pytest vitest jest mocha tsc eslint biome prettier ruff mypy pyright');
const PROJECT_SUB: Record<string, Set<string>> = {
  cargo: set('test build check clippy fmt'),
  go: set('test build vet fmt'),
  dotnet: set('test build format'),
  mvn: set('test build verify check assemble'),
  mvnw: set('test build verify check assemble'),
  gradle: set('test build verify check assemble'),
  gradlew: set('test build verify check assemble'),
};
/** Tools whose first argument is a subcommand that belongs to the stem. */
const MULTI = set('git npm pnpm yarn bun cargo go dotnet gh docker kubectl make just mvn mvnw gradle gradlew nx turbo deno pip pip3 uv poetry');
const PY = set('python python3 py');

const isFlag = (t: string | undefined) => t === undefined || t.startsWith('-');

/** The stem, risk and caveats of one step. Pure. */
export function shapeOfStep(tokens: string[]): Shape {
  const prog = programName(tokens[0] ?? '');
  const args = tokens.slice(1);
  const lower = args.map((a) => a.toLowerCase());
  const sub = lower[0];
  const make = (stemLen: number, risk: RuleRisk): Shape => {
    const stem = tokens.slice(0, stemLen);
    const key = risk === 'exact' ? `exact:${[prog, ...lower].join(' ')}` : [prog, ...lower.slice(0, stemLen - 1)].join(' ');
    return { key, stem, risk, caveats: risk === 'project' ? ['repo-script', 'not-a-sandbox'] : ['not-a-sandbox'] };
  };
  const multiLen = MULTI.has(prog) && !isFlag(sub) ? 2 : 1;

  if (NEVER_PROGRAMS.has(prog)) return make(multiLen, 'never');
  if (prog === 'git') {
    if (isFlag(sub)) return make(1, lower.some((a) => NEVER_GIT.has(a)) ? 'never' : 'exact');
    return make(2, NEVER_GIT.has(sub!) ? 'never' : READ_GIT.has(sub!) ? 'read' : 'exact');
  }
  if (PACKAGE_MANAGERS.has(prog)) {
    if (isFlag(sub)) return make(1, 'exact');
    if (PACKAGE_NEVER.has(sub!)) return make(2, 'never');
    if (sub === 'run' || sub === 'run-script') return isFlag(lower[1]) ? make(2, 'exact') : make(3, 'project');
    return make(2, PACKAGE_PROJECT.has(sub!) ? 'project' : 'exact');
  }
  if (PY_MANAGERS.has(prog)) return make(multiLen, sub && PY_NEVER.has(sub) ? 'never' : 'exact');
  if (prog === 'gh') {
    if (isFlag(sub) || isFlag(lower[1])) return make(multiLen, 'never');
    return make(3, GH_READ.has(`${sub} ${lower[1]}`) ? 'read' : 'never');
  }
  if (prog in PROJECT_SUB) return make(multiLen, sub && PROJECT_SUB[prog]!.has(sub) ? 'project' : 'exact');
  if (prog === 'make' || prog === 'just') return make(multiLen, 'project');
  if (prog === 'nx' || prog === 'turbo') return sub === 'run' && !isFlag(lower[1]) ? make(3, 'project') : make(multiLen, 'exact');
  if (PY.has(prog) && sub === '-m' && !isFlag(lower[1])) return make(3, ['pytest', 'unittest', 'mypy', 'ruff'].includes(lower[1]!) ? 'project' : 'exact');
  if (prog === 'node' && sub === '--test') return make(2, 'project');
  if (PROJECT_PROGRAMS.has(prog)) return make(1, 'project');
  if (READ_PROGRAMS.has(prog)) return make(1, 'read');
  return make(multiLen, 'exact');
}

/** The command text of a request: its detail, else its title without one pair of surrounding backticks. */
export function commandText(req: RequestText): string {
  const detail = req.detail?.trim();
  if (detail) return detail;
  const title = req.title.trim();
  return title.length > 1 && title.startsWith('`') && title.endsWith('`') ? title.slice(1, -1).trim() : title;
}

/** One shape per step; [] when the request is not a command, has no text or is opaque. */
export function shapesOf(req: RequestText): Shape[] {
  if (req.kind !== 'execute') return [];
  const text = commandText(req);
  if (!text) return [];
  const a = anatomyOf(text);
  return a.opaque ? [] : a.steps.map(shapeOfStep);
}

// ---------------------------------------------------------------------------------------------------------------
// History, suggestions, rehearsal and usage (section 6.5)

export const RULE_ADVICE_LIMITS = {
  /** Allow suggestions need this many approvals unless the settings say otherwise. */
  threshold: 3,
  /** Deny suggestions need this many rejections. */
  denyThreshold: 2,
  unusedDays: 30,
  suggestions: 10,
  conflicts: 5,
  covers: 10,
  textMax: 300,
  patternMax: 500,
} as const;

/** One request the user, a rule or a profile answered. */
export interface Decided {
  requestId: string;
  sessionId: string;
  sessionTitle: string;
  agentId: string;
  ts: string;
  req: RequestText;
  outcome: 'allowed' | 'rejected';
  by: 'user' | { rule: string } | 'other';
}

/** Suggestion key to `{ forever, at }`; `at` is the evidence count when it was dismissed. */
export type Dismissed = Record<string, { forever: boolean; at: number }>;

const isUser = (d: Decided) => d.by === 'user';
const byRule = (d: Decided, id: string) => typeof d.by === 'object' && d.by.rule === id;

/**
 * Pairs each `permission.requested` with its `permission.decided`. Cancelled and undecided requests and questions
 * (`think`) are dropped; the outcome comes from the kind of the option chosen. Input oldest first; output too.
 */
export function foldDecisions(
  events: readonly SessionEvent[],
  meta: (sessionId: string) => { title: string; agentId: string } | null,
): Decided[] {
  const requests = new Map<string, Extract<SessionEvent, { type: 'permission.requested' }>>();
  const out: Decided[] = [];
  for (const e of events) {
    if (e.type === 'permission.requested') {
      requests.set(e.requestId, e);
      continue;
    }
    if (e.type !== 'permission.decided') continue;
    const r = requests.get(e.requestId);
    if (!r || r.kind === 'think' || e.decision.outcome !== 'selected') continue;
    const optionId = e.decision.optionId;
    const option = r.options.find((o) => o.optionId === optionId);
    if (!option) continue;
    requests.delete(e.requestId);
    const m = meta(r.sessionId);
    out.push({
      requestId: r.requestId,
      sessionId: r.sessionId,
      sessionTitle: m?.title ?? '',
      agentId: m?.agentId ?? '',
      ts: e.ts,
      req: { kind: r.kind, title: r.title, detail: r.detail },
      outcome: option.kind.startsWith('allow') ? 'allowed' : 'rejected',
      by: e.decidedBy === 'user' ? 'user' : e.decidedBy.startsWith('rule:') ? { rule: e.decidedBy.slice(5) } : 'other',
    });
  }
  return out;
}

const shown = (text: string) => redactSecrets(text).slice(0, RULE_ADVICE_LIMITS.textMax);

/** Distinct texts, most frequent first (ties: newest first). */
function examples(texts: string[], max: number): { list: RuleExample[]; more: number } {
  const counts = new Map<string, number>();
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = shown(texts[i]!);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const all = [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
  return { list: all.slice(0, max), more: Math.max(0, all.length - max) };
}

const distinct = (xs: string[], max = 10) => [...new Set(xs.filter(Boolean))].slice(0, max);

/** Whether the candidate rule answers this request, given the other rules. */
function candidateAnswer(candidate: PermissionRule, others: PermissionRule[], req: RequestText): 'allow' | 'deny' | 'held-back' | null {
  // A rule that matches neither a whole text nor a step changes nothing.
  if (!ruleTouches(candidate, req)) return null;
  const full = [candidate, ...others];
  const deny = denyMatch(full, req);
  if (deny) return deny.id === candidate.id ? 'deny' : null;
  if (candidate.decision === 'deny') return null;
  const alone = allowCoverage([candidate], req).coverage;
  // Answered with the candidate, and the candidate matches the request itself or is what makes the difference.
  if (allowCoverage(full, req).coverage === 'answers') return alone !== 'no-match' || allowCoverage(others, req).coverage !== 'answers' ? 'allow' : null;
  return alone === 'held-back' ? 'held-back' : null;
}

const preparedCache = new WeakMap<readonly Decided[], { users: Decided[]; exact: Map<string, Decided[]> }>();

/** The user's decisions in order, and an index from each lower-cased text and step to the decisions that have it. */
function prepared(history: readonly Decided[]) {
  let p = preparedCache.get(history);
  if (p) return p;
  const users = history.filter(isUser);
  const exact = new Map<string, Decided[]>();
  for (const d of users) {
    const keys = new Set<string>();
    for (const text of requestTexts(d.req)) {
      keys.add(text.toLowerCase());
      if (!chainSafe(d.req.kind)) continue;
      const a = anatomyOf(text);
      if (!a.opaque) for (const st of stepTexts(a)) keys.add(st.toLowerCase());
    }
    for (const k of keys) {
      const list = exact.get(k);
      if (list) list.push(d);
      else exact.set(k, [d]);
    }
  }
  p = { users, exact };
  preparedCache.set(history, p);
  return p;
}

/**
 * Replays a rule over the requests the user decided by hand. The candidate replaces any rule with its id; a deny
 * rule among the others shadows it. Example texts are redacted and cut to 300 characters.
 */
export function rehearse(candidate: PermissionRule, rules: PermissionRule[], history: readonly Decided[]): RuleRehearsal {
  const others = rules.filter((r) => r.id !== candidate.id);
  const { users, exact } = prepared(history);
  // A rule without `*` can only touch requests with a text or step equal to it, so look those up.
  const pool = candidate.pattern.includes('*') ? users : (exact.get(candidate.pattern.trim().toLowerCase()) ?? []);
  const considered = users.length;
  let agree = 0;
  let heldBack = 0;
  const conflicts: RuleConflict[] = [];
  const answered: Decided[] = [];
  for (const d of pool) {
    const a = candidateAnswer(candidate, others, d.req);
    if (a === 'held-back') heldBack++;
    if (a !== 'allow' && a !== 'deny') continue;
    answered.push(d);
    if ((a === 'allow') === (d.outcome === 'allowed')) agree++;
    else conflicts.push({ text: shown(commandText(d.req)), ts: d.ts, sessionTitle: d.sessionTitle.slice(0, 200), decided: d.outcome });
  }
  const covers = examples(
    answered.map((d) => commandText(d.req)),
    RULE_ADVICE_LIMITS.covers,
  );
  return {
    considered,
    wouldAnswer: answered.length,
    agree,
    conflict: conflicts.length,
    conflicts: conflicts.reverse().slice(0, RULE_ADVICE_LIMITS.conflicts),
    covers: covers.list,
    moreCovers: covers.more,
    heldBack,
    agents: distinct(answered.map((d) => d.agentId)),
  };
}

interface Evidence {
  decided: Decided;
  /** The step's text: the original text for a plain one-step request, else its tokens joined with spaces. */
  text: string;
  stem: string[];
}

interface Group {
  shape: Shape;
  allowed: Evidence[];
  rejected: Evidence[];
}

const normal = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/** Groups the user's decisions by shape. A request counts once for each distinct shape among its steps. */
function groups(history: readonly Decided[]): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const d of history) {
    if (!isUser(d) || d.req.kind !== 'execute') continue;
    const text = commandText(d.req);
    if (!text) continue;
    const a = anatomyOf(text);
    if (a.opaque) continue;
    const plain = a.steps.length === 1 && !a.wrapped;
    const seen = new Set<string>();
    for (const s of a.steps) {
      const shape = shapeOfStep(s);
      if (seen.has(shape.key)) continue;
      seen.add(shape.key);
      const g = out.get(shape.key) ?? { shape, allowed: [], rejected: [] };
      g.shape = shape;
      (d.outcome === 'allowed' ? g.allowed : g.rejected).push({ decided: d, text: plain ? text : s.join(' '), stem: shape.stem });
      out.set(shape.key, g);
    }
  }
  return out;
}

/**
 * AP-09: rules suggested by the user's own repeated decisions. Allow: `threshold` approvals of a shape whose risk is
 * not `never` and no rejection the pattern covers. Deny: 2 rejections and no approval it covers. Never a pattern
 * an existing rule already answers, one with a secret in it, or one dismissed. Sorted by how much it would answer.
 */
export function suggest(history: readonly Decided[], rules: PermissionRule[], dismissed: Dismissed, settings: RuleAdviceSettings): RuleSuggestion[] {
  const threshold = settings.threshold;
  const out: RuleSuggestion[] = [];
  for (const g of groups(history).values()) {
    for (const decision of ['allow', 'deny'] as const) {
      const evidence = decision === 'allow' ? g.allowed : g.rejected;
      if (evidence.length < (decision === 'allow' ? threshold : RULE_ADVICE_LIMITS.denyThreshold)) continue;
      if (decision === 'allow' && g.shape.risk === 'never') continue;
      const newest = evidence.at(-1)!;
      const stemPattern = `${newest.stem.join(' ')} *`;
      let pattern = stemPattern;
      let wider: string | null = null;
      if (g.shape.risk === 'exact') pattern = newest.text;
      else if (decision === 'allow' && evidence.every((e) => normal(e.text) === normal(newest.text))) {
        pattern = newest.text;
        wider = stemPattern;
      }
      if (pattern.length > RULE_ADVICE_LIMITS.patternMax || redactSecrets(pattern) !== pattern) continue;
      if (wider && (wider.length > RULE_ADVICE_LIMITS.patternMax || redactSecrets(wider) !== wider)) wider = null;
      // An existing rule already answers this step.
      if (decideByRules(rules, { kind: 'execute', title: newest.text, detail: newest.text })) continue;
      const key = `${decision}:${g.shape.key}`.slice(0, 200);
      const count = g.allowed.length + g.rejected.length;
      const d = dismissed[key];
      if (d && (d.forever || count < d.at + threshold)) continue;
      const candidate: PermissionRule = { id: `suggestion:${key}`.slice(0, 200), decision, kind: 'execute', pattern };
      const rehearsal = rehearse(candidate, rules, history);
      if (rehearsal.conflict > 0) continue;
      if (wider && rehearse({ ...candidate, pattern: wider }, rules, history).conflict > 0) wider = null;
      const all = [...g.allowed, ...g.rejected].map((e) => e.decided);
      out.push({
        key,
        decision,
        kind: 'execute',
        pattern,
        wider,
        risk: g.shape.risk,
        caveats: g.shape.caveats,
        evidence: {
          allowed: g.allowed.length,
          rejected: g.rejected.length,
          sessions: new Set(all.map((x) => x.sessionId)).size,
          agents: distinct(all.map((x) => x.agentId)),
          lastTs: newest.decided.ts,
          lastRequestId: newest.decided.requestId,
        },
        rehearsal,
      });
    }
  }
  return out
    .sort((a, b) => b.rehearsal.wouldAnswer - a.rehearsal.wouldAnswer || b.evidence.lastTs.localeCompare(a.evidence.lastTs))
    .slice(0, RULE_ADVICE_LIMITS.suggestions);
}

/** The evidence count behind a suggestion key (stored when it is dismissed), or 0. */
export function evidenceCount(history: readonly Decided[], key: string): number {
  const g = groups(history).get(key.slice(key.indexOf(':') + 1));
  return g ? g.allowed.length + g.rejected.length : 0;
}

const DAY = 86_400_000;

/**
 * Per rule: how often it answered, when it last did, which commands it answered that the user never approved by
 * hand (allow rules only), whether it went unused for 30 days (only when its age is known), and its rehearsal.
 */
export function usage(rules: PermissionRule[], history: readonly Decided[], ruleAges: Record<string, string | null>, now: number): RuleUsage[] {
  const approved = new Set(history.filter((d) => isUser(d) && d.outcome === 'allowed').map((d) => normal(commandText(d.req))));
  const old = (ts: string) => now - Date.parse(ts) >= RULE_ADVICE_LIMITS.unusedDays * DAY;
  return rules.map((rule) => {
    const mine = history.filter((d) => byRule(d, rule.id));
    const lastTs = mine.reduce<string | null>((a, d) => (a === null || d.ts > a ? d.ts : a), null);
    const created = ruleAges[rule.id] ?? null;
    const unseen = rule.decision === 'allow' ? mine.map((d) => commandText(d.req)).filter((t) => !approved.has(normal(t))) : [];
    return {
      ruleId: rule.id,
      answered: mine.length,
      lastTs,
      unused: created !== null && old(created) && (lastTs === null || old(lastTs)),
      unseen: examples(unseen, 10).list,
      rehearsal: rehearse(rule, rules, history),
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Copy (UK English, sentence case), shared by the host tests and the renderer

const times = (n: number) => `${n} ${n === 1 ? 'time' : 'times'}`;
const requestsWord = (n: number) => `${n} ${n === 1 ? 'request' : 'requests'}`;

/** The command a suggestion is about: its pattern without a trailing ` *`. */
export const suggestionSubject = (s: Pick<RuleSuggestion, 'pattern'>) => (s.pattern.endsWith(' *') ? s.pattern.slice(0, -2) : s.pattern);

/** The hint under a decided request, in three parts so the command can be set in a monospaced font. */
export function hintParts(s: Pick<RuleSuggestion, 'pattern' | 'decision' | 'evidence'>): [string, string, string] {
  const n = s.decision === 'allow' ? s.evidence.allowed : s.evidence.rejected;
  return [`You have ${s.decision === 'allow' ? 'allowed' : 'rejected'} `, suggestionSubject(s), ` ${times(n)} in this repository.`];
}
export const hintText = (s: Pick<RuleSuggestion, 'pattern' | 'decision' | 'evidence'>) => hintParts(s).join('');

export const RISK_WORDS: Record<RuleRisk, string> = {
  read: 'Reads only',
  project: 'Runs project code',
  exact: 'Exact command only',
  never: 'Not offered as an allow rule',
};

export const CAVEAT_TEXT: Record<RuleCaveat, string> = {
  'repo-script': 'Runs code from the repository, which an agent can change.',
  'not-a-sandbox': 'A rule matches the words of a request. It is not a sandbox.',
};

export const decisionWords = (d: 'allow' | 'deny') => (d === 'allow' ? 'Allow without asking' : 'Reject without asking');

export function rehearsalText(r: Pick<RuleRehearsal, 'considered' | 'wouldAnswer' | 'conflict'>): string {
  if (r.considered === 0) return 'There are no requests you decided yourself in this repository yet.';
  if (r.wouldAnswer === 0) return `Would not have answered any of your last ${requestsWord(r.considered)}.`;
  const head = `Would have answered ${r.wouldAnswer} of your last ${requestsWord(r.considered)}`;
  if (r.conflict === 0) return r.wouldAnswer === 1 ? `${head}, the way you decided.` : `${head}, each the way you decided.`;
  return `${head}, ${r.conflict} against your decision.`;
}

export const heldBackText = (n: number) => `${n} more matched, but had extra steps or shell syntax, so ADE would still ask.`;

/** "From Claude Code and Codex." with names from the caller's label function. */
export function agentsText(ids: readonly string[], label: (id: string) => string): string {
  const names = ids.filter(Boolean).map(label);
  if (!names.length) return '';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
  return `From ${list}.`;
}

export function evidenceText(e: Pick<RuleSuggestion['evidence'], 'allowed' | 'rejected' | 'sessions'>, decision: 'allow' | 'deny'): string {
  const [main, other, mainWord, otherWord] =
    decision === 'allow' ? [e.allowed, e.rejected, 'Allowed', 'rejected'] : [e.rejected, e.allowed, 'Rejected', 'allowed'];
  const second = other === 0 ? `never ${otherWord}` : `${otherWord} ${times(other)}`;
  return `${mainWord} ${times(main)}, ${second}, in ${e.sessions} ${e.sessions === 1 ? 'session' : 'sessions'}.`;
}

export const formatRuleDate = (ts: string) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

export function usageText(u: Pick<RuleUsage, 'answered' | 'lastTs'>): string {
  if (u.answered === 0 || !u.lastTs) return 'Has not answered a request yet.';
  return `Answered ${requestsWord(u.answered)}, last on ${formatRuleDate(u.lastTs)}.`;
}

export const UNUSED_TEXT = 'Not used in 30 days.';

export const unseenText = (n: number) => `Answered ${n} ${n === 1 ? 'command' : 'commands'} you never approved yourself`;
