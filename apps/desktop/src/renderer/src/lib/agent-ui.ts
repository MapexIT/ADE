import type { AgentId } from '@ade/contracts';

/** TM-03: each agent's own terminal UI binary. */
export const AGENT_COMMANDS: Record<Exclude<AgentId, 'fake'>, string> = { codex: 'codex', 'claude-code': 'claude', opencode: 'opencode' };

/**
 * SR-08: the command that reopens an ACP session in the agent's own terminal UI. Verified: Claude's ACP adapter
 * passes its session id to the Claude SDK as the session id (`claude --resume <id>`); Codex's ACP adapter uses
 * the Codex thread id as the session id (`codex resume <SESSION_ID>`). OpenCode's docs do not say how to resume
 * an ACP session in its UI, so it opens without resuming. Pure.
 */
export function agentUiCommand(agentId: AgentId, agentSessionId: string | null): { command: string[]; resumes: boolean } | null {
  if (agentId === 'fake') return null;
  const bin = AGENT_COMMANDS[agentId];
  if (agentSessionId && agentId === 'claude-code') return { command: [bin, '--resume', agentSessionId], resumes: true };
  if (agentSessionId && agentId === 'codex') return { command: [bin, 'resume', agentSessionId], resumes: true };
  return { command: [bin], resumes: false };
}
