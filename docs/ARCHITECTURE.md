# Architecture

Items marked `VERIFY` are not confirmed. Check them against the official docs or the installed package and
record the answer in `docs/DECISIONS.md` before building on them.

## 1. Processes

| Process | Kind | Owns |
| --- | --- | --- |
| main | Electron main | Windows, menus, updater, notifications, credential store (`safeStorage`), supervising the other processes |
| renderer | Sandboxed browser window | The React UI. Talks only through the preload API |
| host | Electron `utilityProcess` | Sessions, ACP clients, SQLite, worktrees, checkpoints, workflows, skills, connectors, run records |
| pty | Electron `utilityProcess` | node-pty instances for terminals and runs, shell-integration parsing, scrollback |

Requests go renderer -> main -> host/pty with `invoke`-style calls. High-volume streams (session events,
terminal bytes) use `MessagePort`s between the renderer and the host or pty process so they bypass main.
`VERIFY` the current Electron guidance for `utilityProcess` and `MessagePortMain` before wiring this.

If the host or pty process dies, main restarts it and the renderer shows a reconnect banner. Sessions that
were mid-turn become `Interrupted`.

## 2. Repository layout

```
ade/
  apps/desktop/
    src/main/        # windows, updater, process supervision, safeStorage
    src/preload/     # contextBridge API (typed)
    src/renderer/    # React app
    src/host/        # utility process
    src/pty/         # utility process
    electron-builder.yml
  packages/
    contracts/         # zod schemas + types: IPC requests, events, entities
    acp-client/        # AgentRuntime + AgentSession over the official ACP SDK
    fake-agent/        # scripted ACP agent for tests
    git/               # worktrees, checkpoints, diffs (argument arrays only)
    shell-integration/ # scripts for pwsh, bash, zsh, fish + sequence parser
    workflow-engine/   # v1
    ui/                # design tokens, shared components
  docs/
  .ade/                # this repo's own workflows, skills, run configurations (dogfooding)
```

## 3. Data model (SQLite in WAL mode, migrations from day one)

| Table | Key columns |
| --- | --- |
| `workspaces` | id, root_path, name, created_at, last_opened_at |
| `agents` | id (`codex`, `claude-code`, `opencode`), path, version, capabilities_json, detected_at |
| `sessions` | id, workspace_id, agent_id, title, state, base_commit, branch, worktree_path, permission_profile, sandbox_state, agent_session_id, work_item_ref, created_at, ended_at |
| `turns` | id, session_id, index, started_at, ended_at, stop_reason, start_checkpoint, end_checkpoint |
| `events` | session_id, seq (unique per session), ts, type, payload_json, turn_id |
| `permission_requests` | id, session_id, turn_id, tool_call_id, title, options_json, decision, decided_by (`user` or rule id), decided_at |
| `terminals` | id, workspace_id, session_id, kind (`smart`, `plain`, `agent-ui`), shell, cwd, layout_json |
| `run_configs` | id, workspace_id, name, command_json, cwd, env_set, source (`detected`, `user`) |
| `runs` | id, run_config_id, session_id, worktree_path, started_at, ended_at, exit_code, summary_json |
| `workflow_runs`, `workflow_node_runs` | v1: run state, node state, session_id per node, budgets used |
| `skills_index` | v1: name, description, location (`repo`, `library`), path |
| `review_marks` | v1: session_id, path, fingerprint, marked_at (one row per reviewed file, RV-15) |
| `audit_log` | id, ts, workspace_id, session_id, actor, action, detail_json (append-only) |
| `settings` | key, value_json |

Secrets are never stored in SQLite. Large terminal output is stored as files under the app data folder with
a reference in the row.

## 4. Agent layer

ADE's own seam (define it in `packages/acp-client`):

```ts
interface AgentRuntime {
  id: 'codex' | 'claude-code' | 'opencode';
  detect(): Promise<AgentInstall | null>;            // path + version, or null when missing
  start(opts: StartOptions): Promise<AgentSession>;  // spawn, initialize, authenticate if needed, session/new
}

interface AgentSession {
  readonly capabilities: AgentCapabilities;          // from the initialize response, never hard-coded
  readonly agentSessionId: string;
  prompt(content: PromptBlock[]): Promise<StopReason>;
  cancel(): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  events: AsyncIterable<SessionEvent>;               // mapped from ACP session/update
  onPermissionRequest(handler: PermissionHandler): void;
  close(): Promise<void>;
}
```

How each agent is started (one agent process per session, `cwd` = the session worktree):

| Agent | Command | Notes |
| --- | --- | --- |
| OpenCode | `opencode acp` from the user's install | Native ACP over stdio, protocol version 1 |
| Claude Code | the `@agentclientprotocol/claude-agent-acp` package, bundled | Built on the Claude Agent SDK. `VERIFY` its entry point and how it locates Claude Code |
| Codex | the `@agentclientprotocol/codex-acp` package, bundled | `VERIFY` its entry point and whether it needs the Codex CLI installed |

ACP facts confirmed on 2026-11-20 (https://agentclientprotocol.com/protocol/overview.md):

- Client to agent: `initialize`, `authenticate`, `session/new`, `session/prompt`; optional `session/load`
  (needs the `loadSession` capability) and `session/set_mode`; notification `session/cancel`.
- Agent to client: `session/request_permission`; optional `fs/read_text_file`, `fs/write_text_file`,
  `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`;
  notification `session/update`.
- `session/update` carries message chunks (agent, user, thought), tool calls and tool call updates, plans,
  available commands, mode changes and notices.
- Tool calls have a `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`,
  `switch_mode`, `other`) and a `status` (`pending`, `in_progress`, `completed`, `failed`). Content can be
  text, a diff (`path`, `oldText`, `newText`) or a terminal reference.
- Permission options have kinds `allow_once`, `allow_always`, `reject_once`, `reject_always`. When a turn is
  cancelled the client must answer every pending permission request with the `cancelled` outcome.
- `session/new` takes an absolute `cwd` and optional `mcpServers` (stdio always; HTTP only if the agent
  advertises it). `session/load` replays the conversation as `session/update` notifications.

ADE advertises the `fs` and `terminal` client capabilities. When an agent uses them, ADE performs the file
operation or runs the command itself, inside the worktree, and refuses paths outside it. `VERIFY` which of
the three agents actually route file writes and commands through the client; where they do not, containment
relies on the worktree and the agent's own sandbox.

Event mapping (ADE event types in `packages/contracts`): `user.message`, `turn.started`, `turn.ended`,
`agent.message.chunk`, `agent.thought.chunk`, `tool.call`, `tool.update`, `plan.updated`,
`permission.requested`, `permission.decided`, `commands.available`, `mode.changed`, `checkpoint.created`,
`session.state_changed`, `session.landed`, `session.discarded`, `run.finished`. Persist every event except
raw chunks, which are coalesced into the completed message before storage.

Agent process environment: an allow-list of variables (PATH, HOME or USERPROFILE, locale, proxy settings and
the variables each agent documents), not the user's full environment.

Sandbox badge per session, derived at start: `sandboxed`, `commands-sandboxed` or `not-sandboxed`.
The host sandbox (CN-07, `apps/desktop/src/host/containment.ts`) makes a session `sandboxed` on Linux
(bubblewrap) and, when chosen, on Windows (WSL2 plus bubblewrap), after a probe proves it; see
`docs/DECISIONS.md` for exactly what it enforces.
Known today: Claude Code's sandbox covers shell commands on Linux, macOS and WSL2 and does not exist on
native Windows; OpenCode has no sandbox. `VERIFY` Codex's sandbox on Windows and Linux and how each adapter
accepts sandbox and permission-mode settings at launch.

## 5. Worktrees, checkpoints and landing (`packages/git`)

- Worktree: `git worktree add -b agent/<slug> <app-data>/worktrees/<workspace>/<slug> <base-commit>`.
  Worktrees live outside the repository folder.
- Setup: run the workspace setup commands from `.ade/workspace.yaml` after creation, and copy the listed
  untracked files (for example a local env file).
- Checkpoint (turn start and turn end): build a tree from the whole worktree with a temporary index file,
  `git commit-tree` it, and point `refs/ade/checkpoints/<session>/<n>` at it. The session branch and the
  user's index are never touched.
- Change set: Git diff between the base commit and the latest checkpoint. Per-turn diff: between a turn's
  start and end checkpoints. Changes between one turn's end and the next turn's start are the user's.
- Undo turn: restore the worktree to a checkpoint tree, including deleting files that the tree lacks.
- Land: (a) apply the selected files or hunks to the user's checkout as uncommitted changes with a
  three-way apply, or (b) commit them on the session branch. Pull requests are v1.
- Discard: write the final patch to app data (kept 30 days), remove the worktree, delete the branch.

Cover all of this with integration tests against temporary repositories, including untracked files,
deleted files, renames, binary files and CRLF line endings.

## 6. Terminals (`src/pty`, `packages/shell-integration`)

- One node-pty per terminal. Windows uses ConPTY. Shells: PowerShell and Git Bash on Windows; bash, zsh and
  fish on Linux.
- Smart terminal: inject the integration script when the shell starts. It emits OSC 133 A/B/C/D (prompt
  start, command start, output start, command end with exit code) and OSC 7 (working directory). The parser
  turns the byte stream into command blocks: command text, cwd, start, end, exit code, output range.
- Plain terminal: same pty, no injection, no blocks, no status bar.
- Agent terminal UI: a terminal that starts `codex`, `claude` or `opencode` in the session worktree.
- Agent awareness: watch the foreground process name and OSC 9 / OSC 777 notifications to mark a terminal
  as working, waiting or finished. Waiting terminals get the attention ring and join the Needs-you inbox.
- Status bar segments: location, Git, session, process, ports, resources, usage, work item.
- Scrollback is serialised on exit and restored on start. Processes are not resurrected.

## 7. Code runner

A run configuration is `{ name, command: string[], cwd, envSet }`. Detection reads project manifests
(package scripts, .NET projects and launch profiles, Makefile targets, Python project files). A run is a
command executed by the pty process in a chosen worktree; it appears as a smart terminal block and as a row
in `runs`. Review checks and workflow command nodes call the same service. Test report parsing (TRX, JUnit
XML) and scratchpads are v1.

## 8. Workflow engine (v1, `packages/workflow-engine`)

- A workflow is a YAML file in `.ade/workflows/`. Nodes: `agent`, `command`, `gate`, `loop`, `branch`,
  `fanout`, `connector`, `land`. Edges carry an optional condition (`pass`, `fail`).
- A run is a state machine persisted in `workflow_runs` and `workflow_node_runs`. Each agent node runs as a
  normal session, so everything in sections 4 and 5 applies to it.
- Hand-off packet between nodes: previous summary, diff, check output, work item fields.
- Budgets per run: wall-clock time, turns, loop count, cost where reported. Hitting one pauses the run and
  raises a Needs-you item. A workflow that changes code must end in a gate before any land node.
- Nodes that run without approval prompts are allowed only when the session badge is `sandboxed`.

## 9. Skills (v1)

A skill is a folder with a `SKILL.md` whose frontmatter has `name` and `description` (the Agent Skills
format). Repository skills live in `.ade/skills/<name>/`; personal ones in the app data folder. Before an
agent node or session starts, ADE copies its selected skills into that agent's skills folder inside the
worktree and excludes them from the change set. Folder names and discovery rules were verified in M6-T05 (see `docs/DECISIONS.md`).

## 10. Connectors

The host is an MCP client. Shortcut uses the hosted server `https://mcp.shortcut.com/mcp` with OAuth.
GitHub and GitHub Projects use the official GitHub MCP server with the `issues`, `pull_requests`, `actions`
and `projects` toolsets, plus the `gh` CLI where it is simpler. The same server definitions are passed to
agents in `session/new`, with read scope unless the user opted into write. Tokens are encrypted with
`safeStorage`. On Linux, `VERIFY` `safeStorage.getSelectedStorageBackend()` and refuse to store tokens when
the backend is plain text; tell the user to install a keyring instead.

## 11. Packaging

electron-builder produces a per-user NSIS installer for Windows and an AppImage plus a `.deb` for Linux in
the MVP, and a notarised `.dmg` for macOS in v1. Native modules (node-pty, better-sqlite3) are rebuilt per
platform in CI. The two adapters ship inside the app. Agents themselves are not bundled: first-run setup
detects them and offers each vendor's official installer. Updates use electron-updater; `VERIFY` update
behaviour for AppImage and plan a "new version available" notice for `.deb` installs.

CI runs on Windows and Ubuntu: typecheck, lint, tests, end-to-end tests and `pnpm dist`, followed by an
install on a clean machine image that starts one fake-agent session.
