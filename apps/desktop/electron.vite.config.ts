import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Native modules and the ACP adapters stay outside the bundle; everything else (including the
// workspace packages, which ship TypeScript sources) is bundled.
const external = ['electron', 'node-pty', /^node:/];

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
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
});
