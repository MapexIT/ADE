import type { CommandBlock } from '@ade/contracts';
import { rejoinConptyWraps, stripAnsi, type ShellEvent } from './parser.ts';

export const MAX_OUTPUT = 256 * 1024;

/**
 * Turns shell events into command blocks (SM-01): command text, cwd, start, end, exit code and output.
 * Builder pattern over the event stream; `onBlock` fires when a block opens and again when it completes.
 */
export class BlockBuilder {
  private cwd: string | null = null;
  private commandLine: string | null = null;
  private current: CommandBlock | null = null;
  private inOutput = false;
  private typed = '';
  private inPrompt = false;
  private nextId = 1;
  readonly blocks: CommandBlock[] = [];
  /** True once any integration sequence was seen; a shell without it falls back to plain (SM-02). */
  integrated = false;

  private readonly onBlock: (block: CommandBlock) => void;
  private readonly now: () => number;
  private readonly idPrefix: string;

  constructor(onBlock: (block: CommandBlock) => void = () => undefined, now: () => number = Date.now, idPrefix = 'b') {
    this.onBlock = onBlock;
    this.now = now;
    this.idPrefix = idPrefix;
  }

  get currentCwd(): string | null {
    return this.cwd;
  }

  get running(): CommandBlock | null {
    return this.current && this.current.endedAt === null ? this.current : null;
  }

  push(event: ShellEvent): void {
    switch (event.type) {
      case 'cwd':
        this.cwd = event.path;
        this.integrated = true;
        return;
      case 'prompt-start':
        this.integrated = true;
        this.inPrompt = true;
        this.typed = '';
        return;
      case 'command-start':
        this.integrated = true;
        this.inPrompt = false;
        this.typed = '';
        return;
      case 'command-line':
        this.commandLine = event.command;
        return;
      case 'output-start': {
        this.integrated = true;
        const command = (this.commandLine ?? stripAnsi(this.typed)).trim();
        this.current = {
          id: `${this.idPrefix}${this.nextId++}`,
          command,
          cwd: this.cwd,
          startedAt: this.now(),
          endedAt: null,
          exitCode: null,
          output: '',
          truncated: false,
        };
        this.inOutput = true;
        this.commandLine = null;
        this.onBlock(this.current);
        return;
      }
      case 'command-end': {
        this.integrated = true;
        this.inOutput = false;
        if (!this.current) return; // empty prompt (Enter on a blank line)
        if (this.current.command === '' && stripAnsi(this.current.output).trim() === '') {
          this.current = null; // some shells report a blank line as a command
          return;
        }
        const done: CommandBlock = { ...this.current, endedAt: this.now(), exitCode: event.exitCode, output: stripAnsi(rejoinConptyWraps(this.current.output)) };
        this.blocks.push(done);
        this.current = null;
        this.onBlock(done);
        return;
      }
      case 'text':
        if (this.inOutput && this.current) {
          const next = this.current.output + event.text;
          if (next.length > MAX_OUTPUT) {
            // Keep the tail and say so (SM-18 does not claim a problem was fixed from cut output).
            this.current.output = next.slice(next.length - MAX_OUTPUT);
            this.current.truncated = true;
          } else this.current.output = next;
        } else if (!this.inPrompt) {
          this.typed += event.text;
        }
        return;
      case 'notify':
        return;
    }
  }
}
