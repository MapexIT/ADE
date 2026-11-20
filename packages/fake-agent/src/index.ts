import { fileURLToPath } from 'node:url';

export { createFakeAgent, serveStdio, type FakeAgentOptions } from './agent.ts';
export { parseScript, SCENARIOS, type Step } from './script.ts';

/** Absolute path of the stdio entry point, for spawning the fake agent as a child process. */
export const FAKE_AGENT_ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));
