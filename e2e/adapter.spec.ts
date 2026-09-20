import { Chess } from 'chess.js';
import { expect, test, type Page } from '@playwright/test';
import { square, tapMove, waitIdle } from './helpers';

/**
 * Swapping a style adapter in the browser, against the toy files committed in `public/test/`.
 *
 * `toy-decoder-lora.onnx` is the same one-layer decoder as `toy-decoder.onnx`, exported with its
 * LoRA factors as **inputs of the graph** (`rukh export --adapter-inputs`), and `toy-lora.bin` is
 * an adapter of exactly the size that graph declares. Both are written by
 * `rukh/scripts/make_toy_web_models.py` with the same functions that write the published files.
 *
 * What is under test here is the claim the whole design rests on: one model file, several styles,
 * and changing style costs a 256-byte upload rather than another download. The proof is that the
 * distribution the model publishes for the *same position* is different with the adapter loaded —
 * "same position" being why the comparison is made from a fresh game both times, and why it reads
 * the top-five panel (the model's own softmax) instead of the move it happened to sample.
 */
const STAGE = '/?stage=test-lora';
const LOAD_TIMEOUT = 120_000;

async function openDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('drawer');
  if (await drawer.evaluate((element) => (element as HTMLDetailsElement).open)) return;
  await drawer.locator('summary').click();
}

async function plies(page: Page): Promise<string[]> {
  return page.getByTestId('move-list').locator('[data-ply]').allTextContents();
}

/** Plays the first legal move of the current position, which is deterministic from a new game. */
async function playFirstLegal(page: Page, touch: boolean): Promise<void> {
  await waitIdle(page);
  const chess = new Chess();
  for (const san of await plies(page)) chess.move(san);
  const move = chess.moves({ verbose: true }).find((candidate) => !candidate.promotion);
  if (!move) throw new Error('no legal move left');
  await tapMove(page, { from: move.from, to: move.to, san: move.san }, touch);
}

/** The model's own top choice for the position it has just answered. */
async function topChoice(page: Page): Promise<string> {
  await openDrawer(page);
  const first = page.getByTestId('top5').locator('.top5__uci').first();
  await expect(first).toHaveText(/^[a-h][1-8][a-h][1-8][qrbn]?$/, { timeout: LOAD_TIMEOUT });
  return (await first.textContent()) ?? '';
}

async function answerOnce(page: Page, touch: boolean): Promise<string> {
  await playFirstLegal(page, touch);
  await expect(page.getByTestId('move-list').locator('[data-ply]')).toHaveCount(2, {
    timeout: LOAD_TIMEOUT,
  });
  return topChoice(page);
}

async function load(page: Page): Promise<void> {
  await page.goto(STAGE);
  await expect(square(page, 'e2')).toBeVisible();
  await waitIdle(page);
  await page.getByTestId('play').click();
  await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
}

test.describe('style adapters in the browser', () => {
  test('the style selector is off for a stage whose graph takes no factors', async ({ page }) => {
    await page.goto('/?stage=test');
    await waitIdle(page);
    const style = page.getByTestId('adapter');
    await expect(style).toBeDisabled();
    await expect(page.getByTestId('adapter-hint')).toContainText('intercambiables');
  });

  test('changing the adapter changes what the model wants to play', async ({ page, hasTouch }) => {
    const downloads: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (/\.onnx$|\.bin$/.test(url)) downloads.push(url);
    });

    await load(page);
    const before = await answerOnce(page, hasTouch);

    // One model file so far, and the style selector is live.
    expect(downloads.filter((url) => url.endsWith('.onnx'))).toHaveLength(1);
    const style = page.getByTestId('adapter');
    await expect(style).toBeEnabled();
    await expect(style).toHaveValue('none');

    await page.getByRole('button', { name: 'Nueva partida' }).click();
    await waitIdle(page);
    await style.selectOption('test-lora');
    await expect(style).toHaveValue('test-lora', { timeout: LOAD_TIMEOUT });

    const after = await answerOnce(page, hasTouch);
    expect(after).not.toBe(before);

    // The style cost one small file and **no** second copy of the model: that is the whole point.
    expect(downloads.filter((url) => url.endsWith('.onnx'))).toHaveLength(1);
    expect(downloads.filter((url) => url.endsWith('toy-lora.bin'))).toHaveLength(1);
  });

  test('clearing the adapter puts the plain model back', async ({ page, hasTouch }) => {
    await load(page);
    const before = await answerOnce(page, hasTouch);

    const style = page.getByTestId('adapter');
    await page.getByRole('button', { name: 'Nueva partida' }).click();
    await waitIdle(page);
    await style.selectOption('test-lora');
    await expect(style).toHaveValue('test-lora', { timeout: LOAD_TIMEOUT });

    await page.getByRole('button', { name: 'Nueva partida' }).click();
    await waitIdle(page);
    await style.selectOption('none');
    await expect(style).toHaveValue('none');

    // An adapter of zeros is the base model by construction, so this has to be the same number
    // again — not merely close. If it drifts, the graph is not what the export claims.
    expect(await answerOnce(page, hasTouch)).toBe(before);
  });
});
