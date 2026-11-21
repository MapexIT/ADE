import { describe, expect, it } from 'vitest';
import {
  destructiveReason,
  draftedCommand,
  extractShellCommands,
  findSecrets,
  inlineViewFor,
  isMultiLinePaste,
  parseTestSummary,
} from '../src/renderer/src/lib/terminal-intel.ts';

describe('SM-09 and SM-10 suggested commands', () => {
  it('finds shell blocks and strips prompts, ignoring other languages and comments', () => {
    const reply = 'Run this:\n```bash\n$ pnpm test --run\n```\nand in code:\n```ts\nconst a = 1;\n```\n```powershell\nPS C:\\> Get-ChildItem\n# a comment\n```';
    expect(extractShellCommands(reply)).toEqual(['pnpm test --run', 'Get-ChildItem']);
  });

  it('reads a drafted command from a block or the first line', () => {
    expect(draftedCommand('```sh\nls -la\n```')).toBe('ls -la');
    expect(draftedCommand('`git status`\nThis shows changes.')).toBe('git status');
    expect(draftedCommand('')).toBeNull();
  });
});

describe('SM-14 guard rails', () => {
  it('flags destructive commands and not ordinary ones', () => {
    expect(destructiveReason('rm -rf node_modules')).toBe('deletes files recursively or by force');
    expect(destructiveReason('git push --force origin main')).toBe('rewrites the remote branch');
    expect(destructiveReason('git reset --hard HEAD~1')).toBe('throws away uncommitted changes');
    expect(destructiveReason('Remove-Item .\\build -Recurse -Force')).toBe('deletes files recursively');
    expect(destructiveReason('psql -c "DROP TABLE users"')).toBe('deletes database data');
    expect(destructiveReason('git push origin main')).toBeNull();
    expect(destructiveReason('rm notes.txt')).toBeNull();
    expect(destructiveReason('pnpm test')).toBeNull();
  });

  it('spots multi-line pastes and secrets', () => {
    expect(isMultiLinePaste('ls\n')).toBe(false);
    expect(isMultiLinePaste('cd a\nrm b\n')).toBe(true);
    expect(findSecrets(`token ${'ghp_'}${'a'.repeat(36)} and key AKIA${'B'.repeat(16)}`)).toEqual(['an AWS access key', 'a GitHub token']);
    expect(findSecrets('-----BEGIN OPENSSH PRIVATE KEY-----')).toEqual(['a private key']);
    expect(findSecrets('Tests 3 passed')).toEqual([]);
  });
});

describe('SM-12 inline viewers and test summaries', () => {
  it('parses vitest, jest, pytest, dotnet and go output', () => {
    expect(parseTestSummary(' × src/a.test.ts > adds 3ms\n Test Files  1 failed (1)\n      Tests  1 failed | 4 passed (5)')).toEqual({
      framework: 'vitest',
      passed: 4,
      failed: 1,
      skipped: 0,
      failures: ['src/a.test.ts > adds'],
    });
    expect(parseTestSummary('  ● math › adds\nTests:       1 failed, 2 passed, 3 total')).toMatchObject({ framework: 'jest', failed: 1, passed: 2, failures: ['math › adds'] });
    expect(parseTestSummary('FAILED tests/test_a.py::test_x - assert\n===== 1 failed, 3 passed in 0.12s =====')).toMatchObject({ framework: 'pytest', failed: 1, passed: 3, failures: ['tests/test_a.py::test_x'] });
    expect(parseTestSummary('  Failed Demo.Tests.Adds [12 ms]\nFailed!  - Failed:     1, Passed:     5, Skipped:     0, Total:     6')).toMatchObject({ framework: 'dotnet', failed: 1, passed: 5, failures: ['Demo.Tests.Adds'] });
    expect(parseTestSummary('--- FAIL: TestAdd (0.00s)\n--- PASS: TestSub (0.00s)\nFAIL\tdemo\t0.01s')).toMatchObject({ framework: 'go', failed: 1, passed: 1, failures: ['TestAdd'] });
    expect(parseTestSummary('hello')).toBeNull();
  });

  it('chooses JSON, CSV, Markdown, image and test views', () => {
    expect(inlineViewFor('cat data.json', '{"a": [1, 2]}')).toEqual({ kind: 'json', value: { a: [1, 2] } });
    expect(inlineViewFor('cat people.csv', 'name,age\n"Smith, J",40')).toEqual({ kind: 'csv', rows: [['name', 'age'], ['Smith, J', '40']] });
    expect(inlineViewFor('cat README.md', '# Title\nText')).toEqual({ kind: 'markdown', source: '# Title\nText' });
    expect(inlineViewFor('open docs/diagram.png', '')).toEqual({ kind: 'image', path: 'docs/diagram.png' });
    expect(inlineViewFor('pnpm test', 'Tests  2 passed (2)')).toMatchObject({ kind: 'tests' });
    expect(inlineViewFor('echo hi', 'hi')).toBeNull();
  });
});

describe('SM-12 JSON after a shell echo', () => {
  it('finds JSON on the last lines', () => {
    expect(inlineViewFor('node -e x', 'PS C:\repo> node -e x\n{"ok":true}')).toEqual({ kind: 'json', value: { ok: true } });
  });
});
