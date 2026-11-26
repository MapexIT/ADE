import { Copy, FilePlus2, Play, Plus, Save, Undo2, Workflow } from 'lucide-react';
import { Background, Controls, ReactFlow, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, Button, cx, EmptyState, palette, SectionLabel } from '@ade/ui';
import type { AgentId, WorkflowRunView, WorkflowSummary } from '@ade/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { elapsed } from '../../lib/format.ts';
import { attempt, useStore } from '../../lib/store.ts';
import {
  addNode,
  connect,
  edgeInfo,
  fileNameFor,
  canStartHere,
  makeStart,
  NODE_TYPES,
  problemsOf,
  removeEdge,
  removeNode,
  setEdge,
  toDraft,
  updateNode,
  type Draft,
} from '../../lib/workflow-draft.ts';
import { describeNode as detailOf } from '@ade/workflow-engine';
import { buildGraph, EDGE_TYPES, NODE_KINDS, STEP_ICONS, useCanvasState } from './graph.tsx';
import { NodeSettings } from './NodeSettings.tsx';
import { EdgeSettings } from './EdgeSettings.tsx';
import { NewWorkflowDialog } from './NewWorkflowDialog.tsx';
import { RUN_STATUS, RunView } from './RunView.tsx';
import { StartRunDialog, type StartRequest } from './StartRunDialog.tsx';

/** React Flow 13 reads a bare number as pixels, so the margin round a fitted graph is a percentage. */
const FIT_PADDING = '10%';

type View = { kind: 'workflow'; id: string } | { kind: 'run'; id: string } | null;

/** Screen 4: design workflows on a canvas, run them, and watch each run (WF-01, WF-06, WF-11). */
export function WorkflowsScreen() {
  const workspaceId = useStore((s) => s.workspaceId);
  const focusRunId = useStore((s) => s.focusRunId);
  const setStore = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<Record<string, WorkflowRunView>>({});
  const [view, setView] = useState<View>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const flow = useRef<ReactFlowInstance | null>(null);
  const { positions, sizes, onNodesChange, reset: resetPositions } = useCanvasState();
  const [dialog, setDialog] = useState<'run' | 'test' | null>(null);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  useEffect(() => {
    void attempt(() => host.call('skills.list', { workspaceId })).then((l) =>
      setSkillNames([...new Set((l ?? []).filter((x) => x.location !== 'installed').map((x) => x.name))]),
    );
  }, [workspaceId]);

  const reloadList = useCallback(async () => {
    const l = (await attempt(() => host.call('workflows.list', { workspaceId }))) ?? [];
    setList(l);
    return l;
  }, [workspaceId]);

  useEffect(() => {
    void reloadList().then((l) => setView((v) => v ?? (l[0] ? { kind: 'workflow', id: l[0].id } : null)));
    if (!workspaceId) return;
    void attempt(() => host.call('workflows.runs', { workspaceId })).then((r) =>
      setRuns(Object.fromEntries((r ?? []).map((x) => [x.id, x]))),
    );
    return host.on('workflow.run', (r) => {
      if (r.workspaceId === workspaceId) setRuns((all) => ({ ...all, [r.id]: r }));
    });
  }, [workspaceId, reloadList]);

  useEffect(() => {
    if (!focusRunId) return;
    setView({ kind: 'run', id: focusRunId });
    setStore({ focusRunId: null });
    if (workspaceId)
      void attempt(() => host.call('workflows.runs', { workspaceId })).then((r) =>
        setRuns(Object.fromEntries((r ?? []).map((x) => [x.id, x]))),
      );
  }, [focusRunId, setStore, workspaceId]);

  const summary = view?.kind === 'workflow' ? (list.find((w) => w.id === view.id) ?? null) : null;
  const readOnly = summary?.source !== 'repository';

  // Load the selected workflow's definition into an editable draft.
  useEffect(() => {
    setSelectedNode(null);
    setSelectedEdge(null);
    resetPositions();
    if (view?.kind !== 'workflow' || !workspaceId) return setDraft(null);
    void attempt(() => host.call('workflows.get', { workspaceId, workflowId: view.id })).then((d) => {
      const next = d ? toDraft(d.definition) : null;
      setDraft(next);
      setSaved(next);
    });
  }, [view, workspaceId, resetPositions]);

  const problems = useMemo(
    () =>
      draft
        ? problemsOf(draft)
        : (summary?.problems ?? []).map((p) => ({ ...p, nodeId: p.nodeId ?? undefined })),
    [draft, summary],
  );
  const errors = problems.filter((p) => p.level === 'error');
  const dirty = draft !== saved;
  const graph = useMemo(() => {
    if (!draft) return { nodes: [], edges: [] };
    const problemNodes = new Set(errors.flatMap((p) => (p.nodeId ? [p.nodeId] : [])));
    return buildGraph(
      draft.nodes.map((n) => ({ id: n.id, type: n.type, title: n.title ?? n.id, detail: detailOf(n) })),
      draft.edges.map((e, i) => {
        const info = edgeInfo(draft, i);
        return { ...e, cycle: info.cycle, maxRounds: info.cycle ? info.maxRounds : null };
      }),
      { problemNodes, selected: selectedNode, selectedEdge, positions, sizes },
    );
  }, [draft, errors, selectedNode, selectedEdge, positions, sizes]);

  const edit = (next: Draft) => setDraft(next);
  // Keep every step in view when steps or connections change: both move the layout (and a canvas started empty
  // first fits a single step).
  const stepCount = draft?.nodes.length ?? 0;
  const edgeCount = draft?.edges.length ?? 0;
  useEffect(() => {
    if (!stepCount) return;
    const t = setTimeout(() => void flow.current?.fitView({ maxZoom: 1.1, padding: FIT_PADDING, duration: 150 }), 30);
    return () => clearTimeout(t);
  }, [stepCount, edgeCount]);
  const node = draft?.nodes.find((n) => n.id === selectedNode) ?? null;
  const agentsUsed = useMemo<AgentId[]>(() => {
    const nodes = dialog === 'test' && node ? [node] : (draft?.nodes ?? []);
    return [...new Set(nodes.flatMap((n) => (n.type === 'agent' ? [n.agent] : [])))];
  }, [draft, dialog, node]);

  const save = async (file: string) => {
    if (!draft || !workspaceId) return;
    const res = await attempt(() => host.call('workflows.save', { workspaceId, file, definition: draft }));
    if (!res) return;
    await reloadList();
    setSaved(draft);
    setView({ kind: 'workflow', id: res.id });
    toast(`Saved .ade/workflows/${file}`, 'info');
  };

  const copyToRepository = () => {
    if (!draft) return;
    const taken = new Set(list.map((w) => w.id));
    let file = fileNameFor(draft.name);
    for (let i = 2; taken.has(`repo:${file}`); i++) file = fileNameFor(`${draft.name} ${i}`);
    void save(file);
  };

  const start = async (req: StartRequest) => {
    if (!workspaceId || !summary) return;
    const run =
      dialog === 'test' && node
        ? await attempt(() =>
            host.call('workflows.testNode', {
              workspaceId,
              node,
              sample: req.sample ?? {},
              workItem: req.workItem,
              agentOverrides: req.agentOverrides,
            }),
          )
        : await attempt(() =>
            host.call('workflows.start', {
              workspaceId,
              workflowId: summary.id,
              workItem: req.workItem,
              agentOverrides: req.agentOverrides,
            }),
          );
    if (!run) return;
    setRuns((all) => ({ ...all, [run.id]: run }));
    setView({ kind: 'run', id: run.id });
  };

  if (!workspaceId)
    return (
      <EmptyState
        icon={<Workflow className="size-5" />}
        title="Open a repository first"
        body="Workflows live in .ade/workflows/ inside a repository."
      />
    );

  const run = view?.kind === 'run' ? runs[view.id] : null;
  const runList = Object.values(runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fileOf = summary?.path ? summary.path.split(/[\\/]/).pop()! : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="m-0 text-[16px] font-semibold">
          {run ? run.workflowName : (draft?.name ?? summary?.name ?? 'Workflows')}
        </h1>
        {summary ? <Badge>{summary.source === 'template' ? 'Template' : summary.path}</Badge> : null}
        {summary ? (
          <Badge tone={errors.length ? 'danger' : 'ok'}>
            {errors.length ? `${errors.length} problem(s)` : 'Valid'}
          </Badge>
        ) : null}
        {dirty ? <Badge tone="attention">Unsaved changes</Badge> : null}
        <span className="flex-1" />
        {summary && readOnly ? (
          <Button
            icon={<Copy className="size-4" aria-hidden="true" />}
            size="dense"
            onClick={copyToRepository}
          >
            Copy to repository to edit
          </Button>
        ) : null}
        {summary && !readOnly ? (
          <>
            <Button
              icon={<Undo2 className="size-4" aria-hidden="true" />}
              size="dense"
              variant="ghost"
              disabled={!dirty}
              onClick={() => setDraft(saved)}
            >
              Discard changes
            </Button>
            <Button
              icon={<Save className="size-4" aria-hidden="true" />}
              size="dense"
              disabled={!dirty || !fileOf}
              onClick={() => fileOf && void save(fileOf)}
            >
              Save
            </Button>
          </>
        ) : null}
        {summary ? (
          <Button
            icon={<Play className="size-4" aria-hidden="true" />}
            size="dense"
            variant="primary"
            disabled={errors.length > 0 || dirty}
            title={dirty ? 'Save before running' : undefined}
            onClick={() => setDialog('run')}
          >
            Run workflow
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Workflows"
          className="flex w-64 flex-col gap-3 overflow-auto border-r border-line bg-surface p-3"
        >
          <Button
            variant="primary"
            icon={<FilePlus2 className="size-4" aria-hidden="true" />}
            onClick={() => setCreating(true)}
          >
            New workflow
          </Button>
          {(['repository', 'template'] as const).map((source) => {
            const items = list.filter((w) => w.source === source);
            return (
              <section key={source} className="flex flex-col gap-2">
                <SectionLabel>{source === 'repository' ? 'In this repository' : 'Templates'}</SectionLabel>
                {items.length === 0 && source === 'repository' ? (
                  <p className="m-0 text-[12px] text-ink-muted">
                    Start a new workflow, empty or from a template. Files go in .ade/workflows/.
                  </p>
                ) : null}
                {items.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setView({ kind: 'workflow', id: w.id })}
                    aria-current={view?.kind === 'workflow' && w.id === view.id ? 'true' : undefined}
                    className={cx(
                      'rounded-[var(--radius)] border px-3 py-2 text-left',
                      view?.kind === 'workflow' && w.id === view.id
                        ? 'border-accent bg-accent-tint'
                        : 'border-line hover:bg-surface-raised',
                    )}
                  >
                    <span className="block font-semibold">{w.name}</span>
                    {w.problems.some((p) => p.level === 'error') ? (
                      <span className="text-[12px] text-danger">Has problems</span>
                    ) : (
                      <span className="text-[12px] text-ink-muted">{w.nodes.length} steps</span>
                    )}
                  </button>
                ))}
              </section>
            );
          })}
          <section className="flex flex-col gap-2" aria-label="Runs">
            <SectionLabel>Runs</SectionLabel>
            {runList.length === 0 ? <p className="m-0 text-[12px] text-ink-muted">No runs yet.</p> : null}
            {runList.slice(0, 30).map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setView({ kind: 'run', id: r.id })}
                aria-current={view?.kind === 'run' && r.id === view.id ? 'true' : undefined}
                className={cx(
                  'flex flex-col gap-1 rounded-[var(--radius)] border px-3 py-2 text-left',
                  view?.kind === 'run' && r.id === view.id
                    ? 'border-accent bg-accent-tint'
                    : 'border-line hover:bg-surface-raised',
                )}
              >
                <span className="font-semibold">{r.workflowName}</span>
                <span className="flex items-center gap-2">
                  <Badge tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Badge>
                  <span className="text-[12px] text-ink-muted">{elapsed(r.createdAt)} ago</span>
                </span>
              </button>
            ))}
          </section>
        </aside>

        {run ? (
          <RunView run={run} />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col bg-surface-sunken">
              {draft && !readOnly ? (
                <div
                  role="toolbar"
                  aria-label="Add a step"
                  className="flex flex-wrap items-center gap-1 border-b border-line bg-surface px-3 py-2"
                >
                  <span className="mr-1 text-[12px] text-ink-muted">Add a step:</span>
                  {NODE_TYPES.map((t) => {
                    const Icon = STEP_ICONS[t.type]!;
                    return (
                      <Button
                        key={t.type}
                        size="dense"
                        variant="ghost"
                        icon={<Icon className="size-4" aria-hidden="true" />}
                        onClick={() => {
                          const res = addNode(draft, t.type);
                          edit(res.wf);
                          setSelectedNode(res.id);
                        }}
                      >
                        {t.label}
                      </Button>
                    );
                  })}
                  <span className="ml-auto text-[12px] text-ink-muted">
                    Drag between steps to connect; a step can have several inputs and next steps. Click a
                    connection for its settings.
                  </span>
                </div>
              ) : null}
              <div className="min-h-0 flex-1" aria-label="Workflow canvas">
                {draft && !draft.nodes.length && !readOnly ? (
                  <EmptyState
                    icon={<Plus className="size-5" />}
                    title="An empty workflow"
                    body="Add a first step from the toolbar above. A run starts at every step nothing leads into; drag from one step to another to connect them."
                  />
                ) : draft && draft.nodes.length ? (
                  <ReactFlow
                    key={view?.kind === 'workflow' ? view.id : 'none'}
                    nodes={graph.nodes}
                    edges={graph.edges}
                    fitView
                    fitViewOptions={{ maxZoom: 1.1, padding: FIT_PADDING }}
                    edgeTypes={EDGE_TYPES}
                    nodeTypes={NODE_KINDS}
                    onInit={(instance) => (flow.current = instance)}
                    nodesConnectable={!readOnly}
                    nodesDraggable
                    onNodesChange={onNodesChange}
                    onNodeClick={(_, n) => (setSelectedNode(n.id), setSelectedEdge(null))}
                    onPaneClick={() => (setSelectedNode(null), setSelectedEdge(null))}
                    onConnect={(c) => c.source && c.target && edit(connect(draft, c.source, c.target))}
                    onEdgeClick={(_, e) => (setSelectedEdge(Number(e.id.slice(1))), setSelectedNode(null))}
                    onEdgesDelete={(es) => {
                      if (readOnly) return;
                      setSelectedEdge(null);
                      edit(
                        es
                          .map((e) => Number(e.id.slice(1)))
                          .sort((a, b) => b - a)
                          .reduce((wf, i) => removeEdge(wf, i), draft),
                      );
                    }}
                    onNodesDelete={(ns) =>
                      !readOnly && edit(ns.reduce((wf, n) => removeNode(wf, n.id), draft))
                    }
                    deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
                    proOptions={{ hideAttribution: true }}
                  >
                    <Background color={palette.lineStrong} gap={22} size={1.2} />
                    <Controls showInteractive={false} />
                  </ReactFlow>
                ) : (
                  <EmptyState
                    icon={<Workflow className="size-5" />}
                    title="Nothing to draw"
                    body={errors[0]?.message ?? 'Pick a workflow on the left.'}
                  />
                )}
              </div>
            </div>
            <aside
              aria-label="Step settings"
              className="flex w-96 flex-col gap-4 overflow-auto border-l border-line bg-surface p-4"
            >
              {selectedEdge !== null && draft?.edges[selectedEdge] ? (
                <EdgeSettings
                  key={selectedEdge}
                  draft={draft}
                  index={selectedEdge}
                  readOnly={readOnly}
                  onChange={(patch) => edit(setEdge(draft, selectedEdge, patch))}
                  onDelete={() => {
                    edit(removeEdge(draft, selectedEdge));
                    setSelectedEdge(null);
                  }}
                />
              ) : node && draft ? (
                <NodeSettings
                  key={node.id}
                  node={node}
                  readOnly={readOnly}
                  canStartHere={canStartHere(draft, node.id)}
                  skillNames={skillNames}
                  onChange={(next) => {
                    edit(updateNode(draft, node.id, next));
                    if (next.id !== node.id) setSelectedNode(next.id);
                  }}
                  onDelete={() => {
                    edit(removeNode(draft, node.id));
                    setSelectedNode(null);
                  }}
                  onMakeStart={() => edit(makeStart(draft, node.id))}
                  onTest={
                    node.type === 'agent' || node.type === 'command' || node.type === 'connector'
                      ? () => setDialog('test')
                      : null
                  }
                />
              ) : (
                <p className="m-0 text-ink-muted">
                  {summary?.description ||
                    'Workflows chain agent sessions with checks and gates. A gate always comes before anything lands.'}{' '}
                  Select a step or a connection to see its settings.
                </p>
              )}
              {problems.length ? (
                <section aria-label="Problems" className="flex flex-col gap-2">
                  <SectionLabel>Problems</SectionLabel>
                  {problems.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => p.nodeId && setSelectedNode(p.nodeId)}
                      className={cx(
                        'rounded-[var(--radius)] border px-3 py-2 text-left',
                        p.level === 'error'
                          ? 'border-danger-line bg-danger-tint text-danger'
                          : 'border-attention-line text-attention',
                      )}
                    >
                      {p.level === 'error' ? 'Error: ' : 'Warning: '}
                      {p.message}
                    </button>
                  ))}
                </section>
              ) : null}
            </aside>
          </>
        )}
      </div>
      <NewWorkflowDialog
        open={creating}
        onOpenChange={setCreating}
        workspaceId={workspaceId}
        list={list}
        onCreated={(created) => {
          void reloadList().then(() => setView({ kind: 'workflow', id: created.id }));
          toast(`Created ${created.path ?? created.name}`, 'info');
        }}
      />
      <StartRunDialog
        open={dialog !== null}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog === 'test'
            ? `Test the step ${node?.title ?? node?.id ?? ''}`
            : `Run ${draft?.name ?? summary?.name ?? 'workflow'}`
        }
        agentsUsed={agentsUsed}
        withSample={dialog === 'test'}
        onStart={(req) => void start(req)}
      />
    </div>
  );
}
