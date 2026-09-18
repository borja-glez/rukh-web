# rukh-web

Play against **Rukh**, a chess language model trained from scratch, in the browser at
[rukh.borjaglez.com](https://rukh.borjaglez.com). This repository holds the demo only; the model
and data pipeline live in `rukh` and the course in `rukh-lab` (lab.rukh.borjaglez.com).

## One screen

The demo is a single screen and stays that way: the board, the model panel (stage, Elo, consent,
download progress, backend, status, colour) and the move list (SAN in pairs, undo, new game,
export PGN). Everything else (sampling controls, unmasked mode, latency waterfall, top-5 arrows)
lives in the **"Más" drawer**, closed by default, and never touches this screen.

- Board size: `min(100vw - 2*gutter, 100dvh - header - controls, 640px)`; panel on the right from
  900 px, below the board under that. Never a horizontal scroll bar; `env(safe-area-inset-bottom)`.
- Input: tap-tap and drag, mouse and touch, with legal targets highlighted and a large promotion
  dialog. Every control is at least 44 x 44 px and nothing depends on hover.
- Theme: light/dark from the shared design tokens (`light-dark()`), without a flash of the wrong
  scheme; `prefers-reduced-motion` disables the 150 ms move animation.

## Stack

Astro 7 (static) with Preact islands and `@preact/signals`, [cm-chessboard](https://github.com/shaack/cm-chessboard)
8 (MIT, SVG) for the board, [chess.js](https://github.com/jhlywa/chess.js) 1.4 (BSD-2) for the
rules and [onnxruntime-web](https://onnxruntime.ai/) 1.30 (MIT) for the model. TypeScript 6,
pnpm 10, Node 24. Tests with Vitest, E2E with Playwright (three viewports plus a cross-origin
isolated one), axe-core, Lighthouse
CI; served by nginx from a multi-stage Docker image.

The rules always run in the browser: the model only proposes a move and `chess.js` decides whether
it is legal.

## Scripts

| Script                              | What it does                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm dev` / `pnpm build`           | Dev server / static build (`prebuild` copies sprites and ORT, `postbuild` verifies them)   |
| `pnpm preview`                      | Serves `dist/`                                                                             |
| `pnpm check` / `pnpm lint`          | `astro check` (TypeScript) / ESLint                                                        |
| `pnpm format` / `pnpm format:check` | Prettier                                                                                   |
| `pnpm test`                         | Vitest unit tests (`tests/`)                                                               |
| `pnpm e2e`                          | Playwright: mobile 390x844, tablet 820x1180, desktop 1280x800, plus `isolated` (COOP/COEP) |
| `pnpm lighthouse`                   | Lighthouse CI, mobile then desktop, >= 0.95 in the four categories                         |
| `pnpm sync:tokens [--from <src>]`   | Copies `tokens.css` from `../rukh-lab` (or a URL) and updates lock                         |
| `pnpm tokens:hash [--write]`        | Prints (or stores) the sha256 of `src/styles/tokens.css`                                   |
| `pnpm sync:tokenizer [--from <u>]`  | Copies the tokenizer artifacts from `../rukh` (or a base URL)                              |

Run `pnpm exec playwright install chromium` once before `pnpm e2e`.

## Playing against the model

### Stages

`src/lib/registry.ts` is the single list of what you can play against, `mock` first so `?mock=1`
always has somewhere to fall back to:

| Stage        | Label                | Where it comes from                          | Size   |
| ------------ | -------------------- | -------------------------------------------- | ------ |
| `mock`       | Primera jugada legal | no download, first legal move                | 0 MB   |
| `tiny-int8`  | Rukh tiny (int8)     | `chorcat/rukh-tiny`, `onnx/model-int8.onnx`  | ~6 MB  |
| `small-fp16` | Rukh small (fp16)    | `chorcat/rukh-small`, `onnx/model-fp16.onnx` | ~80 MB |
| `small-int8` | Rukh small (int8)    | `chorcat/rukh-small`, `onnx/model-int8.onnx` | ~40 MB |

The sizes are **provisional**: they live in `STAGE_SIZE_MB`, in one place, and are updated once
the real export reports the file sizes. `modelUrl(stage)` resolves to
`https://huggingface.co/<repo>/resolve/main/<file>`. Without `?stage=` the default is
`small-int8` on mobile or when `navigator.connection.saveData` is on, and `small-fp16` otherwise.
`?stage=test` points at a 169 KB toy decoder in `public/test/`, which is how the E2E suite
exercises the real worker path without touching the Hub.

The Elo selector (1200-2400 in steps of 100) stays disabled until the Elo-conditioned checkpoints
of M4 land; the prompt already carries both Elo tokens.

### Consent

Nothing is downloaded when the page loads. The model panel shows the stage, its size in MB, the
model licence (Apache-2.0) and, when the browser reports `saveData`, an extra warning; the
download starts only when you press **Jugar**. Weights are kept in the Cache API under a
versioned bucket and "Borrar modelos descargados" empties it.

### Worker, WebGPU and WASM

`src/workers/decoder.worker.ts` is a dedicated module worker created at the call site in
`decoder-client.ts` with the exact
`new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })` shape Vite needs
to emit it as its own chunk (`tests/worker-chunk.test.ts` fails if it is ever inlined as a `data:`
URL). It streams the `.onnx` with `fetch` and a `ReadableStream`, reports the progress in MB,
stores the bytes in the Cache API and then creates the session with
`executionProviders: ['webgpu']`. WebGPU is used whenever `navigator.gpu.requestAdapter()` hands
out an adapter; WASM is the fallback only when there is no adapter or when creating the WebGPU
session throws, and the reason is sent back with the `ready` message and printed under the badge
(`En WASM: …`), so a slow game is never a mystery. Sessions are created strictly in series and
`run` calls go through a single promise chain, because the asyncify build of ORT cannot re-enter
an async call.

The worker pins `ort.env.wasm.numThreads = 1` and `ort.env.wasm.proxy = false`, isolated or not.
WASM here is only the fallback (WebGPU is the fast path and the decoder is 40 MB), and more
threads or the proxy would make ORT reach for artefacts that are not published.

### Publishing the ORT runtime, and the COOP/COEP finding

The ORT runtime is **self-hosted**: `scripts/copy-assets.mjs` (run by `predev` and `prebuild`)
copies `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` into `public/ort/<version>/`, writes a `.gz`
sibling for nginx `gzip_static` and stops the build if the installed `onnxruntime-web` ever drifts
from `ORT_VERSION` in `src/lib/worker-protocol.ts`. The worker points `ort.env.wasm.wasmPaths`
there, a small Vite plugin in `astro.config.mjs` rewrites ORT's
`new URL('...wasm', import.meta.url)` fallback to the same path so the bundler does not ship a
second 27 MB copy, and `public/ort/` is git-ignored because it is generated. Only the asyncify
pair is published: `onnxruntime-web/webgpu` runs on that build for WebGPU and for its WASM
fallback alike, and the other three variants (`...threaded`, `...jsep`, `...jspi`) would add
60 MB for nothing. `postbuild` runs `scripts/copy-assets.mjs --verify`, which greps the built
bundle for every `ort-wasm*.{mjs,wasm}` name it can request and fails the build, by name, if one
of them is not under `dist/ort/<version>/` — and warns about anything published that nobody asks
for. (`ort-wasm-proxy-worker` also appears in the bundle; it is the _name_ given to the proxy
worker, not a file, and `proxy = false` means it is never created.)

**The COOP/COEP finding.** nginx sets `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, so the container is cross-origin isolated while
`pnpm preview` is not. That difference hid a production-only failure that looked like a WASM
threading problem and was not one: nginx's bundled `mime.types` (checked in 1.29) has an entry
for `js` and **none for `mjs`**, so `/ort/<version>/ort-wasm-simd-threaded.asyncify.mjs` went out
as `application/octet-stream`. With `X-Content-Type-Options: nosniff` the browser refuses to
evaluate it, the worker's dynamic `import()` of the ORT loader fails and both backends die with
`no available backend found. ERR: [wasm] Error: previous call to 'initWasm()' failed.` — while the
network panel shows a perfectly healthy 200. `nginx/default.conf` now declares
`location ~* \.mjs$ { default_type text/javascript; }` next to the `.wasm` and `.onnx` ones.

Nothing in the suite would have caught it, because `pnpm preview` serves `.mjs` correctly and
sends no isolation headers. `e2e/fixtures/coi-server.mjs` closes that gap: it serves the built
`dist/` with the two isolation headers and with nginx's own content types — a baseline copied from
`mime.types` (still without `mjs`) plus the `default_type` declarations it reads out of
`nginx/default.conf`. The `isolated` Playwright project runs `e2e/model.spec.ts` against it on
port 4323. Take the `.mjs` location back out of the nginx config and that project fails.

### Two ways the board can be blocked

The board publishes two independent states, and both have to clear before it takes input again:
`data-busy` while cm-chessboard animates a move (about 150 ms) and `data-thinking` while the model
decides, which can be seconds. They used to be one, and that cost a bug: `data-busy` cleared as
soon as the animation ended, the board looked idle while the model was still thinking, and every
move played in that window was refused because it was not the human's turn — a four-move opening
ended up as a single ply in the move list. The panel says `El modelo piensa…` for the same window,
so the screen and the attribute never disagree, and `waitIdle` in `e2e/helpers.ts` waits for both.

### From the position to the move

`src/lib/model.ts` is the TypeScript twin of `rukh/src/rukh/infer/sampler.py`: it builds
`[<bos>, <wXXXX>, <bXXXX>, ...moves]` with the P1 `UciTokenizer` (context 200, oldest moves
dropped first), asks the worker for the last step's logits, masks every token that is not a legal
`chess.js` move with `-inf`, applies the temperature, truncates to the top k, samples
(`temperature == 0` is the argmax) and returns the move, the top five of the very distribution it
sampled and the three timings. With the drawer's "sin máscara" on, an illegal proposal is reported
in the move list instead of being played and the move is drawn again with the mask on, so the game
continues and the legality rate stays honest.

## Mock mode

`/?mock=1` plays against a deterministic opponent that answers with the first legal move in
`chess.js` order, downloading nothing. It is what most of the E2E suite uses. `?color=b` makes you
play black (the opponent moves first).

## Tokenizers

`src/lib/chess-lm/` is the TypeScript twin of the Python tokenizers in `rukh/src/rukh/tokenize/`.
The demo (and the course playground) uses it to turn the game into the ids the model expects.

- `tokenizer.ts`: the fixed UCI vocabulary, a deterministic enumeration that needs no data: 8
  specials (`<pad> <bos> <eos> <mask> <unk> <1-0> <0-1> <1/2>`), 27 white and 27 black Elo bins
  (`<w0600>`...`<w3200>`, `<b0600>`...`<b3200>`, 100 Elo wide, clamped), then the 1792 `fromto`
  moves reachable by a queen or a knight and the 176 promotions, 2030 tokens in total.
  `UciTokenizer.encodeGame(uci, whiteElo, blackElo, result, maxLen)` produces
  `[<bos>, <wXXXX>, <bXXXX>, ...moves, <result>, <eos>]`.
- `san-chars.ts`: character-level tokenizer for numbered SAN (`1.e4 e5 2.Nf3 ...`).
- `bpe.ts`: applies a BPE model trained with Hugging Face `tokenizers` (whitespace split, merges
  by rank) from its `tokenizer.json`.

### Supported BPE subset

`loadBpe()` reproduces one configuration only, the one `rukh data tokenize --scheme bpe` writes,
and throws from the constructor when the file deviates from it instead of encoding it as if the
option were absent:

| Option                            | Supported value               |
| --------------------------------- | ----------------------------- |
| `model.type`                      | `"BPE"` (or absent)           |
| `model.dropout`                   | `null`                        |
| `model.continuing_subword_prefix` | `null` or `""`                |
| `model.end_of_word_suffix`        | `null` or `""`                |
| `model.fuse_unk`                  | `false`                       |
| `model.byte_fallback`             | `false`                       |
| `pre_tokenizer`                   | `WhitespaceSplit` (or `null`) |

`model.ignore_merges` is honoured (both values work). Normalizers, post-processors and decoders
are not applied: the trained model has none, and `bpe_ids` in the fixture are the raw
`Tokenizer.encode(text).ids`.

`pnpm sync:tokenizer` copies `vocab.json`, `bpe.json` and `fixtures/games.json` from
`../rukh/artifacts/tokenizer` into `src/lib/chess-lm/` (validating each one: 2030 tokens in the
vocabulary, `model.vocab` plus `model.merges` in the BPE and 20 complete games in the fixture);
`--from <baseUrl>` downloads them instead (the default base is
`https://huggingface.co/chorcat/rukh-tokenizer/resolve/main`).

### Parity with Python

`tests/parity.test.ts` checks that the three TypeScript tokenizers reproduce, id by id, what
Python exported for the 20 fixture games; the synced files are committed so the tests run
without the ML repo. Two details of the fixture are easy to get wrong:

- The BPE text is the UCI moves **concatenated without spaces** (`e2e4e7e5...`), so the test
  encodes `game.uci.replaceAll(' ', '')`; encoding the spaced string gives different ids.
- `decode()` is deliberately more forgiving than Python: an id outside the vocabulary maps to
  `<unk>` here, while `UciTokenizer.decode` in Python raises `IndexError`. The browser decodes
  whatever the model samples, so it must not crash on an out-of-range id.

## Layout

```
src/pages/index.astro     the only page (+ 404)
src/islands/App.tsx       game state (signals) and the three zones
src/islands/Board.tsx     cm-chessboard + markers + promotion + accessibility
src/islands/ModelPanel.tsx, MoveList.tsx
src/lib/game.ts           pure rules wrapper: applyMove, undoPair, toPgn, legalTargets
src/lib/opponent.ts       Opponent interface + firstLegalMove
src/islands/More.tsx      the drawer: sampling, unmasked, latency, top-5, arrows
src/workers/decoder.worker.ts  ONNX Runtime session, download and logits
src/workers/decoder-client.ts  main-thread handle (owns the `new Worker` literal)
src/lib/model.ts          prompt, legality mask, sampling and timings
src/lib/worker-protocol.ts typed messages, ORT version and the model cache name
src/lib/registry.ts       model stages, sizes and Hub URLs
src/lib/query.ts          ?mock, ?stage, ?color
src/lib/chess-lm/         UCI, SAN char and BPE tokenizers + synced vocab, BPE and fixtures
src/styles/tokens.css     design tokens copied from rukh-lab (hash-locked)
src/styles/board.css      board theme derived from the tokens
public/ort/<version>/     self-hosted ORT runtime (generated, git-ignored)
public/test/              169 KB toy decoder served at ?stage=test
e2e/                      game, layout, a11y and model specs
e2e/fixtures/coi-server.mjs  dist/ served with the production headers and MIME types
nginx/, Dockerfile        static serving with COOP/COEP and security headers
```

## Licenses

Code: MIT (see `LICENSE`). Model weights: Apache-2.0. Training data: CC0 from the
[Lichess database](https://database.lichess.org/). Board and rules libraries: MIT / BSD-2.
