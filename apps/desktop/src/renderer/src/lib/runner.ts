/** Pure helpers for the code runner's v1 features (CR-05 to CR-11). Unit-tested. */
import type { TestSummary } from './terminal-intel.ts';

/** CR-05: the interpreter for a file, by extension, as the start of an argument array. */
export function interpreterFor(path: string, platform: string): string[] | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'mts':
    case 'cts':
      return ['node'];
    case 'py':
      return [platform === 'win32' ? 'python' : 'python3'];
    case 'sh':
    case 'bash':
      return ['bash'];
    case 'ps1':
      return [platform === 'win32' ? 'powershell' : 'pwsh', '-NoProfile', '-File'];
    case 'rb':
      return ['ruby'];
    case 'go':
      return ['go', 'run'];
    case 'cs':
      return ['dotnet', 'run'];
    case 'php':
      return ['php'];
    case 'pl':
      return ['perl'];
    case 'lua':
      return ['lua'];
    default:
      return null;
  }
}

export type RerunScope = { kind: 'test'; file: string | null; name: string } | { kind: 'file'; file: string } | { kind: 'failures'; failures: string[] };

/** CR-06: a failing test's file and name, from the form each framework prints. */
export function splitFailure(framework: TestSummary['framework'], failure: string): { file: string | null; name: string } {
  if (framework === 'pytest') {
    const [file = null, ...rest] = failure.split('::');
    return { file, name: rest.join('::') || failure };
  }
  if (framework === 'vitest' || framework === 'jest') {
    const parts = failure.split(/\s+[>›]\s+/);
    const first = parts[0] ?? '';
    const hasFile = /\.(test|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$/.test(first);
    return { file: hasFile ? first : null, name: (hasFile ? parts.slice(1) : parts).at(-1) ?? failure };
  }
  return { file: null, name: failure };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * CR-06: the command that re-runs one test, one file or only the failures, built on the original run's command.
 * npm needs `--` before arguments for the script; pnpm and yarn pass them on.
 */
export function rerunCommand(framework: TestSummary['framework'], base: string[], scope: RerunScope): string[] {
  const sep = base[0] === 'npm' || base[0]?.endsWith('npm.cmd') ? ['--'] : [];
  const extra = (args: string[]) => [...base, ...(args.length ? [...sep, ...args] : [])];
  switch (framework) {
    case 'vitest':
    case 'jest':
      if (scope.kind === 'test') return extra([...(scope.file ? [scope.file] : []), '-t', scope.name]);
      if (scope.kind === 'file') return extra([scope.file]);
      if (framework === 'jest') return extra(['--onlyFailures']);
      return extra([...new Set(scope.failures.map((f) => splitFailure(framework, f).file).filter((f): f is string => !!f))]);
    case 'pytest':
      if (scope.kind === 'test') return extra([scope.file ? `${scope.file}::${scope.name}` : scope.name]);
      if (scope.kind === 'file') return extra([scope.file]);
      return extra(['--last-failed']);
    case 'go':
      if (scope.kind === 'test') return extra(['-run', `^${escapeRegex(scope.name)}$`]);
      if (scope.kind === 'failures') return extra(['-run', `^(${scope.failures.map(escapeRegex).join('|')})$`]);
      return base;
    case 'dotnet':
      if (scope.kind === 'test') return extra(['--filter', `FullyQualifiedName~${scope.name}`]);
      if (scope.kind === 'failures') return extra(['--filter', scope.failures.map((f) => `FullyQualifiedName~${f}`).join('|')]);
      return base;
  }
}

/** CR-11: secret values replaced before output is stored or sent anywhere. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets.filter((v) => v.length >= 4).sort((a, b) => b.length - a.length)) out = out.split(s).join('••••••');
  return out;
}

const URL_IN_OUTPUT = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>)\]]*)?/;

/** CR-10: the first local web address a run printed (dev servers announce it), 0.0.0.0 shown as localhost. */
export function detectPreviewUrl(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const m = URL_IN_OUTPUT.exec(output.replace(/\x1b\[[0-9;]*m/g, ''));
  return m ? m[0].replace('0.0.0.0', 'localhost').replace(/[.,;]+$/, '') : null;
}
