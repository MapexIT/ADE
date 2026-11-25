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
import type { McpServerSpec } from '@ade/acp-client';
import { listWorkflows } from './workflows.ts';
import { ConnectionStatusService } from './connection-status.ts';
import { CredentialCache, GitHubCliProvider, runFile, ShortcutMcpProvider, type Runner } from './connectors.ts';
import { ChecksService } from './checks.ts';
import { BranchService } from './branches.ts';
import { PullRequestService } from './pull-requests.ts';
import { McpShortcutActions, type ShortcutActions } from './shortcut-actions.ts';
import { WorkItemSync } from './work-item-sync.ts';
import { findOnPath } from '@ade/acp-client';
import { McpManager } from './mcp-manager.ts';
import { commitDetail, commitDiff, gitGraph } from './git-graph.ts';
import { ReviewAssistant } from './review-assistant.ts';
import { ReasoningService } from './reasoning-service.ts';
import { TelegramNotifier, type FetchLike } from './telegram.ts';
import { LoopWatch } from './loop-watch.ts';
import { askOnce } from './one-shot.ts';
import { ScratchService } from './scratch.ts';
import { instructionStatus } from './instruction-files.ts';
import { exportAudit, searchSessions } from './history-search.ts';
import { LspService } from './lsp.ts';
import { PreviewMcp, type PreviewDriver } from './preview-mcp.ts';
import { readFileSync, rmSync } from 'node:fs';
import { relative as relPath } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { ComposerState, LoopSettings, PromptBoxes, ReceiptSettings, TerminalLayout, type ConnectorSecret } from '@ade/contracts';
import { changedFiles, diffPatch, ignoredPaths } from '@ade/git';
import { RECEIPT_EVENTS, ReceiptService } from './receipts.ts';
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
  /** RV-12: overrides the GitHub CLI and how it is run (tests only). */
  github?: { gh: string | null; run: Runner };
  /** HI-08: drives the preview window (main implements it); without one, agents get no preview tools. */
  previewDriver?: PreviewDriver;
  /** CR-08: the runner MCP server's entry; when set, sessions get the `ade-runner` tools. */
  runnerMcpEntry?: string;
  /** CO-05, CO-08, CO-09: replaces the Shortcut MCP actions (tests only). */
  shortcut?: ShortcutActions;
  /** CN-07: overrides the platform and process runner the sandbox probe uses (tests only). */
  sandbox?: { platform?: NodeJS.Platform; exec?: Exec };
}

export const defaultAdapterEntry: AdapterLocator['adapterEntry'] = (pkg) => {
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
  // WA-10: loop watch records what it finds as session events, so it works with the window closed.
  const loops = new LoopWatch({
    bus,
    record: (sessionId, event, turnId) => sessions.record(sessionId, event, turnId ?? null),
    cancel: (sessionId) => sessions.cancel(sessionId),
    settings: () => {
      const parsed = LoopSettings.safeParse(repos.settings.raw('loops') ?? {});
      return parsed.success ? parsed.data : LoopSettings.parse({});
    },
    session: (sessionId) => repos.sessions.get(sessionId),
    audit: (entry) => repos.audit.append(entry),
    refreshInbox: () => sessions.refreshInbox(),
  });
  sessions.inboxSources.push(() => loops.inbox());
  // RV-16: turn receipts are session events too, issued by the host when a turn ends.
  const receipts = new ReceiptService({
    bus,
    record: (sessionId, event, turnId) => sessions.record(sessionId, event, turnId ?? null),
    settings: () => {
      const parsed = ReceiptSettings.safeParse(repos.settings.raw('receipts') ?? {});
      return parsed.success ? parsed.data : ReceiptSettings.parse({});
    },
    session: (sessionId) => repos.sessions.get(sessionId),
    turns: (sessionId) => repos.turns.list(sessionId),
    receiptEvents: (sessionId) => repos.events.listOfTypes(sessionId, RECEIPT_EVENTS),
    git: { changedFiles, diffPatch, ignoredPaths },
    audit: (entry) => repos.audit.append(entry),
  });
  const resolveCommand = commandResolver(config.node, config.nodeEnv);
  const checks = new ChecksService(repos, sessions, resolveCommand, () => sessions.sandbox);
  const runnerLog = (sessionId: string) => join(config.userData, 'runner', `${sessionId}.jsonl`);
  mkdirSync(join(config.userData, 'runner'), { recursive: true });
  /** CR-08: runs the agent made through the runner tool join the run history after each turn. */
  const ingestRunner = (sessionId: string) => {
    const file = runnerLog(sessionId);
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
      rmSync(file, { force: true });
    } catch {
      return;
    }
    const session = repos.sessions.get(sessionId);
    if (!session) return;
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const r = JSON.parse(line) as { command: string[]; cwd: string; startedAt: string; endedAt: string; exitCode: number | null; output: string };
        const run = repos.runs.record(
          { runConfigId: null, sessionId, worktreePath: session.worktreePath ?? '', command: r.command, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, output: r.output },
          session.workspaceId,
        );
        sessions.record(sessionId, { type: 'run.finished', runId: run.id, exitCode: r.exitCode });
      } catch {
        // a torn line: skip it
      }
    }
  };
  sessions.afterTurn = async (sessionId) => {
    ingestRunner(sessionId);
    await checks.afterTurn(sessionId);
  };
  const lsp = new LspService((path) => files.rootOf(path), undefined, config.node.command);
  let previewDriver: PreviewDriver | null = config.previewDriver ?? null;
  const screenshotsDir = join(config.userData, 'screenshots');
  const preview = new PreviewMcp(
    () => previewDriver,
    screenshotsDir,
    (sessionId, url, file) => sessions.record(sessionId, { type: 'preview.screenshot', url, file }),
  );
  const scratch = new ScratchService(join(config.userData, 'scratch'), containment, config.node, config.nodeEnv);
  const branches = new BranchService(repos, sessions);
  const gh = config.github ? config.github.gh : findOnPath('gh');
  const ghRun = config.github?.run ?? runFile;
  const connectionStatus = new ConnectionStatusService(credentials, ghRun, gh, findOnPath('git'));
  const shortcutActions = config.shortcut ?? new McpShortcutActions(shortcut.connection);
  const sync = new WorkItemSync(repos, sessions, () => (config.shortcut || credentials.get('shortcut') ? shortcutActions : null), credentials, ghRun, gh);
  const pullRequests = new PullRequestService(repos, sessions, review, credentials, sync, ghRun, gh);
  workflows.openPullRequest = (sessionId, input) => pullRequests.open(sessionId, input);
  workflows.connectorAction = (connector, action, ref, text) => sync.runAction(connector, action, ref, text);
  sessions.onCreated = (s) => sync.onSessionCreated(s);
  review.onLanded = (s, action, detail) => sync.onLanded(s, action, detail);
  // CO-05: a merged pull request lands its session. Checked every five minutes and whenever its status is shown.
  const mergeTimer = setInterval(() => void pullRequests.pollMerges().catch(() => undefined), 5 * 60_000);
  mergeTimer.unref();
  // CO-13: personal, repository and built-in MCP servers in one place.
  const mcp = new McpManager(repos, () => [
    {
      name: 'ade-runner',
      kind: 'stdio',
      target: 'Built into ADE',
      setting: 'runner.forAgents',
      defaultOn: true,
      note: "Runs this workspace's code runner configurations inside the session's worktree.",
      missing: () => (config.runnerMcpEntry ? [] : ['a build that includes it']),
    },
    {
      name: 'ade-preview',
      kind: 'http',
      target: 'Built into ADE (local only)',
      setting: 'preview.forAgents',
      defaultOn: true,
      note: 'Lets agents open, click, read and screenshot the preview window. Only agents that support HTTP MCP receive it.',
      missing: () => (previewDriver ? [] : ['the preview window']),
    },
    {
      name: 'shortcut',
      kind: 'http',
      target: ShortcutMcpProvider.URL,
      setting: 'connectors.shareWithAgents',
      defaultOn: false,
      note: 'Hands your Shortcut token to the agent, so it can read and change stories.',
      missing: () => (credentials.get('shortcut') ? [] : ['a Shortcut token']),
    },
  ]);
  mkdirSync(join(config.userData, 'review-tmp'), { recursive: true });
  const assistant = new ReviewAssistant(repos, runtimes, join(config.userData, 'review-tmp'), () => sessions.sandbox, () => ({ ...process.env, ADE_FAKE_STATE_DIR: paths.fakeAgentState }));
  const reasoning = new ReasoningService(repos, sessions, runtimes, join(config.userData, 'reasoning-tmp'), () => sessions.sandbox, () => ({ ...process.env, ADE_FAKE_STATE_DIR: paths.fakeAgentState }));
  reasoning.recover();
  // GN-01: a session created with a reasoning method reasons about its first prompt once it is ready.
  sessions.firstReasoned = (sessionId, content, settings) => reasoning.prompt(sessionId, content, settings).catch((err: Error) => sessions.record(sessionId, { type: 'notice', level: 'error', text: `Reasoning could not start: ${err.message}` }));
  const telegram = new TelegramNotifier({
    fetch: ((url, init) => fetch(url, init)) as FetchLike,
    // Tests point this at a local stand-in for the Bot API.
    ...(process.env.ADE_TELEGRAM_API ? { base: process.env.ADE_TELEGRAM_API } : {}),
    secret: (key) => credentials.get(key),
    enabled: () => repos.settings.get<boolean>('telegram.enabled', false),
    setEnabled: (on) => repos.settings.set('telegram.enabled', on),
    onStatus: (status) => bus.emit('telegram.status', status),
  });
  bus.on('notify', ({ sessionId, title, body }) => {
    const session = repos.sessions.get(sessionId);
    const ws = session ? repos.workspaces.get(session.workspaceId) : null;
    void telegram.notify(title, [body, ws ? `Workspace: ${ws.name}` : ''].filter(Boolean).join('\n'));
  });
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
      if (/^(rules|commands|checks|sync|board|mcp|envsets)\./.test(key) || key === 'pullRequests') throw new RpcError('invalid', 'This setting has its own request (rules.save or commands.save).');
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
    'sessions.create': async (input) => {
      const session = await sessions.create(input);
      // The composer keeps the method the session started with.
      if (input.reasoning) repos.settings.set(`composer.${session.id}`, { mode: 'chat', reasoning: input.reasoning });
      return session;
    },
    'sessions.prompt': async ({ sessionId, content }) => {
      await sessions.prompt(sessionId, content);
      return { ok: true };
    },
    'sessions.promptReasoned': ({ sessionId, content, settings }) => reasoning.prompt(sessionId, content, settings),
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
    'sessions.killCommand': async ({ sessionId, terminalId }) => ({ killed: await sessions.killCommand(sessionId, terminalId) }),
    'sessions.cancel': async ({ sessionId }) => {
      // Cancelling stops a reasoning run too; nothing it was preparing is sent.
      reasoning.cancel(sessionId);
      await sessions.cancel(sessionId);
      return { ok: true };
    },
    'sessions.dismissLoop': ({ sessionId }) => {
      loops.dismiss(sessionId);
      return { ok: true };
    },
    'sessions.acknowledgeReceipt': ({ sessionId, turnId }) => {
      receipts.acknowledge(sessionId, turnId);
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
    'sessions.compare': (input) => sessions.compare(input),
    'sessions.handOff': ({ sessionId, agentId, note }) => sessions.handOff(sessionId, agentId, note),
    'sessions.detach': ({ sessionId }) => sessions.detach(sessionId),
    'sessions.overlaps': ({ workspaceId }) => sessions.overlaps(workspaceId),
    'sessions.baseStatus': ({ sessionId }) => branches.baseStatus(sessionId),
    'sessions.rebase': ({ sessionId, askAgent }) => branches.rebase(sessionId, askAgent),
    'sessions.pullRequest': ({ sessionId, ...input }) => pullRequests.open(sessionId, input),
    'sessions.pullRequestStatus': ({ sessionId }) => pullRequests.status(sessionId),
    'sessions.pushUpdate': async ({ sessionId, message }) => {
      await pullRequests.pushUpdate(sessionId, message);
      return { ok: true };
    },
    'sessions.sendReviewComments': ({ sessionId }) => pullRequests.sendReviewComments(sessionId),
    'sessions.sendFailedChecks': ({ sessionId }) => pullRequests.sendFailedChecks(sessionId),
    'sync.settings': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return sync.settings(workspaceId);
    },
    'sync.save': ({ workspaceId, settings }) => {
      workspaceRoot(workspaceId);
      sync.save(workspaceId, settings);
      repos.audit.append({ workspaceId, sessionId: null, actor: 'user', action: 'sync.saved', detail: { settings } });
      return { ok: true };
    },
    'connectors.shortcutStates': async () => {
      if (!config.shortcut && !credentials.get('shortcut')) throw new RpcError('not_connected', 'Connect Shortcut first.');
      return (await shortcutActions.workflowStates()).map(({ id, name, type }) => ({ id, name, type }));
    },
    'board.settings': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return sync.boardSettings(workspaceId);
    },
    'board.save': ({ workspaceId, settings }) => {
      workspaceRoot(workspaceId);
      sync.saveBoard(workspaceId, settings);
      return { ok: true };
    },
    'board.get': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return sync.board(workspaceId);
    },
    'mcp.personal': () => ({ yaml: mcp.personalYaml() }),
    'mcp.savePersonal': async ({ yaml }) => {
      mcp.savePersonalYaml(yaml);
      return { ok: true };
    },
    'mcp.list': ({ workspaceId }) => mcp.list(workspaceId),
    'mcp.save': async ({ original, server }) => {
      mcp.save(original, server);
      return { ok: true };
    },
    'mcp.remove': async ({ name }) => {
      mcp.remove(name);
      return { ok: true };
    },
    'mcp.setEnabled': async ({ workspaceId, source, name, enabled }) => {
      mcp.setEnabled(workspaceId, source, name, enabled);
      return { ok: true };
    },
    'mcp.check': ({ workspaceId, source, name }) => mcp.check(workspaceId, source, name),
    'sessions.draftCommitMessage': async ({ sessionId, hint }) => {
      const reply = await sessions.ask(
        sessionId,
        [
          'Write a commit message for the changes in this worktree: a subject line of at most 72 characters in the imperative mood, a blank line, then a short body saying why. Reply with the message only. Do not change any files.',
          hint?.trim() ?? '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      return { message: cleanCommitMessage(reply) };
    },
    'sessions.reviewAssist': ({ sessionId, agentId, focus }) => assistant.run(sessionId, agentId, focus),
    'sessions.reviewAssessment': ({ sessionId }) => assistant.assessment(sessionId),
    'sessions.reviewProgress': ({ sessionId }) => review.progress(sessionId),
    'sessions.markReviewed': ({ sessionId, files }) => review.markReviewed(sessionId, files),
    'sessions.unmarkReviewed': ({ sessionId, paths }) => review.unmarkReviewed(sessionId, paths),
    'sessions.diffSinceReviewed': ({ sessionId, path }) => review.diffSinceReviewed(sessionId, path),
    'checks.settings': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return checks.settings(workspaceId);
    },
    'checks.saveSettings': ({ workspaceId, settings }) => {
      workspaceRoot(workspaceId);
      checks.save(workspaceId, settings);
      return { ok: true };
    },
    'checks.run': ({ sessionId }) => checks.run(sessionId),
    'instructions.status': ({ workspaceId }) => instructionStatus(workspaceRoot(workspaceId)),
    'history.sessions': ({ workspaceId, query }) => searchSessions(repos, query, workspaceId),
    'audit.export': ({ workspaceId }) => {
      const ws = repos.workspaces.get(workspaceId);
      if (!ws) throw new RpcError('not_found', 'Unknown workspace');
      const worktrees = repos.sessions.list(workspaceId).map((s) => s.worktreePath).filter((p): p is string => !!p && p !== ws.rootPath);
      repos.audit.append({ workspaceId, sessionId: null, actor: 'user', action: 'audit.exported', detail: {} });
      return {
        fileName: `ade-audit-${ws.name.replace(/[^\w.-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`,
        content: exportAudit(repos.audit.exportAll(workspaceId), { workspace: ws.rootPath, userData: config.userData, worktrees }),
      };
    },
    'lsp.open': ({ path, text }) => lsp.open(path, text),
    'lsp.change': ({ path, text }) => {
      lsp.change(path, text);
      return { ok: true };
    },
    'lsp.close': ({ path }) => {
      lsp.close(path);
      return { ok: true };
    },
    'lsp.diagnostics': ({ path }) => lsp.diagnostics(path),
    'lsp.hover': ({ path, line, character }) => lsp.hover(path, line, character),
    'lsp.definition': ({ path, line, character }) => lsp.definition(path, line, character),
    'screenshots.read': async ({ file }) => ({ dataUrl: `data:image/png;base64,${(await readFile(join(screenshotsDir, file))).toString('base64')}` }),
    'scratch.prepare': ({ language, code }) => scratch.prepare(language, code),
    'scratch.write': ({ extension, content }) => scratch.write(extension, content),
    'envSets.list': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return repos.settings.get(`envsets.${workspaceId}`, []);
    },
    'envSets.save': ({ workspaceId, sets }) => {
      workspaceRoot(workspaceId);
      // Secret values never reach the host: only names and plain values are stored here.
      repos.settings.set(`envsets.${workspaceId}`, sets.map((s) => ({ ...s, vars: s.vars.map((v) => (v.secret ? { ...v, value: '' } : v)) })));
      return { ok: true };
    },
    'history.record': ({ workspaceId, sessionId, command, cwd, exitCode }) => {
      repos.history.record({ workspaceId, sessionId, command, cwd, exitCode });
      return { ok: true };
    },
    'history.search': ({ workspaceId, query }) => repos.history.search(query, workspaceId),
    'terminal.draftCommand': async ({ agentId, question, cwd, shell }) => {
      const where = files.assertAllowed(cwd);
      const runtime = runtimes.get(agentId);
      if (!runtime) throw new RpcError('agent_unavailable', `Agent ${agentId} is not available`);
      // A session worktree keeps its sandbox; the drafting agent runs read-only either way.
      const session = repos.workspaces.list().flatMap((w) => repos.sessions.list(w.id)).find((s) => s.worktreePath === cwd && s.containment !== 'none');
      const ws = session ? repos.workspaces.get(session.workspaceId) : null;
      const wrapper = session && ws ? await sessions.sandbox?.wrapperFor(session, ws.rootPath) : null;
      const lang = /pwsh|powershell/i.test(shell) ? 'powershell' : 'bash';
      const reply = await askOnce(runtime, {
        cwd: where,
        prompt: [
          `Reply with exactly one ${shell} command for ${process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'} that does what the request below asks, in a \`\`\`${lang} code block, then one sentence on what it does. Do not run it and do not change any file.`,
          question,
        ].join('\n\n'),
        baseEnv: { ...process.env, ADE_FAKE_STATE_DIR: paths.fakeAgentState },
        wrapper: wrapper ?? null,
        timeoutMs: 3 * 60_000,
        timeoutMessage: 'The agent did not draft a command in time.',
      });
      return { command: draftedCommand(reply), reply: reply.trim() };
    },
    'files.readImage': ({ path }) => files.readImage(path),
    'composer.get': ({ sessionId }) => {
      repos.sessions.require(sessionId);
      const parsed = ComposerState.safeParse(repos.settings.raw(`composer.${sessionId}`));
      return parsed.success ? parsed.data : null;
    },
    'composer.save': ({ sessionId, state }) => {
      repos.sessions.require(sessionId);
      repos.settings.set(`composer.${sessionId}`, state);
      return { ok: true };
    },
    'git.graph': ({ workspaceId, limit, remotes }) => gitGraph(workspaceRoot(workspaceId), repos.sessions.list(workspaceId), { limit, remotes }),
    'git.commit': ({ workspaceId, hash }) => commitDetail(workspaceRoot(workspaceId), hash),
    'git.commitDiff': ({ workspaceId, hash, path, oldPath }) => commitDiff(workspaceRoot(workspaceId), hash, path, oldPath),
    'telegram.status': () => telegram.status(),
    'telegram.setEnabled': ({ enabled }) => {
      const st = telegram.status();
      if (enabled && (!st.tokenStored || !st.passwordSet)) throw new RpcError('not_configured', 'Save the bot token and a password first.');
      return telegram.setEnabled(enabled);
    },
    'telegram.test': async () => {
      const st = telegram.status();
      if (!st.enabled) throw new RpcError('disabled', 'Turn Telegram notifications on first.');
      if (!st.chats) throw new RpcError('no_chats', 'No chat is signed in. Send /auth and the password to the bot first.');
      return { sent: await telegram.notify('Test notification', 'Telegram notifications from ADE work.') };
    },
    'promptBoard.get': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      const stored = PromptBoxes.safeParse(repos.settings.raw(`promptBoard.${workspaceId}`));
      if (stored.success) return stored.data;
      // Boards used to belong to one session: the newest session that had boxes seeds the workspace's board.
      for (const s of [...repos.sessions.list(workspaceId)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        const old = PromptBoxes.safeParse((repos.settings.raw(`composer.${s.id}`) as { boxes?: unknown } | null)?.boxes);
        if (old.success && old.data.length) return old.data;
      }
      return [];
    },
    'promptBoard.save': ({ workspaceId, boxes }) => {
      workspaceRoot(workspaceId);
      repos.settings.set(`promptBoard.${workspaceId}`, boxes);
      return { ok: true };
    },
    'layout.get': async ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      try {
        const parsed = TerminalLayout.safeParse(JSON.parse(await readFile(join(config.userData, 'layouts', `${workspaceId}.json`), 'utf8')));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    'layout.save': async ({ workspaceId, layout }) => {
      workspaceRoot(workspaceId);
      await mkdir(join(config.userData, 'layouts'), { recursive: true });
      await writeFile(join(config.userData, 'layouts', `${workspaceId}.json`), JSON.stringify(layout));
      return { ok: true };
    },
    'checks.results': ({ sessionId }) => checks.last(sessionId),
    'commands.list': ({ workspaceId }) => {
      workspaceRoot(workspaceId);
      return repos.settings.get(`commands.${workspaceId}`, []);
    },
    'commands.save': ({ workspaceId, commands }) => {
      workspaceRoot(workspaceId);
      repos.settings.set(`commands.${workspaceId}`, commands);
      return { ok: true };
    },
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
    'runs.record': ({ workspaceId, ...run }) => {
      const ws =
        workspaceId ??
        (run.sessionId
          ? repos.sessions.get(run.sessionId)?.workspaceId
          : repos.workspaces.list().find((w) => run.worktreePath.startsWith(w.rootPath))?.id);
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
    'connectors.status': ({ workspaceId }) => connectionStatus.status(rootOrNull(workspaceId)),
    'workItems.list': ({ source, query }) => workItems.list(source, query),
  };

  // CO-04: connectors are passed to agents as MCP servers only when the user opted in, because the agent then
  // holds the connector token. Off by default.
  sessions.mcpServersFor = async (workspaceId, sessionId) => {
    const servers: McpServerSpec[] = [];
    // ST-05: the workspace's shared servers from .ade/workspace.yaml.
    const ws = repos.workspaces.get(workspaceId);
    const chosen = await mcp.forSession(workspaceId);
    if (ws) {
      const resolved = chosen.workspace;
      servers.push(...resolved.servers);
      for (const s of resolved.skipped) {
        sessions.record(sessionId, { type: 'notice', level: 'warning', text: `MCP server "${s.name}" was not passed to the agent: ${s.missing.join(', ')} is not set.` });
      }
      if (resolved.servers.length) {
        sessions.record(sessionId, { type: 'notice', level: 'info', text: `Shared MCP servers: ${resolved.servers.map((s) => s.name).join(', ')}.` });
      }
    }
    // CR-08: the runner tools, with this workspace's configurations, running inside the session's worktree.
    const session = repos.sessions.get(sessionId);
    if (config.runnerMcpEntry && ws && session?.worktreePath && repos.settings.get<boolean>('runner.forAgents', true)) {
      const configs = repos.runs.configs(workspaceId).map((c) => ({ name: c.name, command: c.command, cwd: c.cwd === '.' ? '.' : relPath(ws.rootPath, c.cwd) || '.' }));
      if (configs.length) {
        servers.push({
          name: 'ade-runner',
          command: config.node.command,
          args: [...config.node.args, config.runnerMcpEntry],
          env: { ...config.nodeEnv, ADE_RUNNER_CONFIG: JSON.stringify(configs), ADE_RUNNER_ROOT: session.worktreePath, ADE_RUNNER_LOG: runnerLog(sessionId) },
        });
      }
    }
    // HI-08: the preview tools, when ADE can drive a preview window (agents without HTTP MCP do not get them).
    if (previewDriver && repos.settings.get<boolean>('preview.forAgents', true)) servers.push(await preview.specFor(sessionId));
    // CO-10: the user's personal servers, for every workspace.
    const personal = chosen.personal;
    servers.push(...personal.servers);
    for (const s of personal.skipped) {
      sessions.record(sessionId, { type: 'notice', level: 'warning', text: `Personal MCP server "${s.name}" was not passed to the agent: ${s.missing.join(', ')} is not set.` });
    }
    if (repos.settings.get<boolean>('connectors.shareWithAgents', false)) {
      const token = credentials.get('shortcut');
      if (token) servers.push({ name: 'shortcut', url: ShortcutMcpProvider.URL, headers: { Authorization: `Bearer ${token}` } });
    }
    return servers;
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
    sync,
    pullRequests,
    workItems,
    workflows,
    skills,
    paths,
    /** Main hands over decrypted connector tokens; they stay in memory only. */
    setCredentials(values: Partial<Record<ConnectorSecret, string>>) {
      credentials.set(values);
      void shortcut.reset();
      telegram.configure();
    },
    /** HI-08: main hands over the preview driver once its window code is ready. */
    setPreviewDriver(driver: PreviewDriver | null) {
      previewDriver = driver;
    },
    async dispose() {
      clearInterval(mergeTimer);
      loops.dispose();
      receipts.dispose();
      telegram.dispose();
      await lsp.dispose();
      await preview.dispose();
      await workflows.dispose();
      await sessions.shutdown();
      db.close();
    },
  };
}

export type Host = ReturnType<typeof createHost>;

/** SM-10: the command in a drafted reply: the first fenced block, else the first non-empty line. Pure. */
export function draftedCommand(reply: string): string | null {
  const block = /```[\w-]*[^\n]*\n([\s\S]*?)```/.exec(reply)?.[1]?.trim();
  if (block) return block.replace(/^\s*(?:PS [^>]*>|PS>|\$)\s?/gm, '').trim();
  return reply.split(/\r?\n/).map((l) => l.trim().replace(/^`+|`+$/g, '')).find(Boolean) ?? null;
}

/** RV-13: strips code fences and quotes an agent may wrap the message in. Pure. */
export function cleanCommitMessage(reply: string): string {
  return reply
    .trim()
    .replace(/^```[a-z]*\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2')
    .trim();
}
