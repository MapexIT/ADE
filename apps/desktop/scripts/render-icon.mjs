// Renders resources/icon.svg to resources/icon.png (512 x 512, transparent) with Electron's own Chromium.
// Run: pnpm --filter @ade/desktop exec electron scripts/render-icon.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const svgPath = join(__dirname, '../resources/icon.svg');
const pngPath = join(__dirname, '../resources/icon.png');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const svg = readFileSync(svgPath, 'utf8');
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(pngPath, image.resize({ width: 512, height: 512 }).toPNG());
  console.log(`wrote ${pngPath}`);
  app.exit(0);
});
