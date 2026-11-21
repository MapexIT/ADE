import { describe, expect, it } from 'vitest';
import { isLocalPreviewUrl } from '../src/main/preview.ts';
import { detectPreviewUrl, interpreterFor, maskSecrets, rerunCommand, splitFailure } from '../src/renderer/src/lib/runner.ts';

describe('CR-05 interpreters', () => {
  it('picks the interpreter by extension and platform', () => {
    expect(interpreterFor('/a/b.ts', 'linux')).toEqual(['node']);
    expect(interpreterFor('C:\\a\\b.py', 'win32')).toEqual(['python']);
    expect(interpreterFor('/a/b.py', 'linux')).toEqual(['python3']);
    expect(interpreterFor('x.ps1', 'win32')).toEqual(['powershell', '-NoProfile', '-File']);
    expect(interpreterFor('x.cs', 'linux')).toEqual(['dotnet', 'run']);
    expect(interpreterFor('README.md', 'linux')).toBeNull();
  });
});

describe('CR-06 re-running tests', () => {
  it('splits failures and builds framework commands', () => {
    expect(splitFailure('vitest', 'src/a.test.ts > math > adds')).toEqual({ file: 'src/a.test.ts', name: 'adds' });
    expect(splitFailure('pytest', 'tests/t.py::test_x')).toEqual({ file: 'tests/t.py', name: 'test_x' });
    expect(rerunCommand('vitest', ['pnpm', 'vitest', 'run'], { kind: 'test', file: 'src/a.test.ts', name: 'adds' })).toEqual(['pnpm', 'vitest', 'run', 'src/a.test.ts', '-t', 'adds']);
    expect(rerunCommand('vitest', ['npm', 'test'], { kind: 'failures', failures: ['src/a.test.ts > adds', 'src/a.test.ts > subs', 'src/b.test.ts > x'] })).toEqual(['npm', 'test', '--', 'src/a.test.ts', 'src/b.test.ts']);
    expect(rerunCommand('jest', ['npx', 'jest'], { kind: 'failures', failures: [] })).toEqual(['npx', 'jest', '--onlyFailures']);
    expect(rerunCommand('pytest', ['pytest'], { kind: 'failures', failures: ['t.py::a'] })).toEqual(['pytest', '--last-failed']);
    expect(rerunCommand('go', ['go', 'test', './...'], { kind: 'test', file: null, name: 'TestAdd' })).toEqual(['go', 'test', './...', '-run', '^TestAdd$']);
    expect(rerunCommand('dotnet', ['dotnet', 'test'], { kind: 'test', file: null, name: 'Demo.Adds' })).toEqual(['dotnet', 'test', '--filter', 'FullyQualifiedName~Demo.Adds']);
  });
});

describe('CR-10 preview and CR-11 secrets', () => {
  it('detects local web addresses and only opens local ones', () => {
    expect(detectPreviewUrl('\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m')).toBe('http://localhost:5173/');
    expect(detectPreviewUrl('Listening on http://0.0.0.0:3000.')).toBe('http://localhost:3000');
    expect(detectPreviewUrl('see https://example.com:443/')).toBeNull();
    expect(isLocalPreviewUrl('http://127.0.0.1:8080/app')).toBe(true);
    expect(isLocalPreviewUrl('https://example.com')).toBe(false);
    expect(isLocalPreviewUrl('file:///etc/passwd')).toBe(false);
  });

  it('masks secret values in output', () => {
    expect(maskSecrets('token=abcd1234 and abcd1234!', ['abcd1234', 'x'])).toBe('token=•••••• and ••••••!');
  });
});
