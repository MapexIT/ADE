export interface CoalescedMessage {
  kind: 'message' | 'thought';
  messageId: string;
  text: string;
}

/**
 * Collects streamed message chunks per message id so only the completed text is persisted
 * (docs/ARCHITECTURE.md: "raw chunks are coalesced into the completed message before storage").
 */
export class ChunkCoalescer {
  private readonly buffers = new Map<string, { kind: 'message' | 'thought'; text: string }>();
  private order: string[] = [];

  push(kind: 'message' | 'thought', messageId: string, text: string): void {
    const existing = this.buffers.get(messageId);
    if (existing) existing.text += text;
    else {
      this.buffers.set(messageId, { kind, text });
      this.order.push(messageId);
    }
  }

  /** Returns and clears every buffered message, in the order they started. */
  flush(): CoalescedMessage[] {
    return this.flushExcept(null);
  }

  /** Flushes every message except `keepId` (used when another message or a tool call starts). */
  flushExcept(keepId: string | null): CoalescedMessage[] {
    const out: CoalescedMessage[] = [];
    for (const id of this.order) {
      if (id === keepId) continue;
      out.push({ messageId: id, ...this.buffers.get(id)! });
      this.buffers.delete(id);
    }
    this.order = this.order.filter((id) => id === keepId);
    return out;
  }

  get size(): number {
    return this.buffers.size;
  }
}
