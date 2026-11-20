import type { PromptBlock, ToolContent, ToolKind } from '@ade/contracts';
import type { ContentBlock, SessionUpdate, ToolCallContent } from '@agentclientprotocol/sdk';
import type { AgentEvent } from './types.ts';

const TOOL_KINDS: readonly ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
export const toToolKind = (k: string | null | undefined): ToolKind => (k && (TOOL_KINDS as string[]).includes(k) ? (k as ToolKind) : 'other');

export function contentText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return block.uri;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : block.resource.uri;
    default:
      return '';
  }
}

export function mapToolContent(content: ToolCallContent[] | null | undefined): ToolContent[] {
  if (!content) return [];
  return content.map((c): ToolContent => {
    switch (c.type) {
      case 'diff':
        return { type: 'diff', path: c.path, oldText: c.oldText ?? null, newText: c.newText };
      case 'terminal':
        return { type: 'terminal', terminalId: c.terminalId };
      case 'content':
        return { type: 'text', text: contentText(c.content) };
    }
  });
}

/** Maps ADE prompt blocks to ACP content blocks. */
export function toAcpContent(blocks: PromptBlock[], embeddedContext: boolean): ContentBlock[] {
  return blocks.map((b): ContentBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'image':
        return { type: 'image', data: b.data, mimeType: b.mimeType };
      case 'resource':
        // Agents without embedded context get the file as plain text so nothing is lost.
        return embeddedContext
          ? { type: 'resource', resource: { uri: b.uri, text: b.text, mimeType: b.mimeType } }
          : { type: 'text', text: `File ${b.name}:\n${b.text}` };
    }
  });
}

/**
 * Maps one ACP `session/update` to ADE events. Unknown update kinds map to nothing, so a newer agent
 * never breaks the timeline. `fallbackMessageId` groups chunks when the agent sends no message id.
 */
export function mapSessionUpdate(update: SessionUpdate, fallbackMessageId: string): AgentEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return [{ type: 'agent.message.chunk', messageId: update.messageId ?? fallbackMessageId, text: contentText(update.content) }];
    case 'agent_thought_chunk':
      return [{ type: 'agent.thought.chunk', messageId: update.messageId ?? `${fallbackMessageId}:thought`, text: contentText(update.content) }];
    case 'tool_call':
      return [
        {
          type: 'tool.call',
          toolCallId: update.toolCallId,
          title: update.title,
          kind: toToolKind(update.kind),
          status: update.status ?? 'pending',
          content: mapToolContent(update.content),
          locations: (update.locations ?? []).map((l) => (l.line ? `${l.path}:${l.line}` : l.path)),
        },
      ];
    case 'tool_call_update':
      return [
        {
          type: 'tool.update',
          toolCallId: update.toolCallId,
          title: update.title ?? null,
          status: update.status ?? null,
          content: update.content ? mapToolContent(update.content) : null,
        },
      ];
    case 'plan':
      return [{ type: 'plan.updated', entries: update.entries.map((e) => ({ content: e.content, priority: e.priority, status: e.status })) }];
    case 'available_commands_update':
      return [{ type: 'commands.available', commands: update.availableCommands.map((c) => ({ name: c.name, description: c.description })) }];
    case 'current_mode_update':
      return [{ type: 'mode.changed', modeId: update.currentModeId, available: null }];
    case 'notice': {
      const n = update as unknown as { message?: string; severity?: string };
      const level = n.severity === 'error' ? 'error' : n.severity === 'warning' ? 'warning' : 'info';
      return n.message ? [{ type: 'notice', level, text: n.message }] : [];
    }
    default:
      return [];
  }
}

export interface UsageSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** Reads a usage update when the agent reports one (HI-03); otherwise usage stays "not reported". */
export function readUsage(update: SessionUpdate): UsageSnapshot | null {
  if (update.sessionUpdate !== 'usage_update') return null;
  const cost = update.cost && update.cost.currency === 'USD' ? update.cost.amount : null;
  return { inputTokens: update.used, outputTokens: null, costUsd: cost };
}
