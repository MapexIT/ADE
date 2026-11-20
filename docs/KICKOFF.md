# Kickoff

## Before you start (for the human)

1. Create an empty Git repository and copy `CLAUDE.md`, `KICKOFF.md` and the `docs/` folder into it.
2. Install Node.js (current LTS), pnpm and Git.
3. Install Codex, Claude Code and OpenCode and sign in to each one in its own terminal UI.
4. Have two real repositories at hand for the spike (one .NET, one Node works well).
5. Open the repository in Claude Code and paste the prompt below.

Work on Windows or Linux first; the spike needs to be repeated on the other one before M1 starts.

## Prompt to paste into Claude Code

```
You are building ADE, the Agentic Development Environment, in this repository.

Read CLAUDE.md first, then every file in docs/ in the order CLAUDE.md gives.

Then start milestone M0 in docs/PLAN.md and follow that file exactly:
- one task at a time, in order
- tick a task only when its "Done when" holds
- never guess a third-party API: read the installed package's types and the linked docs
- record every answer and every surprise in docs/DECISIONS.md
- when a milestone gate passes, summarise what you built and what you deferred, then stop and wait for me

Do not build anything from a later milestone early. If something in the docs is wrong or contradictory,
tell me before you work around it.
```

## After each milestone

Review the summary, run the app yourself, then tell Claude Code to continue with the next milestone. The
two release gates in `docs/DECISIONS.md` are yours to clear; Claude Code cannot do that for you.
