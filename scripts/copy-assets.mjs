// Copies into public/ everything that must be served from this origin:
//
//   * the cm-chessboard sprites (CSP `img-src 'self'`, board `assetsUrl: '/'`);
//   * the ONNX Runtime Web runtime, under `public/ort/<version>/`, which the decoder worker
//     points `ort.env.wasm.wasmPaths` at. The `.wasm` is 28 MB, so a `.gz` sibling is written
//     next to it for nginx `gzip_static` (the runtime is never compressed per request).
//
// Both `predev` and `prebuild` run this; `public/ort/` is generated and git-ignored.
//
// `node scripts/copy-assets.mjs --verify` runs the other way round, as `postbuild`: it reads out
// of the built bundle every `ort-wasm*.{mjs,wasm}` file the runtime can ask for and fails the
// build when one of them is not published. A missing artefact is then a build error with a name
// in it instead of a 404 and a dead demo in production.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifyOnly = process.argv.includes('--verify');

const BOARD_ASSETS = [
  'pieces/standard.svg',
  'extensions/markers/markers.svg',
  'extensions/arrows/arrows.svg',
];

// Only the asyncify pair: `onnxruntime-web/webgpu` runs on that build for WebGPU and for its
// WASM fallback alike, and shipping the other three variants (`...threaded`, `...jsep`,
// `...jspi`) would add 60 MB for nothing. The worker keeps `numThreads = 1` and `proxy = false`
// so nothing ever reaches for a threaded or proxy artefact; `--verify` is what keeps that
// honest, by checking the built bundle against this list instead of trusting the comment.
const ORT_ASSETS = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

/**
 * The ORT version the worker expects, declared once in the shared protocol module. If the
 * installed package ever drifts from it the build stops here instead of 404-ing at runtime.
 */
function ortVersion() {
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
  return installed;
}

function copyBoardSprites() {
  const assets = resolve(root, 'node_modules/cm-chessboard/assets');
  for (const asset of BOARD_ASSETS) {
    const target = resolve(root, 'public', asset);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(assets, asset), target);
    console.log(`copied ${asset} -> public/${asset}`);
  }
}

function copyOrtRuntime(version) {
  const ortDist = resolve(root, 'node_modules/onnxruntime-web/dist');
  const ortOut = resolve(root, 'public/ort', version);
  mkdirSync(ortOut, { recursive: true });

  for (const file of ORT_ASSETS) {
    const source = resolve(ortDist, file);
    const target = resolve(ortOut, file);
    if (!existsSync(target) || statSync(target).size !== statSync(source).size) {
      copyFileSync(source, target);
      console.log(`copied ${file} -> public/ort/${version}/${file}`);
    }
    if (file.endsWith('.wasm')) {
      const gz = `${target}.gz`;
      if (!existsSync(gz) || statSync(gz).mtimeMs < statSync(target).mtimeMs) {
        writeFileSync(gz, gzipSync(readFileSync(target), { level: 9 }));
        console.log(`compressed ${file} -> public/ort/${version}/${file}.gz`);
      }
    }
  }
}

/** Every file under `directory`, recursively. */
function walk(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

/**
 * Names of the ORT artefacts the built bundle can request. Only names with a `.mjs` or `.wasm`
 * extension count: `ort-wasm-proxy-worker` also appears in the bundle, but it is the *name* the
 * proxy worker is given, not a file, and `ort.env.wasm.proxy = false` means it is never created.
 */
function referencedOrtAssets() {
  const dist = resolve(root, 'dist');
  if (!existsSync(dist)) {
    throw new Error('dist/ does not exist: run `pnpm build` before `copy-assets.mjs --verify`');
  }
  const pattern = /ort-wasm[A-Za-z0-9._-]*\.(?:mjs|wasm)/g;
  const referenced = new Set();
  for (const file of walk(dist)) {
    if (!/\.(js|mjs|html|css|json)$/.test(file)) continue;
    if (file.includes(join('dist', 'ort'))) continue; // the runtime referring to itself
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) referenced.add(match[0]);
  }
  return referenced;
}

function verifyPublishedRuntime(version) {
  const referenced = referencedOrtAssets();
  const published = resolve(root, 'dist/ort', version);
  const missing = [...referenced].filter((file) => !existsSync(resolve(published, file)));
  if (missing.length > 0) {
    throw new Error(
      [
        `the built bundle asks for ONNX Runtime artefacts that are not published under public/ort/${version}/:`,
        ...missing.map((file) => `  - ${file}`),
        'Add them to ORT_ASSETS in scripts/copy-assets.mjs (they live in',
        'node_modules/onnxruntime-web/dist/), or change the worker so it stops asking for them.',
      ].join('\n'),
    );
  }

  // The other direction is only a warning: an artefact nobody asks for is wasted bandwidth, not
  // a broken demo.
  const extra = existsSync(published)
    ? readdirSync(published).filter((file) => !file.endsWith('.gz') && !referenced.has(file))
    : [];
  for (const file of extra) {
    console.warn(`warning: public/ort/${version}/${file} is published but never referenced`);
  }
  console.log(
    `verified ${referenced.size} ONNX Runtime artefact(s) under dist/ort/${version}/: ${[...referenced].join(', ')}`,
  );
}

const version = ortVersion();
if (verifyOnly) {
  verifyPublishedRuntime(version);
} else {
  copyBoardSprites();
  copyOrtRuntime(version);
}
