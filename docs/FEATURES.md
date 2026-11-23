# Features

151 features in 17 areas. Phase is `MVP`, `v1` or `Later`. MVP features have acceptance criteria; build
nothing from `v1` or `Later` until the MVP gate in `docs/PLAN.md` has passed. MVP platforms are Windows and
Linux.

## Start a session (ST)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| ST-01 | Agent health | MVP | Detects Codex, Claude Code and OpenCode with path and version. Shows Ready, Needs sign-in or Not installed. Sign-in and install open the agent's own flow. Capabilities come from `initialize`. |
| ST-02 | Composer | MVP | Prompt, agent, base branch and permission profile, plus the model and mode options the agent advertises. Start creates the worktree and the session. A missing agent disables Start with the reason. |
| ST-03 | Context attachments | MVP | Files, editor selections, diff hunks and images can be attached, appear as removable chips and are sent as ACP content blocks. |
| ST-04 | Slash commands | MVP | Typing `/` lists the commands the agent advertised. Nothing advertised means no list. |
| ST-05 | Shared MCP servers | v1 | Define MCP servers once per workspace; every session receives them. |
| ST-06 | Prompt library | Later | Saved prompts and task templates. |

## Watch (WA)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| WA-01 | Timeline | MVP | Streams messages and thoughts, one card per tool call with kind and status. Virtualised. Rebuilt from stored events after a restart. |
| WA-02 | Inline results | MVP | Edit tool calls show their diff; execute tool calls show live output. |
| WA-03 | Plan panel | MVP | Shows the agent's plan entries with status and updates live. Hidden when no plan is sent. |
| WA-04 | Session header | MVP | State, agent and version, branch, sandbox badge, elapsed time, and tokens and cost or "not reported". |
| WA-05 | Protocol inspector | MVP | Lists raw ACP messages for a session with search. Credentials in `env` or headers are redacted. |
| WA-06 | Follow mode | v1 | The editor follows the file the agent is working on. |
| WA-07 | Live observability | v1 | The Observe page shows every session as it works: what the agent is doing now, a phase timeline, event rate, tool calls, edits, commands, approvals, files touched, plan progress and usage, and the result when a turn ends. Built only from ACP events, so it is the same for every agent. |

## Steer (SR)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| SR-01 | Follow-up | MVP | A Ready session accepts another prompt and returns to Working. |
| SR-02 | Queued message | MVP | A message typed while Working is stored, shown as queued and sent when the turn ends. It can be edited or removed first. |
| SR-03 | Interrupt and redirect | MVP | One action cancels the turn, answers pending permission requests as cancelled, takes a checkpoint and sends the new prompt. |
| SR-04 | Answer questions | MVP | Agent questions render inline and in the Needs-you inbox; answering resumes the turn. |
| SR-05 | Mode switch | MVP | Modes the agent advertises can be switched mid-session; the header reflects the change. |
| SR-06 | Fork | v1 | New session and worktree from any earlier turn's checkpoint. |
| SR-07 | Hand-off | v1 | Continue in the same worktree with another agent, given the summary and diff. |
| SR-08 | Open in the agent's terminal UI | v1 | Resume the same session in the agent's own interface where possible. |
| SR-09 | Mid-turn steering | Later | Add input to a running turn; needs a native adapter. |

## Generate (GN)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| GN-01 | Generation method (reasoning trajectories) | v1 | A per-session dropdown picks how a prompt is generated: IO (as written, the default), Chain of Thought, CoT self-consistency, Graph of Thought or Fleet of Agents. Switching to anything but IO first shows a dialog that explains the change and the number of extra agent calls, with the method's settings (paths, thoughts, agents, generations); back to IO needs no dialog. Extra calls go to the session's own agent, read-only, in a temporary detached worktree with every permission refused. Each run is a timeline card with every step of the graph, its scores and the chosen approach; Cancel reasoning stops it and sends nothing. The user's words are always sent first, unchanged. Interrupt and send skips reasoning. |
| GN-02 | Prompt board | v1 | Besides the chat box, a Board mode where the prompt is built from text boxes that can be added, titled, written, moved and resized (mouse or arrow keys) and deleted. Selected boxes, read top to bottom and left to right, are the prompt; titled boxes become headings. The board belongs to the workspace: every session there shares the same boxes, and a change in one session shows in the others. Positions, sizes, content and selection are kept across restarts; Chat or Board and the generation method are saved per session. |

## Contain (CN)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| CN-01 | Worktree per session | MVP | Every session gets a worktree and branch from a recorded base commit, outside the repository folder. The user's checkout is never written to. |
| CN-02 | Workspace setup script | MVP | Setup commands and the untracked-file copy list from `.ade/workspace.yaml` run after worktree creation; failures are shown and block the first prompt. |
| CN-03 | Bring my changes | MVP | Optional: the checkout's uncommitted and untracked changes are applied in the new worktree. |
| CN-04 | Agent sandbox pass-through | MVP | The permission profile switches on the agent's own sandbox where it exists on this platform. |
| CN-05 | Sandbox badge | MVP | Every session shows Sandboxed, Commands sandboxed or Not sandboxed, derived from agent and platform, never assumed. |
| CN-06 | Minimal environment | MVP | Agent processes receive an allow-listed environment. A test proves an arbitrary user variable is absent. |
| CN-07 | Host sandbox | v1 | Linux: OS sandbox around the whole agent process. Windows: sessions run inside WSL2. |
| CN-08 | Run in place | v1 | One session at a time may use the real checkout after a snapshot. Off by default. |
| CN-09 | Port and cache isolation | Later | Per-worktree ports and caches. |

## Approve (AP)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| AP-01 | Permission profiles | MVP | Ask, Auto-edit, Autonomous and Read-only map onto each agent's modes at launch. Autonomous is selectable only when the badge is Sandboxed. |
| AP-02 | Approval card | MVP | Shows the tool, the command or diff and the working directory, with exactly the options the agent offered. The decision is stored with who decided. |
| AP-03 | Reject with a note | MVP | Rejecting can queue a message for the agent. |
| AP-04 | Needs-you inbox | MVP | One list of pending approvals and questions across sessions, fully keyboard-driven, with a count in the top bar. |
| AP-05 | Notifications | MVP | A desktop notification when a session needs the user, finishes or fails; clicking it focuses that session. |
| AP-06 | Workspace rules | v1 | Allow and deny rules that answer matching requests; every automatic answer is logged. |

## Review and land (RV)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| RV-01 | Changes view | MVP | File list plus side-by-side and inline diff of the session against its base, computed by Git. |
| RV-02 | Turn checkpoints | MVP | A snapshot on a hidden ref at each turn start and end. Survives an agent crash. |
| RV-03 | Per-turn diff | MVP | Selecting a turn shows only that turn's changes. |
| RV-04 | Undo turn | MVP | Restores the worktree to an earlier checkpoint after confirmation, including deletions. |
| RV-05 | Comment to agent | MVP | A comment on a line or hunk becomes the next prompt with file and line references. |
| RV-06 | Edit in place | MVP | Worktree files can be edited in ADE; edits made while the agent is idle are attributed to the user. |
| RV-07 | Land | MVP | Apply selected files or hunks to the checkout as uncommitted changes, or commit them on the session branch. Never automatic. |
| RV-08 | Discard | MVP | Removes worktree and branch after confirmation; the final patch is kept for 30 days. |
| RV-09 | Batch review | v1 | Collect comments and send them as one review. |
| RV-10 | Checks | v1 | Run configurations as checks, on demand or after each turn; failures go to the agent in one click. |
| RV-11 | Rebase and conflicts | v1 | Shows conflicts when the base moved; offers to ask the agent to resolve them. |
| RV-12 | Pull request | v1 | Push the branch and open a pull request. |
| RV-13 | Commit message draft | v1 | Ask the session's agent for a commit message. |
| RV-14 | Review assistant | v1 | A second agent pre-reviews the diff read-only and ranks files by risk. |
| RV-15 | Review progress | v1 | Mark files as reviewed; a file that changes afterwards shows as changed since review, with a diff of only what changed. Landing unreviewed files warns first and is recorded in the audit log. |

## Parallel (PL)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| PL-01 | Sessions list | MVP | All sessions grouped as Needs you, Working, Ready for review, Done; updates live. |
| PL-02 | Concurrency cap | MVP | At most N sessions run at once (default 3); extra sessions wait as Queued. |
| PL-03 | Compare run | v1 | One prompt to two or three agents in separate worktrees, compared side by side. |
| PL-04 | Overlap warning | v1 | Flags two live sessions that changed the same file. |
| PL-05 | Background sessions | v1 | Sessions keep running with the window closed. |

## Terminals (TM)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| TM-01 | Terminal panel | MVP | PTY terminals with tabs and splits, shell choice, scrollback and search, on Windows and Linux. |
| TM-02 | Terminal per worktree | MVP | New terminals open in the selected session's worktree; selecting a session switches the panel to its terminals. |
| TM-03 | Agent terminal UI | MVP | Starts Codex, Claude Code or OpenCode in its own terminal interface inside a session worktree. |
| TM-04 | Agent command terminals | MVP | Commands an agent runs through ADE appear live in the timeline and can be opened and killed. |
| TM-05 | Send to agent | MVP | Selected terminal output attaches to the next prompt. |
| TM-06 | Process list | MVP | Lists processes ADE started per session and kills the whole tree when the session ends. |
| TM-07 | Saved commands | v1 | Named commands per workspace. |
| TM-08 | Port labels | Later | Detects a dev server port and offers to open it. |

## Smart terminal (SM)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| SM-01 | Command blocks | MVP | Each command and its output form a block with exit code, duration and time; blocks collapse, copy and re-run. |
| SM-02 | Shell integration | MVP | Injected automatically for PowerShell, bash, zsh and fish; reports cwd, command boundaries and exit codes. A shell without it falls back to a plain terminal with a notice. |
| SM-03 | Status bar | MVP | Segments: location, Git, session, process, ports, resources, usage, work item. Each hides when it has no data. |
| SM-04 | Agent awareness | MVP | Detects an agent running in the terminal and shows working, waiting or finished. |
| SM-05 | Attention ring | MVP | A waiting terminal gets a ring, a badge in the sessions list and an entry in the Needs-you inbox. |
| SM-06 | Jump and sticky header | MVP | Shortcuts jump between blocks; the running command stays pinned while output scrolls. |
| SM-07 | Clickable output | MVP | File paths with line numbers open in the editor or diff; links open in the browser. |
| SM-08 | Fix with agent | MVP | A failed block offers one action that starts a turn with command, output and exit code attached. |
| SM-09 | Suggested commands | v1 | An agent proposes a command as a pending block; Enter runs it. |
| SM-10 | Ask in the prompt | v1 | A question in the prompt is drafted into a command by the selected agent. |
| SM-11 | Command history search | v1 | Search across terminals, worktrees and sessions. |
| SM-12 | Inline viewers | v1 | Images, Markdown, JSON, CSV and test results render inside a block. |
| SM-13 | Layouts | v1 | Saved splits and tabs per workspace, restored with scrollback. |
| SM-14 | Guard rails | v1 | Confirmation before destructive commands and multi-line pastes; secret warning before sending to an agent. |
| SM-15 | Recording | Later | Replayable terminal log linked to the audit trail. |
| SM-16 | Remote terminals | Later | SSH profiles with blocks and status bar. |
| SM-17 | Terminal CLI | Later | A command to open tabs, notify and attach blocks. |

## Code runner (CR)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| CR-01 | Run configurations | MVP | Detects run, test and build commands from project manifests; the user can edit them and add their own. |
| CR-02 | Run bar | MVP | Run button, configuration picker and worktree picker; a run executes in the chosen worktree. |
| CR-03 | Run output | MVP | Every run is a smart terminal block with exit code, duration and clickable stack traces, and a row in run history. |
| CR-04 | Send run to agent | MVP | One action attaches a run's command, output and result to the next prompt. |
| CR-05 | Run file and selection | v1 | Run the current file or selection with the right interpreter. |
| CR-06 | Test results view | v1 | Parsed pass and fail tree; run one test, one file or only failures. |
| CR-07 | Scratchpad | v1 | Run a snippet in JavaScript, TypeScript, Python or C# in a temporary sandboxed folder. |
| CR-08 | Runner for agents | v1 | Agents call configurations through a tool and get a structured result. |
| CR-09 | Run history and compare | v1 | Compare a run between two worktrees. |
| CR-10 | Preview | v1 | A web run opens the preview pane on the detected port. |
| CR-11 | Environment sets | v1 | Named variable sets; secrets from the credential store, never shown to agents. |
| CR-12 | Watch mode | Later | Re-run on file change. |
| CR-13 | Debugging | Later | Breakpoints and stepping. |
| CR-14 | Container runs | Later | Run inside a dev container. |

## Connectors (CO)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| CO-01 | Work item panel | MVP | Browse and search Shortcut stories and GitHub issues assigned to the user, by iteration, epic or project. Read scope only. |
| CO-02 | Start from a work item | MVP | Opens the composer with title, description and acceptance criteria attached, shown for review before sending. |
| CO-03 | Branch naming | MVP | The session branch is named from the work item; Shortcut items use the `sc-<id>` form. |
| CO-04 | Linked sessions | MVP | A session shows its work item; the panel shows which items have sessions. |
| CO-05 | State sync | v1 | Opt-in moves of the story or project item on session start, pull request and merge. |
| CO-06 | Review comments to agent | v1 | Pull-request review comments become one prompt. |
| CO-07 | Failed checks to agent | v1 | A failing GitHub Actions job and its log go to the session. |
| CO-08 | Progress notes | v1 | Summary and pull-request link posted to the work item on landing. |
| CO-09 | Board view | v1 | A GitHub Projects board or Shortcut iteration with session badges. |
| CO-10 | More connectors | v1 | Any MCP server can be added. |
| CO-11 | Connection guides | v1 | An unconnected Shortcut or GitHub source (work items or board) shows numbered steps instead of an empty list, each ticked when this machine shows it done: `gh` installed (with its version), the account `gh` signs in as, the Git identity (with `git config` commands prefilled from the GitHub account), the Shortcut token stored. Commands copy in one click; "Check again" re-reads. Read locally; no token value is ever shown. |
| CO-12 | Telegram notifications | v1 | Settings take a bot token (from @BotFather) and a sign-in password, both in the OS credential store, and an on/off switch that stays disabled until both are saved. The top bar shows whether Telegram notifications are on or off, and how many chats are signed in. A private chat signs in by sending `/auth <password>` to the bot; ADE deletes every `/auth` message straight away, right or wrong. A chat stays signed in for 3 hours and is told when that ends; sign-ins are kept in memory only, so a restart signs every chat out, as do a new token or password. Five wrong passwords lock a chat out for 15 minutes; group chats and `/auth` messages sent while ADE was not listening never sign in. Signed-in chats get every notification (finished, failed, needs you, workflows) with the workspace name. `/status` and `/logout` work in the chat; Settings can send a test message. |
| CO-13 | MCP servers dialog | v1 | One dialog (Settings, or "MCP servers" in the command palette) lists every MCP server a new session receives: personal servers, the repository's servers from `.ade/workspace.yaml`, and ADE's own (code runner, preview, Shortcut). Each row shows its source, its type (command or HTTP) and a status: on, off, missing variables or connections, or the last check. Check connects to the server, lists its tools and disconnects (a command runs on this machine for the check). Every server has an on/off switch: personal servers keep theirs, repository servers can be switched off for this machine only, and ADE's map to their existing settings. Personal servers can be added, edited (name, command or URL, environment variables or headers) and removed, or edited in bulk as YAML. Variable and header values are never shown in the list; secrets are written as `$VARIABLE`. Changes apply to sessions started afterwards. |
| CO-11 | Work item triggers | Later | Start a workflow from a story state or issue label. |

## Agent workflows (WF) and skills (SK)

| ID | Feature | Phase | Description |
| --- | --- | --- | --- |
| WF-01 | Node canvas | v1 | Drag nodes from a palette, connect them, pan and zoom, watch nodes light up as they run. |
| WF-02 | Workflow picker | v1 | Choose a workflow instead of a single agent when starting a session or work item. |
| WF-03 | Workflow files | v1 | YAML in `.ade/workflows/`, versioned with the code. |
| WF-04 | Templates | v1 | Plan-build-review, fix failing tests, cross-review, spec first, story to pull request. |
| WF-05 | Hand-off packet | v1 | Summary, diff and check output passed between nodes. |
| WF-06 | Run view | v1 | Node status, session per node, time and cost per node. |
| WF-07 | Budgets and stop rules | v1 | Time, turns, loops and cost limits; a run that hits one pauses and asks. |
| WF-08 | Retry from step | v1 | Re-run from any node using its checkpoint. |
| WF-09 | Mixed agents per step | v1 | Different agent or model per node. |
| WF-10 | Manual and event triggers | v1 | By hand, from a terminal command, on a failed check or a ready session. |
| WF-11 | Test a node | v1 | Run one node on sample input. |
| WF-12 | Fan-out and join | Later | Parallel nodes with a compare view. |
| WF-13 | Scheduled and external triggers | Later | Schedule, story state, issue label. |
| WF-14 | Shared library | Later | Export and import workflows and skills. |
| WF-15 | Missions | Later | A goal, success criteria and a budget on top of a workflow. |
| SK-01 | Skills on a node | v1 | Attach Agent Skills to any agent node; loaded for that step only. |
| SK-02 | Skill library | v1 | Browse and search repository, personal and installed skills. |
| SK-03 | Skill builder | v1 | Create a skill in a form; ADE writes the `SKILL.md` folder. |
| SK-04 | Draft a skill with an agent | v1 | Describe it or point at a past session; an agent drafts it. |
| SK-05 | Skills manager | v1 | Install a skill once and sync it to all three agents. |

Node types: agent, command, gate, loop, branch, fan-out, connector, land.

## Editor (ED), history and platform (HI), packaging (PK)

| ID | Feature | Phase | Acceptance criteria / description |
| --- | --- | --- | --- |
| ED-01 | Editor | MVP | Monaco with syntax highlighting, file tree, search and go to file for the checkout and every worktree. Saving detects external changes. The file tree is virtualised, with compact folders, indent guides, file-type icons, the session's changes marked on files and counted on folders, a "Changed only" view, a filter that opens the folders it matches in, the editor's file revealed, and WAI-ARIA tree keyboard navigation with type-ahead. |
| ED-02 | Open in my editor | MVP | Opens a worktree in the configured external editor. |
| ED-03 | Language servers | v1 | Diagnostics, hover, go to definition. |
| ED-04 | Instruction files | v1 | Shows which instruction files each agent reads and flags divergence. |
| HI-01 | History | MVP | Every session is stored and can be reopened read-only; it continues when the agent supports `session/load`. |
| HI-02 | Audit log | MVP | Append-only record of agent, version, permission decisions and landing actions per workspace. |
| HI-03 | Usage | MVP | Tokens and cost per session when reported, otherwise "not reported". |
| HI-04 | Limits | MVP | Maximum duration and turn count per session, enforced by ADE. |
| HI-05 | Settings | MVP | Agents, workspace setup, notifications, retention, external editor. No telemetry setting exists because there is no telemetry. |
| HI-06 | History search | v1 | Full-text search across sessions. |
| HI-07 | Audit export | v1 | JSON export with secrets and local paths redacted. |
| HI-08 | Preview pane | v1 | A built-in browser the agent can drive, with screenshots in the timeline. |
| HI-09 | Built-in agent | Later | A fourth runtime that ADE supplies itself. |
| HI-10 | Debugger, extensions, remote hosts | Later | - |
| HI-11 | Phone companion | Later | Approve and answer from a phone. |
| PK-01 | Installers | MVP | One per-user installer for Windows and an AppImage plus `.deb` for Linux, each carrying the app, host, adapters and terminal layer. |
| PK-02 | First-run setup | MVP | One screen: Git, shells, agents with sign-in state, connectors, sandbox state per agent. |
| PK-03 | Signed self-update | MVP | The app updates itself where the package format supports it and announces new versions where it does not. |
| PK-04 | macOS installer | v1 | Notarised `.dmg`. |
