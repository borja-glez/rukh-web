// Copies the cm-chessboard sprites into public/ so they are served from the same origin
// (CSP `img-src 'self'`) at the paths the board is configured with (`assetsUrl: '/'`).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'node_modules/cm-chessboard/assets');

const assets = [
  ['pieces/standard.svg', 'public/pieces/standard.svg'],
  ['extensions/markers/markers.svg', 'public/extensions/markers/markers.svg'],
];

for (const [src, dest] of assets) {
  const target = resolve(root, dest);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(from, src), target);
  console.log(`copied ${src} -> ${dest}`);
}
