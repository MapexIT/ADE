import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toSpawnable } from '../src/process.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ade-shim-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

const file = (rel: string, text = '') => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
  return p;
};

// The npm.cmd that ships with Node on Windows (npm 10/11), as installed in C:\Program Files\nodejs.
const NODE_NPM_CMD = [
  ":: Created by npm, please don't edit manually.",
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
].join('\r\n');

// Shims and their backslash paths exist only on Windows.
describe.runIf(process.platform === 'win32')('toSpawnable: Windows command shims run without a shell', () => {
  it('reads the script of Node’s own npm.cmd, not the prefix helper it calls first', () => {
    const cli = file('node_modules/npm/bin/npm-cli.js');
    file('node_modules/npm/bin/npm-prefix.js');
    expect(toSpawnable(file('npm.cmd', NODE_NPM_CMD), 'NODE')).toEqual({ command: 'NODE', args: [cli] });
  });

  it('reads npm’s cmd-shim for globally installed packages', () => {
    const cli = file('node_modules/pnpm/bin/pnpm.cjs');
    const shim = '@SETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\pnpm\\bin\\pnpm.cjs" %*\r\n';
    expect(toSpawnable(file('pnpm.cmd', shim), 'NODE')).toEqual({ command: 'NODE', args: [cli] });
  });

  it('runs a native binary behind a shim, and gives up on a shim it does not understand', () => {
    const exe = file('node_modules/tool/bin/tool.exe');
    expect(toSpawnable(file('tool.cmd', '"%~dp0\\node_modules\\tool\\bin\\tool.exe" %*'), 'NODE')).toEqual({ command: exe, args: [] });
    expect(toSpawnable(file('odd.cmd', '@echo off\r\ncall something %*'), 'NODE')).toBeNull();
    // The script it names is missing.
    expect(toSpawnable(file('other/npm.cmd', NODE_NPM_CMD), 'NODE')).toBeNull();
  });
});
