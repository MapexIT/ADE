import { Button } from '@ade/ui';
import type { AgentId, HandOffSample } from '@ade/contracts';
import { useState } from 'react';
import { type z } from 'zod';
import { inputClass, Modal } from '../Modal.tsx';
import { AgentOverrideFields, useAgentOverrides } from './AgentOverrides.tsx';

type Sample = z.input<typeof HandOffSample>;

export interface StartRequest {
  workItem: Record<string, string>;
  agentOverrides: Partial<Record<AgentId, AgentId>>;
  sample?: Sample;
}

/**
 * Starts a run (or tests one step). Asks for the work item the prompts refer to and, for every agent the
 * workflow names that is not ready, which installed agent should stand in (WF-09).
 */
export function StartRunDialog({
  open,
  onOpenChange,
  title,
  agentsUsed,
  withSample,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  agentsUsed: AgentId[];
  withSample: boolean;
  onStart: (req: StartRequest) => void;
}) {
  const [itemTitle, setItemTitle] = useState('');
  const [itemBody, setItemBody] = useState('');
  const [summary, setSummary] = useState('');
  const [checkOutput, setCheckOutput] = useState('');
  const stand = useAgentOverrides(agentsUsed, open);
  const { overrides, blocked } = stand;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Each agent step opens a normal session in its own worktree. Nothing lands until you approve a gate."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={blocked}
            onClick={() => {
              const workItem: Record<string, string> = {};
              if (itemTitle.trim()) workItem.title = itemTitle.trim();
              if (itemBody.trim()) workItem.description = itemBody.trim();
              onStart({
                workItem,
                agentOverrides: overrides,
                ...(withSample ? { sample: { summary, checkOutput } } : {}),
              });
              onOpenChange(false);
            }}
          >
            {withSample ? 'Test step' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="run-item-title" className="font-semibold">
            Work item title
          </label>
          <input
            id="run-item-title"
            value={itemTitle}
            onChange={(e) => setItemTitle(e.target.value)}
            className={inputClass}
            placeholder="Fills {{workItem.title}}"
            autoFocus
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="run-item-body" className="font-semibold">
            Work item description
          </label>
          <textarea
            id="run-item-body"
            rows={3}
            value={itemBody}
            onChange={(e) => setItemBody(e.target.value)}
            className={`${inputClass} py-2`}
            placeholder="Fills {{workItem.description}}"
          />
        </div>
        {withSample ? (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="run-sample-summary" className="font-semibold">
                Sample summary
              </label>
              <textarea
                id="run-sample-summary"
                rows={3}
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className={`${inputClass} py-2`}
                placeholder="Fills {{summary}}"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor="run-sample-check" className="font-semibold">
                Sample check output
              </label>
              <textarea
                id="run-sample-check"
                rows={3}
                value={checkOutput}
                onChange={(e) => setCheckOutput(e.target.value)}
                className={`${inputClass} py-2 font-mono`}
                placeholder="Fills {{checkOutput}}"
              />
            </div>
          </>
        ) : null}
        <AgentOverrideFields state={stand} />
      </div>
    </Modal>
  );
}
