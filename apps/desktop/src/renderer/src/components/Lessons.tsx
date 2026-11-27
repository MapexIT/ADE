import { BookMarked, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, cx, SectionLabel, Waiting } from '@ade/ui';
import type { AgentId, Lesson, LessonFiles, LessonOccasion, LessonRehearsal, LessonRoute, LessonSuggestion } from '@ade/contracts';
import {
  formatRuleDate,
  lessonHintText,
  lessonRehearsalText,
  lessonsChipText,
  lessonUnused,
  ORIGIN_WORDS,
  ROUTE_HINTS,
  ROUTE_WORDS,
  timesWord,
} from '@ade/session-core';
import { useEffect, useId, useRef, useState } from 'react';
import { host } from '../lib/bridge.ts';
import { agentLabel } from '../lib/format.ts';
import { attempt, useStore } from '../lib/store.ts';
import { Field, inputClass, Modal } from './Modal.tsx';

const label = (id: string) => agentLabel(id as AgentId) ?? id;
const ROUTES: LessonRoute[] = ['first-prompt', 'instruction-files'];

function lessonsChanged(workspaceId: string) {
  const s = useStore.getState();
  s.set({ lessonsVersion: s.lessonsVersion + 1 });
  s.refreshLessonAdvice(workspaceId);
}

async function dismissLesson(workspaceId: string, key: string, forever: boolean) {
  const done = await attempt(() => host.call('lessons.dismiss', { workspaceId, key, forever }));
  if (done) useStore.getState().refreshLessonAdvice(workspaceId);
  return !!done;
}

/** "AGENTS.md updated as an uncommitted change. Codex and OpenCode read it." */
function filesText(r: LessonFiles): string {
  const names = r.readers.map(label);
  const readers = names.length ? `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}` : names[0]!} ${names.length > 1 ? 'read' : 'reads'} AGENTS.md.` : 'No agent reads AGENTS.md here.';
  const what = r.changed.length ? `Updated ${r.changed.join(' and ')} as an uncommitted change.` : 'The instruction files were already up to date.';
  return `${what} ${readers} New sessions see it once you commit it.`;
}

async function writeFiles(workspaceId: string, alsoClaude = false) {
  return attempt(() => host.call('lessons.writeFiles', { workspaceId, alsoClaude }));
}

/** ED-05: the line under the user's newest correction in a session. Never on a pending card, never in the attention tint. */
export function LessonHintFor({ sessionId, itemKey }: { sessionId: string; itemKey: string }) {
  const workspaceId = useStore((s) => s.sessions[sessionId]?.workspaceId ?? null);
  const suggestion = useStore((s) => (workspaceId ? (s.lessonAdvice[workspaceId]?.suggestions.find((x) => x.anchors.some((a) => a.sessionId === sessionId && a.itemKey === itemKey)) ?? null) : null));
  const [busy, setBusy] = useState(false);
  if (!workspaceId || !suggestion) return null;
  return (
    <div role="note" aria-label="Lesson suggestion" className="flex w-full flex-wrap items-center gap-2 border-t border-line pt-2 text-[12px] text-ink-muted">
      <BookMarked className="size-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-semibold text-ink">Lesson suggested.</span> {lessonHintText(suggestion, label)}
      </span>
      <span className="ml-auto flex gap-2">
        <Button size="dense" icon={<BookMarked className="size-4" aria-hidden="true" />} onClick={() => useStore.getState().set({ lessonDialog: { workspaceId, suggestion, lesson: null } })}>
          Review lesson
        </Button>
        <Button
          size="dense"
          variant="ghost"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            await dismissLesson(workspaceId, suggestion.key, false);
            setBusy(false);
          }}
        >
          Not now
        </Button>
      </span>
    </div>
  );
}

/** The watch pattern's rehearsal over past commands, 250 ms after the last change. */
function useLessonRehearsal(workspaceId: string, pattern: string) {
  const [cache, setCache] = useState<Record<string, LessonRehearsal>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const key = pattern.trim();
  useEffect(() => {
    if (!key || key in cacheRef.current) return;
    let live = true;
    const timer = setTimeout(() => {
      void host.call('lessons.rehearse', { workspaceId, pattern: key }).then(
        (r) => live && setCache((c) => ({ ...c, [key]: r })),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, key]);
  return key ? (cache[key] ?? null) : null;
}

function Occasions({ occasions, onOpen }: { occasions: readonly LessonOccasion[]; onOpen: (sessionId: string) => void }) {
  const known = useStore((s) => s.sessions);
  return (
    <section aria-label="When you said it" className="flex flex-col gap-1.5">
      <SectionLabel>When you said it</SectionLabel>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {occasions.map((o, i) => (
          <li key={`${o.sessionId}-${o.ts}-${i}`} className="flex flex-col gap-0.5 rounded-[var(--radius)] border border-line px-2.5 py-2 text-[12px]">
            <span className="flex flex-wrap items-center gap-x-2 text-ink-muted">
              {known[o.sessionId] ? (
                <button type="button" className="cursor-pointer rounded-[var(--radius-small)] font-semibold text-accent-soft underline-offset-2 hover:underline focus-visible:shadow-[0_0_0_3px_var(--accent-glow)] focus-visible:outline-none" onClick={() => onOpen(o.sessionId)}>
                  {o.sessionTitle || 'Untitled session'}
                </button>
              ) : (
                <span className="font-semibold text-ink">{o.sessionTitle || 'A deleted session'}</span>
              )}
              <span>· {label(o.agentId)}</span>
              <span>· {formatRuleDate(o.ts)}</span>
              <span>· {ORIGIN_WORDS[o.origin]}</span>
            </span>
            <span className="text-ink">“{o.text}”</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** ED-05: Review lesson, Add lesson and Edit lesson. Nothing becomes a lesson without Add lesson here. */
export function LessonDialog() {
  const open = useStore((s) => s.lessonDialog);
  const set = useStore((s) => s.set);
  const close = () => set({ lessonDialog: null });
  const title = open?.suggestion ? 'Review lesson' : open?.lesson ? 'Edit lesson' : 'Add lesson';
  return (
    <Modal open={!!open} onOpenChange={(o) => !o && close()} title={title} description="A lesson is a standing instruction in your own words that every agent gets. ADE never rewrites it.">
      {open ? <LessonBody key={open.suggestion?.key ?? open.lesson?.id ?? 'new'} workspaceId={open.workspaceId} suggestion={open.suggestion} lesson={open.lesson} onClose={close} /> : null}
    </Modal>
  );
}

function LessonBody({ workspaceId, suggestion, lesson, onClose }: { workspaceId: string; suggestion: LessonSuggestion | null; lesson: Lesson | null; onClose: () => void }) {
  const [text, setText] = useState(lesson?.text ?? suggestion?.text ?? '');
  const [route, setRoute] = useState<LessonRoute>(lesson?.route ?? 'first-prompt');
  const [pattern, setPattern] = useState(lesson?.pattern ?? '');
  const [busy, setBusy] = useState<'add' | 'never' | 'later' | null>(null);
  const id = useId();
  const rehearsal = useLessonRehearsal(workspaceId, pattern);
  const occasions = suggestion?.occasions ?? lesson?.occasions ?? [];
  const openSession = (sessionId: string) => {
    const s = useStore.getState();
    s.selectSession(sessionId);
    s.set({ tab: 'sessions', lessonDialog: null, settingsOpen: false });
  };

  const add = async () => {
    setBusy('add');
    const draft = { text: text.trim(), route, pattern: pattern.trim() || null };
    let ok = false;
    if (lesson) {
      const list = await attempt(() => host.call('lessons.list', { workspaceId }));
      if (list) ok = !!(await attempt(() => host.call('lessons.save', { workspaceId, lessons: list.map((l) => (l.id === lesson.id ? { ...l, ...draft } : l)) })));
    } else {
      ok = !!(await attempt(() => host.call('lessons.adopt', { workspaceId, key: suggestion?.key ?? 'manual', lesson: draft })));
    }
    setBusy(null);
    if (!ok) return;
    const toast = useStore.getState().toast;
    if (route === 'instruction-files' || lesson?.route === 'instruction-files') {
      const res = await writeFiles(workspaceId);
      if (res) toast(`${lesson ? 'Lesson saved.' : 'Lesson added.'} ${filesText(res)}${res.claudeSeparate ? ' Claude Code reads CLAUDE.md: add the block there from Settings, Lessons.' : ''}`);
    } else toast(lesson ? 'Lesson saved.' : 'Lesson added. New sessions in this repository get it with their first prompt.');
    lessonsChanged(workspaceId);
    onClose();
  };

  return (
    <div className="flex flex-col gap-4">
      {suggestion ? <p className="m-0 text-[12px] text-ink-muted">{lessonHintText(suggestion, label)} Keep it as it is, or put it the way you want every agent to hear it.</p> : null}
      <Field label="Lesson" htmlFor={`${id}-text`} hint="In your own words. Agents get exactly this sentence.">
        <input id={`${id}-text`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className={inputClass} />
      </Field>
      {occasions.length ? <Occasions occasions={occasions} onOpen={openSession} /> : null}
      <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[12px] font-semibold text-ink-muted">How agents get it</legend>
        {ROUTES.map((r) => (
          <label key={r} className="flex min-h-11 items-start gap-2">
            <input type="radio" name={`${id}-route`} checked={route === r} onChange={() => setRoute(r)} className="mt-1 size-4 accent-[var(--accent)]" />
            <span>
              {ROUTE_WORDS[r]}
              <span className="block text-[12px] text-ink-muted">{ROUTE_HINTS[r]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-pattern`} className="text-[12px] font-semibold text-ink-muted">
          Watch for a command (optional)
        </label>
        <input id={`${id}-pattern`} value={pattern} maxLength={500} placeholder="npm *" onChange={(e) => setPattern(e.target.value)} className={cx(inputClass, 'font-mono')} />
        <span className="text-[12px] text-ink-muted">Uses the workspace rule syntax; * matches anything. When an agent runs a matching command, the timeline says the lesson was not followed. Nothing is blocked.</span>
        <div aria-live="polite" className="text-[12px]">
          {pattern.trim() ? (
            rehearsal ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-ink">{lessonRehearsalText(rehearsal)}</span>
                {rehearsal.examples.length ? (
                  <span className="flex flex-wrap gap-x-3 text-ink-muted">
                    {rehearsal.examples.map((x) => (
                      <code key={x.text} className="font-mono text-ink">
                        {x.text}
                        {x.count > 1 ? <span className="font-sans text-ink-muted"> ({timesWord(x.count)})</span> : null}
                      </code>
                    ))}
                  </span>
                ) : null}
              </div>
            ) : (
              <Waiting>Rehearsing against past commands</Waiting>
            )
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {suggestion ? (
          <>
            <Button
              variant="ghost"
              busy={busy === 'never'}
              onClick={async () => {
                setBusy('never');
                if (await dismissLesson(workspaceId, suggestion.key, true)) onClose();
                setBusy(null);
              }}
            >
              Never suggest this
            </Button>
            <Button
              variant="ghost"
              busy={busy === 'later'}
              onClick={async () => {
                setBusy('later');
                if (await dismissLesson(workspaceId, suggestion.key, false)) onClose();
                setBusy(null);
              }}
            >
              Not now
            </Button>
          </>
        ) : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={lesson ? undefined : <Plus className="size-4" aria-hidden="true" />} busy={busy === 'add'} disabled={!text.trim()} onClick={() => void add()}>
          {lesson ? 'Save lesson' : 'Add lesson'}
        </Button>
      </div>
    </div>
  );
}

function metaText(l: Lesson): string {
  const parts: string[] = [ROUTE_WORDS[l.route]];
  if (l.occasions.length) parts.push(`said ${timesWord(l.occasions.length)}`);
  if (l.route === 'first-prompt') parts.push(l.lastSentAt ? `sent ${timesWord(l.sent)}, last on ${formatRuleDate(l.lastSentAt)}` : 'not sent yet');
  if (l.pattern) parts.push(l.notFollowed ? `not followed ${timesWord(l.notFollowed)}` : 'always followed so far');
  return parts.join(' · ');
}

/** ED-05: lessons in Settings, beside the workspace rules. */
export function LessonsSettings({ workspaceId }: { workspaceId: string }) {
  const version = useStore((s) => s.lessonsVersion);
  const advice = useStore((s) => s.lessonAdvice[workspaceId]);
  const set = useStore((s) => s.set);
  const ask = useStore((s) => s.ask);
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [files, setFiles] = useState<LessonFiles | null>(null);
  const [writing, setWriting] = useState(false);

  useEffect(() => {
    void attempt(() => host.call('lessons.list', { workspaceId })).then((l) => setLessons(l ?? []));
    useStore.getState().refreshLessonAdvice(workspaceId);
  }, [workspaceId, version]);

  const save = async (next: Lesson[]) => {
    if (await attempt(() => host.call('lessons.save', { workspaceId, lessons: next }))) {
      setLessons(next);
      lessonsChanged(workspaceId);
      return true;
    }
    return false;
  };
  const shared = (lessons ?? []).some((l) => l.route === 'instruction-files');
  const update = async (alsoClaude: boolean) => {
    setWriting(true);
    const res = await writeFiles(workspaceId, alsoClaude);
    setWriting(false);
    if (res) setFiles(res);
  };
  const now = Date.now();

  return (
    <section className="flex flex-col gap-2" aria-label="Lessons">
      <SectionLabel>Lessons</SectionLabel>
      <p className="m-0 text-[12px] text-ink-muted">
        Standing instructions in your own words, for every agent. ADE suggests one when you correct agents the same way in two sessions or to two agents, and never adds one without you.
      </p>
      {advice?.suggestions.length ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-line p-3" role="group" aria-label="Suggested lessons">
          <SectionLabel>Suggested lessons</SectionLabel>
          {advice.suggestions.map((s) => (
            <div key={s.key} className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="min-w-0 flex-1">
                <span className="text-ink">“{s.text}”</span> <span className="text-ink-muted">{lessonHintText(s, label)}</span>
              </span>
              <Button size="dense" icon={<BookMarked className="size-4" aria-hidden="true" />} onClick={() => set({ lessonDialog: { workspaceId, suggestion: s, lesson: null } })}>
                Review lesson
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {lessons === null ? <Waiting>Loading lessons</Waiting> : lessons.length === 0 ? <span className="text-ink-muted">No lessons yet.</span> : null}
      {(lessons ?? []).map((l, i) => (
        <div key={l.id} role="group" aria-label={`Lesson ${i + 1}`} className={cx('flex flex-wrap items-start gap-2 rounded-[var(--radius)] border border-line px-3 py-2', !l.enabled && 'opacity-70')}>
          <input
            id={`lesson-on-${l.id}`}
            type="checkbox"
            checked={l.enabled}
            onChange={(e) => void save(lessons!.map((x) => (x.id === l.id ? { ...x, enabled: e.target.checked } : x)))}
            className="mt-1 size-5 accent-[var(--accent)]"
          />
          <label htmlFor={`lesson-on-${l.id}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="break-words text-ink">{l.text}</span>
            <span className="text-[12px] text-ink-muted">
              {metaText(l)}
              {l.pattern ? (
                <>
                  {' · watching '}
                  <code className="font-mono text-ink">{l.pattern}</code>
                </>
              ) : null}
            </span>
            {lessonUnused(l, now) ? <span className="text-[12px] font-semibold text-ink">Not sent in 30 days.</span> : null}
          </label>
          {l.notFollowed ? <Badge tone="attention">Not followed {timesWord(l.notFollowed)}</Badge> : null}
          <span className="flex gap-1">
            <Button size="dense" variant="ghost" icon={<Pencil className="size-4" aria-hidden="true" />} aria-label={`Edit lesson ${i + 1}`} onClick={() => set({ lessonDialog: { workspaceId, suggestion: null, lesson: l } })}>
              Edit
            </Button>
            <Button
              size="dense"
              variant="ghost"
              icon={<Trash2 className="size-4" aria-hidden="true" />}
              aria-label={`Remove lesson ${i + 1}`}
              onClick={() =>
                ask({
                  title: 'Remove this lesson?',
                  body: `“${l.text}” will no longer be sent to agents.${l.route === 'instruction-files' ? ' Update AGENTS.md afterwards to take it out of the file.' : ''}`,
                  confirmLabel: 'Remove lesson',
                  danger: true,
                  onConfirm: async () => void (await save(lessons!.filter((x) => x.id !== l.id))),
                })
              }
            >
              Remove
            </Button>
          </span>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="dense" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => set({ lessonDialog: { workspaceId, suggestion: null, lesson: null } })}>
          Add lesson
        </Button>
        {shared || files ? (
          <Button size="dense" icon={<FileText className="size-4" aria-hidden="true" />} busy={writing} onClick={() => void update(false)}>
            Update AGENTS.md
          </Button>
        ) : null}
      </div>
      {files ? (
        <div aria-live="polite" className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
          <span>{filesText(files)}</span>
          {files.claudeSeparate ? (
            <Button size="dense" onClick={() => void update(true)}>
              Add the same block to CLAUDE.md
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** ED-05: in New session, the lessons sent with the first prompt, each switchable off for this session only. */
export function useSessionLessons(workspaceId: string | null, open: boolean) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [off, setOff] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !workspaceId) return;
    setOff([]);
    void host.call('lessons.list', { workspaceId }).then(
      (l) => setLessons(l.filter((x) => x.enabled && x.route === 'first-prompt')),
      () => setLessons([]),
    );
  }, [open, workspaceId]);
  const ids = lessons.filter((l) => !off.includes(l.id)).map((l) => l.id);
  return { lessons, off, setOff, ids };
}

export function SessionLessons({ state }: { state: ReturnType<typeof useSessionLessons> }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const { lessons, off, setOff, ids } = state;
  if (!lessons.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        onClick={() => setExpanded((x) => !x)}
        className="inline-flex min-h-9 w-fit cursor-pointer items-center gap-2 rounded-full border border-line bg-surface-sunken px-3 text-[12px] text-ink hover:border-accent focus-visible:shadow-[0_0_0_3px_var(--accent-glow)] focus-visible:outline-none"
      >
        <BookMarked className="size-4" aria-hidden="true" />
        {ids.length ? lessonsChipText(ids.length) : 'No lessons will be sent'}
      </button>
      {expanded ? (
        <fieldset id={`${id}-list`} className="m-0 flex flex-col gap-1 rounded-[var(--radius)] border border-dashed border-line p-3">
          <legend className="px-1 text-[12px] font-semibold text-ink-muted">Added after your words as “Standing notes from the user”</legend>
          {lessons.map((l) => (
            <label key={l.id} className="flex min-h-9 items-start gap-2">
              <input
                type="checkbox"
                checked={!off.includes(l.id)}
                onChange={(e) => setOff((o) => (e.target.checked ? o.filter((x) => x !== l.id) : [...o, l.id]))}
                className="mt-0.5 size-4 accent-[var(--accent)]"
              />
              <span className="break-words">{l.text}</span>
            </label>
          ))}
          <span className="text-[12px] text-ink-muted">Switching one off applies to this session only.</span>
        </fieldset>
      ) : null}
    </div>
  );
}
