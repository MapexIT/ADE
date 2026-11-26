import type { PermissionRule, ToolKind } from '@ade/contracts';
import { describe, expect, it } from 'vitest';
import { commandAnatomy, decideByRules, allowCoverage, programName, ruleRegExp, shapeOfStep, shapesOf, type RequestText } from '../src/rule-advice.ts';

const steps = (text: string) => {
  const a = commandAnatomy(text);
  return a.opaque ? 'opaque' : a.steps.map((s) => s.join(' '));
};

describe('commandAnatomy', () => {
  it('reads one plain step', () => {
    expect(steps('npm test')).toEqual(['npm test']);
    expect(commandAnatomy('npm test')).toMatchObject({ opaque: false, wrapped: false });
    expect(steps('  git   status  -s ')).toEqual(['git status -s']);
  });

  it('splits on &&, ||, ;, | and line breaks', () => {
    expect(steps('npm test && rm -rf build')).toEqual(['npm test', 'rm -rf build']);
    expect(steps('a || b')).toEqual(['a', 'b']);
    expect(steps('a; b ;c')).toEqual(['a', 'b', 'c']);
    expect(steps('git log | head -5')).toEqual(['git log', 'head -5']);
    expect(steps('a\nb\r\nc')).toEqual(['a', 'b', 'c']);
    expect(steps('a&&b')).toEqual(['a', 'b']);
  });

  it('keeps separators inside quotes in one token', () => {
    expect(commandAnatomy('git commit -m "a && b; c | d"').steps).toEqual([['git', 'commit', '-m', 'a && b; c | d']]);
    expect(commandAnatomy("echo 'x;y'").steps).toEqual([['echo', 'x;y']]);
    expect(commandAnatomy('echo "say \\"hi\\""').steps).toEqual([['echo', 'say "hi"']]);
  });

  it('calls an unterminated quote opaque', () => {
    expect(steps('echo "abc')).toBe('opaque');
    expect(steps("echo 'abc")).toBe('opaque');
  });

  it('drops harmless redirections', () => {
    expect(steps('npm test 2>&1')).toEqual(['npm test']);
    expect(steps('npm test > /dev/null')).toEqual(['npm test']);
    expect(steps('npm test 2>/dev/null')).toEqual(['npm test']);
    expect(steps('npm test &> /dev/null')).toEqual(['npm test']);
    expect(steps('dir > NUL')).toEqual(['dir']);
    expect(steps('Get-ChildItem *> $null')).toEqual(['Get-ChildItem']);
    expect(steps('npm test 2>&1 | tail -20')).toEqual(['npm test', 'tail -20']);
  });

  it('calls other redirections opaque', () => {
    for (const t of ['npm test > out.txt', 'sort < in.txt', 'echo x >> log', 'echo x>out', 'cat <<EOF\nx\nEOF']) expect(steps(t)).toBe('opaque');
  });

  it('calls substitution, subshells, braces, assignments and control flow opaque', () => {
    for (const t of [
      'echo $(whoami)',
      'echo `whoami`',
      'echo "$(whoami)"',
      'echo ${HOME}',
      'diff <(ls a) <(ls b)',
      '(cd x && rm -rf y)',
      '{ ls; }',
      'cp file.{a,b} x',
      'FOO=1 npm test',
      '$env:X=1; npm test',
      'npm test &',
      "& 'C:\\tools\\x.exe'",
      'if true; then rm x; fi',
      'for f in *; do rm $f; done',
      'ls # && rm x',
      'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
    ])
      expect(steps(t), t).toBe('opaque');
  });

  it('unwraps shell wrappers once, with or without quotes', () => {
    expect(steps('bash -lc "npm test && npm run lint"')).toEqual(['npm test', 'npm run lint']);
    expect(commandAnatomy('bash -lc "npm test"')).toMatchObject({ wrapped: true, steps: [['npm', 'test']] });
    // An argument array joined with spaces: the quotes are gone.
    expect(steps('bash -lc npm test && rm -rf build')).toEqual(['npm test', 'rm -rf build']);
    expect(steps('/bin/zsh -c ls')).toEqual(['ls']);
    expect(steps('pwsh -NoProfile -Command "Get-ChildItem; git status"')).toEqual(['Get-ChildItem', 'git status']);
    expect(steps('powershell.exe -NoLogo -ExecutionPolicy Bypass -Command npm test')).toEqual(['npm test']);
    expect(steps('cmd /c dir')).toEqual(['dir']);
    expect(steps('cmd.exe /s /c "npm test"')).toEqual(['npm test']);
    // Only once: an inner wrapper stays a shell step.
    expect(steps('bash -c "bash -c ls"')).toEqual(['bash -c ls']);
    // Other uses stay one step.
    expect(steps('bash script.sh')).toEqual(['bash script.sh']);
    // Positional arguments after a quoted script are not followed.
    expect(steps("bash -c 'echo $1' x")).toBe('opaque');
    expect(steps('bash -lc "echo $(id)"')).toBe('opaque');
    expect(steps('cmd /c "dir & del x"')).toBe('opaque');
  });

  it('strips process prefixes', () => {
    expect(steps('timeout 30 npm test')).toEqual(['npm test']);
    expect(steps('timeout -s KILL 5m npm test')).toEqual(['npm test']);
    expect(steps('time npm test')).toEqual(['npm test']);
    expect(steps('nice -n 10 nohup npm test')).toEqual(['npm test']);
    expect(steps('command ls')).toEqual(['ls']);
    expect(steps('timeout /t 5')).toEqual(['timeout /t 5']);
    expect(steps('env FOO=1 npm test')).toEqual(['env FOO=1 npm test']);
    expect(steps('time FOO=1 npm test')).toBe('opaque');
  });

  it('keeps Windows paths and calls very long input opaque', () => {
    expect(commandAnatomy('C:\\tools\\Git.EXE status').steps).toEqual([['C:\\tools\\Git.EXE', 'status']]);
    expect(steps(`echo ${'a'.repeat(4_001)}`)).toBe('opaque');
  });

  it('normalises program names', () => {
    expect(programName('C:\\tools\\Git.EXE')).toBe('git');
    expect(programName('/usr/bin/npm')).toBe('npm');
    expect(programName('npm.cmd')).toBe('npm');
    expect(programName('build.ps1')).toBe('build');
  });
});

describe('ruleRegExp', () => {
  it('matches whole text with * as a wildcard, ignoring case', () => {
    expect(ruleRegExp('npm *').test('NPM test')).toBe(true);
    expect(ruleRegExp('npm *').test('pnpm test')).toBe(false);
    expect(ruleRegExp('git status').test('git status --short')).toBe(false);
    expect(ruleRegExp('rm -rf (all)').test('rm -rf (all)')).toBe(true);
    expect(ruleRegExp('npm test*').test('npm test --watch')).toBe(true);
  });

  it('lets a trailing " *" match the bare command', () => {
    expect(ruleRegExp('git status *').test('git status')).toBe(true);
    expect(ruleRegExp('git status *').test('git status -s')).toBe(true);
    expect(ruleRegExp('git status *').test('git statusx')).toBe(false);
  });
});

const req = (detail: string | null, kind: ToolKind | null = 'execute', title = detail ? `Run ${detail}` : ''): RequestText => ({ kind, title, detail });
const rule = (id: string, decision: 'allow' | 'deny', pattern: string, kind: PermissionRule['kind'] = 'any'): PermissionRule => ({ id, decision, kind, pattern });

describe('decideByRules', () => {
  it('answers one step with a wildcard allow', () => {
    expect(decideByRules([rule('a', 'allow', 'npm test*')], req('npm test --watch'))).toMatchObject({ decision: 'allow', rule: { id: 'a' } });
    expect(decideByRules([rule('a', 'allow', 'npm *')], req('npm test 2>&1'))).toMatchObject({ decision: 'allow' });
  });

  it('holds back a chain unless every step is allowed', () => {
    const rules = [rule('a', 'allow', 'npm test*')];
    expect(decideByRules(rules, req('npm test && rm -rf build'))).toBeNull();
    expect(allowCoverage(rules, req('npm test && rm -rf build')).coverage).toBe('held-back');
    expect(decideByRules([...rules, rule('b', 'allow', 'rm -rf build')], req('npm test && rm -rf build'))).toMatchObject({ decision: 'allow', rule: { id: 'a' } });
    // Every step allowed by its own rule, though no rule matches the whole text.
    expect(decideByRules([rule('t', 'allow', 'npm test'), rule('l', 'allow', 'npm run lint')], req('npm test && npm run lint'))).toMatchObject({
      rule: { id: 't' },
    });
  });

  it('answers a chain with an exact rule that equals it', () => {
    expect(decideByRules([rule('x', 'allow', 'npm test && rm -rf build')], req('npm test && rm -rf build'))).toMatchObject({ decision: 'allow' });
  });

  it('answers opaque text only with an exact rule', () => {
    expect(allowCoverage([rule('a', 'allow', 'npm *')], req('npm test > out.txt')).coverage).toBe('held-back');
    expect(decideByRules([rule('a', 'allow', 'npm test > out.txt')], req('npm test > out.txt'))).toMatchObject({ decision: 'allow' });
  });

  it('lets a deny on any step win over an allow of the whole', () => {
    const rules = [rule('a', 'allow', 'npm *'), rule('d', 'deny', 'rm *')];
    expect(decideByRules(rules, req('npm test && rm -rf build'))).toMatchObject({ decision: 'deny', rule: { id: 'd' } });
    expect(decideByRules(rules, req('bash -lc "npm test; rm -rf /"'))).toMatchObject({ decision: 'deny' });
    expect(decideByRules([rule('d', 'deny', 'npm publish*'), rule('a', 'allow', 'npm *')], req('npm publish --tag x'))).toMatchObject({ decision: 'deny' });
  });

  it('checks a wrapped single step against the rules', () => {
    expect(decideByRules([rule('a', 'allow', 'bash *')], req('bash -lc "rm -rf build"'))).toBeNull();
    expect(decideByRules([rule('a', 'allow', 'npm *')], req('bash -lc "npm test"'))).toMatchObject({ decision: 'allow' });
  });

  it('respects the kind for each step', () => {
    expect(decideByRules([rule('a', 'allow', 'npm *', 'execute'), rule('b', 'allow', 'ls', 'edit')], req('npm test && ls'))).toBeNull();
    expect(decideByRules([rule('a', 'allow', 'npm *', 'execute'), rule('b', 'allow', 'ls', 'execute')], req('npm test && ls'))).not.toBeNull();
  });

  it('leaves other kinds as they were', () => {
    expect(decideByRules([rule('g', 'allow', 'git *')], req(null, 'edit', 'git notes && more'))).toMatchObject({ decision: 'allow' });
    expect(decideByRules([rule('g', 'allow', 'Edit *', 'edit')], req(null, 'edit', 'Edit src/a.ts; b'))).toMatchObject({ decision: 'allow' });
  });

  it('works on a title-only request', () => {
    expect(decideByRules([rule('a', 'allow', 'git status *')], req(null, 'execute', 'git status'))).toMatchObject({ decision: 'allow' });
    expect(decideByRules([rule('a', 'allow', 'git status *')], req(null, 'execute', 'git status; rm x'))).toBeNull();
  });
});

describe('shapeOfStep', () => {
  const shape = (t: string) => {
    const s = shapeOfStep(commandAnatomy(t).steps[0]!);
    return [s.stem.join(' '), s.risk, s.caveats];
  };

  it('classifies reads', () => {
    expect(shape('git status -s')).toEqual(['git status', 'read', ['not-a-sandbox']]);
    expect(shape('C:\\tools\\Git.EXE status')).toEqual(['C:\\tools\\Git.EXE status', 'read', ['not-a-sandbox']]);
    expect(shape('gh pr view 3')).toEqual(['gh pr view', 'read', ['not-a-sandbox']]);
    expect(shape('Get-ChildItem -Recurse')).toEqual(['Get-ChildItem', 'read', ['not-a-sandbox']]);
    expect(shape('ls -la')[1]).toBe('read');
  });

  it('classifies project commands with the repository caveat', () => {
    expect(shape('npm run lint')).toEqual(['npm run lint', 'project', ['repo-script', 'not-a-sandbox']]);
    expect(shape('pnpm test -- --watch')).toEqual(['pnpm test', 'project', ['repo-script', 'not-a-sandbox']]);
    expect(shape('python -m pytest -q')).toEqual(['python -m pytest', 'project', ['repo-script', 'not-a-sandbox']]);
    expect(shape('cargo test --all')[1]).toBe('project');
    expect(shape('vitest run')[1]).toBe('project');
    expect(shape('node --test')[1]).toBe('project');
    expect(shape('make check')[0]).toBe('make check');
  });

  it('keeps everything else exact', () => {
    expect(shape('node x.js')[1]).toBe('exact');
    expect(shape('find . -name x')[1]).toBe('exact');
    expect(shape('sed -i s/a/b/ f')[1]).toBe('exact');
    expect(shape('python x.py')[1]).toBe('exact');
    expect(shapeOfStep(['node', 'a.js']).key).not.toBe(shapeOfStep(['node', 'b.js']).key);
  });

  it('never offers shells, network, deletion and history changes', () => {
    for (const t of ['git push origin x', 'rm -rf x', 'curl https://example.com', 'bash script.sh', 'npx foo', 'docker ps', 'gh pr merge 3', 'npm install x', 'pip install x', 'git -C x push', 'Remove-Item x', 'sudo ls'])
      expect(shape(t)[1], t).toBe('never');
  });

  it('gives one shape per step and none for opaque or non-command requests', () => {
    expect(shapesOf(req('cd app && npm test')).map((s) => s.key)).toEqual(['cd', 'npm test']);
    expect(shapesOf(req('npm test > out.txt'))).toEqual([]);
    expect(shapesOf(req('npm test', 'edit'))).toEqual([]);
    expect(shapesOf({ kind: 'execute', title: '`git status`', detail: null }).map((s) => s.key)).toEqual(['git status']);
  });
});
