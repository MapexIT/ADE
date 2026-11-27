import { describe, expect, it } from 'vitest';
import { WatchRule } from '@ade/contracts';
import { initialWatch, MAX_QUIET_FIRES, nextWakeAt, watchNotificationText, watchReasonText, watchStep, type WatchEvent, type WatchFire, type WatchState } from '../src/watch.ts';

const rule = (r: Partial<WatchRule> = {}): WatchRule => WatchRule.parse(r);

/** Feeds events in order and collects everything that fired. */
function run(events: WatchEvent[], state: WatchState = initialWatch()) {
  const fired: WatchFire[] = [];
  for (const e of events) {
    const step = watchStep(state, e);
    state = step.state;
    fired.push(...step.fired);
  }
  return { state, fired };
}

const start = (at = 0): WatchEvent => ({ type: 'start', blockId: 'b1', command: 'pnpm test', at });
const out = (text: string, at: number): WatchEvent => ({ type: 'output', text, at });
const end = (exitCode: number | null, at: number): WatchEvent => ({ type: 'end', exitCode, at });
const tick = (at: number): WatchEvent => ({ type: 'timer', at });
const set = (r: WatchRule | null, at = 0): WatchEvent => ({ type: 'set', rule: r, at });

describe('watchStep: end of the command', () => {
  it('"any" fires once with finished or failed and clears the watch', () => {
    const ok = run([start(), set(rule()), out('ok\r\n', 10), end(0, 20)]);
    expect(ok.fired.map((f) => [f.reason, f.exitCode])).toEqual([['finished', 0]]);
    expect(ok.state.rule).toBeNull();
    const bad = run([start(), set(rule()), end(2, 20)]);
    expect(bad.fired.map((f) => [f.reason, f.exitCode, f.command])).toEqual([['failed', 2, 'pnpm test']]);
  });

  it('"fail" fires only on a non-zero exit code', () => {
    expect(run([start(), set(rule({ end: 'fail' })), end(0, 5)]).fired).toEqual([]);
    expect(run([start(), set(rule({ end: 'fail' })), end(1, 5)]).fired.map((f) => f.reason)).toEqual(['failed']);
  });

  it('"none" never fires at the end, and the watch still ends with the command', () => {
    const r = run([start(), set(rule({ end: 'none', match: 'zzz' })), end(1, 5)]);
    expect(r.fired).toEqual([]);
    expect(r.state.rule).toBeNull();
  });

  it('a watch set with nothing running attaches to the next block', () => {
    const r = run([set(rule({ end: 'any' })), start(100), end(0, 200)]);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]?.blockId).toBe('b1');
  });

  it('stopping a watch (null) means nothing fires', () => {
    expect(run([start(), set(rule()), set(null), end(1, 5)]).fired).toEqual([]);
  });

  it('carries the auto flag through', () => {
    expect(run([start(), set(rule({ auto: true })), end(0, 5)]).fired[0]?.auto).toBe(true);
  });
});

describe('watchStep: quiet', () => {
  const q = rule({ end: 'none', quietSeconds: 30 });

  it('fires once after N seconds of silence, not before', () => {
    let r = run([start(0), set(q, 0), out('working\r\n', 1000)]);
    expect(nextWakeAt(r.state)).toBe(31_000);
    r = run([tick(30_999)], r.state);
    expect(r.fired).toEqual([]);
    r = run([tick(31_000)], r.state);
    expect(r.fired.map((f) => [f.reason, f.quietSeconds])).toEqual([['quiet', 30]]);
    r = run([tick(90_000)], r.state);
    expect(r.fired).toEqual([]);
    expect(nextWakeAt(r.state)).toBeNull();
  });

  it('re-arms after output resumes and stops after three fires', () => {
    let state = run([start(0), set(q, 0)]).state;
    let count = 0;
    for (let i = 0; i < 5; i++) {
      const base = i * 100_000;
      const r = run([out('more\r\n', base + 1), tick(base + 40_000)], state);
      state = r.state;
      count += r.fired.length;
    }
    expect(count).toBe(MAX_QUIET_FIRES);
  });

  it('pauses on the alternate screen', () => {
    let r = run([start(0), set(q, 0), out('\x1b[?1049hvim screen', 10)]);
    expect(r.state.altScreen).toBe(true);
    r = run([tick(100_000)], r.state);
    expect(r.fired).toEqual([]);
    r = run([out('\x1b[?1049l', 100_001), tick(129_000)], r.state);
    expect(r.fired).toEqual([]);
    r = run([tick(130_002)], r.state);
    expect(r.fired.map((f) => f.reason)).toEqual(['quiet']);
  });

  it('does not count a resize repaint or chunks with nothing printable as output', () => {
    let r = run([start(0), set(q, 0), out('a\r\n', 1000)]);
    r = run([{ type: 'resize', at: 20_000 }, out('\x1b[2J\x1b[Hrepainted text', 20_100), out('\x1b[?25l\x1b[1;1H', 25_000)], r.state);
    expect(r.state.lastOutputAt).toBe(1000);
    r = run([tick(31_000)], r.state);
    expect(r.fired.map((f) => f.reason)).toEqual(['quiet']);
  });

  it('a watch set while a command runs counts silence from then', () => {
    const r = run([start(0), out('x\r\n', 10), set(q, 50_000), tick(60_000)]);
    expect(r.fired).toEqual([]);
    expect(nextWakeAt(r.state)).toBe(80_000);
  });
});

describe('watchStep: match', () => {
  const m = rule({ end: 'none', match: 'Listening on' });

  it('matches across two chunks and inside ANSI colour codes, case-insensitively, once only', () => {
    const r = run([start(0), set(m, 0), out('server \x1b[32mlist', 10), out('ening\x1b[0m ON :3000\r\n', 20), out('listening on :3001\r\n', 30)]);
    expect(r.fired.map((f) => [f.reason, f.line])).toEqual([['matched', 'server listening ON :3000']]);
  });

  it('matches an ANSI sequence cut between chunks', () => {
    const r = run([start(0), set(m, 0), out('\x1b[3', 10), out('2mlistening on 80\r\n', 20)]);
    expect(r.fired.map((f) => f.line)).toEqual(['listening on 80']);
  });

  it('tests an unfinished last line after a pause (prompts have no newline)', () => {
    const p = rule({ end: 'none', match: 'password' });
    let r = run([start(0), set(p, 0), out('Password: ', 100)]);
    expect(r.fired).toEqual([]);
    expect(nextWakeAt(r.state)).toBe(400);
    r = run([tick(399)], r.state);
    expect(r.fired).toEqual([]);
    r = run([tick(400)], r.state);
    expect(r.fired.map((f) => f.line)).toEqual(['Password:']);
  });

  it('does not match the typed command line, which comes before the block starts', () => {
    const r = run([set(m, 0), out('echo listening on\r\n', 5), start(10), out('nothing\r\n', 20), end(0, 30)]);
    expect(r.fired).toEqual([]);
  });

  it('matches the last line at the end of the command', () => {
    const r = run([start(0), set(rule({ end: 'any', match: 'done' }), 0), out('all done', 10), end(0, 20)]);
    expect(r.fired.map((f) => f.reason)).toEqual(['matched', 'finished']);
  });
});

describe('watch text', () => {
  it('puts the reason in words', () => {
    expect(watchReasonText({ reason: 'failed', exitCode: 1, line: null, quietSeconds: null })).toBe('Failed · exit 1');
    expect(watchReasonText({ reason: 'finished', exitCode: 0, line: null, quietSeconds: null })).toBe('Finished · exit 0');
    expect(watchReasonText({ reason: 'quiet', exitCode: null, line: null, quietSeconds: 30 })).toBe('Quiet for 30 s · may be waiting for you');
    expect(watchReasonText({ reason: 'matched', exitCode: null, line: 'listening on :3000', quietSeconds: null })).toBe('Printed: listening on :3000');
  });

  it('never puts output in a notification', () => {
    expect(watchNotificationText({ reason: 'matched', exitCode: null, quietSeconds: null })).not.toContain(':3000');
  });
});

describe('WatchRule contract', () => {
  it('rejects a quiet time under five seconds and a match over 200 characters', () => {
    expect(WatchRule.safeParse({ quietSeconds: 2 }).success).toBe(false);
    expect(WatchRule.safeParse({ match: 'x'.repeat(201) }).success).toBe(false);
    expect(WatchRule.parse({})).toEqual({ end: 'any', quietSeconds: null, match: null, auto: false });
  });
});
