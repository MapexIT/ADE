# UI

ADE has one theme: dark. There is no light mode and no theme switch. The look is calm: few panels at once,
detail on demand, soft borders, short motion.

## Tokens (CSS custom properties in `packages/ui/tokens.css`)

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#0F1318` | App ground |
| `--surface` | `#161B22` | Panels, bars, cards |
| `--surface-sunken` | `#0B0E13` | Terminals, code, canvas |
| `--line` | `#2A3441` | Hairlines and borders |
| `--ink` | `#E6EAF0` | Primary text |
| `--ink-muted` | `#9AA7B6` | Secondary text |
| `--accent` | `#7FA6F5` | Primary actions, selection, focus ring |
| `--accent-ink` | `#0E1420` | Text on accent fills |
| `--accent-tint` | `#1E2A40` | Selected backgrounds |
| `--accent-soft` | `#B7CDFB` | Text on accent tint |
| `--attention` | `#FFB86B` | Needs you, waiting |
| `--attention-tint` | `#33240F` | Attention backgrounds |
| `--attention-line` | `#D9882B` | Attention borders and rings |
| `--ok` | `#7BD88F` | Success text |
| `--ok-tint` | `#14301F` | Success backgrounds |
| `--danger` | `#FF9B9B` | Failure text |
| `--danger-tint` | `#3A1A1A` | Failure backgrounds |
| `--radius` | `10px` (cards 12px) | Corners |

Type: Inter for UI (13px base, 16px section titles), JetBrains Mono for code and terminals (12 to 12.5px).
Spacing in steps of 4px. Controls are at least 36px tall in dense toolbars and 44px elsewhere.

Colour never carries meaning alone: every state also has a word (Waiting on you, Failed, Sandboxed).

## Layout

A Dockview workspace with a fixed top bar:

- Top bar: ADE wordmark, workspace switcher, primary tabs (Sessions, Work items, Workflows, Terminals, Run,
  Review), Needs-you button with a count, command palette (Ctrl K).
- Left: sessions list grouped as Needs you, Working, Ready for review, Done.
- Centre: the active surface (timeline, diff, canvas, terminal, runner).
- Right: inspector for the selection (changes, node settings, checkpoints).
- Bottom: terminal panel, collapsible, with tabs and splits.

Default to three visible regions at most. Everything else opens on demand and remembers its place.

## Screens (see the wireframe canvas for each)

| # | Screen | Purpose |
| --- | --- | --- |
| 1 | Main workspace | Sessions list, timeline with plan, approval card, composer, inspector, terminal strip |
| 2 | Smart terminal | Terminal list, command blocks, suggested command, status bar, agent terminal with attention ring, plain terminal |
| 3 | Review and land | Changed files, per-turn selector, side-by-side diff, comment to agent, review assistant, landing actions |
| 4 | Workflow canvas | Node palette, skills list, node graph, run strip, node settings with skills |
| 5 | Work items and new session | Shortcut and GitHub items by state, new-session form with a preview of what is sent |
| 6 | First-run setup | Git, shells, agents, connectors, sandbox state per agent |
| 7 | Skill builder | Form, `SKILL.md` preview, save location, trial run |
| 8 | Code runner | Run bar, configurations, test results, raw output, history, scratchpad |

## Component rules

- Use shadcn/ui components restyled with the tokens. Do not introduce a second component library.
- Lists that can grow (timeline, terminal blocks, history) are virtualised.
- Streaming text never re-renders the whole timeline; append to the last item.
- Every destructive action (discard session, undo turn, remove worktree) asks for confirmation and says
  what will be lost.
- Keyboard: every action is reachable from the command palette; the Needs-you inbox is fully keyboard-driven.
- Motion: 120 to 200 ms ease-out for panels, cards and rings; none for streaming text. Respect
  `prefers-reduced-motion`.
- Empty states say what the area is for and offer the one obvious next action.
