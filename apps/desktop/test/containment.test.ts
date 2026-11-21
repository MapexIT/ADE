import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { git } from '@ade/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHost, type Host } from '../src/host/app.ts';
import {
  appPathsUnderTmp,
  bubblewrapArgs,
  BubblewrapWrapper,
  execRunner,
  parseWslList,
  probeBubblewrap,
  probeWsl,
  windowsToWslPath,
  WslWrapper,
  wslToWindowsPath,
  type Exec,
} from '../src/host/containment.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ade-sandbox-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bubblewrap arguments', () => {
  it('keeps an AppImage visible behind the private /tmp', () => {
    expect(appPathsUnderTmp('/tmp/.mount_ADEabc/ade', '/tmp/.mount_ADEabc')).toEqual(['/tmp/.mount_ADEabc']);
    expect(appPathsUnderTmp('/tmp/appimage_extracted_1/ade', undefined)).toEqual(['/tmp/appimage_extracted_1']);
    expect(appPathsUnderTmp('/opt/ADE/ade', undefined)).toEqual([]);
    const args = bubblewrapArgs({ writable: ['/w'], tmp: '/data/tmp/s1', cwd: '/w', readonly: ['/tmp/.mount_ADEabc'] });
    const at = args.indexOf('--ro-bind-try');
    // After the private /tmp, or the bind would be hidden by it.
    expect(at).toBeGreaterThan(args.indexOf('/data/tmp/s1'));
    expect(args.slice(at, at + 3)).toEqual(['--ro-bind-try', '/tmp/.mount_ADEabc', '/tmp/.mount_ADEabc']);
  });

  it('makes everything read-only except the writable paths and a private /tmp', () => {
    const args = bubblewrapArgs({ writable: ['/w/tree', '/repo/.git'], tmp: '/data/tmp/s1', cwd: '/w/tree' });
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args.join(' ')).toContain('--bind /data/tmp/s1 /tmp');
    expect(args.join(' ')).toContain('--bind-try /w/tree /w/tree --bind-try /repo/.git /repo/.git');
    // Writable paths come after /tmp so a worktree under /tmp is still bound.
    expect(args.indexOf('/tmp')).toBeLessThan(args.indexOf('/w/tree'));
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--unshare-pid');
    expect(args.at(-1)).toBe('--');
  });

  it('wraps the agent and keeps paths as they are', () => {
    const w = new BubblewrapWrapper({ bwrap: 'bwrap', writable: ['/w/tree'], tmp: '/t' });
    const spec = w.wrap({ command: '/usr/bin/node', args: ['agent.js'] }, { cwd: '/w/tree', env: { A: '1' } });
    expect(spec.cmd.command).toBe('bwrap');
    expect(spec.cmd.args.slice(-3)).toEqual(['--', '/usr/bin/node', 'agent.js']);
    expect(spec.env).toEqual({ A: '1' });
    expect(w.toAgentPath('/w/tree/a')).toBe('/w/tree/a');
  });
});

describe('WSL paths and wrapper', () => {
  it('translates paths both ways', () => {
    expect(windowsToWslPath('C:\\Users\\me\\wt')).toBe('/mnt/c/Users/me/wt');
    expect(windowsToWslPath('D:/code')).toBe('/mnt/d/code');
    expect(windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me')).toBe('/home/me');
    expect(windowsToWslPath('/home/me/.claude')).toBe('/home/me/.claude');
    expect(wslToWindowsPath('/mnt/c/Users/me/wt/a.txt', 'Ubuntu')).toBe('C:\\Users\\me\\wt\\a.txt');
    expect(wslToWindowsPath('/home/me/x', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\x');
    expect(wslToWindowsPath('relative/x', 'Ubuntu')).toBe('relative/x');
  });

  it('parses wsl -l -v and leaves out Docker Desktop', () => {
    const list = parseWslList('  NAME              STATE           VERSION\n* Ubuntu            Running         2\n  docker-desktop    Stopped         2\n  Legacy            Stopped         1\n');
    expect(list).toEqual([
      { name: 'Ubuntu', isDefault: true, version: 2 },
      { name: 'Legacy', isDefault: false, version: 1 },
    ]);
  });

  it('runs the agent through wsl.exe and bubblewrap and passes only agent variables', () => {
    const w = new WslWrapper({ distro: 'Ubuntu', writable: ['C:\\wt', '/home/me/.claude'], tmp: 'C:\\ud\\tmp\\s1' });
    const spec = w.wrap(
      { command: 'claude-agent-acp', args: [] },
      { cwd: 'C:\\wt', env: { PATH: 'C:\\Windows', ANTHROPIC_BASE_URL: 'https://example.invalid', ADE_FAKE_STATE_DIR: 'C:\\ud\\fake' } },
    );
    expect(spec.cmd.command).toBe('wsl.exe');
    expect(spec.cmd.args.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/wt', '--exec', 'bwrap']);
    const joined = spec.cmd.args.join(' ');
    expect(joined).toContain('--bind /mnt/c/ud/tmp/s1 /tmp');
    expect(joined).toContain('--bind-try /mnt/c/wt /mnt/c/wt');
    expect(joined).toContain('--bind-try /home/me/.claude /home/me/.claude');
    expect(spec.cmd.args.at(-1)).toBe('claude-agent-acp');
    expect(spec.env.WSLENV).toBe('ANTHROPIC_BASE_URL:ADE_FAKE_STATE_DIR');
    expect(spec.env.ADE_FAKE_STATE_DIR).toBe('/mnt/c/ud/fake');
    expect(spec.cwd).toBe('C:\\wt');
  });
});

/** A stand-in for bubblewrap: does what the probe's inner command would do, or misbehaves on purpose. */
function fakeBwrap(behaviour: 'enforces' | 'leaks' | 'fails' | 'missing'): Exec {
  return async (_cmd, args) => {
    if (behaviour === 'missing') return { code: null, stdout: '', stderr: '', spawnError: 'ENOENT' };
    if (behaviour === 'fails') return { code: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied\n', spawnError: null };
    const cwd = args[args.indexOf('--chdir') + 1]!;
    writeFileSync(join(cwd, 'ok'), '');
    if (behaviour === 'leaks') writeFileSync(args.at(-1)!, '');
    return { code: 0, stdout: '', stderr: '', spawnError: null };
  };
}

describe('the bubblewrap probe never labels a session sandboxed without proof', () => {
  const home = () => {
    const h = join(root, 'home');
    mkdirSync(h, { recursive: true });
    return h;
  };

  it('passes only when the worktree is writable and the home folder is not', async () => {
    expect(await probeBubblewrap(fakeBwrap('enforces'), join(root, 'probe'), home())).toEqual({ ok: true, reason: null });
  });

  it('fails, and cleans up, when a write outside got through', async () => {
    const h = home();
    const res = await probeBubblewrap(fakeBwrap('leaks'), join(root, 'probe'), h);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('did not stop a write');
    expect(readdirSync(h)).toEqual([]);
  });

  it('explains a missing or blocked bubblewrap', async () => {
    expect((await probeBubblewrap(fakeBwrap('missing'), join(root, 'probe'), home())).reason).toBe('bubblewrap (bwrap) is not installed.');
    expect((await probeBubblewrap(fakeBwrap('fails'), join(root, 'probe'), home())).reason).toContain('setting up uid map');
  });

  it('reports WSL as unavailable without a WSL2 distribution', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: '  NAME  STATE  VERSION\n  Old  Stopped  1\n', stderr: '', spawnError: null });
    expect(await probeWsl(exec, join(root, 'probe'), null)).toMatchObject({ ok: false, reason: 'No WSL2 distribution is installed.' });
  });
});

async function makeRepo(): Promise<string> {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  await git(['config', 'user.email', 't@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# Demo\n');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
  return repo;
}

function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 30_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out waiting'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

// The real thing. CI installs bubblewrap on Ubuntu and sets ADE_REQUIRE_SANDBOX so a failing probe fails the test.
describe.runIf(process.platform === 'linux')('CN-07 on Linux: the agent runs inside bubblewrap', () => {
  let host: Host;

  afterEach(async () => {
    await host?.dispose();
  });

  it('can write in its worktree but not in the home folder', async (ctx) => {
    host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
    const status = await host.containment.status();
    if (!status.available) {
      if (process.env.ADE_REQUIRE_SANDBOX) throw new Error(`The sandbox probe failed: ${status.reason}`);
      ctx.skip();
    }
    expect(status).toMatchObject({ kind: 'bubblewrap', defaultOn: true });
    const repo = await makeRepo();
    const outside = join(homedir(), `.ade-escape-${Date.now()}`);
    const ws = await host.handlers['workspace.open']({ path: repo });
    const session = await host.handlers['sessions.create']({
      workspaceId: ws.id,
      agentId: 'fake',
      prompt: [{ type: 'text', text: `edit inside.txt hello\nescape ${outside}\nsay done` }],
      permissionProfile: 'autonomous',
      bringChanges: false,
    });
    expect(session).toMatchObject({ sandboxState: 'sandboxed', containment: 'bubblewrap' });
    await waitFor(() => host.repos.sessions.require(session.id).state === 'ready');
    const messages = host.repos.events.list(session.id).flatMap((e) => (e.type === 'agent.message' ? [e.text] : []));
    expect(messages.join(' ')).toMatch(/Escape: refused \((EROFS|EACCES)\)/);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(session.worktreePath!, 'inside.txt'))).toBe(true);
  }, 60_000);
});

// Needs a WSL2 distribution with bubblewrap, so it only runs where ADE_TEST_WSL is set (verified on a developer machine).
describe.runIf(process.platform === 'win32' && !!process.env.ADE_TEST_WSL)('CN-07 on Windows: bubblewrap inside WSL2', () => {
  it('the probe passes against the real distribution', async () => {
    const res = await probeWsl(execRunner, join(root, 'probe'), null);
    expect(res).toMatchObject({ ok: true, reason: null });
    expect(res.home).toMatch(/^\//);
  }, 60_000);
});
