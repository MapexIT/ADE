import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Badge, SectionLabel } from '@ade/ui';

const NODES: Node[] = [
  { id: 'trigger', position: { x: 0, y: 80 }, data: { label: 'Trigger · work item' } },
  { id: 'plan', position: { x: 220, y: 80 }, data: { label: 'Agent · plan' } },
  { id: 'build', position: { x: 440, y: 80 }, data: { label: 'Agent · build' } },
  { id: 'check', position: { x: 660, y: 80 }, data: { label: 'Command · tests' } },
  { id: 'gate', position: { x: 880, y: 80 }, data: { label: 'Gate · your review' } },
  { id: 'land', position: { x: 1100, y: 80 }, data: { label: 'Land · pull request' } },
];
const EDGES: Edge[] = [
  { id: 'e1', source: 'trigger', target: 'plan' },
  { id: 'e2', source: 'plan', target: 'build' },
  { id: 'e3', source: 'build', target: 'check' },
  { id: 'e4', source: 'check', target: 'gate', label: 'pass' },
  { id: 'e5', source: 'check', target: 'build', label: 'fail', animated: true },
  { id: 'e6', source: 'gate', target: 'land' },
];

/**
 * Screen 4 preview. Agent workflows are a v1 feature (WF-01..WF-11); this shows the "Story to pull request"
 * template read-only so the shape is visible, without running anything.
 */
export function WorkflowsScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <h1 className="m-0 text-[16px] font-semibold">Workflows</h1>
        <Badge tone="attention">Arrives in v1</Badge>
        <span className="text-ink-muted">Workflows chain agent sessions with checks and gates. Every code change still ends at a gate before anything lands.</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 flex-col gap-2 border-r border-line bg-surface p-3">
          <SectionLabel>Templates</SectionLabel>
          {['Story to pull request', 'Plan, build, review', 'Fix failing tests', 'Cross-review', 'Spec first'].map((t, i) => (
            <div key={t} className={`rounded-[var(--radius)] border px-3 py-2 ${i === 0 ? 'border-accent bg-accent-tint' : 'border-line text-ink-muted'}`}>
              {t}
            </div>
          ))}
        </aside>
        <div className="min-h-0 flex-1 bg-surface-sunken" aria-label="Workflow canvas preview">
          <ReactFlow nodes={NODES} edges={EDGES} fitView nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} proOptions={{ hideAttribution: true }}>
            <Background color="#2A3441" gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}
