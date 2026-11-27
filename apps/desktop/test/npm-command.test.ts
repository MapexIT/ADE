import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath } from '@ade/acp-client';
import { describe, expect, it } from 'vitest';
import { commandResolver } from '../src/host/executors.ts';
import { runArgv } from '../src/host/run-command.ts';
import { removeTemp } from './cleanup.ts';

// Checks and run configurations that call npm used to end "not found" with no exit code on Windows, because
// Node's npm.cmd was not understood. Runs only where npm is installed.
describe.runIf(!!findOnPath('npm'))('npm runs as a check or run configuration', () => {
  it('npm --version finishes with exit code 0 through the same resolver checks use', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ade-npm-'));
    try {
      const res = await runArgv(['npm', '--version'], { cwd, resolve: commandResolver({ command: process.execPath, args: [] }, {}) });
      expect(res?.code).toBe(0);
      expect(res?.output.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      removeTemp(cwd);
    }
  });
});
