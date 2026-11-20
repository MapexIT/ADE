import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandBlock } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { BlockBuilder, DEFAULT_SCRIPTS_DIR, ShellIntegrationParser, shellKindOf, smartLaunch, stripAnsi, type ShellEvent } from '../src/index.ts';

const OSC = (body: string, st: 'bel' | 'st' = 'bel') => `\x1b]${body}${st === 'bel' ? '\x07' : '\x1b\\'}`;

/** A recorded bash session: prompt, `echo hi` (exit 0), prompt, `false` (exit 1), prompt. */
const BASH_RECORDING = [
  OSC('133;D;0'),
  OSC('7;file://box/home/dev/repo'),
  OSC('133;A'),
  'dev@box:~/repo$ ',
  OSC('133;B'),
  'echo hi\r\n',
  OSC('633;E;echo hi'),
  OSC('133;C'),
  'hi\r\n',
  OSC('133;D;0'),
  OSC('7;file://box/home/dev/repo'),
  OSC('133;A'),
  'dev@box:~/repo$ ',
  OSC('133;B'),
  'false\r\n',
  OSC('633;E;false'),
  OSC('133;C'),
  OSC('133;D;1'),
  OSC('133;A'),
  '$ ',
  OSC('133;B'),
].join('');

/** A recorded PowerShell session with ESC \ terminators and a Windows cwd. */
const PWSH_RECORDING = [
  OSC('7;file://localhost/C:/Users/dev/repo', 'st'),
  OSC('133;A', 'st'),
  'PS C:\\Users\\dev\\repo> ',
  OSC('133;B', 'st'),
  OSC('633;E;Get-Item x\\x3b exit 3', 'st'),
  OSC('133;C', 'st'),
  '\x1b[31mGet-Item: Cannot find path\x1b[0m\r\n',
  OSC('133;D;3', 'st'),
].join('');

function run(recording: string, chunkSize: number) {
  const parser = new ShellIntegrationParser();
  const blocks: CommandBlock[] = [];
  let t = 0;
  const builder = new BlockBuilder((b) => b.endedAt !== null && blocks.push(b), () => (t += 10));
  const events: ShellEvent[] = [];
  for (let i = 0; i < recording.length; i += chunkSize) {
    for (const e of parser.feed(recording.slice(i, i + chunkSize))) {
      events.push(e);
      builder.push(e);
    }
  }
  return { events, blocks, builder };
}

describe('ShellIntegrationParser', () => {
  it.each([1, 3, 7, 1000])('parses a bash recording fed in chunks of %i', (size) => {
    const { blocks, builder } = run(BASH_RECORDING, size);
    expect(blocks.map((b) => [b.command, b.exitCode, b.output.trim()])).toEqual([
      ['echo hi', 0, 'hi'],
      ['false', 1, ''],
    ]);
    expect(blocks[0]?.cwd).toBe('/home/dev/repo');
    expect(builder.integrated).toBe(true);
  });

  it('parses a PowerShell recording with ST terminators and escaped command lines', () => {
    const { blocks, builder } = run(PWSH_RECORDING, 5);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ command: 'Get-Item x; exit 3', exitCode: 3, cwd: 'C:/Users/dev/repo' });
    expect(blocks[0]?.output).toBe('Get-Item: Cannot find path\r\n');
    expect(builder.currentCwd).toBe('C:/Users/dev/repo');
  });

  it('falls back to the typed text when no command line is reported', () => {
    const rec = OSC('133;A') + '$ ' + OSC('133;B') + 'ls\r\n' + OSC('133;C') + 'a b\r\n' + OSC('133;D;0');
    const { blocks } = run(rec, 4);
    expect(blocks[0]?.command).toBe('ls');
  });

  it('passes unknown OSC sequences through as text and reports notifications', () => {
    const p = new ShellIntegrationParser();
    const events = p.feed(`${OSC('0;title')}x${OSC('9;Claude needs your input')}${OSC('777;notify;Codex;Done')}${OSC('9;4;1;50')}`);
    expect(events).toEqual([
      { type: 'text', text: '\x1b]0;title\x07x' },
      { type: 'notify', title: '', body: 'Claude needs your input' },
      { type: 'notify', title: 'Codex', body: 'Done' },
      { type: 'text', text: '\x1b]9;4;1;50\x07' },
    ]);
  });

  it('marks a shell without integration as not integrated', () => {
    const { builder, blocks } = run('$ ls\r\na b\r\n$ ', 3);
    expect(builder.integrated).toBe(false);
    expect(blocks).toEqual([]);
  });

  it('strips ANSI sequences', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe('red link');
  });
});

describe('shell launch', () => {
  it('injects scripts for each supported shell', () => {
    expect(smartLaunch('bash', '/bin/bash').args).toContain('--init-file');
    expect(smartLaunch('zsh', '/bin/zsh').env.ZDOTDIR).toContain('zsh');
    expect(smartLaunch('pwsh', 'pwsh.exe').args).toContain('-NoExit');
    expect(smartLaunch('fish', '/usr/bin/fish').args[0]).toBe('--init-command');
  });

  it('ships every script it references', () => {
    for (const f of ['ade.bash', 'ade.ps1', 'ade.fish', join('zsh', '.zshrc')]) {
      expect(readFileSync(join(DEFAULT_SCRIPTS_DIR, f), 'utf8')).toContain('133;');
    }
  });

  it('recognises shells by path', () => {
    expect(shellKindOf('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('git-bash');
    expect(shellKindOf('/usr/bin/zsh')).toBe('zsh');
    expect(shellKindOf('C:\\x\\pwsh.exe')).toBe('pwsh');
  });
});
