# rukh-web

Play against **Rukh**, a chess language model trained from scratch, in the browser at
[rukh.borjaglez.com](https://rukh.borjaglez.com). This repository holds the demo only; the model
and data pipeline live in `rukh` and the course in `rukh-lab` (lab.rukh.borjaglez.com).

## One screen

The demo is a single screen and stays that way: the board, the model panel (stage, status, colour,
new game) and the move list (SAN in pairs, undo, new game, export PGN). Later features (arena,
puzzles, latency waterfall, unmasked mode, adapters) go behind a drawer or tabs without touching
this screen.

- Board size: `min(100vw - 2*gutter, 100dvh - header - controls, 640px)`; panel on the right from
  900 px, below the board under that. Never a horizontal scroll bar; `env(safe-area-inset-bottom)`.
- Input: tap-tap and drag, mouse and touch, with legal targets highlighted and a large promotion
  dialog. Every control is at least 44 x 44 px and nothing depends on hover.
- Theme: light/dark from the shared design tokens (`light-dark()`), without a flash of the wrong
  scheme; `prefers-reduced-motion` disables the 150 ms move animation.

## Stack

Astro 7 (static) with Preact islands and `@preact/signals`, [cm-chessboard](https://github.com/shaack/cm-chessboard)
8 (MIT, SVG) for the board and [chess.js](https://github.com/jhlywa/chess.js) 1.4 (BSD-2) for the
rules. TypeScript 6, pnpm 10, Node 24. Tests with Vitest, E2E with Playwright (three viewports),
axe-core, Lighthouse CI; served by nginx from a multi-stage Docker image.

The rules always run in the browser: the model only proposes a move and `chess.js` decides whether
it is legal.

## Scripts

| Script                              | What it does                                                       |
| ----------------------------------- | ------------------------------------------------------------------ |
| `pnpm dev` / `pnpm build`           | Dev server / static build (`prebuild` copies the board sprites)    |
| `pnpm preview`                      | Serves `dist/`                                                     |
| `pnpm check` / `pnpm lint`          | `astro check` (TypeScript) / ESLint                                |
| `pnpm format` / `pnpm format:check` | Prettier                                                           |
| `pnpm test`                         | Vitest unit tests (`tests/`)                                       |
| `pnpm e2e`                          | Playwright: mobile 390x844, tablet 820x1180, desktop 1280x800      |
| `pnpm lighthouse`                   | Lighthouse CI, mobile then desktop, >= 0.95 in the four categories |
| `pnpm sync:tokens [--from <src>]`   | Copies `tokens.css` from `../rukh-lab` (or a URL) and updates lock |
| `pnpm tokens:hash [--write]`        | Prints (or stores) the sha256 of `src/styles/tokens.css`           |
| `pnpm sync:tokenizer [--from <u>]`  | Copies the tokenizer artifacts from `../rukh` (or a base URL)      |

Run `pnpm exec playwright install chromium` once before `pnpm e2e`.

## Mock mode

`/?mock=1` plays against a deterministic opponent that answers with the first legal move in
`chess.js` order. It is what the E2E tests use and, in P0, the only opponent. `?color=b` makes you
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

## Where the model comes from

Nothing is downloaded until you press play. From P2 the demo loads ONNX exports from Hugging Face
(`chorcat/rukh-*`) with `onnxruntime-web` in a worker (WebGPU, WASM fallback); weights are never
committed to git. The `sizeMb` in `src/lib/registry.ts` drives the consent dialog.

## Layout

```
src/pages/index.astro     the only page (+ 404)
src/islands/App.tsx       game state (signals) and the three zones
src/islands/Board.tsx     cm-chessboard + markers + promotion + accessibility
src/islands/ModelPanel.tsx, MoveList.tsx
src/lib/game.ts           pure rules wrapper: applyMove, undoPair, toPgn, legalTargets
src/lib/opponent.ts       Opponent interface + firstLegalMove
src/lib/registry.ts       model stages (only `mock` in P0)
src/lib/query.ts          ?mock, ?stage, ?color
src/lib/chess-lm/         UCI, SAN char and BPE tokenizers + synced vocab, BPE and fixtures
src/styles/tokens.css     design tokens copied from rukh-lab (hash-locked)
src/styles/board.css      board theme derived from the tokens
e2e/                      game, layout and a11y specs
nginx/, Dockerfile        static serving with COOP/COEP and security headers
```

## Licenses

Code: MIT (see `LICENSE`). Model weights: Apache-2.0. Training data: CC0 from the
[Lichess database](https://database.lichess.org/). Board and rules libraries: MIT / BSD-2.
