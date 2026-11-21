import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Native modules and the ACP adapters stay outside the bundle; everything else (including the
// workspace packages, which ship TypeScript sources) is bundled.
const external = ['electron', 'node-pty', /^node:/];

// Libraries and workspace packages shared by the entries go to one chunk, never into another entry (otherwise
// loading main could run the host's top-level code). The fake agent's own entry file is excluded.
const SHARED = /^(?!.*fake-agent[\\/]src[\\/]main\.ts$).*(?:node_modules|[\\/]packages[\\/])/;

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      outDir: 'out/main',
      rollupOptions: {
        external,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          host: resolve(__dirname, 'src/host/index.ts'),
          pty: resolve(__dirname, 'src/pty/index.ts'),
          'fake-agent': resolve(__dirname, '../../packages/fake-agent/src/main.ts'),
          'runner-mcp': resolve(__dirname, 'src/runner-mcp/main.ts'),
        },
        // Shared code goes to its own chunk, never into another entry: otherwise loading main could run the
        // host's top-level code.
        output: {
          codeSplitting: {
            groups: [{ name: 'shared', test: SHARED }],
          },
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      outDir: 'out/preload',
      rollupOptions: {
        external: ['electron'],
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [
      react(),
      tailwindcss(),
      {
        // The dev server needs its websocket for hot reload; the packaged app allows nothing but itself.
        name: 'ade-csp',
        transformIndexHtml: {
          order: 'pre',
          handler: (html, ctx) => html.replace('__ADE_DEV_CONNECT__', ctx.server ? 'ws://localhost:* http://localhost:*' : ''),
        },
      },
    ],
    worker: { format: 'es' },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
