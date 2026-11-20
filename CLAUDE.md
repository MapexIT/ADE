# ADE (Agentic Development Environment)

ADE is a dark-mode desktop app that supervises external coding agents. It runs Codex, Claude Code and OpenCode
side by side, gives each session its own Git worktree, and puts one approval, review, terminal and audit
experience over all three. ADE does not contain an agent of its own.

Read these before writing code, in this order:

1. `docs/PRODUCT.md` - what ADE is, principles, glossary
2. `docs/ARCHITECTURE.md` - processes, modules, data model, protocols
3. `docs/FEATURES.md` - every feature with an ID, a phase and acceptance criteria
4. `docs/UI.md` - dark theme tokens, layout, screens
5. `docs/PLAN.md` - the ordered build plan. **Work from this file.**
6. `docs/DECISIONS.md` - settled decisions, release gates, facts still to verify

## How to work

- Follow `docs/PLAN.md` top to bottom. Do one task at a time, tick its checkbox when its "Done when" holds,
  and commit with the task ID in the message (`M2-T04: permission request cards`).
- Build only what `docs/FEATURES.md` lists for the current milestone. If something is missing or unclear,
  add a question to the "Open questions" list in `docs/DECISIONS.md` and pick the simplest reading.
- **Never guess a third-party API.** Read the installed package's type definitions and the linked official
  docs first. Items marked `VERIFY` in the docs are facts nobody has confirmed yet: check them and record the
  answer in `docs/DECISIONS.md`.
- Every task ends with `pnpm typecheck && pnpm lint && pnpm test` passing.
- Keep the app runnable after every task (`pnpm dev`).

## Stack (decided, do not change without asking)

- Electron, TypeScript (strict) everywhere, pnpm workspaces
- Renderer: React + Vite, Tailwind CSS, shadcn/ui on Radix, Dockview, Monaco, xterm.js (WebGL), React Flow,
  TanStack Query + Virtual, Zustand, cmdk, Motion
- Host (Electron utility process): official ACP TypeScript SDK, official MCP TypeScript SDK, better-sqlite3,
  Git CLI through `child_process` (no shell strings)
- Terminals (second utility process): node-pty
- Packaging: electron-builder, electron-updater
- Tests: Vitest, Playwright

Use the current stable version of each package and pin it in the lockfile.

## Platforms

Windows and Linux are both first platforms and ship together in the MVP. macOS follows in v1.

- Every feature must work on both. CI runs on Windows and Ubuntu, and a task is not done if it passes on
  only one of them.
- Never hard-code path separators, home folders, shell names or line endings. Use `node:path`, the app
  data folder Electron gives you, and the shell the user picked.
- Shells: PowerShell and Git Bash on Windows; bash, zsh and fish on Linux.
- Installers: a per-user NSIS installer for Windows; an AppImage and a `.deb` for Linux.
- Do not add macOS-only code paths before v1, and do not block them either.

## Commands

```
pnpm install
pnpm dev          # run the app with hot reload
pnpm typecheck
pnpm lint
pnpm test         # unit + integration (uses the fake ACP agent)
pnpm e2e          # Playwright against the built app
pnpm dist         # build the installer for the current OS
```

## Non-negotiable rules

1. **Dark only.** One dark theme from the tokens in `docs/UI.md`. No light theme, no theme switch.
2. **Never touch agent credentials.** ADE launches each agent's unmodified binary or adapter. Sign-in always
   happens in the agent's own flow. Do not read, store, log or proxy agent tokens.
3. **Every session works in its own Git worktree.** Agents never write to the user's checkout.
4. **Nothing lands without an explicit user action.** No auto-commit, auto-merge or auto-push anywhere.
5. **Be honest about safety.** Show the real sandbox state of every session. Never label something
   sandboxed unless the OS enforces it.
6. **Agent-neutral core.** No session, timeline or review code may depend on one agent. Capabilities come
   from the ACP `initialize` handshake; anything an agent does not advertise is shown as "not supported".
7. **Secrets** (connector tokens) go in the OS credential store through Electron `safeStorage`. Never in
   SQLite, settings files, logs, prompts or the repository.
8. **No telemetry.** Nothing leaves the machine except what agents and connectors send themselves.
9. **Electron security:** `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer, strict CSP,
   no remote content, every IPC payload validated with a zod schema.
10. **Process spawning:** always argument arrays, never shell-interpolated strings. Track every child process
    per session and kill the whole tree when the session ends.

## Conventions

- Shared types and zod schemas live in `packages/contracts`. Renderer, host and pty import from there.
- State machines (session, workflow run) are pure functions with exhaustive unit tests.
- Everything that happens in a session is an append-only event in SQLite. UI state is derived from events.
- UK English in UI copy. Sentence case. No emoji in the UI.
- Accessibility: real `button`, `a`, `input` and `label` elements, visible focus, 4.5:1 text contrast.
- Motion: 120 to 200 ms, ease-out, and respect `prefers-reduced-motion`.

## Testing approach

- Write a **fake ACP agent** (`packages/fake-agent`): a small scripted stdio program that speaks ACP and
  replays scenarios (message, tool call, permission request, plan, failure, hang). All integration tests use
  it, so tests never need a real agent or network.
- Unit-test parsers (shell integration sequences, test reports), policies and state machines.
- One Playwright end-to-end test per milestone gate, listed in `docs/PLAN.md`.
