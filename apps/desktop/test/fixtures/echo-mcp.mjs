// A tiny stdio MCP server for tests: one tool, "echo". With ECHO_FAIL set it exits at once, like a broken server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (process.env.ECHO_FAIL) {
  process.stderr.write('echo-mcp: refusing to start\n');
  process.exit(3);
}
const server = new McpServer({ name: 'echo', version: '0.0.1' });
server.registerTool('echo', { description: 'Repeats what it is given.' }, async () => ({ content: [{ type: 'text', text: 'echo' }] }));
await server.connect(new StdioServerTransport());
