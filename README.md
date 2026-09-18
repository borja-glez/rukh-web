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
| `pnpm sync:tokenizer`               | Syncs the UCI tokenizer from the Hub (arrives in P1)               |

Run `pnpm exec playwright install chromium` once before `pnpm e2e`.

## Mock mode

`/?mock=1` plays against a deterministic opponent that answers with the first legal move in
`chess.js` order. It is what the E2E tests use and, in P0, the only opponent. `?color=b` makes you
play black (the opponent moves first).

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
src/styles/tokens.css     design tokens copied from rukh-lab (hash-locked)
src/styles/board.css      board theme derived from the tokens
e2e/                      game, layout and a11y specs
nginx/, Dockerfile        static serving with COOP/COEP and security headers
```

## Licenses

Code: MIT (see `LICENSE`). Model weights: Apache-2.0. Training data: CC0 from the
[Lichess database](https://database.lichess.org/). Board and rules libraries: MIT / BSD-2.
