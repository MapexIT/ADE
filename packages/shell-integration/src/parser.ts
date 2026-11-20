/**
 * Streaming parser for shell-integration sequences (SM-02). It understands
 *   OSC 133 ; A|B|C|D[;exit]   prompt start, command start, output start, command end
 *   OSC 633 ; E ; <command>    the command line (VS Code's convention, escaped with \xHH)
 *   OSC 7 ; file://host/path   working directory
 *   OSC 9 ; <text> and OSC 777 ; notify ; <title> ; <body>   desktop notifications from programs (agents)
 * Sequences may be split across chunks; the parser buffers partial ones. Terminators are BEL or ESC \.
 */
export type ShellEvent =
  | { type: 'text'; text: string }
  | { type: 'prompt-start' }
  | { type: 'command-start' }
  | { type: 'output-start' }
  | { type: 'command-end'; exitCode: number | null }
  | { type: 'command-line'; command: string }
  | { type: 'cwd'; path: string }
  | { type: 'notify'; title: string; body: string };

const ESC = '\x1b';
const BEL = '\x07';
const MAX_OSC = 64 * 1024;

export function decodeCommandLine(value: string): string {
  return value.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\\/g, '\\');
}

export function fileUrlToPath(url: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(url);
  if (!m?.[1]) return null;
  let p = decodeURIComponent(m[1]);
  // file:///C:/Users/x -> C:/Users/x on Windows
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

function interpret(body: string): ShellEvent | null {
  const semi = body.indexOf(';');
  const code = semi === -1 ? body : body.slice(0, semi);
  const rest = semi === -1 ? '' : body.slice(semi + 1);
  switch (code) {
    case '133': {
      const [kind, arg] = rest.split(';');
      if (kind === 'A') return { type: 'prompt-start' };
      if (kind === 'B') return { type: 'command-start' };
      if (kind === 'C') return { type: 'output-start' };
      if (kind === 'D') {
        const n = arg === undefined || arg === '' ? null : Number(arg);
        return { type: 'command-end', exitCode: n === null || Number.isNaN(n) ? null : n };
      }
      return null;
    }
    case '633': {
      if (rest.startsWith('E;')) return { type: 'command-line', command: decodeCommandLine(rest.slice(2).split(';')[0] ?? '') };
      // 633 A-D mirror 133.
      const mirrored = interpret(`133;${rest}`);
      return mirrored;
    }
    case '7': {
      const path = fileUrlToPath(rest);
      return path ? { type: 'cwd', path } : null;
    }
    case '9':
      // OSC 9;4 is a progress report (ConEmu/Windows Terminal), not a notification.
      if (rest.startsWith('4;')) return null;
      return { type: 'notify', title: '', body: rest };
    case '777': {
      const [kind, title = '', ...body] = rest.split(';');
      return kind === 'notify' ? { type: 'notify', title, body: body.join(';') } : null;
    }
    default:
      return null;
  }
}

export class ShellIntegrationParser {
  private pending = '';

  /** Feeds a chunk of terminal output; returns events in order. Unrecognised OSCs pass through as text. */
  feed(chunk: string): ShellEvent[] {
    const data = this.pending + chunk;
    this.pending = '';
    const events: ShellEvent[] = [];
    let text = '';
    let i = 0;
    const flush = () => {
      if (text) events.push({ type: 'text', text });
      text = '';
    };
    while (i < data.length) {
      const start = data.indexOf(`${ESC}]`, i);
      if (start === -1) {
        // Keep a trailing lone ESC: it may start an OSC in the next chunk.
        if (data.endsWith(ESC)) {
          text += data.slice(i, -1);
          this.pending = ESC;
        } else text += data.slice(i);
        break;
      }
      text += data.slice(i, start);
      const bel = data.indexOf(BEL, start + 2);
      const st = data.indexOf(`${ESC}\\`, start + 2);
      let end = -1;
      let termLen = 0;
      if (bel !== -1 && (st === -1 || bel < st)) {
        end = bel;
        termLen = 1;
      } else if (st !== -1) {
        end = st;
        termLen = 2;
      }
      if (end === -1) {
        if (data.length - start > MAX_OSC) {
          text += data.slice(start);
        } else this.pending = data.slice(start);
        break;
      }
      const body = data.slice(start + 2, end);
      const event = interpret(body);
      if (event) {
        flush();
        events.push(event);
      } else {
        text += data.slice(start, end + termLen);
      }
      i = end + termLen;
    }
    flush();
    return events;
  }
}

/** Removes ANSI escape sequences, for storing and searching block output as plain text. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, '');
}
