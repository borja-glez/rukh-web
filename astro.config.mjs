// @ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { defineConfig, fontProviders } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

/**
 * ONNX Runtime Web is self-hosted under `public/ort/<version>/` (see `scripts/copy-assets.mjs`)
 * and the decoder worker points `ort.env.wasm.wasmPaths` there. The published bundle still
 * carries a `new URL('...wasm', import.meta.url)` fallback, which makes Rollup emit a second,
 * never-loaded copy of the 27 MB binary into `_astro/`. Rewriting it to the self-hosted path
 * keeps the fallback correct and the build free of the duplicate.
 */
const ORT_WASM_URL =
  /new URL\("(ort-wasm-simd-threaded[\w.-]*\.wasm)",\s*import\.meta\.url\)\.href/g;

function ortExternalWasm() {
  const base = `/ort/${JSON.parse(readFileSync(new URL('./node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version}/`;
  return {
    name: 'rukh:ort-external-wasm',
    /** @type {'pre'} */
    enforce: 'pre',
    /**
     * @param {string} code
     * @param {string} id
     */
    transform(code, id) {
      if (!id.includes('onnxruntime-web') || !ORT_WASM_URL.test(code)) return null;
      ORT_WASM_URL.lastIndex = 0;
      return {
        code: code.replace(ORT_WASM_URL, (_match, file) => JSON.stringify(base + file)),
        map: null,
      };
    },
  };
}

/**
 * The theme bootstrap script is inlined verbatim in the <head> (see Base.astro) so the page
 * paints with the stored theme and no flash. Its hash is allow-listed in the CSP instead of
 * enabling 'unsafe-inline'. tests/theme-script-hash.test.ts keeps both in sync.
 */
const themeInit = readFileSync(new URL('./src/scripts/theme-init.js', import.meta.url), 'utf8');
const themeInitHash = /** @type {`sha256-${string}`} */ (
  `sha256-${createHash('sha256').update(themeInit).digest('base64')}`
);

// https://astro.build/config
export default defineConfig({
  site: 'https://rukh.borjaglez.com',
  trailingSlash: 'ignore',
  integrations: [preact(), sitemap()],
  vite: {
    // Vite bundles workers with their own plugin pipeline (`worker.plugins`), so the rewrite
    // has to be registered there as well as in the page pipeline.
    plugins: [ortExternalWasm()],
    worker: { format: 'es', plugins: () => [ortExternalWasm()] },
  },
  // No Markdown pages: keep Shiki's inline styles out of the CSP picture.
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self' https://huggingface.co https://*.hf.co",
        "worker-src 'self' blob:",
      ],
      scriptDirective: {
        hashes: [themeInitHash],
      },
      styleDirective: {
        // cm-chessboard positions the dragged piece with a `style` attribute on every pointer
        // move; only the attribute scope is relaxed, `style-src` itself stays hashed.
        resources: ["'self'", { resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },
  fonts: [
    {
      name: 'Bricolage Grotesque',
      cssVariable: '--font-display',
      provider: fontProviders.fontsource(),
      weights: ['300 800'],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['system-ui', 'sans-serif'],
    },
    {
      name: 'IBM Plex Mono',
      cssVariable: '--font-mono',
      provider: fontProviders.fontsource(),
      weights: [400, 500],
      styles: ['normal'],
      subsets: ['latin', 'latin-ext'],
      fallbacks: ['ui-monospace', 'monospace'],
    },
  ],
});
