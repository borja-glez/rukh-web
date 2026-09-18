// Build guard. The decoder worker must be emitted as its own chunk: Vite only does that for the
// exact `new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })` shape,
// and any other shape (or `worker.format` left at the default) makes it inline the worker as a
// `data:` URL, which the CSP rejects and which would ship ORT inside the page bundle.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const astro = resolve(root, 'node_modules/astro/bin/astro.mjs');
const copyAssets = resolve(root, 'scripts/copy-assets.mjs');
const chunks = resolve(root, 'dist/_astro');

let files: string[] = [];

beforeAll(() => {
  if (!existsSync(resolve(root, 'dist/index.html'))) {
    // A fresh clone runs `pnpm test` before `pnpm build`; build once instead of skipping.
    execFileSync(process.execPath, [copyAssets], { cwd: root, stdio: 'inherit' });
    execFileSync(process.execPath, [astro, 'build'], { cwd: root, stdio: 'inherit' });
  }
  files = readdirSync(chunks);
}, 300_000);

describe('decoder worker chunk', () => {
  it('is emitted as its own JavaScript chunk', () => {
    const worker = files.filter((file) => /^decoder\.worker-.*\.js$/.test(file));
    expect(worker).toHaveLength(1);
    expect(readFileSync(resolve(chunks, worker[0]), 'utf8')).toContain('wasmPaths');
  });

  it('is referenced by URL from the island bundle, never inlined as data:', () => {
    const worker = files.find((file) => /^decoder\.worker-.*\.js$/.test(file));
    const referencing = files.filter(
      (file) =>
        file.endsWith('.js') &&
        file !== worker &&
        readFileSync(resolve(chunks, file), 'utf8').includes(worker!),
    );
    expect(referencing.length).toBeGreaterThan(0);

    for (const file of files.filter((name) => name.endsWith('.js'))) {
      const code = readFileSync(resolve(chunks, file), 'utf8');
      expect(code).not.toMatch(/new Worker\(\s*["'`]data:/);
      expect(code).not.toContain('data:text/javascript');
      expect(code).not.toContain('data:application/javascript');
    }
  });

  it('does not ship a second copy of the ONNX Runtime binary', () => {
    // The runtime is self-hosted under `public/ort/<version>/`; a `.wasm` in `_astro/` would
    // mean the bundler inlined the 27 MB fallback again (see `ortExternalWasm` in astro.config).
    expect(files.filter((file) => file.endsWith('.wasm'))).toEqual([]);
  });
});
