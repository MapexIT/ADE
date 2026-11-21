import type { ChildProcess } from 'node:child_process';
import { extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { findOnPath, killTree, spawnCommand, toSpawnable } from '@ade/acp-client';
import type { LspDiagnostic } from '@ade/contracts';

/**
 * ED-03: a minimal Language Server Protocol client (LSP 3.17: Content-Length framed JSON-RPC over stdio) for
 * diagnostics, hover and go to definition. One server per language and project root, started on first use.
 */
export class LspClient {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly diagnostics = new Map<string, LspDiagnostic[]>();
  readonly ready: Promise<void>;
  private readonly versions = new Map<string, number>();

  constructor(command: { command: string; args: string[] }, root: string) {
    this.child = spawnCommand(command, { cwd: root, stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
    this.child.stdout!.on('data', (d: Buffer) => this.read(d));
    this.child.on('exit', () => {
      for (const w of this.waiting.values()) w.reject(new Error('The language server stopped.'));
      this.waiting.clear();
    });
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(root).href,
      workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: false },
          publishDiagnostics: { relatedInformation: false },
        },
      },
    }).then(() => this.notify('initialized', {}));
  }

  private send(message: object) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private read(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
      if (!Number.isFinite(length) || this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.handle(JSON.parse(body) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } });
    }
  }

  private handle(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }) {
    if (msg.method === 'textDocument/publishDiagnostics') {
      const p = msg.params as { uri: string; diagnostics: { range: { start: { line: number; character: number }; end: { line: number; character: number } }; severity?: number; message: string; source?: string }[] };
      this.diagnostics.set(
        p.uri,
        p.diagnostics.map((d) => ({
          line: d.range.start.line,
          character: d.range.start.character,
          endLine: d.range.end.line,
          endCharacter: d.range.end.character,
          severity: (['error', 'error', 'warning', 'info', 'hint'] as const)[d.severity ?? 1] ?? 'error',
          message: d.message,
          source: d.source ?? null,
        })),
      );
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server-to-client requests (configuration, progress): answer with nothing so the server carries on.
      this.send({ id: msg.id, result: null });
      return;
    }
    if (msg.id !== undefined) {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.result);
    }
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The language server did not answer ${method} in time.`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  open(path: string, languageId: string, text: string) {
    const uri = pathToFileURL(path).href;
    this.versions.set(uri, 1);
    this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  }

  change(path: string, text: string) {
    const uri = pathToFileURL(path).href;
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
  }

  close(path: string) {
    const uri = pathToFileURL(path).href;
    this.versions.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  async stop() {
    try {
      await this.request('shutdown', null, 2000);
      this.notify('exit', null);
    } catch {
      // not answering: kill it below
    }
    if (this.child.pid) await killTree(this.child.pid);
  }
}

export interface ServerSpec {
  languageId: string;
  command: string;
  args: string[];
}

/** Language servers by file extension, found on the PATH. Users install them; ADE bundles none. */
export const SERVERS: Record<string, ServerSpec[]> = {
  typescript: [{ languageId: 'typescript', command: 'typescript-language-server', args: ['--stdio'] }],
  python: [
    { languageId: 'python', command: 'pyright-langserver', args: ['--stdio'] },
    { languageId: 'python', command: 'pylsp', args: [] },
  ],
  go: [{ languageId: 'go', command: 'gopls', args: [] }],
  rust: [{ languageId: 'rust', command: 'rust-analyzer', args: [] }],
  c: [{ languageId: 'cpp', command: 'clangd', args: [] }],
  csharp: [{ languageId: 'csharp', command: 'csharp-ls', args: [] }],
};

const BY_EXT: Record<string, { family: keyof typeof SERVERS; languageId: string }> = {
  '.ts': { family: 'typescript', languageId: 'typescript' },
  '.tsx': { family: 'typescript', languageId: 'typescriptreact' },
  '.mts': { family: 'typescript', languageId: 'typescript' },
  '.cts': { family: 'typescript', languageId: 'typescript' },
  '.js': { family: 'typescript', languageId: 'javascript' },
  '.jsx': { family: 'typescript', languageId: 'javascriptreact' },
  '.mjs': { family: 'typescript', languageId: 'javascript' },
  '.cjs': { family: 'typescript', languageId: 'javascript' },
  '.py': { family: 'python', languageId: 'python' },
  '.go': { family: 'go', languageId: 'go' },
  '.rs': { family: 'rust', languageId: 'rust' },
  '.c': { family: 'c', languageId: 'c' },
  '.h': { family: 'c', languageId: 'c' },
  '.cpp': { family: 'c', languageId: 'cpp' },
  '.cc': { family: 'c', languageId: 'cpp' },
  '.hpp': { family: 'c', languageId: 'cpp' },
  '.cs': { family: 'csharp', languageId: 'csharp' },
};

/** Flattens LSP hover contents (MarkupContent, MarkedString or an array of them) to Markdown text. Pure. */
export function hoverText(contents: unknown): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n');
  const c = contents as { kind?: string; value?: string; language?: string };
  if (c.language) return `\`\`\`${c.language}\n${c.value ?? ''}\n\`\`\``;
  return c.value ?? '';
}

export class LspService {
  private readonly clients = new Map<string, Promise<LspClient | null>>();
  private readonly opened = new Map<string, { client: LspClient; languageId: string }>();

  constructor(
    private readonly rootOf: (path: string) => string,
    private readonly find: (name: string) => string | null = findOnPath,
    private readonly nodeCommand = process.execPath,
    private readonly overrides: () => Partial<Record<string, ServerSpec[]>> = () => ({}),
  ) {}

  private spec(path: string): { spec: ServerSpec; languageId: string; family: string } | { reason: string } {
    const lang = BY_EXT[extname(path).toLowerCase()];
    if (!lang) return { reason: 'No language server is known for this kind of file.' };
    const candidates = this.overrides()[lang.family] ?? SERVERS[lang.family] ?? [];
    for (const c of candidates) if (this.find(c.command)) return { spec: c, languageId: lang.languageId, family: lang.family };
    return { reason: `Install ${candidates.map((c) => c.command).join(' or ')} to get diagnostics, hover and go to definition.` };
  }

  async open(path: string, text: string): Promise<{ server: string | null; reason: string | null }> {
    const found = this.spec(path);
    if ('reason' in found) return { server: null, reason: found.reason };
    const root = this.rootOf(path);
    const key = `${found.family}:${root}`;
    if (!this.clients.has(key)) {
      const exe = this.find(found.spec.command)!;
      // Servers installed as JavaScript run with Node; npm's Windows shims are unwrapped.
      const cmd = /\.(c|m)?js$/i.test(exe) ? { command: this.nodeCommand, args: [exe] } : toSpawnable(exe, this.nodeCommand);
      this.clients.set(
        key,
        (async () => {
          if (!cmd) return null;
          const client = new LspClient({ command: cmd.command, args: [...cmd.args, ...found.spec.args] }, root);
          await client.ready;
          return client;
        })().catch(() => null),
      );
    }
    const client = await this.clients.get(key)!;
    if (!client) {
      this.clients.delete(key);
      return { server: null, reason: `${found.spec.command} did not start.` };
    }
    const prior = this.opened.get(path);
    if (prior) prior.client.change(path, text);
    else {
      client.open(path, found.languageId, text);
      this.opened.set(path, { client, languageId: found.languageId });
    }
    return { server: found.spec.command, reason: null };
  }

  change(path: string, text: string) {
    this.opened.get(path)?.client.change(path, text);
  }

  close(path: string) {
    const o = this.opened.get(path);
    if (!o) return;
    o.client.close(path);
    this.opened.delete(path);
  }

  diagnostics(path: string): LspDiagnostic[] {
    return this.opened.get(path)?.client.diagnostics.get(pathToFileURL(path).href) ?? [];
  }

  async hover(path: string, line: number, character: number): Promise<{ contents: string } | null> {
    const o = this.opened.get(path);
    if (!o) return null;
    const res = (await o.client.request('textDocument/hover', { textDocument: { uri: pathToFileURL(path).href }, position: { line, character } })) as { contents?: unknown } | null;
    const text = hoverText(res?.contents);
    return text ? { contents: text } : null;
  }

  async definition(path: string, line: number, character: number): Promise<{ path: string; line: number; character: number }[]> {
    const o = this.opened.get(path);
    if (!o) return [];
    const res = (await o.client.request('textDocument/definition', { textDocument: { uri: pathToFileURL(path).href }, position: { line, character } })) as unknown;
    const list = (Array.isArray(res) ? res : res ? [res] : []) as { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } }[];
    return list.flatMap((l) => {
      const uri = l.uri ?? l.targetUri;
      const start = (l.range ?? l.targetSelectionRange)?.start;
      if (!uri?.startsWith('file:') || !start) return [];
      return [{ path: fileURLToPath(uri), line: start.line, character: start.character }];
    });
  }

  async dispose() {
    const clients = await Promise.all(this.clients.values());
    await Promise.all(clients.map((c) => c?.stop()));
    this.clients.clear();
  }
}
