import type { ReasoningMethod, ReasoningSettings } from '@ade/contracts';
import { aggregatePrompt, extractApproach, finalPrompt, parseScore, refinePrompt, samplePrompt, scorePrompt } from './prompts.ts';
import type { ReasoningStrategy, StepReport, StrategyContext, StrategyResult } from './types.ts';
import { ANGLES, mostConsistent, pool, ReasoningCancelled, resample, similarity, throwIfAborted } from './util.ts';

/** The score a candidate gets when its rating could not be read. Mid-scale, so it neither wins nor loses by default. */
const UNRATED = 5;
const MAX_DETAIL = 4000;

interface Candidate {
  id: string;
  approach: string;
  score: number | null;
  reason: string | null;
}

/** One reasoning run: numbers its steps, reports each one, and counts agent calls. */
class Trace {
  calls = 0;
  private n = 0;
  private readonly ctx: StrategyContext;
  constructor(ctx: StrategyContext) {
    this.ctx = ctx;
  }

  report(step: Omit<StepReport, 'stepId'> & { stepId?: string }): string {
    const stepId = step.stepId ?? `s${++this.n}`;
    this.ctx.report({ ...step, stepId, detail: step.detail ? step.detail.slice(0, MAX_DETAIL) : null });
    return stepId;
  }

  /** Asks the agent once as a step of the graph. Returns null when that call failed (the step is marked failed). */
  async ask(phase: StepReport['phase'], label: string, parents: string[], prompt: string): Promise<{ id: string; reply: string } | null> {
    throwIfAborted(this.ctx.signal);
    const id = this.report({ phase, label, parents, status: 'running', score: null, detail: null });
    this.calls++;
    try {
      const reply = await this.ctx.thinker.think(prompt, this.ctx.signal);
      throwIfAborted(this.ctx.signal);
      return { id, reply };
    } catch (err) {
      if (err instanceof ReasoningCancelled || this.ctx.signal.aborted) throw new ReasoningCancelled();
      this.report({ stepId: id, phase, label, parents, status: 'failed', score: null, detail: (err as Error).message });
      return null;
    }
  }

  /** A step that produces an approach (sample, generate, aggregate, refine, mutate). */
  async propose(phase: StepReport['phase'], label: string, parents: string[], prompt: string): Promise<Candidate | null> {
    const r = await this.ask(phase, label, parents, prompt);
    if (!r) return null;
    const approach = extractApproach(r.reply);
    this.report({ stepId: r.id, phase, label, parents, status: 'done', score: null, detail: approach });
    return { id: r.id, approach, score: null, reason: null };
  }

  /** Rates a candidate in place. An unreadable rating counts as UNRATED. */
  async rate(task: string, c: Candidate, label: string): Promise<void> {
    const r = await this.ask('score', label, [c.id], scorePrompt(task, c.approach));
    const parsed = r ? parseScore(r.reply) : null;
    c.score = parsed?.score ?? UNRATED;
    c.reason = parsed?.reason ?? null;
    if (r) this.report({ stepId: r.id, phase: 'score', label, parents: [c.id], status: 'done', score: c.score, detail: parsed ? parsed.reason : 'No score in the reply; counted as 5.' });
  }

  done(approach: string | null): StrategyResult {
    return { approach, calls: this.calls };
  }
}

function needAny(cands: (Candidate | null)[], what: string): Candidate[] {
  const ok = cands.filter((c): c is Candidate => c !== null);
  if (!ok.length) throw new Error(`Every ${what} failed, so nothing was sent.`);
  return ok;
}

const byScore = (a: Candidate, b: Candidate) => (b.score ?? UNRATED) - (a.score ?? UNRATED);

/** Input-output: the prompt goes to the agent as written. */
export const ioStrategy: ReasoningStrategy = {
  method: 'io',
  label: 'IO (as written)',
  summary: 'Sends your prompt to the agent exactly as you wrote it. No extra agent calls.',
  plannedCalls: () => 0,
  run: async () => ({ approach: null, calls: 0 }),
};

/** Chain of Thought: one turn, with an instruction to reason step by step before acting. */
export const cotStrategy: ReasoningStrategy = {
  method: 'cot',
  label: 'Chain of Thought',
  summary: 'Adds an instruction to reason step by step and plan before changing anything. No extra agent calls.',
  plannedCalls: () => 0,
  run: async () => ({ approach: null, calls: 0 }),
};

/** CoT with self-consistency: several independent reasoning paths; the plan that agrees most with the others wins. */
export const cotScStrategy: ReasoningStrategy = {
  method: 'cot-sc',
  label: 'CoT self-consistency',
  summary: 'Samples several independent step-by-step reasoning paths and keeps the plan the others agree with most.',
  plannedCalls: (s) => s.samples,
  async run(task, s, ctx) {
    const t = new Trace(ctx);
    const samples = needAny(
      await pool(
        Array.from({ length: s.samples }, (_, i) => () => t.propose('sample', `Reasoning path ${i + 1}`, [], samplePrompt(task, `attempt ${i + 1} of ${s.samples}; reason independently`))),
        ctx.concurrency,
        ctx.signal,
      ),
      'reasoning path',
    );
    const pick = samples[mostConsistent(samples.map((c) => c.approach))]!;
    const agreement = samples.length > 1 ? samples.filter((c) => c !== pick).reduce((sum, c) => sum + similarity(pick.approach, c.approach), 0) / (samples.length - 1) : 1;
    t.report({ phase: 'select', label: 'Most consistent path', parents: samples.map((c) => c.id), status: 'done', score: Math.round(agreement * 100) / 10, detail: pick.approach });
    return t.done(pick.approach);
  },
};

/**
 * Graph of Thought (Besta et al., 2024): generate several thoughts, score them, keep the best, aggregate them into
 * one, refine it, score again and keep the best node of the graph.
 */
export const gotStrategy: ReasoningStrategy = {
  method: 'got',
  label: 'Graph of Thought',
  summary: 'Searches a graph of thoughts: generates several approaches, scores them, merges the best two, refines the merge and keeps the best-scored node.',
  plannedCalls: (s) => 2 * s.branches + 3,
  async run(task, s, ctx) {
    const t = new Trace(ctx);
    const thoughts = needAny(
      await pool(
        Array.from({ length: s.branches }, (_, i) => () => t.propose('generate', `Thought ${i + 1}`, [], samplePrompt(task, ANGLES[i % ANGLES.length]))),
        ctx.concurrency,
        ctx.signal,
      ),
      'thought',
    );
    await pool(thoughts.map((c, i) => () => t.rate(task, c, `Score thought ${i + 1}`)), ctx.concurrency, ctx.signal);
    const best = [...thoughts].sort(byScore).slice(0, 2);
    const graph = [...thoughts];
    let head = best[0]!;
    if (best.length > 1) {
      const merged = await t.propose('aggregate', 'Merge the best thoughts', best.map((c) => c.id), aggregatePrompt(task, best.map((c) => c.approach)));
      if (merged) head = merged;
    }
    const feedback = best.map((c) => c.reason).filter(Boolean).join(' ');
    const refined = await t.propose('refine', 'Refine', [head.id], refinePrompt(task, head.approach, feedback || undefined));
    if (refined) {
      await t.rate(task, refined, 'Score the refined thought');
      graph.push(refined);
    }
    if (head !== best[0] && !refined) {
      await t.rate(task, head, 'Score the merged thought');
      graph.push(head);
    }
    const winner = [...graph].sort(byScore)[0]!;
    t.report({ phase: 'select', label: 'Best node', parents: [winner.id], status: 'done', score: winner.score, detail: winner.approach });
    return t.done(winner.approach);
  },
};

/**
 * Fleet of Agents (Klein et al., 2024): a fleet of agents each proposes a plan; every generation the fleet is
 * scored, resampled in proportion to the scores (genetic particle filtering, with the best plan so far allowed back
 * in), and each surviving agent mutates its plan. The best plan ever seen wins.
 */
export const foaStrategy: ReasoningStrategy = {
  method: 'foa',
  label: 'Fleet of Agents',
  summary: 'Evolves a fleet of plans: each generation scores the fleet, resamples it by score (keeping the best so far in play) and has each agent improve its plan.',
  plannedCalls: (s) => s.agents * (2 * s.generations + 2),
  async run(task, s, ctx) {
    const t = new Trace(ctx);
    let fleet = needAny(
      await pool(
        Array.from({ length: s.agents }, (_, i) => () => t.propose('generate', `Agent ${i + 1}: first plan`, [], samplePrompt(task, ANGLES[i % ANGLES.length]))),
        ctx.concurrency,
        ctx.signal,
      ),
      'agent',
    );
    const seen: Candidate[] = [];
    for (let g = 1; g <= s.generations; g++) {
      await pool(fleet.map((c, i) => () => t.rate(task, c, `Generation ${g}: score agent ${i + 1}`)), ctx.concurrency, ctx.signal);
      seen.push(...fleet);
      // Backtracking: the best plan seen so far competes with the current fleet.
      const elite = [...seen].sort(byScore)[0]!;
      const pool_ = fleet.includes(elite) ? fleet : [...fleet, elite];
      const picked = resample(pool_.map((c) => c.score ?? UNRATED), s.agents, ctx.random).map((i) => pool_[i]!);
      t.report({
        phase: 'resample',
        label: `Generation ${g}: resample the fleet`,
        parents: [...new Set(picked.map((c) => c.id))],
        status: 'done',
        score: null,
        detail: `Kept: ${picked.map((c) => `${c.id} (${c.score ?? UNRATED})`).join(', ')}`,
      });
      throwIfAborted(ctx.signal);
      const mutated = await pool(
        picked.map((c, i) => () => t.propose('mutate', `Generation ${g}: agent ${i + 1} improves its plan`, [c.id], refinePrompt(task, c.approach, c.reason ?? undefined))),
        ctx.concurrency,
        ctx.signal,
      );
      fleet = mutated.map((c, i) => c ?? picked[i]!);
    }
    const fresh = fleet.filter((c) => c.score === null);
    await pool(fresh.map((c, i) => () => t.rate(task, c, `Final score: agent ${i + 1}`)), ctx.concurrency, ctx.signal);
    const winner = [...new Set([...seen, ...fleet])].sort(byScore)[0]!;
    t.report({ phase: 'select', label: 'Best plan in the fleet', parents: [winner.id], status: 'done', score: winner.score, detail: winner.approach });
    return t.done(winner.approach);
  },
};

/** Registry: one strategy per method. */
export const STRATEGIES: Record<ReasoningMethod, ReasoningStrategy> = {
  io: ioStrategy,
  cot: cotStrategy,
  'cot-sc': cotScStrategy,
  got: gotStrategy,
  foa: foaStrategy,
};

export const METHODS = Object.keys(STRATEGIES) as ReasoningMethod[];

export function strategyFor(method: ReasoningMethod): ReasoningStrategy {
  return STRATEGIES[method];
}

/** The text the agent receives for the turn. IO leaves the prompt exactly as written. */
export function buildPrompt(method: ReasoningMethod, text: string, approach: string | null): string {
  return method === 'io' ? text : finalPrompt(text, approach, STRATEGIES[method].label);
}

export const DEFAULT_SETTINGS: ReasoningSettings = { method: 'io', samples: 3, branches: 3, agents: 3, generations: 1 };
