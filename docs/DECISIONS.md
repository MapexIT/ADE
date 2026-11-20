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

_(fill in during M0)_

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

_(add questions here as they come up; pick the simplest reading and keep going)_

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
