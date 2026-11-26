import type { PermissionRule, RuleCaveat, RuleRisk, ToolKind } from '@ade/contracts';

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
    const stepRules = a.steps.map((s) => {
      const joined = s.join(' ');
      return allows.find((r) => ruleRegExp(r.pattern).test(joined)) ?? null;
    });
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
      if (!a.opaque && a.steps.some((s) => re.test(s.join(' ')))) return rule;
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
