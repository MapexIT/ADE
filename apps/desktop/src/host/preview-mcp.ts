import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** HI-08: what drives the preview window. Main implements it (see main/index.ts); tests use a fake. */
export interface PreviewDriver {
  open(url: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  text(): Promise<string>;
}

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/;

/**
 * HI-08: an MCP server (streamable HTTP, loopback only) that lets a session's agent drive the preview window:
 * open a local URL, click, type, read the text and take screenshots, which appear in the session's timeline.
 * Each session gets its own bearer token, so a request always belongs to one session.
 */
export class PreviewMcp {
  private server: Server | null = null;
  private port = 0;
  private readonly tokens = new Map<string, string>();
  private current: string | null = null;

  constructor(
    private readonly driver: () => PreviewDriver | null,
    private readonly screenshotsDir: string,
    private readonly onScreenshot: (sessionId: string, url: string, file: string) => void,
  ) {
    mkdirSync(screenshotsDir, { recursive: true });
  }

  /** The MCP server spec for a session (started on first use). */
  async specFor(sessionId: string): Promise<{ name: string; url: string; headers: Record<string, string> }> {
    await this.start();
    let token = [...this.tokens].find(([, s]) => s === sessionId)?.[0];
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.tokens.set(token, sessionId);
    }
    return { name: 'ade-preview', url: `http://127.0.0.1:${this.port}/mcp`, headers: { Authorization: `Bearer ${token}` } };
  }

  private build(sessionId: string): McpServer {
    const server = new McpServer({ name: 'ade-preview', version: '0.1.0' });
    const drive = () => {
      const d = this.driver();
      if (!d) throw new Error('The preview is not available.');
      return d;
    };
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    server.registerTool(
      'preview_open',
      { description: 'Open a local web app (http://localhost:<port>/...) in ADE\'s preview window.', inputSchema: { url: z.string().describe('A localhost URL') } },
      async ({ url }) => {
        if (!LOCAL.test(url)) return { isError: true, ...text('Only local addresses (localhost) can be opened in the preview.') };
        await drive().open(url);
        this.current = url;
        return text(`Opened ${url}.`);
      },
    );
    server.registerTool('preview_screenshot', { description: 'Take a screenshot of the preview window. It is also shown to the user in the session.' }, async () => {
      const png = await drive().screenshot();
      const file = `${randomUUID()}.png`;
      writeFileSync(join(this.screenshotsDir, file), png);
      this.onScreenshot(sessionId, this.current ?? '', file);
      return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
    });
    server.registerTool('preview_click', { description: 'Click the first element matching a CSS selector in the preview.', inputSchema: { selector: z.string() } }, async ({ selector }) => {
      await drive().click(selector);
      return text(`Clicked ${selector}.`);
    });
    server.registerTool('preview_type', { description: 'Type text into the first element matching a CSS selector in the preview.', inputSchema: { selector: z.string(), text: z.string() } }, async ({ selector, text: value }) => {
      await drive().type(selector, value);
      return text(`Typed into ${selector}.`);
    });
    server.registerTool('preview_text', { description: 'Read the visible text of the page in the preview.' }, async () => text((await drive().text()).slice(0, 50_000)));
    return server;
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.server = createServer((req, res) => {
      const token = /^Bearer (\w+)$/.exec(req.headers.authorization ?? '')?.[1];
      const sessionId = token ? this.tokens.get(token) : undefined;
      if (!sessionId || !req.url?.startsWith('/mcp')) {
        res.writeHead(401).end();
        return;
      }
      // Stateless: a fresh server and transport for every request (SDK 1.32 streamable HTTP).
      const server = this.build(sessionId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      void server.connect(transport).then(() => transport.handleRequest(req, res));
    });
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  async dispose() {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}
