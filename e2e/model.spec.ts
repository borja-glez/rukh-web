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
