# Build plan

Work top to bottom. One task at a time. Tick a task only when its "Done when" holds and
`pnpm typecheck && pnpm lint && pnpm test` passes. At the end of every milestone: run its gate, write a
short summary of what was built and what was deferred, then **stop and wait for the user**.

Feature IDs refer to `docs/FEATURES.md`.

> Status on 2026-11-20: M1 to M4 are built and their Playwright gates pass on Windows; CI runs the unit and
> integration suite on Ubuntu (and on Windows for pushes to main). Open items are listed in
> `docs/DECISIONS.md` under "Spike answers" and "Open questions". Tasks left unticked are partly done or need
> a human (real agents, clean machines, connector accounts).

## M0 - Spike (throwaway code on a `spike` branch)

Goal: answer the eight spike questions in `docs/DECISIONS.md` before any product code exists.

- [ ] **M0-T01** Minimal Electron + TypeScript app with one utility process. Done when `pnpm dev` opens a
      window on Windows and Linux.
- [ ] **M0-T02** ACP hello world: spawn `opencode acp`, run `initialize`, `session/new` and one
      `session/prompt`, and print every `session/update`. Repeat with the Claude Code and Codex adapters.
      Done when all three answer one prompt and their `initialize` responses are saved to `docs/spike/`.
- [ ] **M0-T03** Capability probes: advertise `fs` and `terminal`, then record whether each agent calls
      them, how `session/load` and `session/cancel` behave, and whether usage is reported. Done when
      questions 2 and 3 are answered.
- [ ] **M0-T04** Time worktree creation plus a setup script on two real repositories. Done when question 4
      is answered.
- [ ] **M0-T05** Find how to switch on each agent's sandbox and permission mode at launch. Done when
      question 5 is answered.
- [ ] **M0-T06** node-pty with shell integration in PowerShell, bash and zsh: print parsed command
      boundaries and exit codes. Done when question 8 is answered.
- [ ] **M0-T07** Build unsigned installers and install them on a clean Windows machine and a clean Linux
      machine. Done when questions 6 and 7 are answered.

**Gate:** all answers are written in `docs/DECISIONS.md`. Report anything that contradicts
`docs/ARCHITECTURE.md` and propose the smallest change. Stop.

## M1 - Skeleton

- [x] **M1-T01** Monorepo: pnpm workspaces, strict TypeScript, ESLint, Prettier, Vitest, CI on Windows and
      Ubuntu. Done when CI is green on an empty test.
- [x] **M1-T02** Electron shell: main, typed preload, sandboxed renderer with CSP, host and pty utility
      processes with supervised restart. Done when killing either utility process restarts it and the UI
      shows a reconnect notice.
- [x] **M1-T03** `packages/contracts`: zod schemas for entities, IPC requests and events, plus request and
      stream helpers. Done when an invalid payload is rejected in a test.
- [x] **M1-T04** UI foundation: tokens, Tailwind, restyled shadcn/ui base components, top bar, Dockview
      layout with persistence, command palette. Done when the layout survives a restart.
- [x] **M1-T05** SQLite with migrations; workspaces and settings; "open repository" flow that requires a
      Git repository. Done when a workspace reopens after a restart.
- [x] **M1-T06** Editor (ED-01, ED-02). Done when a file can be found, edited and saved, and an external
      change is detected.
- [x] **M1-T07** `pnpm dist` produces installers on both CI platforms. Done when the artefacts exist.

**Gate (Playwright):** launch, open a repository, edit and save a file, restart, layout and workspace are
restored.

## M2 - Sessions

- [x] **M2-T01** `packages/fake-agent` with scripted scenarios: message, tool call, permission request,
      plan, question, failure, hang. Done when each scenario runs from a test.
- [x] **M2-T02** `packages/acp-client`: `AgentRuntime` and `AgentSession` over the official SDK, runtimes
      for the three agents, detection and health (ST-01). Done when the fake agent and one real agent run
      through the same interface.
- [x] **M2-T03** Session service, state machine and event store. Done when every transition in
      `docs/PRODUCT.md` has a unit test and invalid transitions are rejected.
- [x] **M2-T04** Composer (ST-02, ST-03, ST-04).
- [x] **M2-T05** Timeline, inline results, plan panel, session header (WA-01 to WA-04).
- [x] **M2-T06** Steering (SR-01 to SR-05).
- [x] **M2-T07** Permissions: profiles, approval card, reject with a note, Needs-you inbox, notifications
      (AP-01 to AP-05).
- [x] **M2-T08** Sessions list, concurrency cap, history, usage, limits, protocol inspector (PL-01, PL-02,
      HI-01, HI-03, HI-04, WA-05).

**Gate (Playwright, fake agent):** start a session, see a tool call, approve a permission request, receive
a message, send a follow-up, restart the app, history is intact. Manual check: one real prompt with each
of the three agents on Windows and on Linux.

## M3 - Worktrees and review

- [x] **M3-T01** `packages/git`: worktree create and remove, setup script, bring my changes (CN-01 to
      CN-03), with integration tests on temporary repositories.
- [x] **M3-T02** Checkpoints at turn start and end; undo turn (RV-02, RV-04).
- [x] **M3-T03** Changes view with Monaco diff; per-turn diff (RV-01, RV-03).
- [x] **M3-T04** Comment to agent; edit in place with attribution (RV-05, RV-06).
- [x] **M3-T05** Land and discard; audit log (RV-07, RV-08, HI-02).
- [ ] **M3-T06** Sandbox pass-through, sandbox badge, minimal environment (CN-04 to CN-06).
      Badge and minimal environment are done and tested; pass-through waits for spike question 5.

**Gate (Playwright, fake agent):** two turns edit two files; the per-turn diff is correct; undo turn 2;
land one file into the checkout; discard the session; the final patch exists in app data.

## M4 - Terminals and code runner

- [x] **M4-T01** pty process and terminal panel: tabs, splits, search, resize, process tree kill (TM-01,
      TM-02, TM-06).
- [x] **M4-T02** Shell-integration scripts and parser, unit-tested on recorded byte streams (SM-02).
- [x] **M4-T03** Smart terminal: blocks, sticky header, jump, clickable output (SM-01, SM-06, SM-07).
- [x] **M4-T04** Status bar (SM-03).
- [ ] **M4-T05** Agent terminal UI, agent awareness, attention ring, agent command terminals (TM-03, SM-04,
      SM-05, TM-04). Agent terminal UI, awareness and the ring are done; TM-04 live terminals are open.
- [x] **M4-T06** Send to agent and Fix with agent (TM-05, SM-08).
- [x] **M4-T07** Code runner: detection, run bar, run output, send run to agent (CR-01 to CR-04).

**Gate (Playwright):** a failing command produces a failed block; Fix with agent starts a turn with the
block attached; running a configuration adds a history row.

## M5 - Connectors, first run, installers (MVP)

- [x] **M5-T01** MCP client and credential store wrapper, including the Linux backend check.
- [ ] **M5-T02** Shortcut connector and work item panel (CO-01). Built on the hosted MCP server with tool
      discovery; needs a check against a real Shortcut workspace.
- [ ] **M5-T03** GitHub issues and Projects items in the work item panel (CO-01). Issues work through the `gh`
      CLI; Projects items are open.
- [x] **M5-T04** Start from a work item, branch naming, linked sessions; connectors passed to agents as MCP
      servers (CO-02 to CO-04).
- [x] **M5-T05** First-run setup and settings (PK-02, HI-05).
- [x] **M5-T06** Installers, self-update and signing configuration (PK-01, PK-03). Signing certificates
      come from the user: leave documented placeholders, never commit secrets.
- [ ] **M5-T07** Clean-machine install test in CI for Windows and Linux.

**MVP gate:** from a single installer on a clean Windows machine and a clean Linux machine, complete one
task with each of the three agents from prompt to landed change, then restart with history intact. Stop.

## M6 - v1: workflows and skills

- [x] **M6-T01** Workflow YAML schema, validation and engine state machine with persistence (WF-03).
- [x] **M6-T02** Node executors: agent, command, gate, loop, branch, connector, land; hand-off packet;
      agent and model per node (WF-05, WF-09). Connector nodes say "not supported yet" until CO-05.
- [x] **M6-T03** Node canvas with React Flow, node settings, run view, test a node (WF-01, WF-06, WF-11).
      Node positions on the canvas are not saved; the layout is computed from the graph.
- [x] **M6-T04** Budgets, stop rules, retry from step, triggers, workflow picker, templates (WF-02, WF-04,
      WF-07, WF-08, WF-10).
- [x] **M6-T05** Skills: library, builder, draft with an agent, per-node skills, sync to agents (SK-01 to
      SK-05).

**Gate:** the "Story to pull request" template runs end to end with three different agents and stops at
both gates. Covered by `apps/desktop/test/workflows.test.ts` (Claude Code, Codex and OpenCode nodes mapped to the
fake agent) and `e2e/m6-workflows.spec.ts` (the same flow through the UI). Not yet run with the real agents.

## M7 - v1: containment, parallel work and the rest

- [x] **M7-T01** Host sandbox on Linux and WSL2 sessions on Windows; run in place; workspace rules
      (CN-07, CN-08, AP-06). The Linux sandbox is tested for real on the Ubuntu CI runner; WSL sessions are
      verified up to the probe against a real distribution, not yet with a real agent inside WSL.
- [ ] **M7-T02** Compare run, overlap warning, background sessions; fork, hand-off, open in the agent's
      terminal UI; follow mode; shared MCP servers; saved commands (PL-03 to PL-05, SR-06 to SR-08, WA-06,
      ST-05, TM-07).
- [ ] **M7-T03** Checks, batch review, review assistant, rebase and conflicts, pull requests (RV-09 to
      RV-14).
- [ ] **M7-T04** Connector state sync, review comments, failed checks, progress notes, board view (CO-05
      to CO-10).
- [ ] **M7-T05** Smart terminal v1 features (SM-09 to SM-14) and code runner v1 features (CR-05 to CR-11).
- [ ] **M7-T06** Language servers, instruction files, history search, audit export, preview pane (ED-03,
      ED-04, HI-06 to HI-08).
- [ ] **M7-T07** macOS installer (PK-04).

**v1 gate:** a workflow runs three sandboxed agents and lands one result.
