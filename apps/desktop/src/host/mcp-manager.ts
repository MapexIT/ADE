import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RpcError, McpServerConfig, type McpCheck, type McpServerEntry, type McpSource } from '@ade/contracts';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Repositories } from './repositories.ts';
import { readWorkspaceConfig, resolveMcpServers, toArgv, WORKSPACE_FILE, type ResolvedMcpServer } from './workspace-config.ts';
import { join } from 'node:path';

const LIST_KEY = 'mcp.servers';
const LEGACY_YAML_KEY = 'mcp.personal';
const MAX_SERVERS = 20;
const CHECK_TIMEOUT_MS = 20_000;

export type PersonalServer = McpServerConfig & { enabled: boolean };

/** A server ADE itself provides; its switch is an existing setting. */
export interface BuiltInServer {
  name: string;
  kind: 'stdio' | 'http';
  target: string;
  setting: string;
  defaultOn: boolean;
  note: string;
  missing(): string[];
}

/** Connects to a server, lists its tools and disconnects. Injected so tests need no real server. */
export type Probe = (server: ResolvedMcpServer, opts: { cwd: string; timeoutMs: number }) => Promise<{ name: string; description: string | null }[]>;

const quoteArg = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
const describeTarget = (s: McpServerConfig) => ('url' in s ? s.url : toArgv(s.command).map(quoteArg).join(' '));
const keysOf = (s: McpServerConfig) => Object.keys('url' in s ? s.headers : s.env);

/**
 * CO-13: the MCP manager. Personal servers are a JSON list in the settings (each with an on/off switch); the
 * repository's servers come from .ade/workspace.yaml and can be switched off for this machine; ADE's own servers map
 * to their existing settings. `forSession` is what a new session receives.
 */
export class McpManager {
  constructor(
    private readonly repos: Repositories,
    private readonly builtIns: () => BuiltInServer[],
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    private readonly probe: Probe = probeServer,
  ) {}

  /** The personal list. The first read moves servers from the older YAML setting (CO-10). */
  personal(): PersonalServer[] {
    const raw = this.repos.settings.raw(LIST_KEY);
    if (Array.isArray(raw)) {
      return raw.flatMap((r: unknown) => {
        const parsed = McpServerConfig.safeParse(r);
        return parsed.success ? [{ ...parsed.data, enabled: (r as { enabled?: unknown }).enabled !== false }] : [];
      });
    }
    const yaml = this.repos.settings.get<string>(LEGACY_YAML_KEY, '');
    let legacy: PersonalServer[] = [];
    try {
      const parsed = McpServerConfig.array().safeParse(yaml.trim() ? (parseYaml(yaml) ?? []) : []);
      legacy = parsed.success ? parsed.data.map((s) => ({ ...s, enabled: true })) : [];
    } catch {
      legacy = [];
    }
    this.store(legacy);
    return legacy;
  }

  private store(list: PersonalServer[]) {
    this.repos.settings.set(LIST_KEY, list);
  }

  /** The personal list as YAML (switched-off servers included), for editing in bulk. */
  personalYaml(): string {
    const list = this.personal().map(({ enabled: _e, ...s }) => s);
    return list.length ? stringifyYaml(list) : '';
  }

  /** Replaces the personal list from YAML, keeping the switches of servers that keep their names. */
  savePersonalYaml(yaml: string) {
    let data: unknown;
    try {
      data = yaml.trim() ? (parseYaml(yaml) ?? []) : [];
    } catch (err) {
      throw new RpcError('invalid', `This is not valid YAML: ${(err as Error).message}`);
    }
    const parsed = McpServerConfig.array().max(MAX_SERVERS).safeParse(data);
    if (!parsed.success) throw new RpcError('invalid', `Each server needs a name and a command or a url: ${parsed.error.issues[0]?.message ?? ''}`);
    const names = parsed.data.map((s) => s.name);
    if (new Set(names).size !== names.length) throw new RpcError('invalid', 'Two servers have the same name.');
    const before = new Map(this.personal().map((s) => [s.name, s.enabled]));
    this.store(parsed.data.map((s) => ({ ...s, enabled: before.get(s.name) ?? true })));
  }

  save(original: string | null, server: McpServerConfig) {
    const list = this.personal();
    const at = original ? list.findIndex((s) => s.name === original) : -1;
    if (original && at === -1) throw new RpcError('not_found', `There is no personal server called ${original}.`);
    if (list.some((s, i) => s.name === server.name && i !== at)) throw new RpcError('duplicate', `A personal server called ${server.name} already exists.`);
    if (at === -1 && list.length >= MAX_SERVERS) throw new RpcError('too_many', `At most ${MAX_SERVERS} personal servers.`);
    const entry = { ...server, enabled: at === -1 ? true : list[at]!.enabled };
    if (at === -1) list.push(entry);
    else list[at] = entry;
    this.store(list);
  }

  remove(name: string) {
    const list = this.personal();
    if (!list.some((s) => s.name === name)) throw new RpcError('not_found', `There is no personal server called ${name}.`);
    this.store(list.filter((s) => s.name !== name));
  }

  private disabledKey(workspaceId: string) {
    return `mcp.workspaceDisabled.${workspaceId}`;
  }

  workspaceDisabled(workspaceId: string): string[] {
    return this.repos.settings.get<string[]>(this.disabledKey(workspaceId), []);
  }

  setEnabled(workspaceId: string | null, source: McpSource, name: string, enabled: boolean) {
    if (source === 'personal') {
      const list = this.personal();
      const s = list.find((x) => x.name === name);
      if (!s) throw new RpcError('not_found', `There is no personal server called ${name}.`);
      s.enabled = enabled;
      this.store(list);
    } else if (source === 'workspace') {
      if (!workspaceId) throw new RpcError('invalid', 'Open a repository first.');
      const off = new Set(this.workspaceDisabled(workspaceId));
      if (enabled) off.delete(name);
      else off.add(name);
      this.repos.settings.set(this.disabledKey(workspaceId), [...off]);
    } else {
      const b = this.builtIns().find((x) => x.name === name);
      if (!b) throw new RpcError('not_found', `There is no built-in server called ${name}.`);
      this.repos.settings.set(b.setting, enabled);
    }
  }

  private async workspaceServers(workspaceId: string | null) {
    const ws = workspaceId ? this.repos.workspaces.get(workspaceId) : null;
    if (!ws) return { ws: null, servers: [] as McpServerConfig[], file: null };
    const cfg = await readWorkspaceConfig(ws.rootPath);
    return { ws, servers: cfg.config.mcpServers, file: { path: join(ws.rootPath, WORKSPACE_FILE), exists: cfg.exists, error: cfg.error } };
  }

  private missingVars(s: McpServerConfig): string[] {
    const r = resolveMcpServers([s], this.env());
    return [...new Set(r.skipped.flatMap((x) => x.missing))].map((v) => `$${v}`);
  }

  async list(workspaceId: string | null): Promise<{ servers: McpServerEntry[]; workspaceFile: { path: string; exists: boolean; error: string | null } | null }> {
    const { servers: repoServers, file } = await this.workspaceServers(workspaceId);
    const off = workspaceId ? new Set(this.workspaceDisabled(workspaceId)) : new Set<string>();
    const entry = (source: McpSource, s: McpServerConfig, enabled: boolean, editable: boolean): McpServerEntry => ({
      source,
      name: s.name,
      kind: 'url' in s ? 'http' : 'stdio',
      target: describeTarget(s),
      enabled,
      editable,
      checkable: true,
      missing: this.missingVars(s),
      keys: keysOf(s),
      note: null,
      config: editable ? s : null,
    });
    const builtIn = this.builtIns().map<McpServerEntry>((b) => ({
      source: 'built-in',
      name: b.name,
      kind: b.kind,
      target: b.target,
      enabled: this.repos.settings.get<boolean>(b.setting, b.defaultOn),
      editable: false,
      checkable: false,
      missing: b.missing(),
      keys: [],
      note: b.note,
      config: null,
    }));
    return {
      servers: [
        ...this.personal().map(({ enabled, ...s }) => entry('personal', s, enabled, true)),
        ...repoServers.map((s) => entry('workspace', s, !off.has(s.name), false)),
        ...builtIn,
      ],
      workspaceFile: file,
    };
  }

  /** The personal and repository servers a new session receives: switched on, with every variable set. */
  async forSession(workspaceId: string) {
    const { servers } = await this.workspaceServers(workspaceId);
    const off = new Set(this.workspaceDisabled(workspaceId));
    return {
      workspace: resolveMcpServers(servers.filter((s) => !off.has(s.name)), this.env()),
      personal: resolveMcpServers(this.personal().filter((s) => s.enabled).map(({ enabled: _e, ...s }) => s), this.env()),
    };
  }

  async check(workspaceId: string | null, source: McpSource, name: string): Promise<McpCheck> {
    const started = Date.now();
    const done = (ok: boolean, tools: McpCheck['tools'], error: string | null): McpCheck => ({ ok, tools, error, ms: Date.now() - started, checkedAt: new Date().toISOString() });
    let config: McpServerConfig | undefined;
    let cwd = process.cwd();
    if (source === 'personal') config = this.personal().find((s) => s.name === name);
    else if (source === 'workspace') {
      const { ws, servers } = await this.workspaceServers(workspaceId);
      config = servers.find((s) => s.name === name);
      if (ws) cwd = ws.rootPath;
    } else throw new RpcError('not_supported', 'ADE checks its own servers when a session starts.');
    if (!config) throw new RpcError('not_found', `There is no server called ${name}.`);
    const resolved = resolveMcpServers([config], this.env());
    const server = resolved.servers[0];
    if (!server) return done(false, [], `Not set: ${resolved.skipped[0]!.missing.map((v) => `$${v}`).join(', ')}.`);
    try {
      return done(true, await this.probe(server, { cwd, timeoutMs: CHECK_TIMEOUT_MS }), null);
    } catch (err) {
      return done(false, [], (err as Error).message.slice(0, 1000));
    }
  }
}

/** The real probe: an MCP client over stdio or streamable HTTP, closed afterwards (which ends a stdio process). */
export const probeServer: Probe = async (server, { cwd, timeoutMs }) => {
  const client = new Client({ name: 'ade-check', version: '0.1.0' });
  let stderr = '';
  const transport =
    'url' in server
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
      : new StdioClientTransport({ command: server.command, args: server.args, env: { ...getDefaultEnvironment(), ...server.env }, cwd, stderr: 'pipe' });
  if (transport instanceof StdioClientTransport) transport.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-2000)));
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return tools.map((t) => ({ name: t.name, description: t.description ?? null }));
    })();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer within ${timeoutMs / 1000} seconds.`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join('\n');
    throw new Error(tail ? `${(err as Error).message}\n${tail}` : (err as Error).message);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
};
