import { defineConfig } from '@playwright/test';

// End-to-end tests drive the built app (`pnpm build` first) with the fake ACP agent.
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
