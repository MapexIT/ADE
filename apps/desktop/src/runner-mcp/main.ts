/**
 * CR-08: the runner for agents. A small stdio MCP server ADE hands to every session (unless switched off). It
 * offers the workspace's run configurations as tools and returns a structured result. It runs inside whatever
 * the agent runs in (the session's worktree and sandbox), and appends each result to a log ADE adds to the run
 * history after the turn.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { findOnPath, spawnCommand, toSpawnable } from '@ade/acp-client';
import { z } from 'zod';

interface RunnerConfig {
  name: string;
  command: string[];
  /** Relative to the worktree. */
  cwd: string;
}

const configs = JSON.parse(process.env.ADE_RUNNER_CONFIG ?? '[]') as RunnerConfig[];
const root = process.env.ADE_RUNNER_ROOT ?? process.cwd();
const log = process.env.ADE_RUNNER_LOG ?? null;
const TAIL = 20_000;

function run(config: RunnerConfig, timeoutSeconds: number): Promise<{ exitCode: number | null; durationMs: number; output: string; timedOut: boolean }> {
  const started = Date.now();
  const name = config.command[0]!;
  const path = /[\\/]/.test(name) ? name : findOnPath(name);
  const cmd = path ? toSpawnable(path, process.execPath) : null;
  if (!cmd) return Promise.resolve({ exitCode: null, durationMs: 0, output: `${name} was not found on the PATH.`, timedOut: false });
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawnCommand({ command: cmd.command, args: [...cmd.args, ...config.command.slice(1)] }, {
      cwd: join(root, config.cwd || '.'),
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const add = (b: Buffer) => {
      out = (out + b.toString('utf8')).slice(-TAIL * 4);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, durationMs: Date.now() - started, output: `${out}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, durationMs: Date.now() - started, output: out.slice(-TAIL), timedOut });
    });
  });
}

const server = new McpServer({ name: 'ade-runner', version: '0.1.0' });

server.registerTool(
  'list_configurations',
  { description: "List the repository's run, test and build configurations that run_configuration can run." },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(configs.map((c) => ({ name: c.name, command: c.command.join(' ') }))) }],
  }),
);

server.registerTool(
  'run_configuration',
  {
    description: 'Run one of the repository\'s configurations (see list_configurations) in this worktree and get its exit code, duration and output.',
    inputSchema: { name: z.string().describe('The configuration name'), timeoutSeconds: z.number().int().min(1).max(3600).optional() },
    outputSchema: { name: z.string(), passed: z.boolean(), exitCode: z.number().nullable(), durationMs: z.number(), timedOut: z.boolean(), output: z.string() },
  },
  async ({ name, timeoutSeconds }) => {
    const config = configs.find((c) => c.name === name);
    if (!config) {
      return { isError: true, content: [{ type: 'text', text: `No configuration called "${name}". Known: ${configs.map((c) => c.name).join(', ') || 'none'}.` }] };
    }
    const startedAt = new Date().toISOString();
    const r = await run(config, timeoutSeconds ?? 600);
    const result = { name, passed: r.exitCode === 0, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, output: r.output };
    if (log) {
      try {
        appendFileSync(log, `${JSON.stringify({ name, command: config.command, cwd: config.cwd, startedAt, endedAt: new Date().toISOString(), exitCode: r.exitCode, output: r.output })}\n`);
      } catch {
        // The history entry is a convenience; the agent still gets its result.
      }
    }
    return {
      structuredContent: result,
      content: [{ type: 'text', text: `${name}: ${result.passed ? 'passed' : r.timedOut ? 'timed out' : `failed (exit ${r.exitCode ?? 'none'})`} in ${r.durationMs} ms\n${r.output}` }],
    };
  },
);

// The main build output is CommonJS, which has no top-level await.
void server.connect(new StdioServerTransport());
