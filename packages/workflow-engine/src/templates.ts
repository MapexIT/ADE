/** WF-04: built-in templates. Each one validates (see the tests) and ends in a gate before any land. */
export const TEMPLATES: Record<string, string> = {
  'parallel-checks': `
name: Build with parallel checks
description: Build, then lint and test at the same time. The gate waits for both; a failing test sends the work back to the agent at most twice.
trigger: work-item
nodes:
  - { id: build, type: agent, agent: claude-code, prompt: "Implement: {{workItem.title}}. {{checkOutput}}" }
  - { id: lint, type: command, run: [pnpm, lint] }
  - { id: test, type: command, run: [pnpm, test] }
  - { id: review, type: gate, question: "Lint and tests ran. Review the change" }
  - { id: land, type: land, mode: commit }
edges:
  - { from: build, to: lint }
  - { from: build, to: test }
  - { from: lint, to: review }
  - { from: test, to: review }
  - { from: test, to: build, when: fail, maxRounds: 2 }
  - { from: review, to: land, when: pass }
`,
  'story-to-pull-request': `
name: Story to pull request
description: Plan, build and test a work item, with two gates before a pull request.
trigger: work-item
budgets: { minutes: 90, turns: 30, loops: 3 }
nodes:
  - { id: plan, type: agent, agent: claude-code, profile: read-only, prompt: "Write a plan for: {{workItem.title}}" }
  - { id: approve-plan, type: gate, question: "Is the plan right?" }
  - { id: build, type: agent, agent: codex, prompt: "Implement the approved plan. {{summary}}" }
  - { id: tests, type: command, run: [pnpm, test] }
  - { id: retry, type: loop, max: 3 }
  - { id: review, type: gate, question: "Review the change before the pull request" }
  - { id: open-pr, type: land, mode: pull-request }
edges:
  - { from: plan, to: approve-plan }
  - { from: approve-plan, to: build, when: pass }
  - { from: build, to: tests }
  - { from: tests, to: review, when: pass }
  - { from: tests, to: retry, when: fail }
  - { from: retry, to: build }
  - { from: review, to: open-pr, when: pass }
`,
  'plan-build-review': `
name: Plan, build, review
nodes:
  - { id: plan, type: agent, agent: claude-code, profile: read-only, prompt: "Plan the change" }
  - { id: build, type: agent, agent: codex, prompt: "Build it. {{summary}}" }
  - { id: review, type: agent, agent: opencode, profile: read-only, prompt: "Review the diff. {{diff}}" }
  - { id: gate, type: gate }
  - { id: land, type: land, mode: commit }
edges:
  - { from: plan, to: build }
  - { from: build, to: review }
  - { from: review, to: gate }
  - { from: gate, to: land, when: pass }
`,
  'fix-failing-tests': `
name: Fix failing tests
trigger: failed-check
budgets: { loops: 5 }
nodes:
  - { id: tests, type: command, run: [pnpm, test] }
  - { id: fix, type: agent, agent: claude-code, prompt: "Make these tests pass. {{checkOutput}}" }
  - { id: retry, type: loop, max: 5 }
  - { id: gate, type: gate }
  - { id: land, type: land, mode: commit }
edges:
  - { from: tests, to: gate, when: pass }
  - { from: tests, to: fix, when: fail }
  - { from: fix, to: retry }
  - { from: retry, to: tests }
  - { from: gate, to: land, when: pass }
`,
  'cross-review': `
name: Cross-review
nodes:
  - { id: build, type: agent, agent: codex, prompt: "Implement the task" }
  - { id: review, type: agent, agent: claude-code, profile: read-only, prompt: "Review the diff and list risks. {{diff}}" }
  - { id: gate, type: gate }
edges:
  - { from: build, to: review }
  - { from: review, to: gate }
`,
  'spec-first': `
name: Spec first
nodes:
  - { id: spec, type: agent, agent: claude-code, profile: read-only, prompt: "Write a spec with acceptance criteria" }
  - { id: approve, type: gate, question: "Approve the spec?" }
  - { id: tests, type: agent, agent: codex, prompt: "Write failing tests from the spec. {{summary}}" }
  - { id: build, type: agent, agent: codex, prompt: "Make the tests pass" }
  - { id: check, type: command, run: [pnpm, test] }
  - { id: gate, type: gate }
  - { id: land, type: land, mode: commit }
edges:
  - { from: spec, to: approve }
  - { from: approve, to: tests, when: pass }
  - { from: tests, to: build }
  - { from: build, to: check }
  - { from: check, to: gate, when: pass }
  - { from: gate, to: land, when: pass }
`,
};

/** Fills `{{summary}}`, `{{diff}}`, `{{checkOutput}}` and `{{workItem.field}}` from a hand-off packet. */
export function renderPrompt(template: string, packet: { summary: string; diff: string; checkOutput: string; workItem: Record<string, string> }): string {
  return template.replace(/\{\{\s*(summary|diff|checkOutput|workItem\.([a-zA-Z0-9_]+))\s*\}\}/g, (_m, key: string, field?: string) => {
    if (field) return packet.workItem[field] ?? '';
    return packet[key as 'summary' | 'diff' | 'checkOutput'] ?? '';
  });
}
