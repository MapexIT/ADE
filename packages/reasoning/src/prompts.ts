/** Prompt templates and reply parsers. Pure, so every strategy shares one wording and one parser. */

const PLANNING_RULES =
  'You are planning, not implementing. Do not modify any file and do not run commands that change anything. You may read files to understand the code.';

export const COT_INSTRUCTION = [
  'Before you change anything, think step by step:',
  '1. Restate the goal in one sentence.',
  '2. List what you need to inspect and inspect it.',
  '3. Reason through the options and pick one, saying why.',
  '4. Write a short numbered plan.',
  'Then carry out the plan.',
].join('\n');

const FINAL = 'FINAL APPROACH:';

function taskBlock(task: string) {
  return `Task:\n<task>\n${task}\n</task>`;
}

/** A reasoning path that ends with a plan after "FINAL APPROACH:". `hint` steers paths apart. */
export function samplePrompt(task: string, hint?: string): string {
  return [
    PLANNING_RULES,
    'Think step by step about how to accomplish the task below.',
    hint ? `Angle for this attempt: ${hint}` : '',
    `End your reply with a line "${FINAL}" followed by a concise plan of at most 12 lines.`,
    taskBlock(task),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function scorePrompt(task: string, approach: string): string {
  return [
    PLANNING_RULES,
    'Rate how well the approach below would accomplish the task: correctness, completeness, risk and simplicity.',
    'Reply with only JSON like {"score": 7, "reason": "one sentence"}, where score is from 1 (poor) to 10 (excellent).',
    taskBlock(task),
    `Approach:\n<approach>\n${approach}\n</approach>`,
  ].join('\n\n');
}

export function aggregatePrompt(task: string, approaches: string[]): string {
  return [
    PLANNING_RULES,
    'Merge the approaches below into one that keeps the strengths of each and drops their weaknesses.',
    `End your reply with a line "${FINAL}" followed by the merged plan of at most 12 lines.`,
    taskBlock(task),
    ...approaches.map((a, i) => `Approach ${i + 1}:\n<approach>\n${a}\n</approach>`),
  ].join('\n\n');
}

export function refinePrompt(task: string, approach: string, feedback?: string): string {
  return [
    PLANNING_RULES,
    'Improve the approach below: find gaps, wrong assumptions and risks, and fix them.',
    feedback ? `A reviewer said: ${feedback}` : '',
    `End your reply with a line "${FINAL}" followed by the improved plan of at most 12 lines.`,
    taskBlock(task),
    `Approach:\n<approach>\n${approach}\n</approach>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The turn's prompt once reasoning chose an approach. The user's words come first, unchanged. */
export function finalPrompt(task: string, approach: string | null, label: string): string {
  if (!approach) return `${task}\n\n${COT_INSTRUCTION}`;
  return [
    task,
    `---\nBefore this turn ADE reasoned about the task (${label}) and chose this approach. Follow it unless you find it is wrong, and say so if you deviate:\n<approach>\n${approach}\n</approach>`,
    COT_INSTRUCTION,
  ].join('\n\n');
}

const MAX_APPROACH = 4000;

/** The plan after the last "FINAL APPROACH:", or the end of the reply when the agent left the marker out. */
export function extractApproach(reply: string): string {
  const at = reply.toUpperCase().lastIndexOf(FINAL);
  const text = (at === -1 ? reply : reply.slice(at + FINAL.length)).trim();
  return text.length > MAX_APPROACH ? text.slice(text.length - MAX_APPROACH) : text;
}

/** The score from a rating reply: JSON first, then "score: n", then a lone "n/10". Null when there is none. */
export function parseScore(reply: string): { score: number; reason: string | null } | null {
  const clamp = (n: number) => Math.min(10, Math.max(1, n));
  for (const m of reply.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]) as { score?: unknown; reason?: unknown };
      if (typeof o.score === 'number' && Number.isFinite(o.score)) return { score: clamp(o.score), reason: typeof o.reason === 'string' ? o.reason : null };
    } catch {
      // not JSON; try the next brace pair
    }
  }
  const labelled = /score\D{0,5}(\d+(?:\.\d+)?)/i.exec(reply) ?? /\b(\d+(?:\.\d+)?)\s*\/\s*10\b/.exec(reply);
  return labelled ? { score: clamp(Number(labelled[1])), reason: null } : null;
}
