import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShellKind } from '@ade/contracts';

/** Folder with the integration scripts. The packaged app overrides this with its resources path. */
export const DEFAULT_SCRIPTS_DIR = fileURLToPath(new URL('../scripts/', import.meta.url));

export interface ShellLaunch {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** False when ADE cannot inject integration into this shell; it then runs as a plain terminal. */
  integrated: boolean;
}

export function shellKindOf(path: string): ShellKind | null {
  // Split on both separators: a Windows path must be recognised on any platform.
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh') return 'pwsh';
  if (name === 'powershell') return 'powershell';
  if (name === 'zsh') return 'zsh';
  if (name === 'fish') return 'fish';
  if (name === 'bash') return path.toLowerCase().includes('git') ? 'git-bash' : 'bash';
  return null;
}

/**
 * How to start each shell with integration injected (SM-02). Argument arrays only. Smart terminals call
 * this; plain terminals start the shell with no arguments.
 */
export function smartLaunch(kind: ShellKind, file: string, scriptsDir = DEFAULT_SCRIPTS_DIR): ShellLaunch {
  const script = (name: string) => join(scriptsDir, name);
  switch (kind) {
    case 'bash':
    case 'git-bash':
      return { file, args: ['--init-file', script('ade.bash'), '-i'], env: {}, integrated: true };
    case 'zsh':
      // ZDOTDIR points at our folder; its .zshrc sources the user's own then adds the hooks.
      return { file, args: ['-i'], env: { ADE_USER_ZDOTDIR: process.env.ZDOTDIR ?? process.env.HOME ?? '', ZDOTDIR: join(scriptsDir, 'zsh') }, integrated: true };
    case 'fish':
      return { file, args: ['--init-command', `source ${JSON.stringify(script('ade.fish'))}`], env: {}, integrated: true };
    case 'pwsh':
    case 'powershell':
      // Dot-sourced with -Command so the prompt function lands in the global scope.
      return {
        file,
        args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', `. '${script('ade.ps1').replace(/'/g, "''")}'`],
        env: {},
        integrated: true,
      };
  }
}

export function plainLaunch(file: string): ShellLaunch {
  return { file, args: [], env: {}, integrated: false };
}

const CANDIDATES: Record<'win32' | 'posix', { kind: ShellKind; label: string; paths: string[] }[]> = {
  win32: [
    { kind: 'pwsh', label: 'PowerShell 7', paths: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'] },
    { kind: 'powershell', label: 'Windows PowerShell', paths: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'] },
    { kind: 'git-bash', label: 'Git Bash', paths: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'] },
  ],
  posix: [
    { kind: 'bash', label: 'bash', paths: ['/bin/bash', '/usr/bin/bash'] },
    { kind: 'zsh', label: 'zsh', paths: ['/bin/zsh', '/usr/bin/zsh'] },
    { kind: 'fish', label: 'fish', paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/bin/fish'] },
  ],
};

/** Shells available on this machine (PowerShell and Git Bash on Windows; bash, zsh, fish on Linux). */
export function detectShells(platform: NodeJS.Platform = process.platform): { id: ShellKind; label: string; path: string }[] {
  const list = CANDIDATES[platform === 'win32' ? 'win32' : 'posix'];
  const out: { id: ShellKind; label: string; path: string }[] = [];
  for (const c of list) {
    const found = c.paths.find((p) => existsSync(p));
    if (found) out.push({ id: c.kind, label: c.label, path: found });
  }
  return out;
}
