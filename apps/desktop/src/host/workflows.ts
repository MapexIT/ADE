import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkflowSummary } from '@ade/contracts';
import { describeNode, TEMPLATES, validate, Workflow, WorkflowError } from '@ade/workflow-engine';
import { parse } from 'yaml';

export const detailOf = describeNode;

/** Parses and validates one workflow file into what the canvas shows (WF-01, WF-03). */
export function summarise(id: string, source: WorkflowSummary['source'], path: string | null, yamlText: string): WorkflowSummary {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    return { id, name: id, description: '', source, path, trigger: 'manual', agents: [], nodes: [], edges: [], problems: [{ level: 'error', message: `The YAML is invalid: ${(err as Error).message}`, nodeId: null }] };
  }
  const parsed = Workflow.safeParse(raw);
  if (!parsed.success) {
    const err = new WorkflowError(parsed.error.issues.map((i) => ({ level: 'error' as const, message: `${i.path.join('.')}: ${i.message}` })));
    return { id, name: (raw as { name?: string })?.name ?? id, description: '', source, path, trigger: 'manual', agents: [], nodes: [], edges: [], problems: err.problems.map((p) => ({ ...p, nodeId: null })) };
  }
  const wf = parsed.data;
  return {
    id,
    name: wf.name,
    description: wf.description,
    source,
    path,
    trigger: wf.trigger,
    agents: [...new Set(wf.nodes.flatMap((n) => (n.type === 'agent' ? [n.agent] : [])))],
    nodes: wf.nodes.map((n) => ({ id: n.id, type: n.type, title: n.title ?? n.id, detail: detailOf(n) })),
    edges: wf.edges.map((e) => ({ from: e.from, to: e.to, when: e.when ?? null })),
    problems: validate(wf).map((p) => ({ level: p.level, message: p.message, nodeId: p.nodeId ?? null })),
  };
}

/** Templates plus the repository's own `.ade/workflows/*.yaml`. */
export async function listWorkflows(repoRoot: string | null): Promise<WorkflowSummary[]> {
  const out: WorkflowSummary[] = [];
  if (repoRoot) {
    const dir = join(repoRoot, '.ade', 'workflows');
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /\.ya?ml$/i.test(f)).sort();
    for (const f of files) out.push(summarise(`repo:${f}`, 'repository', `.ade/workflows/${f}`, await readFile(join(dir, f), 'utf8')));
  }
  for (const [id, text] of Object.entries(TEMPLATES)) out.push(summarise(`template:${id}`, 'template', null, text));
  return out;
}

/** The YAML behind a workflow id from `listWorkflows` (`template:<id>` or `repo:<file>`). */
export async function loadWorkflowSource(repoRoot: string, id: string): Promise<string | null> {
  if (id.startsWith('template:')) return TEMPLATES[id.slice('template:'.length)] ?? null;
  if (id.startsWith('repo:')) {
    const file = id.slice('repo:'.length);
    if (basename(file) !== file || !/\.ya?ml$/i.test(file)) return null;
    return readFile(join(repoRoot, '.ade', 'workflows', file), 'utf8').catch(() => null);
  }
  return null;
}
