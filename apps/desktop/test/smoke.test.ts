import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_AGENT_ENTRY } from '@ade/fake-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHost, defaultAdapterEntry, type Host } from '../src/host/app.ts';
import { runSmokeChecks } from '../src/host/smoke.ts';
import { SmokeRun, type SmokeReport } from '../src/main/smoke.ts';
import { removeTemp } from './cleanup.ts';

describe('SmokeRun (M5-T07)', () => {
  afterEach(() => vi.useRealTimers());

  const make = (timeoutMs = 1000) => {
    const reports: SmokeReport[] = [];
    const request = vi.fn();
    const run = new SmokeRun({ version: '1.0.0', platform: 'test', request, finish: (r) => reports.push(r), timeoutMs });
    return { run, reports, request };
  };

  it('asks the processes once both are up and passes when every part passed', () => {
    const { run, reports, request } = make();
    run.markReady('window');
    run.markReady('host');
    expect(request).not.toHaveBeenCalled();
    run.markReady('pty');
    run.markReady('pty'); // a restart does not ask twice
    expect(request).toHaveBeenCalledTimes(1);
    run.add('host', [{ name: 'database', ok: true, detail: '' }]);
    run.add('pty', [{ name: 'terminal', ok: true, detail: '' }]);
    expect(reports).toHaveLength(0);
    run.add('window', [{ name: 'window', ok: true, detail: '' }]);
    expect(reports).toEqual([{ ok: true, version: '1.0.0', platform: 'test', checks: expect.arrayContaining([expect.objectContaining({ name: 'terminal' })]) }]);
  });

  it('fails when one check failed', () => {
    const { run, reports } = make();
    run.add('host', [{ name: 'adapter', ok: false, detail: 'missing' }]);
    run.add('pty', [{ name: 'terminal', ok: true, detail: '' }]);
    run.add('window', [{ name: 'window', ok: true, detail: '' }]);
    expect(reports[0]?.ok).toBe(false);
  });

  it('fails with a readable check for a part that never answered', () => {
    vi.useFakeTimers();
    const { run, reports } = make(500);
    run.markReady('host');
    run.add('window', [{ name: 'window', ok: true, detail: '' }]);
    vi.advanceTimersByTime(600);
    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.checks.find((c) => c.name === 'pty')?.detail).toContain('never started');
    expect(reports[0]?.checks.find((c) => c.name === 'host')?.detail).toContain('started');
    run.add('pty', [{ name: 'terminal', ok: true, detail: '' }]); // late answers are ignored
    expect(reports).toHaveLength(1);
  });
});

describe('runSmokeChecks (M5-T07)', () => {
  let root: string;
  let host: Host;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ade-smoke-'));
    host = createHost({ userData: join(root, 'userData'), node: { command: process.execPath, args: [] }, nodeEnv: {}, fakeAgentEntry: FAKE_AGENT_ENTRY });
  });
  afterEach(async () => {
    await host.dispose();
    removeTemp(root);
  });

  it('passes on a working install: database, bundled adapters, agents and a real session', async () => {
    const checks = await runSmokeChecks(host, { adapterEntry: defaultAdapterEntry, scratch: join(root, 'scratch') });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.map((c) => c.name)).toEqual(['database', 'adapter @agentclientprotocol/claude-agent-acp', 'adapter @agentclientprotocol/codex-acp', 'agents', 'session']);
    expect(checks.at(-1)?.detail).toContain('edited its worktree');
  }, 60_000);

  it('reports an adapter that is missing on disk', async () => {
    const checks = await runSmokeChecks(host, { adapterEntry: () => join(root, 'nowhere', 'index.js'), scratch: join(root, 'scratch') });
    const adapter = checks.find((c) => c.name.startsWith('adapter'));
    expect(adapter?.ok).toBe(false);
    expect(adapter?.detail).toContain('Missing on disk');
  }, 60_000);
});
