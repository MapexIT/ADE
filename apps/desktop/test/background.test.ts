import { describe, expect, it } from 'vitest';
import { backgroundMessage, hideOnClose } from '../src/main/background.ts';
import { agentUiCommand } from '../src/renderer/src/lib/agent-ui.ts';

describe('PL-05 background sessions', () => {
  it('hides the window instead of quitting only while sessions run and the setting is on', () => {
    expect(hideOnClose({ live: 2, keepRunning: true }, false)).toBe(true);
    expect(hideOnClose({ live: 0, keepRunning: true }, false)).toBe(false);
    expect(hideOnClose({ live: 2, keepRunning: false }, false)).toBe(false);
    // Quitting from the tray or the menu always quits.
    expect(hideOnClose({ live: 2, keepRunning: true }, true)).toBe(false);
    expect(backgroundMessage(1)).toBe('One session keeps running. ADE notifies you when it needs you.');
  });
});

describe('SR-08 open in the agent terminal UI', () => {
  it('resumes Claude Code and Codex by session id and opens OpenCode fresh', () => {
    expect(agentUiCommand('claude-code', 'abc')).toEqual({ command: ['claude', '--resume', 'abc'], resumes: true });
    expect(agentUiCommand('codex', 'th-1')).toEqual({ command: ['codex', 'resume', 'th-1'], resumes: true });
    expect(agentUiCommand('opencode', 'ses_1')).toEqual({ command: ['opencode'], resumes: false });
    expect(agentUiCommand('codex', null)).toEqual({ command: ['codex'], resumes: false });
    expect(agentUiCommand('fake', 'x')).toBeNull();
  });
});

describe('RV-09 and RV-10 prompts', () => {
  it('groups review comments by file and line, and lists only failing checks', async () => {
    const { batchReviewPrompt, checkFailurePrompt } = await import('../src/renderer/src/lib/review.ts');
    expect(
      batchReviewPrompt([
        { path: 'b.ts', line: 9, text: 'Rename this' },
        { path: 'a.ts', line: 3, text: 'Handle null' },
        { path: 'b.ts', line: 2, text: 'Unused import ' },
      ]),
    ).toBe('Review of your changes (3 comments). Address each one, then summarise what you changed.\n\nb.ts\n- line 2: Unused import\n- line 9: Rename this\n\na.ts\n- line 3: Handle null');
    const prompt = checkFailurePrompt([
      { configId: 'a', name: 'Unit', command: ['pnpm', 'test'], exitCode: 1, output: 'boom', runId: 'r1', finishedAt: '' },
      { configId: 'b', name: 'Lint', command: ['pnpm', 'lint'], exitCode: 0, output: '', runId: 'r2', finishedAt: '' },
    ]);
    expect(prompt).toContain('Check "Unit" (pnpm test) exited with 1:\nboom');
    expect(prompt).not.toContain('Lint');
  });
});
