import { Chess } from 'chess.js';
import { expect, test, type Page } from '@playwright/test';
import { openBoard, tapMove, waitIdle } from './helpers';

/**
 * Playing against a model loaded from the reader's own disk.
 *
 * The file is the toy decoder committed in `public/test/` — same contract and same exporter as
 * the Hub files, 154 KB instead of 40 MB — but it reaches the page the way a reader's export
 * would: through the file picker, never through the network. That last part is the assertion
 * that matters, so this spec watches every request the page makes while the model loads and
 * plays, and expects not one of them to be for a `.onnx`.
 */

const LOAD_TIMEOUT = 120_000;
const TOY = 'public/test/toy-decoder.onnx';

/** Requests for model weights, from anywhere. */
function modelRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (/\.onnx(\?|$)/.test(request.url())) seen.push(request.url());
  });
  return seen;
}

async function pick(page: Page, file: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(file);
}

/** The board is the proof the island hydrated; until then the picker has no listener. */

test('a model from disk plays, and nothing is downloaded to do it', async ({ page }) => {
  const requests = modelRequests(page);
  await openBoard(page);
  await pick(page, TOY);

  await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });

  /* The whole promise of the feature: the file went from the disk to the worker. */
  expect(requests, 'a local model must not be fetched').toEqual([]);

  /* And it really plays: one human move, one answer. */
  await waitIdle(page);
  const chess = new Chess();
  const first = chess.moves({ verbose: true })[0];
  await tapMove(page, { from: first.from, to: first.to, san: first.san }, false);
  await waitIdle(page);
  const plies = await page.getByTestId('move-list').locator('[data-ply]').allTextContents();
  expect(plies.length, 'the model answered').toBeGreaterThanOrEqual(2);
  expect(requests, 'still nothing fetched after a move').toEqual([]);
});

test('the stage selector names the file, and the name is only ever the file name', async ({
  page,
}) => {
  await openBoard(page);
  await pick(page, TOY);
  await expect(page.locator('select').first()).toContainText('toy-decoder.onnx', {
    timeout: LOAD_TIMEOUT,
  });
  /* The label carries the basename, never the path the browser was handed. */
  await expect(page.locator('select').first()).not.toContainText('public/test');
});

test('a file that is not a model is refused by name, not by crashing', async ({ page }) => {
  await openBoard(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'weights.pt',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(4096, 7),
  });
  await expect(page.getByTestId('byo-error')).toContainText('.onnx');
});

test('an .onnx that is not a Rukh decoder is refused by the contract', async ({ page }) => {
  await openBoard(page);
  /* Right extension, wrong everything else: the cheap checks pass and ORT refuses the bytes. */
  await page.locator('input[type="file"]').setInputFiles({
    name: 'not-a-model.onnx',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(8192, 3),
  });
  await expect(page.getByTestId('model-error')).not.toBeEmpty({ timeout: LOAD_TIMEOUT });
});

test('the local model is gone after a reload, so no link can restore it', async ({ page }) => {
  await openBoard(page);
  await pick(page, TOY);
  await expect(page.locator('select').first()).toContainText('toy-decoder.onnx', {
    timeout: LOAD_TIMEOUT,
  });

  await openBoard(page);
  await expect(page.locator('select').first()).not.toContainText('toy-decoder.onnx');
});
