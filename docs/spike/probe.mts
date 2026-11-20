// M0-T02/T03 probe: initialize + session/new against each real agent. No prompt is sent.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createRuntimes } from '@ade/acp-client';

const require = createRequire(import.meta.url);
const cwd = process.argv[2]!;
const out = process.argv[3]!;
const runtimes = createRuntimes({
  adapterEntry: (pkg) => join(require.resolve(`${pkg}/package.json`), '..', 'dist', 'index.js'),
  nodeCommand: () => ({ command: process.execPath, args: [] }),
  nodeEnv: () => ({}),
});
for (const id of ['claude-code', 'codex', 'opencode'] as const) {
  const rt = runtimes.get(id)!;
  const install = await rt.detect();
  const log: string[] = [];
  const result: Record<string, unknown> = { id, install, platform: process.platform };
  try {
    const s = await Promise.race([
      rt.start({ cwd, permissionProfile: 'ask', onProtocolMessage: (d, b) => log.push(`${d} ${b}`) }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout after 60 s')), 60_000)),
    ]);
    result.capabilities = s.capabilities;
    result.modes = s.modes;
    result.currentModeId = s.currentModeId;
    await s.close();
  } catch (e) {
    result.error = (e as Error).message.slice(0, 500);
  }
  result.protocol = log.filter((l) => l.includes('"initialize"') || l.includes('"protocolVersion"') || l.includes('session/new') || l.includes('"modes"')).slice(0, 6);
  writeFileSync(join(out, `${id}-${process.platform}.json`), JSON.stringify(result, null, 2));
  console.log(id, result.error ? `error: ${result.error}` : 'ok', JSON.stringify(result.capabilities ?? {}).slice(0, 200));
}
process.exit(0);
