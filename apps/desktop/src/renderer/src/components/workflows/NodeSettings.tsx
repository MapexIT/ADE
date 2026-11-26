import { FlaskConical, Play, Trash2 } from 'lucide-react';
import { Button, SectionLabel } from '@ade/ui';
import type { WorkflowNode } from '@ade/workflow-engine';
import { useEffect, useState, type ReactNode } from 'react';
import { inputClass } from '../Modal.tsx';
import { TYPE_LABELS } from './graph.tsx';

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
] as const;

const PROFILES = [
  { id: 'ask', label: 'Ask (approve every action)' },
  { id: 'auto-edit', label: 'Auto-edit (approve commands)' },
  { id: 'read-only', label: 'Read-only' },
  { id: 'autonomous', label: 'Autonomous (needs a sandbox)' },
] as const;

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold">
        {label}
      </label>
      {children}
      {hint ? <span className="text-[12px] text-ink-muted">{hint}</span> : null}
    </div>
  );
}

/**
 * WF-01: settings for the selected step. Edits apply on every change so validation stays live; the id is
 * applied on blur because renaming rewires edges.
 */
export function NodeSettings({
  node,
  readOnly,
  onChange,
  onDelete,
  onMakeStart,
  onTest,
  canStartHere,
  skillNames,
}: {
  node: WorkflowNode;
  readOnly: boolean;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
  onMakeStart: () => void;
  onTest: (() => void) | null;
  /** WF-18: the step sits on a cycle no start leads into, so listing it first makes the run enter there. */
  canStartHere: boolean;
  /** Repository and personal skills that can be attached (SK-01). */
  skillNames: string[];
}) {
  const [id, setId] = useState(node.id);
  useEffect(() => setId(node.id), [node.id]);
  const set = (patch: Partial<WorkflowNode>) => onChange({ ...node, ...patch } as WorkflowNode);
  const f = (name: string) => `node-${name}`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <SectionLabel>{TYPE_LABELS[node.type]} step</SectionLabel>
        <Field id={f('id')} label="Id" hint="Lower-case letters, digits and dashes.">
          <input
            id={f('id')}
            value={id}
            onChange={(e) => setId(e.target.value)}
            onBlur={() => id !== node.id && set({ id })}
            className={`${inputClass} font-mono`}
          />
        </Field>
        <Field id={f('title')} label="Title">
          <input
            id={f('title')}
            value={node.title ?? ''}
            onChange={(e) => set({ title: e.target.value || undefined })}
            className={inputClass}
            placeholder={node.id}
          />
        </Field>

        {node.type === 'agent' ? (
          <>
            <Field id={f('agent')} label="Agent">
              <select
                id={f('agent')}
                value={node.agent}
                onChange={(e) => set({ agent: e.target.value as typeof node.agent })}
                className={inputClass}
              >
                {AGENTS.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id={f('model')}
              label="Model"
              hint="Leave empty for the agent's default. The step fails if the agent does not offer it."
            >
              <input
                id={f('model')}
                value={node.model ?? ''}
                onChange={(e) => set({ model: e.target.value.trim() || undefined })}
                className={`${inputClass} font-mono`}
              />
            </Field>
            <Field id={f('profile')} label="Permissions">
              <select
                id={f('profile')}
                value={node.profile}
                onChange={(e) => set({ profile: e.target.value as typeof node.profile })}
                className={inputClass}
              >
                {PROFILES.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              id={f('prompt')}
              label="Prompt"
              hint="{{summary}}, {{diff}}, {{checkOutput}} and {{workItem.title}} are filled from the previous steps."
            >
              <textarea
                id={f('prompt')}
                rows={6}
                value={node.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                className={`${inputClass} py-2`}
              />
            </Field>
            <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
              <legend className="mb-1 font-semibold">Skills for this step</legend>
              {[...new Set([...skillNames, ...node.skills])].map((name) => (
                <label key={name} className="flex min-h-9 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={node.skills.includes(name)}
                    onChange={(e) =>
                      set({
                        skills: e.target.checked
                          ? [...node.skills, name]
                          : node.skills.filter((x) => x !== name),
                      })
                    }
                    className="size-4 accent-[var(--accent)]"
                  />
                  <span className="font-mono text-[12px]">{name}</span>
                  {!skillNames.includes(name) ? (
                    <span className="text-[12px] text-danger">not in the library</span>
                  ) : null}
                </label>
              ))}
              {skillNames.length === 0 && node.skills.length === 0 ? (
                <span className="text-[12px] text-ink-muted">
                  No skills yet. Build one on the Skills screen.
                </span>
              ) : (
                <span className="text-[12px] text-ink-muted">
                  Loaded into the agent's skills folder for this step only.
                </span>
              )}
            </fieldset>
          </>
        ) : null}

        {node.type === 'command' ? (
          <Field id={f('run')} label="Command" hint="One argument per line. Never run through a shell.">
            <textarea
              id={f('run')}
              rows={4}
              value={node.run.join('\n')}
              onChange={(e) => {
                const run = e.target.value
                  .split(/\r?\n/)
                  .filter((x, i, all) => x !== '' || i < all.length - 1);
                if (run.length) set({ run });
              }}
              className={`${inputClass} py-2 font-mono`}
            />
          </Field>
        ) : null}

        {node.type === 'gate' ? (
          <Field id={f('question')} label="Question">
            <input
              id={f('question')}
              value={node.question}
              onChange={(e) => set({ question: e.target.value })}
              className={inputClass}
            />
          </Field>
        ) : null}

        {node.type === 'loop' ? (
          <Field id={f('max')} label="Most attempts" hint="The run pauses and asks when the loop runs out.">
            <input
              id={f('max')}
              type="number"
              min={1}
              max={20}
              value={node.max}
              onChange={(e) => set({ max: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
              className={inputClass}
            />
          </Field>
        ) : null}

        {node.type === 'branch' ? (
          <Field id={f('condition')} label="Follow the pass edge when the previous step">
            <select
              id={f('condition')}
              value={node.condition}
              onChange={(e) => set({ condition: e.target.value as 'pass' | 'fail' })}
              className={inputClass}
            >
              <option value="pass">passed</option>
              <option value="fail">failed</option>
            </select>
          </Field>
        ) : null}

        {node.type === 'connector' ? (
          <>
            <Field id={f('connector')} label="Connector">
              <select
                id={f('connector')}
                value={node.connector}
                onChange={(e) => set({ connector: e.target.value as 'github' | 'shortcut' })}
                className={inputClass}
              >
                <option value="github">GitHub</option>
                <option value="shortcut">Shortcut</option>
              </select>
            </Field>
            <Field
              id={f('action')}
              label="Action"
              hint="Connector actions are not supported yet; the step fails with that message."
            >
              <input
                id={f('action')}
                value={node.action}
                onChange={(e) => set({ action: e.target.value })}
                className={inputClass}
              />
            </Field>
          </>
        ) : null}

        {node.type === 'land' ? (
          <Field id={f('mode')} label="How to land" hint="Land steps only run after a gate you approve.">
            <select
              id={f('mode')}
              value={node.mode}
              onChange={(e) => set({ mode: e.target.value as typeof node.mode })}
              className={inputClass}
            >
              <option value="apply">Apply to my checkout</option>
              <option value="commit">Commit on the session branch</option>
              <option value="pull-request">Commit for a pull request</option>
            </select>
          </Field>
        ) : null}
      </fieldset>

      <div className="flex flex-wrap gap-2 pt-1">
        {onTest ? (
          <Button icon={<FlaskConical className="size-4" aria-hidden="true" />} size="dense" onClick={onTest}>
            Test this step
          </Button>
        ) : null}
        {canStartHere && !readOnly ? (
          <Button icon={<Play className="size-4" aria-hidden="true" />} size="dense" variant="ghost" onClick={onMakeStart}>
            Start here
          </Button>
        ) : null}
        {!readOnly ? (
          <Button icon={<Trash2 className="size-4" aria-hidden="true" />} size="dense" variant="danger" onClick={onDelete}>
            Delete step
          </Button>
        ) : null}
      </div>
    </div>
  );
}
