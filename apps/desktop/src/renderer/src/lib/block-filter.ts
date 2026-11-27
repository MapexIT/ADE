/**
 * SM-20: filtering a finished block's output. Pure: no DOM, no IPC, unit-tested. Regular expressions the user types
 * run in a worker through `filterInWorker`, so a runaway pattern cannot freeze the window.
 */

export interface FilterOptions {
  query: string;
  regex: boolean;
  matchCase: boolean;
  /** "Hide matching lines": shows the lines that do not match. */
  invert: boolean;
  /** Lines shown before and after each hit, 0 to 9. */
  context: number;
}

export interface FilterRow {
  /** Original line number, from 1. */
  n: number;
  text: string;
  /** A line that matched (or, inverted, one that did not); false for a context line. */
  hit: boolean;
  /** Lines were skipped before this row. */
  gapBefore: boolean;
  /** Matched character ranges [start, end) for highlighting; empty when inverted or for context lines. */
  ranges: [number, number][];
}

export interface FilterResult {
  rows: FilterRow[];
  matched: number;
  total: number;
}

export type FilterOutcome = (FilterResult & { error?: undefined }) | { error: 'invalid' | 'slow' };

/** Lines longer than this are cut for display; matching still runs on the whole line. */
export const DISPLAY_LINE = 2000;
export const MAX_CONTEXT = 9;
/** Regular expressions get this long in the worker before they are stopped. */
export const REGEX_BUDGET_MS = 250;
const MAX_RANGES = 50;

/**
 * Splits output into lines on `\r?\n`. A line with a lone `\r` (a progress bar redrawn in place) keeps only its last
 * non-empty segment, the state the user saw. A trailing newline does not make an empty last line.
 */
export function splitLines(output: string): string[] {
  if (!output) return [];
  const lines = output.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => {
    if (!line.includes('\r')) return line;
    const parts = line.split('\r').filter((p) => p !== '');
    return parts[parts.length - 1] ?? '';
  });
}

/** One fixed, linear pattern: error, warning, failed, exception, traceback and panic, as whole words. */
export const ERRORS_PRESET = /\b(?:errors?|warn(?:ing)?s?|fail(?:ed|ure|ures|s)?|exceptions?|traceback|panic(?:ked)?|fatal)\b/i;

/** Builds the line test for a query, or throws when a regular expression is not valid. */
export function matcher(opts: Pick<FilterOptions, 'query' | 'regex' | 'matchCase'>): (line: string) => [number, number][] | null {
  if (opts.regex) {
    const re = new RegExp(opts.query, opts.matchCase ? 'g' : 'gi');
    return (line) => {
      re.lastIndex = 0;
      const ranges: [number, number][] = [];
      let hit = false;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) {
        hit = true;
        if (m[0] === '') {
          // An empty match (`^`, `\b`) selects the line but has nothing to highlight.
          re.lastIndex++;
          continue;
        }
        ranges.push([m.index, m.index + m[0].length]);
        if (ranges.length >= MAX_RANGES) break;
      }
      return hit ? ranges : null;
    };
  }
  const needle = opts.matchCase ? opts.query : opts.query.toLowerCase();
  return (line) => {
    const hay = opts.matchCase ? line : line.toLowerCase();
    let at = hay.indexOf(needle);
    if (at === -1) return null;
    const ranges: [number, number][] = [];
    while (at !== -1 && ranges.length < MAX_RANGES) {
      ranges.push([at, at + needle.length]);
      at = hay.indexOf(needle, at + needle.length);
    }
    return ranges;
  };
}

/** The errors preset as a line test (no user pattern, so it runs on the main thread). */
export function errorsMatcher(line: string): [number, number][] | null {
  const re = new RegExp(ERRORS_PRESET.source, 'gi');
  const ranges: [number, number][] = [];
  for (const m of line.matchAll(re)) {
    ranges.push([m.index, m.index + m[0].length]);
    if (ranges.length >= MAX_RANGES) break;
  }
  return ranges.length ? ranges : null;
}

/**
 * Keeps the lines a test selects, plus `context` lines each side. Overlapping context ranges merge, so no line shows
 * twice; `gapBefore` marks where lines were skipped.
 */
export function selectLines(lines: string[], test: (line: string, index: number) => [number, number][] | null, opts: { invert: boolean; context: number }): FilterResult {
  const context = Math.max(0, Math.min(MAX_CONTEXT, Math.floor(opts.context)));
  const hits: ([number, number][] | null)[] = lines.map((l, i) => {
    const r = test(l, i);
    if (opts.invert) return r ? null : [];
    return r;
  });
  const keep = new Array<boolean>(lines.length).fill(false);
  let matched = 0;
  hits.forEach((h, i) => {
    if (!h) return;
    matched++;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const rows: FilterRow[] = [];
  let last = -1;
  keep.forEach((k, i) => {
    if (!k) return;
    const h = hits[i];
    rows.push({ n: i + 1, text: lines[i]!, hit: !!h, gapBefore: last === -1 ? i > 0 : i > last + 1, ranges: h && !opts.invert ? h : [] });
    last = i;
  });
  return { rows, matched, total: lines.length };
}

/** Filters lines by a plain text or regular expression query. An empty query returns every line. */
export function filterLines(lines: string[], opts: FilterOptions): FilterResult {
  if (!opts.query) return selectLines(lines, () => [], { invert: false, context: 0 });
  return selectLines(lines, matcher(opts), opts);
}

/** Same as `filterLines`, but reports an invalid regular expression instead of throwing. */
export function tryFilterLines(lines: string[], opts: FilterOptions): FilterOutcome {
  try {
    return filterLines(lines, opts);
  } catch {
    return { error: 'invalid' };
  }
}

/** Runs of digits collapse, so times, durations and counters do not count as a change. */
export const normaliseLine = (line: string) => line.trim().replace(/\d+/g, '0');

/**
 * "Changed since last run": the indexes of lines in `current` the previous run did not print. A multiset difference,
 * so a line printed twice now and once before counts once as changed.
 */
export function changedLines(current: string[], previous: string[]): Set<number> {
  const counts = new Map<string, number>();
  for (const l of previous) {
    const k = normaliseLine(l);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Set<number>();
  current.forEach((l, i) => {
    const k = normaliseLine(l);
    const left = counts.get(k) ?? 0;
    if (left > 0) counts.set(k, left - 1);
    else if (k !== '') out.add(i);
  });
  return out;
}

/** The shown rows as text, with "…" where lines were skipped. */
export function shownText(rows: FilterRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.gapBefore) out.push('…');
    out.push(r.text);
  }
  return out.join('\n');
}

export const lineCount = (n: number) => `${n.toLocaleString('en-GB')} ${n === 1 ? 'line' : 'lines'}`;

/** "42 of 3,120 lines". */
export const countText = (r: Pick<FilterResult, 'matched' | 'total'>) => `${r.matched.toLocaleString('en-GB')} of ${lineCount(r.total)}`;

/** The heading of an attachment of filtered lines. */
export function filteredHeading(command: string, r: Pick<FilterResult, 'matched' | 'total'>, filter: string): string {
  return `Filtered output of \`${command}\`: ${countText(r)}, filter: ${filter}`;
}

/** The part of the worker API the wrapper uses, so tests can stub it. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface WorkerRequest {
  lines: string[];
  opts: FilterOptions;
}

/**
 * Runs a regular expression filter in a fresh worker and terminates it after `budgetMs`. Resolves to
 * `{ error: 'slow' }` when the worker does not answer in time; a stuck pattern then stops with the worker.
 */
export function filterInWorker(make: () => WorkerLike, request: WorkerRequest, budgetMs = REGEX_BUDGET_MS): Promise<FilterOutcome> {
  return new Promise((resolve) => {
    let worker: WorkerLike;
    try {
      worker = make();
    } catch {
      return resolve(tryFilterLines(request.lines, { ...request.opts, regex: false }));
    }
    let done = false;
    const finish = (outcome: FilterOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ error: 'slow' }), budgetMs);
    worker.onmessage = (e) => finish(e.data as FilterOutcome);
    worker.onerror = () => finish({ error: 'invalid' });
    worker.postMessage(request);
  });
}
