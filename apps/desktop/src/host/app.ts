import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { createRuntimes, type AdapterLocator, type Command } from '@ade/acp-client';
import { RpcError, type Handlers, type HostApi } from '@ade/contracts';
import { EventBus } from './bus.ts';
import { migrate, openDatabase } from './db.ts';
import { Repositories } from './repositories.ts';
import { ReviewService } from './review-service.ts';
import { AgentService, detectRunConfigs, FileService, WorkspaceService } from './services.ts';
import { SessionService, type HostPaths } from './session-service.ts';
import { readWorkspaceConfig } from './workspace-config.ts';
import { listWorkflows } from './workflows.ts';
import { CredentialCache, GitHubCliProvider, ShortcutMcpProvider } from './connectors.ts';
import { WorkItemService } from './work-items.ts';
import { commandResolver } from './executors.ts';
import { WorkflowService } from './workflow-service.ts';
import { SkillService } from './skills.ts';
import { ContainmentService, type Exec } from './containment.ts';
import { rulesKey } from './workspace-rules.ts';
import { homedir } from 'node:os';

export interface HostConfig {
  userData: string;
  /** Node command for running JS adapters (Electron binary with ELECTRON_RUN_AS_NODE in the app). */
  node: Command;
  nodeEnv: Record<string, string>;
  /** Path of the fake agent entry; when set, the `fake` agent is offered (tests and development only). */
  fakeAgentEntry?: string;
  /** Resolves adapter entry points; defaults to Node resolution from this file. */
  adapterEntry?: AdapterLocator['adapterEntry'];
  databasePath?: string;
  /** Home folder for the agents' user skills folders (SK-05); tests point it at a temporary folder. */
  homeDir?: string;
  /** CN-07: overrides the platform and process runner the sandbox probe uses (tests only). */
  sandbox?: { platform?: NodeJS.Platform; exec?: Exec };
}

const defaultAdapterEntry: AdapterLocator['adapterEntry'] = (pkg) => {
  try {
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const pkgJson = require.resolve(`${pkg}/package.json`);
    // Packaged builds unpack the adapters so they can be spawned.
    return join(dirname(pkgJson), 'dist', 'index.js').replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  } catch {
    return null;
  }
};

/** Composition root for the host process. Electron-free, so tests drive it directly. */
export function createHost(config: HostConfig) {
  const paths: HostPaths = {
    userData: config.userData,
    worktrees: join(config.userData, 'worktrees'),
    patches: join(config.userData, 'patches'),
    fakeAgentState: join(config.userData, 'fake-agent'),
  };
  for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });

  const db = openDatabase(config.databasePath ?? join(config.userData, 'ade.db'));
  migrate(db);
  const repos = new Repositories(db);
  const bus = new EventBus();
  const runtimes = createRuntimes(
    {
      adapterEntry: config.adapterEntry ?? defaultAdapterEntry,
      nodeCommand: () => config.node,
      nodeEnv: () => config.nodeEnv,
    },
    config.fakeAgentEntry ? { fakeAgentEntry: config.fakeAgentEntry } : {},
  );
  const sessions = new SessionService(repos, bus, runtimes, paths);
  // The probe writes (or fails to write) in the real home folder, so it always uses it, even in tests.
  const containment = new ContainmentService(
    repos.settings,
    { probe: join(config.userData, 'sandbox-probe'), tmp: join(config.userData, 'sandbox-tmp') },
    () => [...runtimes.keys()],
    config.sandbox?.platform ?? process.platform,
    config.sandbox?.exec,
  );
  sessions.sandbox = containment;
  const review = new ReviewService(repos, sessions, paths);
  const workspaces = new WorkspaceService(repos);
  const agents = new AgentService(runtimes);
  const files = new FileService(repos, sessions);
  const credentials = new CredentialCache();
  const workItems = new WorkItemService();
  const shortcut = new ShortcutMcpProvider(credentials);
  workItems.register(shortcut);
  const github = new GitHubCliProvider(credentials);
  if (github.available()) workItems.register(github);
  const workflows = new WorkflowService(
    repos,
    bus,
    {
      repos,
      bus,
      sessions,
      review,
      worktreesDir: paths.worktrees,
      resolveCommand: commandResolver(config.node, config.nodeEnv),
    },
    () => sessions.refreshInbox(),
  );
  sessions.inboxSources.push(() => workflows.inbox());
  const skills = new SkillService(join(config.userData, 'skills'), config.homeDir ?? homedir());
  sessions.installSkills = async (repoRoot, worktree, agentId, names) =>
    skills.install(worktree, agentId, await skills.resolve(repoRoot, names));
  const rootOrNull = (workspaceId: string | null) => (workspaceId ? workspaceRoot(workspaceId) : null);
  const startedAt = new Date().toISOString();

  const workspaceRoot = (workspaceId: string) => {
    const ws = repos.workspaces.get(workspaceId);
    if (!ws) throw new RpcError('not_found', 'Unknown workspace');
    return ws.rootPath;
  };

  const handlers: Handlers<HostApi> = {
    'app.ping': () => ({ pid: process.pid, startedAt }),
    'workspace.list': () => workspaces.list(),
    'workspace.open': ({ path }) => workspaces.open(path),
    'workspace.setupFile': async ({ workspaceId }) => {
      const res = await readWorkspaceConfig(workspaceRoot(workspaceId));
      return { exists: res.exists, content: res.raw };
    },
    'settings.get': ({ key }) => ({ value: repos.settings.raw(key) }),
    'settings.set': ({ key, value }) => {
      if (key.startsWith('rules.')) throw new RpcError('invalid', 'Use rules.save for workspace rules.');
      repos.settings.set(key, value);
      if (key.startsWith('sandbox.')) void containment.status(true);
      return { ok: true };
    },
    'agents.status': ({ refresh }) => agents.status(refresh),
    'containment.status': ({ refresh }) => containment.status(refresh),
    'rules.list': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return sessions.rules(workspaceId);
    },
    'rules.save': ({ workspaceId, rules }) => {
      workspaceRoot(workspaceId);
      repos.settings.set(rulesKey(workspaceId), rules);
      repos.audit.append({ workspaceId, sessionId: null, actor: 'user', action: 'rules.saved', detail: { rules } });
      return { ok: true };
    },
    'sessions.list': ({ workspaceId }) => repos.sessions.list(workspaceId),
    'sessions.get': ({ sessionId }) => ({
      session: repos.sessions.require(sessionId),
      turns: repos.turns.list(sessionId),
      events: repos.events.list(sessionId),
      queued: sessions.queued(sessionId),
    }),
    'sessions.create': (input) => sessions.create(input),
    'sessions.prompt': async ({ sessionId, content }) => {
      await sessions.prompt(sessionId, content);
      return { ok: true };
    },
    'sessions.queue': async ({ sessionId, content }) => ({
      id: (await sessions.prompt(sessionId, content)).id,
    }),
    'sessions.unqueue': ({ sessionId, id }) => {
      sessions.unqueue(sessionId, id);
      return { ok: true };
    },
    'sessions.editQueued': ({ sessionId, id, content }) => {
      sessions.editQueued(sessionId, id, content);
      return { ok: true };
    },
    'sessions.cancel': async ({ sessionId }) => {
      await sessions.cancel(sessionId);
      return { ok: true };
    },
    'sessions.interrupt': async ({ sessionId, content }) => {
      await sessions.interrupt(sessionId, content);
      return { ok: true };
    },
    'sessions.answerPermission': ({ sessionId, requestId, optionId, note }) => {
      sessions.answerPermission(sessionId, requestId, optionId, note);
      return { ok: true };
    },
    'sessions.setMode': async ({ sessionId, modeId }) => {
      await sessions.setMode(sessionId, modeId);
      return { ok: true };
    },
    'sessions.changes': ({ sessionId, turnIndex }) => review.changes(sessionId, turnIndex),
    'sessions.diff': ({ sessionId, path, turnIndex }) => review.diff(sessionId, path, turnIndex),
    'sessions.undoTurn': async ({ sessionId, turnIndex }) => {
      await review.undoTurn(sessionId, turnIndex);
      return { ok: true };
    },
    'sessions.land': async ({ sessionId, mode, files: selected, message }) => {
      await review.land(sessionId, mode, selected, message);
      return { ok: true };
    },
    'sessions.discard': async ({ sessionId }) => ({ patchPath: await review.discard(sessionId) }),
    'sessions.protocol': ({ sessionId }) => sessions.protocol(sessionId),
    'inbox.list': () => sessions.inbox(),
    'files.list': ({ root }) => files.list(root),
    'files.read': ({ path }) => files.read(path),
    'files.write': ({ path, content, expectedMtimeMs, sessionId }) =>
      files.write(path, content, expectedMtimeMs, sessionId),
    'runs.configs': async ({ workspaceId }) => {
      repos.runs.replaceDetected(workspaceId, await detectRunConfigs(workspaceRoot(workspaceId)));
      return repos.runs.configs(workspaceId);
    },
    'runs.saveConfig': (c) => repos.runs.saveUser(c),
    'runs.record': (run) => {
      const ws = run.sessionId
        ? repos.sessions.get(run.sessionId)?.workspaceId
        : repos.workspaces.list().find((w) => run.worktreePath.startsWith(w.rootPath))?.id;
      const saved = repos.runs.record(run, ws ?? null);
      workflows.onRunRecorded(run, ws ?? null);
      if (run.sessionId)
        sessions.record(run.sessionId, { type: 'run.finished', runId: saved.id, exitCode: run.exitCode });
      return saved;
    },
    'runs.history': ({ workspaceId }) => repos.runs.history(workspaceId),
    'audit.list': ({ workspaceId }) => repos.audit.list(workspaceId),
    'workflows.list': ({ workspaceId }) => listWorkflows(workspaceId ? workspaceRoot(workspaceId) : null),
    'workflows.start': (input) => workflows.start(input),
    'workflows.runs': ({ workspaceId }) => workflows.list(workspaceId),
    'workflows.get': ({ workspaceId, workflowId }) => workflows.detail(workspaceId, workflowId),
    'workflows.save': ({ workspaceId, file, definition }) => workflows.save(workspaceId, file, definition),
    'workflows.testNode': (input) => workflows.testNode(input),
    'workflows.decideGate': ({ runId, nodeId, approved }) => workflows.decideGate(runId, nodeId, approved),
    'workflows.resume': ({ runId }) => workflows.resume(runId),
    'workflows.retryFrom': ({ runId, nodeId }) => workflows.retryFrom(runId, nodeId),
    'workflows.cancel': ({ runId }) => workflows.cancel(runId),
    'skills.list': ({ workspaceId }) => skills.list(rootOrNull(workspaceId)),
    'skills.read': ({ workspaceId, id }) => skills.read(rootOrNull(workspaceId), id),
    'skills.save': ({ workspaceId, ...input }) => skills.save(rootOrNull(workspaceId), input),
    'skills.sync': ({ workspaceId, id, enabled }) => skills.sync(rootOrNull(workspaceId), id, enabled),
    'skills.draft': ({ workspaceId, agentId, name, description, fromSessionId }) => {
      // SK-04: an ordinary session drafts the skill into .ade/skills, so it is reviewed and landed like any change.
      const transcript = fromSessionId
        ? repos.events
            .list(fromSessionId)
            .flatMap((e) =>
              e.type === 'agent.message'
                ? [`Agent: ${e.text}`]
                : e.type === 'user.message'
                  ? [`User: ${e.content.map((b) => ('text' in b ? b.text : '')).join(' ')}`]
                  : [],
            )
            .join('\n\n')
            .slice(-20_000)
        : '';
      const prompt = [
        `Write an Agent Skill called ${name}.`,
        `Create the file .ade/skills/${name}/SKILL.md. Start it with YAML frontmatter that has exactly "name: ${name}" and a one-sentence "description:" saying when to use the skill, then write clear, step-by-step instructions. Put long reference material or scripts in files next to SKILL.md and link them.`,
        `What the skill is for: ${description}`,
        transcript ? `Base it on how this past session went:\n\n${transcript}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      return sessions.create({
        workspaceId,
        agentId,
        title: `Draft skill: ${name}`,
        prompt: [{ type: 'text', text: prompt }],
        permissionProfile: 'auto-edit',
      });
    },
    'workItems.sources': () => workItems.sources(),
    'workItems.list': ({ source, query }) => workItems.list(source, query),
  };

  // CO-04: connectors are passed to agents as MCP servers only when the user opted in, because the agent then
  // holds the connector token. Off by default.
  sessions.mcpServersFor = () => {
    if (!repos.settings.get<boolean>('connectors.shareWithAgents', false)) return [];
    const token = credentials.get('shortcut');
    return token
      ? [{ name: 'shortcut', url: ShortcutMcpProvider.URL, headers: { Authorization: `Bearer ${token}` } }]
      : [];
  };

  sessions.recover();
  workflows.recover();
  void review.prunePatches();

  return {
    handlers,
    bus,
    repos,
    sessions,
    review,
    containment,
    workItems,
    workflows,
    skills,
    paths,
    /** Main hands over decrypted connector tokens; they stay in memory only. */
    setCredentials(values: Partial<Record<'shortcut' | 'github', string>>) {
      credentials.set(values);
      void shortcut.reset();
    },
    async dispose() {
      await workflows.dispose();
      await sessions.shutdown();
      db.close();
    },
  };
}

export type Host = ReturnType<typeof createHost>;
