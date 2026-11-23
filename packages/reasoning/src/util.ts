/** Thrown when the user cancels a reasoning run. */
export class ReasoningCancelled extends Error {
  constructor() {
    super('Reasoning was cancelled.');
    this.name = 'ReasoningCancelled';
  }
}

export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw new ReasoningCancelled();
}

/** Runs `jobs` with at most `limit` at a time, keeping their order. Stops starting new ones once aborted. */
export async function pool<T>(jobs: (() => Promise<T>)[], limit: number, signal: AbortSignal): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      throwIfAborted(signal);
      const i = next++;
      results[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, worker));
  return results;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
}

/** Jaccard similarity of the two texts' word sets, 0..1. */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Self-consistency for free-form answers: the index of the answer that agrees most with all the others (the
 * medoid). Ties go to the earliest. Returns -1 for an empty list.
 */
export function mostConsistent(answers: string[]): number {
  let best = -1;
  let bestScore = -1;
  answers.forEach((a, i) => {
    const score = answers.reduce((sum, b, j) => (i === j ? sum : sum + similarity(a, b)), 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

/**
 * Systematic resampling: picks `n` indexes with probability proportional to `weights`, using one random draw.
 * Heavier particles may be picked more than once; zero weights are never picked unless all are zero.
 */
export function resample(weights: number[], n: number, random: () => number): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!weights.length) return [];
  if (total <= 0) return Array.from({ length: n }, (_, i) => i % weights.length);
  const step = total / n;
  let u = random() * step;
  const picked: number[] = [];
  let acc = 0;
  for (let i = 0; i < weights.length && picked.length < n; i++) {
    acc += Math.max(0, weights[i]!);
    while (u < acc && picked.length < n) {
      picked.push(i);
      u += step;
    }
  }
  while (picked.length < n) picked.push(weights.length - 1);
  return picked;
}

/** Angles that push parallel reasoning paths apart. */
export const ANGLES = [
  'the most direct, minimal change',
  'robustness: edge cases, errors and tests first',
  'the design that fits the existing code best',
  'performance and simplicity',
  'what could go wrong, and how to avoid it',
  'how a senior reviewer would want it done',
  'an unconventional alternative',
];
