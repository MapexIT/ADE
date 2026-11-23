import { describe, expect, it } from 'vitest';
import type { ReasoningSettings } from '@ade/contracts';
import {
  buildPrompt,
  DEFAULT_SETTINGS,
  extractApproach,
  METHODS,
  mostConsistent,
  parseScore,
  pool,
  ReasoningCancelled,
  resample,
  similarity,
  strategyFor,
  type StepReport,
  type Thinker,
} from '../src/index.ts';

const settings = (s: Partial<ReasoningSettings>): ReasoningSettings => ({ ...DEFAULT_SETTINGS, ...s });

/** A scripted agent: answers rating prompts with `rate(approach)` and plans with `plan(prompt, n)`. */
function scripted(plan: (prompt: string, n: number) => string, rate: (approach: string) => number = () => 5) {
  const prompts: string[] = [];
  const thinker: Thinker = {
    async think(prompt) {
      prompts.push(prompt);
      if (prompt.includes('Rate how well')) {
        const approach = /<approach>\n([\s\S]*?)\n<\/approach>/.exec(prompt)![1]!;
        return `{"score": ${rate(approach)}, "reason": "ok"}`;
      }
      return `thinking...\nFINAL APPROACH:\n${plan(prompt, prompts.length)}`;
    },
  };
  return { thinker, prompts };
}

function ctx(thinker: Thinker, signal = new AbortController().signal) {
  const steps: StepReport[] = [];
  return { steps, ctx: { thinker, signal, report: (s: StepReport) => void steps.push(s), random: () => 0.5, concurrency: 2 } };
}

describe('reply parsing', () => {
  it('takes the plan after the last marker, or the whole reply', () => {
    expect(extractApproach('a\nFINAL APPROACH: x\nFinal approach:\n1. do it')).toBe('1. do it');
    expect(extractApproach('  just a plan ')).toBe('just a plan');
  });

  it('reads scores from JSON, labels or n/10, clamped to 1..10', () => {
    expect(parseScore('Sure: {"score": 8, "reason": "good"}')).toEqual({ score: 8, reason: 'good' });
    expect(parseScore('Score: 12')).toEqual({ score: 10, reason: null });
    expect(parseScore('I give it 3/10.')).toEqual({ score: 3, reason: null });
    expect(parseScore('no idea')).toBeNull();
  });
});

describe('helpers', () => {
  it('measures word overlap and finds the most consistent answer', () => {
    expect(similarity('add a test for parser', 'add a test for parser')).toBe(1);
    expect(similarity('alpha beta', 'gamma delta')).toBe(0);
    expect(mostConsistent(['patch parser add test', 'rewrite everything in rust', 'patch parser and add test'])).toBe(0);
    expect(mostConsistent([])).toBe(-1);
  });

  it('resamples in proportion to the weights', () => {
    expect(resample([1, 1, 1], 3, () => 0.5)).toEqual([0, 1, 2]);
    expect(resample([0, 9, 0], 3, () => 0.1)).toEqual([1, 1, 1]);
    expect(resample([0, 0], 3, () => 0.1)).toEqual([0, 1, 0]);
    expect(resample([3, 1], 4, () => 0.5)).toEqual([0, 0, 0, 1]);
  });

  it('runs jobs with a concurrency limit and keeps their order', async () => {
    let running = 0;
    let peak = 0;
    const job = (n: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return n;
    };
    expect(await pool([job(1), job(2), job(3), job(4)], 2, new AbortController().signal)).toEqual([1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe('strategies', () => {
  it('IO sends the prompt as written; the others add the step-by-step instruction and the approach', () => {
    expect(buildPrompt('io', 'Fix it', null)).toBe('Fix it');
    expect(buildPrompt('cot', 'Fix it', null)).toMatch(/^Fix it\n\nBefore you change anything, think step by step/);
    const got = buildPrompt('got', 'Fix it', '1. patch');
    expect(got.startsWith('Fix it')).toBe(true);
    expect(got).toContain('Graph of Thought');
    expect(got).toContain('<approach>\n1. patch\n</approach>');
  });

  it('IO and CoT make no extra agent calls', async () => {
    const { thinker, prompts } = scripted(() => 'x');
    for (const m of ['io', 'cot'] as const) {
      expect(strategyFor(m).plannedCalls(DEFAULT_SETTINGS)).toBe(0);
      expect(await strategyFor(m).run('t', settings({ method: m }), ctx(thinker).ctx)).toEqual({ approach: null, calls: 0 });
    }
    expect(prompts).toHaveLength(0);
  });

  it('CoT-SC keeps the reasoning path the others agree with', async () => {
    const plans = ['patch the parser and add a test', 'rewrite the module in another language', 'patch the parser, then add a test'];
    const { thinker, prompts } = scripted((_p, n) => plans[n - 1]!);
    const { ctx: c, steps } = ctx(thinker);
    const s = settings({ method: 'cot-sc', samples: 3 });
    const result = await strategyFor('cot-sc').run('Fix the parser', s, c);
    expect(result.calls).toBe(strategyFor('cot-sc').plannedCalls(s));
    expect(prompts.every((p) => p.includes('Do not modify any file'))).toBe(true);
    expect(result.approach).toContain('patch the parser');
    const select = steps.find((x) => x.phase === 'select')!;
    expect(select.parents).toHaveLength(3);
  });

  it('Graph of Thought generates, scores, merges, refines and keeps the best node', async () => {
    const { thinker } = scripted(
      (p, n) => (p.includes('Merge the approaches') ? 'merged plan' : p.includes('Improve the approach') ? 'refined plan' : `thought ${n}`),
      (a) => (a === 'refined plan' ? 9 : a === 'thought 2' ? 7 : 4),
    );
    const { ctx: c, steps } = ctx(thinker);
    const s = settings({ method: 'got', branches: 3 });
    const result = await strategyFor('got').run('task', s, c);
    expect(result.approach).toBe('refined plan');
    expect(result.calls).toBe(strategyFor('got').plannedCalls(s));
    const done = steps.filter((x) => x.status === 'done');
    expect(done.map((x) => x.phase)).toEqual(expect.arrayContaining(['generate', 'score', 'aggregate', 'refine', 'select']));
    const merge = done.find((x) => x.phase === 'aggregate')!;
    expect(merge.parents).toHaveLength(2);
  });

  it('Fleet of Agents evolves the fleet and returns the best plan seen', async () => {
    const { thinker } = scripted(
      (p, n) => (p.includes('Improve the approach') ? `improved ${n}` : `plan ${n}`),
      (a) => (a.startsWith('improved') ? 8 : a === 'plan 1' ? 6 : 3),
    );
    const { ctx: c, steps } = ctx(thinker);
    const s = settings({ method: 'foa', agents: 3, generations: 2 });
    const result = await strategyFor('foa').run('task', s, c);
    expect(result.approach).toMatch(/^improved/);
    expect(result.calls).toBe(strategyFor('foa').plannedCalls(s));
    expect(steps.filter((x) => x.phase === 'resample')).toHaveLength(2);
    expect(steps.filter((x) => x.phase === 'mutate' && x.status === 'done')).toHaveLength(6);
  });

  it('a failed call marks its step failed; when every path fails nothing is sent', async () => {
    let n = 0;
    const flaky: Thinker = {
      async think() {
        n++;
        if (n === 1) throw new Error('agent crashed');
        return 'FINAL APPROACH:\nok';
      },
    };
    const { ctx: c, steps } = ctx(flaky);
    expect((await strategyFor('cot-sc').run('t', settings({ method: 'cot-sc', samples: 2 }), c)).approach).toBe('ok');
    expect(steps.some((x) => x.status === 'failed' && x.detail === 'agent crashed')).toBe(true);

    const broken: Thinker = { think: async () => Promise.reject(new Error('down')) };
    await expect(strategyFor('got').run('t', settings({ method: 'got' }), ctx(broken).ctx)).rejects.toThrow(/Every thought failed/);
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    const slow: Thinker = {
      think: async () => {
        ac.abort();
        return 'FINAL APPROACH:\nx';
      },
    };
    await expect(strategyFor('foa').run('t', settings({ method: 'foa' }), ctx(slow, ac.signal).ctx)).rejects.toBeInstanceOf(ReasoningCancelled);
  });

  it('every method has a label, a summary and a strategy', () => {
    expect(METHODS).toEqual(['io', 'cot', 'cot-sc', 'got', 'foa']);
    for (const m of METHODS) expect(strategyFor(m).summary.length).toBeGreaterThan(20);
  });
});
