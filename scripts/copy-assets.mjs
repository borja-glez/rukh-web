// Copies into public/ everything that must be served from this origin:
//
//   * the cm-chessboard sprites (CSP `img-src 'self'`, board `assetsUrl: '/'`);
//   * the ONNX Runtime Web runtime, under `public/ort/<version>/`, which the decoder worker
//     points `ort.env.wasm.wasmPaths` at. The `.wasm` is 28 MB, so a `.gz` sibling is written
//     next to it for nginx `gzip_static` (the runtime is never compressed per request).
//
// Both `predev` and `prebuild` run this; `public/ort/` is generated and git-ignored.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- board sprites ---------------------------------------------------------
const boardAssets = resolve(root, 'node_modules/cm-chessboard/assets');

for (const asset of [
  'pieces/standard.svg',
  'extensions/markers/markers.svg',
  'extensions/arrows/arrows.svg',
]) {
  const target = resolve(root, 'public', asset);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve(boardAssets, asset), target);
  console.log(`copied ${asset} -> public/${asset}`);
}

// ---- onnxruntime-web runtime ----------------------------------------------
// The version the worker expects is declared once, in the shared protocol module; if the
// installed package ever drifts from it the build stops here instead of 404-ing at runtime.
const protocol = readFileSync(resolve(root, 'src/lib/worker-protocol.ts'), 'utf8');
const declared = /ORT_VERSION\s*=\s*'([^']+)'/.exec(protocol)?.[1];
const installed = JSON.parse(
  readFileSync(resolve(root, 'node_modules/onnxruntime-web/package.json'), 'utf8'),
).version;

if (declared !== installed) {
  throw new Error(
    `ORT_VERSION is '${declared}' in src/lib/worker-protocol.ts but onnxruntime-web ${installed} is installed`,
  );
}

const ortDist = resolve(root, 'node_modules/onnxruntime-web/dist');
const ortOut = resolve(root, 'public/ort', installed);
mkdirSync(ortOut, { recursive: true });

// Only the asyncify pair: `onnxruntime-web/webgpu` runs on that build for WebGPU and for its
// WASM fallback alike, and shipping the other three variants would add 60 MB for nothing.
for (const file of [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
]) {
  const source = resolve(ortDist, file);
  const target = resolve(ortOut, file);
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
    copyFileSync(source, target);
    console.log(`copied ${file} -> public/ort/${installed}/${file}`);
  }
  if (file.endsWith('.wasm')) {
    const gz = `${target}.gz`;
    if (!existsSync(gz) || statSync(gz).mtimeMs < statSync(target).mtimeMs) {
      writeFileSync(gz, gzipSync(readFileSync(target), { level: 9 }));
      console.log(`compressed ${file} -> public/ort/${installed}/${file}.gz`);
    }
  }
}
