import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findOnPath, type Command } from '@ade/acp-client';
import { RpcError, type ScratchLanguage } from '@ade/contracts';
import { bubblewrapArgs, type ContainmentService } from './containment.ts';

const FILES: Record<ScratchLanguage, string> = { javascript: 'snippet.mjs', typescript: 'snippet.ts', python: 'snippet.py', csharp: 'snippet.cs' };

/** The interpreter for a language on this machine, or null with the reason. Pure apart from the PATH lookups. */
export function interpreter(language: ScratchLanguage, file: string, node: Command, nodeEnv: Record<string, string>, platform: NodeJS.Platform, find = findOnPath): { command: string[]; env: Record<string, string> } | null {
  switch (language) {
    case 'javascript':
    case 'typescript': {
      // Node 22.18 and later run TypeScript by stripping types; ADE's own Node (Electron's) is the fallback.
      const system = find('node');
      return system ? { command: [system, file], env: {} } : { command: [node.command, ...node.args, file], env: nodeEnv };
    }
    case 'python': {
      const py = (platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python']).map((n) => find(n)).find(Boolean);
      return py ? { command: [py, file], env: {} } : null;
    }
    case 'csharp': {
      // File-based C# apps: `dotnet run app.cs` needs .NET 10 or later.
      const dotnet = find('dotnet');
      return dotnet ? { command: [dotnet, 'run', file], env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } } : null;
    }
  }
}

/** CR-05 and CR-07: temporary files for snippets and selections, run sandboxed where the OS allows it. */
export class ScratchService {
  constructor(
    private readonly root: string,
    private readonly containment: ContainmentService,
    private readonly node: Command,
    private readonly nodeEnv: Record<string, string>,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async write(extension: string, content: string): Promise<{ path: string }> {
    const dir = join(this.root, `sel-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `selection.${extension}`);
    await writeFile(path, content);
    return { path };
  }

  async prepare(language: ScratchLanguage, code: string) {
    const dir = join(this.root, `pad-${randomUUID().slice(0, 8)}`);
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    const file = join(dir, FILES[language]);
    await writeFile(file, code);
    const run = interpreter(language, file, this.node, this.nodeEnv, this.platform);
    if (!run) throw new RpcError('no_interpreter', language === 'csharp' ? 'The .NET SDK (10 or later) is not installed.' : 'Python is not installed.');
    const status = await this.containment.status();
    if (status.available && status.kind === 'bubblewrap') {
      // Only the scratch folder (and, for C#, the .NET caches) is writable.
      const home = homedir();
      const writable = [dir, ...(language === 'csharp' ? ['.nuget', '.dotnet', '.local/share/NuGet'].map((d) => join(home, d)) : [])];
      const env = Object.entries(run.env).flatMap(([k, v]) => ['--setenv', k, v]);
      const args = bubblewrapArgs({ writable, tmp: join(dir, 'tmp'), cwd: dir });
      return { dir, file, command: ['bwrap', ...args.slice(0, -1), ...env, '--', ...run.command], env: {}, sandboxed: true, note: null };
    }
    return {
      dir,
      file,
      command: run.command,
      env: run.env,
      sandboxed: false,
      note: status.kind === 'wsl' || this.platform === 'win32' ? 'Not sandboxed on Windows: the snippet runs as you, in a temporary folder.' : (status.reason ?? 'Not sandboxed on this machine.'),
    };
  }
}
