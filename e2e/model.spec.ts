import { Chess } from 'chess.js';
import { expect, test, type Page } from '@playwright/test';
import { square, tapMove, waitIdle } from './helpers';

/**
 * The real worker path, exercised against the toy decoder committed in `public/test/`: same
 * contract as the Hub exports (`idx (B, T)` int64 -> `logits (B, V)`), 169 KB instead of 40 MB.
 * `?stage=test` is the only way to reach it. Headless Chromium has no WebGPU adapter, so the
 * session falls back to WASM; the WebGPU assertions skip themselves when no adapter answers.
 */
const STAGE = '/?stage=test';
const LOAD_TIMEOUT = 120_000;

/** URLs of everything the model path could pull: the weights and the ORT runtime. */
function modelRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.onnx$/.test(url) || url.includes('/ort/')) seen.push(url);
  });
  return seen;
}

async function openDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('drawer');
  if (await drawer.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await drawer.locator('summary').click();
}

/** The SAN plies currently in the move list. */
async function plies(page: Page): Promise<string[]> {
  return page.getByTestId('move-list').locator('[data-ply]').allTextContents();
}

/** Plays one human move: the first legal one in the position the move list describes. */
async function playOne(page: Page, touch: boolean): Promise<void> {
  // The move list is only trustworthy once the model has stopped thinking, so wait first and
  // read afterwards.
  await waitIdle(page);
  const chess = new Chess();
  for (const san of await plies(page)) chess.move(san);
  const move = chess.moves({ verbose: true }).find((candidate) => !candidate.promotion);
  if (!move) throw new Error('no legal move left');
  await tapMove(page, { from: move.from, to: move.to, san: move.san }, touch);
}

async function openStage(page: Page): Promise<void> {
  await page.goto(STAGE);
  await expect(square(page, 'e2')).toBeVisible();
  await expect(page.locator('[data-testid="board"] .pieces-layer use').first()).toBeVisible();
  await waitIdle(page);
}

test.describe('playing against the ONNX decoder', () => {
  test('asks for consent and downloads nothing until "Jugar"', async ({ page }) => {
    const requested = modelRequests(page);
    await openStage(page);

    const consent = page.getByTestId('consent');
    await expect(consent).toBeVisible();
    await expect(consent).toContainText('Apache-2.0');
    await expect(consent).toContainText('MB');
    await expect(page.getByTestId('play')).toBeVisible();
    // The board is playable, the model is not loaded and nothing has been fetched.
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
    expect(requested).toEqual([]);

    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
    expect(requested.filter((url) => url.endsWith('toy-decoder.onnx'))).toHaveLength(1);
  });

  test('the Elo selector waits for the conditioned checkpoints', async ({ page }) => {
    await openStage(page);
    const elo = page.getByLabel('Elo objetivo');
    await expect(elo).toBeDisabled();
    await expect(page.getByTestId('elo-hint')).toContainText('M4');
  });

  test('plays a six-move game and reports the latency and the top five', async ({
    page,
    hasTouch,
  }) => {
    await openStage(page);
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });

    const list = page.getByTestId('move-list');
    for (let move = 0; move < 6; move += 1) {
      await playOne(page, hasTouch);
      await expect(list.locator('[data-ply]')).toHaveCount(2 * (move + 1), {
        timeout: LOAD_TIMEOUT,
      });
    }

    // Every ply the model answered is a legal move: chess.js replays the whole game.
    const chess = new Chess();
    for (const san of await plies(page)) expect(() => chess.move(san)).not.toThrow();
    expect(chess.history()).toHaveLength(12);

    await openDrawer(page);

    // Latency waterfall: one row per model move, each with tokenize, infer and sample.
    const rows = page.getByTestId('waterfall-row');
    await expect(rows).toHaveCount(6);
    const times = rows.first();
    for (const id of ['tokenize-ms', 'infer-ms', 'sample-ms']) {
      await expect(times.getByTestId(id)).toHaveText(/^[\d.]+ ms$/);
    }

    // "Qué ha salido por la red": five proposals with their probability.
    await expect(page.getByTestId('top5-row')).toHaveCount(5);
    await expect(page.getByTestId('top5').locator('.top5__uci').first()).toHaveText(
      /^[a-h][1-8][a-h][1-8][qrbn]?$/,
    );
  });

  /**
   * Regression test for a game that stopped after one ply. The board only published `data-busy`,
   * which clears as soon as the 150 ms piece animation ends — long before the model has answered.
   * A player (and this test) then clicks the next move while it is still the model's turn, the
   * board refuses it, and the clicks are silently lost. Nothing here waits for the move list to
   * grow: the only signal used between moves is the one a human reads off the screen, so if the
   * board ever again claims to be idle while the model thinks, the ply count comes up short.
   */
  test('keeps every human move when only the idle state is waited on', async ({
    page,
    hasTouch,
  }) => {
    await openStage(page);
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });

    for (let move = 0; move < 6; move += 1) await playOne(page, hasTouch);
    await waitIdle(page);

    // Six human moves, six model replies: nothing was dropped on the way.
    await expect(page.getByTestId('move-list').locator('[data-ply]')).toHaveCount(12);
    const chess = new Chess();
    for (const san of await plies(page)) expect(() => chess.move(san)).not.toThrow();
  });

  test('says "piensa" while the model decides and clears it afterwards', async ({
    page,
    hasTouch,
  }) => {
    await openStage(page);
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });

    // The toy model answers in milliseconds, so the thinking window cannot be sampled by
    // polling: record the status line from a MutationObserver instead, which sees every flip.
    await page.evaluate(() => {
      const bag = window as unknown as { __thinking?: string[] };
      bag.__thinking = [];
      const board = document.querySelector('[data-testid="board"]');
      const status = document.querySelector('[data-testid="status"]');
      if (!board || !status) return;
      new MutationObserver(() => {
        if (board.getAttribute('data-thinking') === 'true') {
          bag.__thinking?.push(status.textContent ?? '');
        }
      }).observe(board, { attributes: true, attributeFilter: ['data-thinking'] });
    });

    await playOne(page, hasTouch);
    await waitIdle(page);

    const seen = await page.evaluate(
      () => (window as unknown as { __thinking?: string[] }).__thinking ?? [],
    );
    expect(seen.length).toBeGreaterThan(0);
    // Whenever the board said it was thinking, the panel said so too, in Spanish.
    for (const text of seen) expect(text).toContain('piensa');
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  });

  test('draws the top-five arrows when the drawer turns them on', async ({ page, hasTouch }) => {
    await openStage(page);
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
    await playOne(page, hasTouch);
    await expect(page.getByTestId('move-list').locator('[data-ply]')).toHaveCount(2, {
      timeout: LOAD_TIMEOUT,
    });

    const arrows = page.locator('[data-testid="board"] .arrows [data-arrow]');
    await expect(arrows).toHaveCount(0);
    await openDrawer(page);
    await page.getByTestId('arrows').check();
    await expect(arrows).toHaveCount(5);
    await page.getByTestId('arrows').uncheck();
    await expect(arrows).toHaveCount(0);
  });

  test('runs on WebGPU when the browser has an adapter', async ({ page }) => {
    await openStage(page);
    // Headless Chromium exposes `navigator.gpu` but hands out no adapter, so asking for the
    // adapter is the honest test: without one the worker falls back to WASM on purpose.
    const hasAdapter = await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu) return false;
      try {
        return (await gpu.requestAdapter()) !== null;
      } catch {
        return false;
      }
    });
    test.skip(!hasAdapter, 'this browser has no WebGPU adapter; the session falls back to WASM');
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toHaveText('WebGPU', { timeout: LOAD_TIMEOUT });
  });
});
