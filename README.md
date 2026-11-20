# ADE

An Agentic Development Environment for AI-first building on the desktop.

ADE is a dark-mode Electron app that supervises external coding agents: Codex, Claude Code and OpenCode.
Each session gets its own Git worktree, and one approval, review, terminal and audit experience sits over all
three. ADE has no agent of its own and never handles agent credentials.

Product and build docs live in [`docs/`](docs): start with [`CLAUDE.md`](CLAUDE.md), then
[`docs/PLAN.md`](docs/PLAN.md) for progress and [`docs/DECISIONS.md`](docs/DECISIONS.md) for what was decided
and what is still open.

## Quick start

Requirements: Node.js 24, pnpm 10, Git.

```
pnpm install
pnpm dev          # run the app with hot reload
pnpm typecheck
pnpm lint
pnpm test         # unit and integration tests (fake ACP agent, temporary Git repositories)
pnpm build        # bundle main, host, pty, preload and renderer
pnpm e2e          # Playwright gates against the built app (run `pnpm build` first)
pnpm dist         # installer for the current OS: NSIS on Windows, AppImage and .deb on Linux
```

Development builds offer a scripted **Fake agent** next to the real ones, so you can try every flow without a
network or an account. Packaged builds enable it only with `ADE_ENABLE_FAKE_AGENT=1`.

## Layout

```
apps/desktop/
  src/main/        Electron main: secure window, process supervisor, main-only API, safeStorage
  src/preload/     typed bridge; forwards MessagePorts to the page
  src/host/        utility process: sessions, ACP clients, SQLite event store, review, files, runs
  src/pty/         utility process: node-pty terminals, smart blocks, runs
  src/renderer/    React UI (Tailwind, Dockview, Monaco, xterm.js, React Flow, cmdk, zustand)
  e2e/             Playwright milestone gates
packages/
  contracts/         zod schemas and a validated RPC layer shared by every process
  session-core/      pure session state machine, event projection, chunk coalescing
  acp-client/        AgentRuntime and AgentSession over the official ACP SDK
  fake-agent/        scripted ACP agent for tests
  git/               worktrees, checkpoints, diffs, land and discard (argument arrays only)
  shell-integration/ OSC 133/633/7 parser, block builder, scripts for bash, zsh, fish and PowerShell
  ui/                design tokens and shared accessible components
```

## Design patterns

| Pattern | Where |
| --- | --- |
| Strategy | `AgentRuntime` per agent (`acp-client/runtimes.ts`); `PermissionPolicy` per profile (`host/permission-policy.ts`) |
| Template method | `AcpRuntime` holds the shared start flow; agents differ only in their descriptor |
| Adapter | `AcpAgentSession` adapts the ACP SDK to ADE's `AgentSession`; `Database` adapts `node:sqlite`; port adapters in `contracts/rpc.ts` |
| Factory | `createRuntimes`, `createHost` (composition root) |
| Repository | one class per table in `host/repositories.ts`; the append-only `EventStore` |
| State machine | `session-core/state-machine.ts`, a pure function with exhaustive tests |
| Observer | host `EventBus`, RPC topic subscribers, terminal data listeners |
| Reducer / event sourcing | `applyEvent` rebuilds the timeline from stored events |
| Command | the command palette registry (`renderer/lib/commands.ts`) |
| Builder | `BlockBuilder` turns shell events into command blocks |
| Proxy | the renderer's reconnecting process connections survive host and pty restarts |
| Facade | the preload bridge |
| Supervisor | `ProcessSupervisor` restarts utility processes with backoff |

## Design

One dark theme from the tokens in `packages/ui/src/tokens.css`, limited to three hues: blue for actions,
selection and success, amber for anything that needs you, red for failures and destructive actions. Every state
also carries a word, so colour never carries meaning alone.

## CI

`.github/workflows/ci.yml` runs two stages, build (typecheck, lint, bundle) then test. To spend as few minutes as
possible it runs on Ubuntu for pull requests, adds Windows only for pushes to `main`, installs without
scripts, caches the pnpm store, skips documentation-only changes and cancels superseded runs. There is no
deploy stage: ADE is a desktop app.
