import { FilePlus2 } from 'lucide-react';
import { Button } from '@ade/ui';
import type { WorkflowSummary } from '@ade/contracts';
import { useEffect, useState } from 'react';
import { host } from '../../lib/bridge.ts';
import { attempt } from '../../lib/store.ts';
import { emptyDraft, fileNameFor, toDraft } from '../../lib/workflow-draft.ts';
import { Field, inputClass, Modal } from '../Modal.tsx';

/** WF-01: a new workflow in .ade/workflows/, empty (from scratch) or copied from a template. */
export function NewWorkflowDialog({
  open,
  onOpenChange,
  workspaceId,
  list,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  workspaceId: string;
  list: WorkflowSummary[];
  onCreated(summary: WorkflowSummary): void;
}) {
  const [name, setName] = useState('');
  const [from, setFrom] = useState('empty');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setFrom('empty');
    }
  }, [open]);

  const templates = list.filter((w) => w.source === 'template');
  const create = async () => {
    setBusy(true);
    let definition = emptyDraft(name);
    if (from !== 'empty') {
      const detail = await attempt(() => host.call('workflows.get', { workspaceId, workflowId: from }));
      const draft = detail ? toDraft(detail.definition) : null;
      if (draft) definition = { ...draft, name: name.trim() || draft.name };
    }
    const taken = new Set(list.map((w) => w.id));
    let file = fileNameFor(definition.name);
    for (let i = 2; taken.has(`repo:${file}`); i++) file = fileNameFor(`${definition.name} ${i}`);
    const res = await attempt(() => host.call('workflows.save', { workspaceId, file, definition }));
    setBusy(false);
    if (res) {
      onOpenChange(false);
      onCreated(res);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New workflow"
      description="Saved in .ade/workflows/ in this repository, so it is versioned with your code."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button busy={busy} variant="primary" disabled={busy} icon={<FilePlus2 className="size-4" aria-hidden="true" />} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create workflow'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" htmlFor="nw-name">
          <input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New workflow" className={inputClass} autoFocus />
        </Field>
        <Field label="Start from" htmlFor="nw-from" hint={from === 'empty' ? 'An empty canvas: add steps from the toolbar and connect them.' : 'A copy of the template that you can change.'}>
          <select id="nw-from" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass}>
            <option value="empty">Empty (from scratch)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                Template: {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
