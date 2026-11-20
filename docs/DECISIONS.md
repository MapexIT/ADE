# Decisions

## Settled

| Question | Decision |
| --- | --- |
| Name | ADE, the Agentic Development Environment. |
| Shell and language | Electron with TypeScript end to end. |
| Agent protocol | ACP only, through v1. A native adapter is considered only after v1. |
| First platforms | Windows and Linux together in the MVP. macOS in v1. |
| Agents in the installer | Not bundled. First-run setup installs them with each vendor's official installer. |
| Workflow engine | Our own small engine in TypeScript, run state in SQLite. |
| Theme | Dark only. |
| Host sandbox | Linux: OS sandbox first. Windows: sessions inside WSL2, everything else marked not sandboxed. macOS later. All in v1. |
| Run in place | Not in the MVP. Every session uses a worktree. |
| Telemetry | None. |
| Positioning | Depth over breadth: review, containment, smart terminal, workflows with skills. |
| Purpose | A personal tool first. Nothing in the design may block selling it later. |

## Release gates (not code tasks; a human must clear them)

1. **Claude Code sign-in.** ADE never handles credentials; Claude Code runs unmodified and the user signs in
   through its own flow. Before any public or commercial release, get Anthropic's written confirmation that
   subscription sign-in is acceptable when Claude Code runs behind the SDK-based ACP adapter. Until then the
   documentation recommends an API key. Terms: https://code.claude.com/docs/en/legal-and-compliance
2. **Vendor terms.** Review each vendor's terms for a product that launches their agent before the first
   public release. Ship only unmodified vendor binaries. Name agents in plain text; no vendor logos; no
   vendor name in ADE's own product or feature names.

## Spike questions (answer in milestone M0 and write the answers below)

1. Can one ACP client drive all three agents on Windows and Linux, and what does each advertise at
   `initialize`?
2. For each agent, do file writes and commands go through the client (`fs/*`, `terminal/*`) or run inside
   the agent?
3. For each agent, how do `session/load` after a restart, `session/cancel` and usage reporting behave?
4. How long do a worktree and its setup script take on two real repositories?
5. Can the permission profile switch on the Codex and Claude Code sandboxes at launch, and how?
6. Do the bundled adapters run on Electron's own runtime on Windows and Linux?
7. Does the installer on a clean Windows machine and a clean Linux machine reach a first agent session?
8. Does shell integration report command boundaries reliably in PowerShell, bash and zsh through node-pty?

### Spike answers

Probed on 2026-11-20 on Windows 11 with `docs/spike/probe.mts` (initialize and `session/new` only, no prompt,
so no tokens were used). Raw results, with local paths removed, are in `docs/spike/*.json`. Linux is not
probed yet; CI runs the fake-agent suite on Ubuntu.

1. **One ACP client, three agents.** Yes on Windows for Claude Code (adapter 0.109.0) and Codex (adapter 2.8.0):
   both answered `initialize` and `session/new` through `AcpAgentSession`. Both advertise protocol version 1,
   `loadSession`, image and embedded-context prompts and HTTP MCP. Claude Code advertises no auth methods;
   Codex advertises `api-key` and `chat-gpt`. Modes: Claude Code `default`, `acceptEdits`, `plan`, `auto`,
   `bypassPermissions` (starts in `default`); Codex `read-only`, `workspace-write`, `agent`,
   `agent-full-access` (starts in `agent`). OpenCode was not installed on the probe machine: open.
2. **fs/terminal through the client.** Open: needs a real prompt per agent. ADE advertises both and serves them
   inside the worktree; the fake agent covers the path in tests.
3. **session/load, cancel, usage.** Both real adapters advertise `loadSession`. Cancel and usage need a prompt:
   open. ADE falls back to a fresh agent session in the same worktree when `session/load` fails, and shows
   "usage not reported" until an agent sends `usage_update`.
4. **Worktree timing.** Open for real repositories. On the test fixtures a worktree plus snapshot takes well
   under a second.
5. **Sandbox at launch.** Not verified, so ADE switches no sandbox on and every session shows "Not sandboxed"
   (rule 5). Facts found: the Codex npm package ships `codex-windows-sandbox-setup.exe`, so Codex has some
   Windows sandbox; its `read-only` and `workspace-write` modes describe sandbox-like limits. Verify before
   any session is labelled sandboxed.
6. **Adapters on Electron's runtime.** Both adapters are ESM with `dist/index.js` entry points and need Node 22
   or later; Electron 45 ships Node 24.22. They run with `ELECTRON_RUN_AS_NODE=1` from the packaged app
   (unpacked from the asar). They bring their own agent runtime: `@anthropic-ai/claude-agent-sdk` (with a
   native `claude` binary) and `@openai/codex` (with the `codex` binary), so the user's CLI is used only for
   version display and sign-in; it is not required to start a session.
7. **Clean-machine install.** Open: the unpacked Windows build starts, detects agents and opens first-run
   setup on the development machine. A clean Windows and Linux install is a human gate.
8. **Shell integration through node-pty.** Parser verified on recorded bash and PowerShell byte streams
   (OSC 133 with BEL and ST terminators, OSC 633;E command lines, OSC 7). Live verification in zsh and fish
   is open.

### Decisions made during implementation

| Topic | Decision | Why |
| --- | --- | --- |
| Repository layout | The monorepo lives at the repository root; the pack's docs moved to `docs/`. | Asked for by the user. |
| SQLite driver | Node's built-in `node:sqlite` behind a small `Database` adapter instead of better-sqlite3. | Electron 45 ships Node 24 with `node:sqlite`; the same code runs in Vitest and Electron with no native rebuild, and CI needs no install scripts. better-sqlite3 can be swapped in behind the adapter. |
| Colours | Three hues: blue accent (actions, selection, success), amber attention, red danger. The `--ok` tokens alias the accent. Diff additions are blue, deletions red. | The user asked for at most three colours. Every state also has a word, so nothing depends on hue alone. |
| Agent `fake` | A fourth `AgentId` used only by tests, development builds and `ADE_ENABLE_FAKE_AGENT=1`. | Lets integration and e2e tests drive the real session stack without a network. |
| Questions (SR-04) | ACP has no question message, so a question is a permission request whose tool kind is `think`; its options are the answers. | Simplest reading that works with every agent. |
| Mid-turn notes (AP-03) | "Reject with a note" rejects the request and queues the note as the next prompt. | ACP cannot add input to a running turn. |
| Land ends a session | Landing (apply or commit) moves the session to Landed, as in `docs/PRODUCT.md`. | Keeps the state machine as specified. |
| Setup commands | `.ade/workspace.yaml` commands are argument arrays; a string is split on whitespace, never passed to a shell. | Rule 10. |
| Run of a `.cmd` file on Windows | npm shims are resolved to `node script.js`; other batch files run through `cmd.exe /d /c` with the user's own arguments. | Windows cannot start batch files without cmd; arguments never come from an agent. |
| Work items | GitHub items and Shortcut stories come through a `WorkItemProvider` registry; unconnected sources return an empty list. | Keeps the panel connector-neutral. |
| CI | Build, then test. Ubuntu on pull requests; Windows joins on pushes to main. `--ignore-scripts`, pnpm cache, docs-only changes skipped, superseded runs cancelled. e2e and installers run locally. | The user asked for the fewest CI minutes; Windows minutes cost double. |
| Workflow hand-off (WF-05) | Each agent node is a normal session whose worktree starts from the previous node's end checkpoint. Its last message becomes `{{summary}}` and its diff against the node's start becomes `{{diff}}`; command output becomes `{{checkOutput}}`. | Later nodes build on earlier work while every node keeps its own worktree, approvals, review and audit. |
| Workflow land | A land node lands everything since the run's base commit: `apply` applies that range to the checkout; `commit` soft-resets the last session's branch to the base and makes one commit. | Checkpoint commits never reach branch history, and earlier nodes' work is not lost. The schema requires an approved gate before any land, which is the explicit user action rule 4 asks for. |
| Pull-request land mode | Commits on the session branch and says that ADE does not open pull requests yet. | Opening pull requests (RV-14) is M7-T03; pushing is outward-facing. |
| Command nodes | Run in the host as an argument array in the run's latest worktree (a detached scratch worktree if no agent node ran yet), pass on exit 0, and appear in the run history. | The code runner lives in the pty process for interactive runs; a workflow only needs the exit code and output. |
| Model per node (WF-09) | Set through the ACP session config option whose category is `model` (`session/set_config_option`). A session whose agent does not offer the model fails to start with that reason. | The M0 probe showed Claude Code and Codex both expose a `model` config option. Failing is more honest than silently using another model. |
| Agent overrides | Starting a run can map a node's agent to another (for example when Codex is not installed). | WF-09 asks for mixed agents; templates name agents the user may not have. |
| Connector nodes | Fail with "not supported yet" until connector actions (CO-05 to CO-10) arrive in M7. | No connector write actions exist yet. |
| Runs and restarts | A run that was running when ADE closed comes back paused; a run waiting at a gate stays waiting. | Nothing restarts without the user. |

## Facts to verify (`VERIFY` markers in the docs)

- Entry points and prerequisites of `@agentclientprotocol/claude-agent-acp` and
  `@agentclientprotocol/codex-acp`.
- Electron guidance for `utilityProcess` with `MessagePortMain` streams.
- Codex sandbox behaviour on Windows and Linux, and how each adapter accepts sandbox and permission-mode
  settings.
- Each agent's skills folder and discovery rules.
- `safeStorage.getSelectedStorageBackend()` on Linux and the plain-text fallback.
- electron-updater behaviour for AppImage and `.deb`.
- The ACP TypeScript SDK's exact API (read its types; do not rely on memory).

## Open questions

- **Agent command terminals (TM-04).** Commands an agent runs through `terminal/create` run in the host and are
  reported in tool calls; they do not yet appear as live terminals in the pty panel. Simplest reading for now:
  their output shows in the tool card.
- **Scrollback restore (TM-01).** Terminal output is kept in memory while ADE runs; serialising it to disk on
  exit is not built yet.
- **Shortcut and GitHub connectors (M5-T02, M5-T03).** GitHub issues come from `gh search issues
  --assignee=@me` (verified locally), using the user's `gh` login or a stored token. Shortcut uses the hosted MCP
  server with the stored token; ADE picks the story search tool and its query argument from the server's own
  tool list and searches `owner:me !is:done`. Both the tool choice and that query syntax need a check against a
  real workspace. GitHub Projects items are not built.
- **Connectors for agents (CO-04).** Passing a connector to agents hands them the token, so it is opt-in in
  settings and off by default; HTTP servers go only to agents that advertise HTTP MCP.
- **Linux safeStorage.** `getSelectedStorageBackend()` values `basic_text` and `unknown` are treated as
  unsafe and storing is refused. Confirm the full list of backend names on a real Linux desktop.

## References

- Agent Client Protocol: https://agentclientprotocol.com/protocol/overview.md ,
  https://agentclientprotocol.com/protocol/tool-calls ,
  https://agentclientprotocol.com/protocol/v1/session-setup
- OpenCode ACP: https://opencode.ai/docs/cli/acp/
- OpenCode security policy: https://github.com/anomalyco/opencode/security
- Codex app-server (not used before v1): https://learn.chatgpt.com/docs/app-server.md
- Claude Code sandboxing: https://code.claude.com/docs/en/sandbox-environments.md
- Shortcut MCP server: https://www.shortcut.com/help/integrations/mcp-server/
- GitHub MCP server: https://github.com/mcp/github/github-mcp-server
- VS Code shell integration (reference for OSC sequences):
  https://code.visualstudio.com/docs/terminal/shell-integration
- Agent Skills: https://www.anthropic.com/news/donating-agent-skills-to-the-agentic-ai-foundation
