import type { ReasoningMethod, ReasoningSettings } from '@ade/contracts';

/** Asks the agent one question and returns its reply. The host runs it read-only; nothing it does lands. */
export interface Thinker {
  think(prompt: string, signal: AbortSignal): Promise<string>;
}

/** One node in the reasoning graph, reported as it starts and again when it ends. */
export interface StepReport {
  stepId: string;
  phase: 'sample' | 'generate' | 'score' | 'aggregate' | 'refine' | 'select' | 'mutate' | 'resample';
  label: string;
  parents: string[];
  status: 'running' | 'done' | 'failed';
  score: number | null;
  detail: string | null;
}

export interface StrategyContext {
  thinker: Thinker;
  signal: AbortSignal;
  report(step: StepReport): void;
  /** A number in [0, 1); injected so resampling is reproducible in tests. */
  random(): number;
  /** How many agent calls may run at once. */
  concurrency: number;
}

export interface StrategyResult {
  /** The approach reasoning settled on, or null when the method does not search (IO, CoT). */
  approach: string | null;
  /** Agent calls made while reasoning. */
  calls: number;
}

/** Strategy pattern: every reasoning method has the same shape, so the host never depends on one of them. */
export interface ReasoningStrategy {
  readonly method: ReasoningMethod;
  readonly label: string;
  readonly summary: string;
  /** Extra agent calls the method makes before the turn, for the confirmation dialog. */
  plannedCalls(settings: ReasoningSettings): number;
  run(task: string, settings: ReasoningSettings, ctx: StrategyContext): Promise<StrategyResult>;
}
