# UI

ADE has one theme: dark. There is no light mode and no theme switch. The look is calm: few panels at once,
detail on demand, soft borders, short motion.

## Tokens (CSS custom properties in `packages/ui/tokens.css`)

Three colours only: black, white and violet. Greys are mixes of black and white. "Needs you" is the violet at
its brightest on a filled tint; danger is white, bold and outlined. Canvas libraries (xterm.js, Monaco, React
Flow) read the same values from `packages/ui/src/palette.ts`.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#09090B` | App ground |
| `--surface` | `#111114` | Panels, bars, cards |
| `--surface-raised` | `#1A1A1F` | Hover, raised controls |
| `--surface-sunken` | `#050506` | Terminals, code, canvas, inputs |
| `--line` | `#24242A` | Hairlines and borders |
| `--line-strong` | `#3A3A42` | Hovered borders |
| `--ink` | `#FAFAFA` | Primary text |
| `--ink-muted` | `#A1A1AA` | Secondary text |
| `--accent` | `#8B5CF6` | Selection, focus ring, indicators |
| `--accent-strong` | `#7C3AED` | Primary button fill (white text, 5.7:1) |
| `--accent-tint` | `#1D1530` | Selected backgrounds |
| `--accent-soft` | `#C4B5FD` | Text on accent tint, success |
| `--attention` | `#DDD6FE` | Needs you, waiting |
| `--attention-tint` | `#261B44` | Attention backgrounds |
| `--attention-line` | `#A78BFA` | Attention borders and rings |
| `--danger` | `#FFFFFF` | Failure text (bold) |
| `--danger-tint` | `#1F1F24` | Failure backgrounds |
| `--danger-line` | `#E4E4E7` | Failure borders |
| `--radius` | `6px` (cards 8px, small 4px) | Corners |

Icons: lucide-react, 16px, next to the words of a control (never instead of them, except a labelled icon button).

Type: Inter for UI (13px base, 16px section titles), JetBrains Mono for code and terminals (12 to 12.5px).
Spacing in steps of 4px. Controls are at least 36px tall in dense toolbars and 44px elsewhere.

Colour never carries meaning alone: every state also has a word (Waiting on you, Failed, Sandboxed).

## Layout

A Dockview workspace with a fixed top bar:

- Top bar: ADE wordmark, workspace switcher, primary tabs (Sessions, Work items, Workflows, Terminals, Run,
  Review), Needs-you button with a count, command palette (Ctrl K).
- Left: sessions list grouped as Needs you, Working, Ready for review, Done.
- Centre: the active surface (timeline, diff, canvas, terminal, runner).
- Right: inspector for the selection (changes, file tree, node settings, checkpoints).
- Bottom: terminal panel, collapsible, with tabs and splits.

Default to three visible regions at most. Everything else opens on demand and remembers its place.

## Screens (see the wireframe canvas for each)

| # | Screen | Purpose |
| --- | --- | --- |
| 1 | Main workspace | Sessions list, timeline with plan, approval card, rule suggestion under a decided approval, turn receipt, composer (Chat or Board, generation method), inspector, terminal strip |
| 2 | Smart terminal | Terminal list, command blocks, suggested command, status bar, agent terminal with attention ring, plain terminal |
| 3 | Review and land | Changed files, per-turn selector, side-by-side diff, comment to agent, review assistant, receipts to check, landing actions |
| 4 | Workflow canvas | Node palette, skills list, node graph, run strip, node settings with skills |
| 5 | Work items and new session | Shortcut and GitHub items by state, new-session form with a preview of what is sent |
| 6 | First-run setup | Git, shells, agents, connectors, sandbox state per agent |
| 7 | Skill builder | Form, `SKILL.md` preview, save location, trial run |
| 8 | Code runner | Run bar, configurations, test results, raw output, history, scratchpad |
| 9 | Git | Branch graph in the middle (lanes, refs, branch list with sessions and ahead/behind); the selected commit's message, parents and files on the left; the file diff on the right |

## Component rules

- Use shadcn/ui components restyled with the tokens. Do not introduce a second component library.
- Lists that can grow (timeline, terminal blocks, history) are virtualised.
- Streaming text never re-renders the whole timeline; append to the last item.
- Every destructive action (discard session, undo turn, remove worktree) asks for confirmation and says
  what will be lost.
- Keyboard: every action is reachable from the command palette; the Needs-you inbox is fully keyboard-driven.
- Motion: 120 to 200 ms ease-out for panels, cards and rings; none for streaming text. Respect
  `prefers-reduced-motion`.
- Waiting (WA-11): `Button busy` swaps the icon for `Spinner` (an arc in the text colour, 0.9 s a turn);
  loading lines use `Waiting` (three breathing violet dots, fading in after 150 ms). Both stand still under
  reduced motion. Do not add other loading animations.
- Empty states say what the area is for and offer the one obvious next action.
- A rule suggestion (AP-09) never uses the attention tint and never appears on a pending approval. Settings
  shows suggested rules above the workspace rules and a rehearsal line under each rule.
