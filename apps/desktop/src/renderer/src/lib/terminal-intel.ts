/** Pure helpers for the smart terminal's v1 features (SM-09 to SM-14). No DOM, no IPC: unit-tested. */

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'powershell', 'pwsh', 'ps1', 'ps', 'cmd', 'bat', 'terminal']);
const FENCE = /```([\w-]*)[^\n]*\n([\s\S]*?)```/g;

/** SM-09: shell commands an agent proposed in fenced code blocks, prompts (`$ `, `> `, `PS> `) removed. */
export function extractShellCommands(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(FENCE)) {
    if (!SHELL_LANGS.has((m[1] ?? '').toLowerCase())) continue;
    const lines = (m[2] ?? '')
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:PS [^>]*>|PS>|\$|>)\s?/, ''))
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (lines.length) out.push(lines.join('\n').trim());
  }
  return out;
}

/** SM-10: the command in a drafted reply: the first shell block, else the first non-empty line without backticks. */
export function draftedCommand(reply: string): string | null {
  const block = extractShellCommands(reply)[0];
  if (block) return block;
  const any = /```[\w-]*\n([\s\S]*?)```/.exec(reply)?.[1]?.trim();
  if (any) return any;
  const line = reply.split(/\r?\n/).map((l) => l.trim().replace(/^`+|`+$/g, '')).find(Boolean);
  return line ?? null;
}

const DESTRUCTIVE: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, 'deletes files recursively or by force'],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/, 'rewrites the remote branch'],
  [/\bgit\s+reset\s+--hard\b/, 'throws away uncommitted changes'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fdx]/, 'deletes untracked files'],
  [/\bgit\s+checkout\s+(--\s+)?\.\s*$/, 'throws away uncommitted changes'],
  [/\bRemove-Item\b.*-Recurse\b/i, 'deletes files recursively'],
  [/\b(rd|rmdir)\s+\/s\b/i, 'deletes folders recursively'],
  [/\bdel\s+\/[sq]\b/i, 'deletes files without asking'],
  [/\b(mkfs(\.\w+)?|format)\s+\S/i, 'formats a drive'],
  [/\bdd\s+.*\bof=\/dev\//, 'writes to a device'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'deletes database data'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'is a fork bomb'],
  [/\bchmod\s+-R\s+777\b/, 'opens every file to everyone'],
];

/** SM-14: why a command needs confirmation, or null. */
export function destructiveReason(command: string): string | null {
  for (const [re, why] of DESTRUCTIVE) if (re.test(command)) return why;
  return null;
}

/** SM-14: a paste that would run more than one command. */
export function isMultiLinePaste(text: string): boolean {
  return text.replace(/\r?\n$/, '').includes('\n');
}

/** SM-14: kinds of secret found in text about to go to an agent (patterns shared with the audit export). */
export { findSecrets } from '@ade/contracts';

export interface TestSummary {
  framework: 'vitest' | 'jest' | 'pytest' | 'go' | 'dotnet';
  passed: number;
  failed: number;
  skipped: number;
  failures: string[];
}

const num = (s: string | undefined) => (s ? Number(s) : 0);

/** SM-12, CR-06: a test run's counts and failing tests, from vitest, jest, pytest, go test or dotnet test output. */
export function parseTestSummary(raw: string): TestSummary | null {
  // eslint-disable-next-line no-control-regex
  const out = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const vitest = /^\s*Tests\s+(.*\d.*)$/m.exec(out);
  if (vitest && /passed|failed/.test(vitest[1]!)) {
    const line = vitest[1]!;
    const failures = [...out.matchAll(/^\s*(?:×|✗|FAIL)\s+(.+?)(?:\s+\d+ms)?\s*$/gm)].map((m) => m[1]!.trim());
    const isJest = /^Tests:\s/m.test(out);
    return {
      framework: isJest ? 'jest' : 'vitest',
      passed: num(/(\d+) passed/.exec(line)?.[1]),
      failed: num(/(\d+) failed/.exec(line)?.[1]),
      skipped: num(/(\d+) (?:skipped|todo)/.exec(line)?.[1]),
      failures: [...new Set(failures)],
    };
  }
  const jest = /^Tests:\s+(.+)$/m.exec(out);
  if (jest) {
    const line = jest[1]!;
    return {
      framework: 'jest',
      passed: num(/(\d+) passed/.exec(line)?.[1]),
      failed: num(/(\d+) failed/.exec(line)?.[1]),
      skipped: num(/(\d+) skipped/.exec(line)?.[1]),
      failures: [...new Set([...out.matchAll(/^\s*●\s+(.+)$/gm)].map((m) => m[1]!.trim()))],
    };
  }
  const pytest = /^=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s/m.exec(out);
  if (pytest) {
    const line = pytest[1]!;
    return {
      framework: 'pytest',
      passed: num(/(\d+) passed/.exec(line)?.[1]),
      failed: num(/(\d+) failed/.exec(line)?.[1]) + num(/(\d+) errors?/.exec(line)?.[1]),
      skipped: num(/(\d+) skipped/.exec(line)?.[1]),
      failures: [...out.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1]!),
    };
  }
  const dotnet = /(Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+)/.exec(out);
  if (dotnet) {
    return {
      framework: 'dotnet',
      passed: num(dotnet[3]),
      failed: num(dotnet[2]),
      skipped: num(dotnet[4]),
      failures: [...out.matchAll(/^\s*Failed (\S+) \[/gm)].map((m) => m[1]!),
    };
  }
  const goFails = [...out.matchAll(/^--- FAIL: (\S+)/gm)].map((m) => m[1]!);
  const goPasses = [...out.matchAll(/^--- PASS: (\S+)/gm)].length;
  if (goFails.length || goPasses || /^(ok|FAIL)\s+\S+\s+[\d.]+s/m.test(out)) {
    return { framework: 'go', passed: goPasses, failed: goFails.length, skipped: [...out.matchAll(/^--- SKIP:/gm)].length, failures: goFails };
  }
  return null;
}

export type InlineView =
  | { kind: 'json'; value: unknown }
  | { kind: 'csv'; rows: string[][] }
  | { kind: 'markdown'; source: string }
  | { kind: 'tests'; summary: TestSummary }
  | { kind: 'image'; path: string };

const IMAGE = /(?:^|\s)["']?([^\s"']+\.(?:png|jpe?g|gif|webp|svg))["']?\s*$/i;

/** Splits one CSV line, honouring double quotes. */
function csvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      cells.push(cur);
      cur = '';
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

/** SM-12: how a finished block's output can be shown inline, or null for plain text. */
export function inlineViewFor(command: string, output: string): InlineView | null {
  const text = output.trim();
  const image = IMAGE.exec(command.trim());
  if (image && /^(cat|type|Get-Content|gc|open|xdg-open|start|Invoke-Item|ii|code|ls|dir)\b/i.test(command.trim())) return { kind: 'image', path: image[1]! };
  const tests = parseTestSummary(output);
  if (tests) return { kind: 'tests', summary: tests };
  if (!text) return null;
  // The whole output, or its last lines when a shell echoed the prompt or command first.
  const all = text.split(/\r?\n/);
  for (let i = 0; i < all.length; i++) {
    const tail = all.slice(i).join('\n').trim();
    if (!/^[[{]/.test(tail)) continue;
    try {
      const value: unknown = JSON.parse(tail);
      if (value && typeof value === 'object') return { kind: 'json', value };
    } catch {
      // not JSON from here
    }
  }
  if (/\.(md|markdown)["']?\s*$/i.test(command.trim())) return { kind: 'markdown', source: text };
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  for (const sep of [',', '\t']) {
    if (lines.length < 2) break;
    const widths = lines.slice(0, 50).map((l) => csvLine(l, sep).length);
    if (widths[0]! >= 2 && widths.every((w) => w === widths[0]) && (sep === '\t' || /\.(csv|tsv)["']?\s*$/i.test(command.trim()) || lines.length >= 3)) {
      return { kind: 'csv', rows: lines.slice(0, 200).map((l) => csvLine(l, sep)) };
    }
  }
  return null;
}
