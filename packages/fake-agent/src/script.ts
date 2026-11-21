/**
 * The fake agent's tiny script language. Each line of a prompt is one step; anything unrecognised is ignored.
 * Tests compose behaviour from steps, and named scenarios expand to fixed scripts.
 *
 *   say <text>                      stream an agent message
 *   think <text>                    stream a thought
 *   read <path>                     tool call (kind read) that completes
 *   edit <path> <content>           write a file in cwd and report a diff tool call
 *   delete <path>                   delete a file in cwd
 *   ask <command>                   permission request for an execute tool call
 *   question <text> | <a> | <b>     a question, answered by picking an option
 *   plan <a>; <b>; <c>              plan with the first entry in progress
 *   fail <message>                  the prompt fails with a JSON-RPC error
 *   hang                            never finish until cancelled
 *   sleep <ms>                      wait
 *   env <NAME>                      say whether an environment variable is set
 *   usage                           report token usage and cost
 *   mode <id>                       switch to a mode
 *   whichmodel                      say which model the session uses
 */
export type Step =
  | { op: 'say'; text: string }
  | { op: 'think'; text: string }
  | { op: 'read'; path: string }
  | { op: 'edit'; path: string; content: string }
  | { op: 'delete'; path: string }
  | { op: 'ask'; command: string }
  | { op: 'question'; text: string; answers: string[] }
  | { op: 'plan'; entries: string[] }
  | { op: 'fail'; message: string }
  | { op: 'hang' }
  | { op: 'sleep'; ms: number }
  | { op: 'env'; name: string }
  /** Writes straight to an absolute path, bypassing the worktree check, to test the host sandbox (CN-07). */
  | { op: 'escape'; path: string }
  /** Replies with the names of the MCP servers the client passed (ST-05). */
  | { op: 'mcp' }
  | { op: 'usage' }
  | { op: 'mode'; id: string }
  | { op: 'whichmodel' };

export const SCENARIOS: Record<string, string> = {
  message: 'say Hello from the fake agent.',
  'tool-call': 'read README.md\nsay I read the file.',
  permission: 'ask npm test\nsay The command finished.',
  plan: 'plan Reproduce the bug; Patch it; Add a test\nsay Working through the plan.',
  question: 'question Which database should I use? | SQLite | Postgres\nsay Thanks for the answer.',
  failure: 'fail The fake agent failed on purpose.',
  hang: 'say Starting a long task.\nhang',
};

const rest = (line: string) => line.slice(line.indexOf(' ') + 1).trim();

export function parseScript(text: string): Step[] {
  const steps: Step[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [head = ''] = line.split(/\s+/, 1);
    const arg = line.includes(' ') ? rest(line) : '';
    switch (head) {
      case 'whichmodel':
        steps.push({ op: 'whichmodel' });
        break;
      case 'scenario': {
        const script = SCENARIOS[arg];
        if (script) steps.push(...parseScript(script));
        break;
      }
      case 'say':
        steps.push({ op: 'say', text: arg });
        break;
      case 'think':
        steps.push({ op: 'think', text: arg });
        break;
      case 'read':
        steps.push({ op: 'read', path: arg });
        break;
      case 'edit': {
        const space = arg.indexOf(' ');
        const path = space === -1 ? arg : arg.slice(0, space);
        const content = space === -1 ? '' : arg.slice(space + 1).replace(/\\n/g, '\n');
        steps.push({ op: 'edit', path, content });
        break;
      }
      case 'delete':
        steps.push({ op: 'delete', path: arg });
        break;
      case 'ask':
        steps.push({ op: 'ask', command: arg });
        break;
      case 'question': {
        const [q = '', ...answers] = arg.split('|').map((s) => s.trim());
        steps.push({ op: 'question', text: q, answers: answers.length ? answers : ['Yes', 'No'] });
        break;
      }
      case 'plan':
        steps.push({ op: 'plan', entries: arg.split(';').map((s) => s.trim()).filter(Boolean) });
        break;
      case 'fail':
        steps.push({ op: 'fail', message: arg || 'failed' });
        break;
      case 'hang':
        steps.push({ op: 'hang' });
        break;
      case 'sleep':
        steps.push({ op: 'sleep', ms: Number(arg) || 0 });
        break;
      case 'env':
        steps.push({ op: 'env', name: arg });
        break;
      case 'escape':
        steps.push({ op: 'escape', path: arg });
        break;
      case 'mcp':
        steps.push({ op: 'mcp' });
        break;
      case 'usage':
        steps.push({ op: 'usage' });
        break;
      case 'mode':
        steps.push({ op: 'mode', id: arg });
        break;
      default:
        break;
    }
  }
  return steps;
}
