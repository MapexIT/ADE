# Product

## What ADE is

ADE is an agent-neutral cockpit for coding agents. The first three agents are Codex, Claude Code and
OpenCode. The user starts sessions, watches them, steers them, approves what they ask for, reviews their
changes and lands them. ADE adds terminals, a code runner, a workflow canvas with skills, and connectors to
Shortcut, GitHub and GitHub Projects.

ADE is a personal desktop tool first: local-first, no telemetry, one installer per operating system.
Windows and Linux are both first platforms and ship together in the MVP. macOS follows in v1 from the same
codebase.

## Principles

| Principle | Meaning |
| --- | --- |
| Agent-neutral | Nothing in the core depends on one agent. Missing capabilities show as "not supported". |
| Host owns the workspace, agent owns the loop | ADE provides worktrees, sandbox state, approvals, checkpoints, review, history. The agent keeps its model, context, tools, sign-in and config. |
| Conversation first | Every surface assumes follow-ups, interruptions and iteration. |
| Honest safety | Each session shows whether it is sandboxed. No boundary is claimed that is not enforced. |
| Review is the product | The diff and landing flow get the most polish. |
| Local-first, credential-free | History stays on the machine. ADE never handles agent credentials. |
| Dark, smooth and simple | One dark theme. Few panels at once, detail on demand, short purposeful motion. |

## Glossary

| Term | Definition |
| --- | --- |
| Workspace | A Git repository opened in ADE, with its setup script, run configurations, rules and connectors. |
| Agent | An installed coding agent (Codex, Claude Code, OpenCode) with version, capabilities, sign-in state. |
| Session | One conversation with one agent in one worktree. Made of turns. |
| Turn | One user prompt and everything the agent does until it stops. |
| Worktree | A Git worktree and branch created for a session from a recorded base commit. |
| Checkpoint | A Git snapshot of the worktree that ADE takes when a turn ends, stored on a hidden ref. |
| Permission request | A question from the agent ("may I run this?") with the user's decision and its scope. |
| Change set | The session's diff against its base commit, computed by Git. |
| Land | The explicit user action that applies, commits or opens a pull request for a change set. |
| Needs-you inbox | The list of everything waiting on the user across sessions: approvals, questions, gates. |
| Smart terminal | A terminal with shell integration: command blocks, status bar, agent awareness. |
| Run configuration | A named way to run, test or build the project. Used by the code runner, checks and workflows. |
| Workflow | A saved graph of nodes that prompts agents for the user: trigger, steps, checks, gates, stop rules. |
| Node | One step in a workflow: agent, command, gate, loop, branch, fan-out, connector or land. |
| Skill | An Agent Skills folder (`SKILL.md` plus files) that can be attached to an agent node. |
| Connector | An MCP server plus a native panel: Shortcut, GitHub, GitHub Projects. |
| Work item | A Shortcut story or a GitHub issue or project item. |
| Turn receipt | ADE's comparison, made when a turn ends, of what the agent said with the commands it ran and the files Git says changed. |
| Workspace rule | An allow or deny pattern that answers matching permission requests in a repository without asking. |
| Rehearsal | A rule replayed over the repository's past permission requests to show what it would have answered. |

## Session states

```
Starting -> Working <-> WaitingOnUser
Working  -> Ready            (turn ended or cancelled; checkpoint taken)
Ready    -> Working          (user prompts again)
Ready    -> Landed | Discarded   (terminal)
Working  -> Interrupted      (agent crashed or app closed)
Interrupted -> Working       (agent session reloaded)
Interrupted -> Ready         (reopened at the last checkpoint)
```

Review is not a state: the user can read the diff whenever the session is Ready. Cancelling a turn answers
all its pending permission requests as cancelled and still takes a checkpoint.

## Phases

| Phase | Contents | Gate (must be demonstrable) |
| --- | --- | --- |
| Spike | Answers to the eight questions in `docs/DECISIONS.md` | All three agents answer one prompt through one ACP client |
| MVP | Sessions, timeline, approvals, worktrees, checkpoints, review and land, terminals, smart terminal basics, code runner basics, work items, first-run setup, Windows and Linux installers | One task per agent from prompt to landed change, installed from a single installer on a clean Windows machine and a clean Linux machine, history intact after restart |
| v1 | Agent workflows with skills, host sandbox, compare runs, checks, pull request flow, connector state sync, language servers, macOS installer | A workflow runs three sandboxed agents and lands one result |
| Later | Missions and external triggers, a built-in agent, remote terminals, phone companion, extensions, debugger | - |
