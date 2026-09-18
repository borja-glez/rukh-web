// Static server for the built `dist/` that reproduces what nginx serves in production: the two
// cross-origin isolation headers (`Cross-Origin-Opener-Policy: same-origin` and
// `Cross-Origin-Embedder-Policy: require-corp`), so `crossOriginIsolated === true` in the page and
// in every worker, plus the MIME types the ONNX Runtime and the model files need.
//
// `pnpm preview` serves neither those headers nor nginx's content types, so the preview-backed
// E2E projects never exercised what production actually serves. That gap hid a production-only
// failure: nginx has no `mime.types` entry for `.mjs`, the ORT loader went out as
// `application/octet-stream`, and the worker's dynamic `import()` of it was refused, so no
// backend ever came up. The `isolated` Playwright project runs `e2e/model.spec.ts` against this
// server; take the `.mjs` location out of `nginx/default.conf` and it fails again.
//
// Only what nginx also does is reproduced. The page CSP comes from the <meta> tag Astro
// generates, exactly as in production; `frame-ancestors` is a header there and is irrelevant here.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const root = resolve(repo, 'dist');
const port = Number(process.env.COI_PORT ?? process.argv[2] ?? 4323);
const host = process.env.COI_HOST ?? '127.0.0.1';

/**
 * The relevant entries of nginx's bundled `mime.types`, copied verbatim in spirit from
 * nginx 1.29 (`docker run --rm nginx:1.29-alpine cat /etc/nginx/mime.types`).
 *
 * **`.mjs` is deliberately absent, because nginx's map has no entry for it.** Anything nginx
 * cannot type falls back to the `default_type`, `application/octet-stream`, and a module served
 * as octet-stream with `nosniff` is refused by the browser. That gap is precisely the bug this
 * fixture must keep catching, so the map is not "helpfully" completed here: whatever makes the
 * type correct has to be declared in `nginx/default.conf`, and is read from there below.
 */
const NGINX_MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript'],
  ['.css', 'text/css'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain'],
  ['.xml', 'text/xml'],
  ['.woff2', 'font/woff2'],
  ['.wasm', 'application/wasm'],
]);

const NGINX_DEFAULT_TYPE = 'application/octet-stream';

/**
 * The production overrides, read out of `nginx/default.conf`: every `location ~* <regex>` that
 * declares a `default_type`, plus any `types { <type> <ext>; }` block. Reading them instead of
 * repeating them is what makes this fixture a regression test for the server config and not just
 * for the client code.
 */
function nginxOverrides() {
  const conf = readFileSync(resolve(repo, 'nginx/default.conf'), 'utf8');
  const overrides = new Map();

  for (const [, body] of conf.matchAll(/\btypes\s*\{([^}]*)\}/g)) {
    for (const statement of body.split(';')) {
      const [type, ...extensions] = statement.trim().split(/\s+/).filter(Boolean);
      if (!type || extensions.length === 0) continue;
      for (const extension of extensions) overrides.set(`.${extension.toLowerCase()}`, type);
    }
  }

  for (const [, pattern, body] of conf.matchAll(/location\s+~\*\s+(\S+)\s*\{([\s\S]*?)\n {2}\}/g)) {
    const type = /^\s*default_type\s+([^\s;]+);/m.exec(body)?.[1];
    const extensions = /\\\.\(?([A-Za-z0-9|]+)\)?\$/.exec(pattern)?.[1];
    if (!type || !extensions) continue;
    for (const extension of extensions.split('|')) {
      overrides.set(`.${extension.toLowerCase()}`, type);
    }
  }

  return overrides;
}

const TYPES = new Map([...NGINX_MIME_TYPES, ...nginxOverrides()]);

function headers(path) {
  return {
    'Content-Type': TYPES.get(extname(path).toLowerCase()) ?? NGINX_DEFAULT_TYPE,
    // The production isolation headers: this is the whole point of this fixture.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

/** Resolves a URL path inside `dist/`, or `null` when it escapes the root or does not exist. */
function locate(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const candidate = resolve(join(root, normalize(decoded)));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  for (const file of [candidate, join(candidate, 'index.html'), `${candidate}.html`]) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const server = createServer((request, response) => {
  const file = locate(request.url ?? '/');
  if (!file) {
    const fallback = locate('/404.html');
    if (!fallback) {
      response.writeHead(404, headers('.html'));
      response.end('not found');
      return;
    }
    response.writeHead(404, headers(fallback));
    createReadStream(fallback).pipe(response);
    return;
  }
  const head = { ...headers(file), 'Content-Length': String(statSync(file).size) };
  if (request.method === 'HEAD') {
    response.writeHead(200, head);
    response.end();
    return;
  }
  response.writeHead(200, head);
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`cross-origin isolated dist/ on http://${host}:${port}`);
});
