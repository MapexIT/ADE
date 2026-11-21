import type { AgentRuntime, LaunchWrapper } from '@ade/acp-client';
import { RpcError } from '@ade/contracts';

/**
 * Starts an agent once with the read-only profile, sends one prompt and returns its reply. Every permission
 * request is refused, so the agent cannot change anything. Used by the review assistant (RV-14) and for drafting
 * terminal commands (SM-10). Not a session: nothing lands from it.
 */
export async function askOnce(
  runtime: AgentRuntime,
  opts: { cwd: string; prompt: string; baseEnv: NodeJS.ProcessEnv; wrapper?: LaunchWrapper | null; timeoutMs: number; timeoutMessage: string },
): Promise<string> {
  const agent = await runtime.start({ cwd: opts.cwd, permissionProfile: 'read-only', baseEnv: opts.baseEnv, ...(opts.wrapper ? { wrapper: opts.wrapper } : {}) });
  try {
    let reply = '';
    agent.onEvent((e) => {
      if (e.type === 'agent.message.chunk') reply += e.text;
    });
    agent.onPermissionRequest(async (request) => {
      const reject = request.options.find((o) => o.kind === 'reject_once') ?? request.options.find((o) => o.kind === 'reject_always');
      return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      agent.prompt([{ type: 'text', text: opts.prompt }]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new RpcError('timeout', opts.timeoutMessage)), opts.timeoutMs);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
    return reply;
  } finally {
    await agent.close().catch(() => undefined);
  }
}
