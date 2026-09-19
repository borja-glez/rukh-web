import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { square, tapMove, waitIdle, type Uci } from './helpers';

/**
 * The evaluation bar against the toy encoder committed in `public/test/`: the same contract as
 * the Hub export (`idx (B, 69)` int64 -> `value` and `blunder`, the sigmoid inside the graph, the
 * `rukh_*` metadata) written by the same exporter (`rukh.export.export_encoder_onnx`), 84 KB
 * instead of 30 MB. `?encoder=test` is the only way to reach it.
 *
 * The decoder stays mocked (`?mock=1`): the bar is a second model with a second consent and it
 * has nothing to do with who chooses the moves, so the opponent here is the deterministic "first
 * legal move" one and every position below is known in advance.
 *
 * The toy's weights are random, so the numbers are arbitrary — what is asserted is that they
 * move, that they stay inside the range the heads can produce, and that the alert crosses 0.5
 * where the calibration of the fixture says it does (after the capture on move 4; see the
 * generator's docstring in `README.md`).
 */
const PAGE = '/?mock=1&encoder=test';
const LOAD_TIMEOUT = 120_000;

/** 1.e4 2.d4 3.d5 4.dxc6 — the human's moves; the mock opponent answers deterministically. */
const HUMAN: Uci[] = [
  { from: 'e2', to: 'e4', san: 'e4' },
  { from: 'd2', to: 'd4', san: 'd4' },
  { from: 'd4', to: 'd5', san: 'd5' },
  { from: 'd5', to: 'c6', san: 'dxc6' },
];

/** The opponent's reply after each of those, in the same order. */
const REPLIES = ['Nc6', 'Rb8', 'Ra8', 'Rb8'];

/** URLs of everything the encoder path could pull: the weights and the ORT runtime. */
function encoderRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\.onnx$/.test(url) || url.includes('/ort/')) seen.push(url);
  });
  return seen;
}

async function open(page: Page): Promise<void> {
  await page.goto(PAGE);
  await expect(square(page, 'e2')).toBeVisible();
  await expect(page.locator('[data-testid="board"] .pieces-layer use').first()).toBeVisible();
  await waitIdle(page);
}

async function turnBarOn(page: Page): Promise<void> {
  await page.getByTestId('encoder-play').click();
  await expect(page.getByTestId('encoder-backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId('evalbar')).toBeVisible({ timeout: LOAD_TIMEOUT });
}

/** The number the bar prints right now. */
async function reading(page: Page): Promise<number> {
  const text = await page.getByTestId('eval-value').textContent();
  return Number(text);
}

/** Plays the `index`-th human move and waits for the opponent's known reply. */
async function playMove(page: Page, index: number, touch: boolean): Promise<void> {
  await tapMove(page, HUMAN[index], touch);
  await expect(page.locator(`[data-ply="${2 * index + 2}"]`)).toHaveText(REPLIES[index]);
  await waitIdle(page);
}

test.describe('the encoder evaluation bar', () => {
  test('shows nothing and downloads nothing before its own consent', async ({ page }) => {
    const requested = encoderRequests(page);
    await open(page);

    await expect(page.getByTestId('evalbar')).toHaveCount(0);
    await expect(page.getByTestId('blunder-alert')).toHaveCount(0);
    const consent = page.getByTestId('encoder-consent');
    await expect(consent).toBeVisible();
    await expect(consent).toContainText('Apache-2.0');
    await expect(consent).toContainText('MB');
    expect(requested).toEqual([]);

    // The board is fully playable with no encoder at all.
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  });

  test('asks for the encoder separately from the model that plays', async ({ page }) => {
    await open(page);
    // `?mock=1`: nothing is playing an ONNX model, and the bar still has its own consent step.
    await expect(page.getByTestId('consent')).toHaveCount(0);
    await expect(page.getByTestId('encoder-consent')).toBeVisible();
    await expect(page.getByTestId('encoder-play')).toBeVisible();
  });

  test('loads the encoder after consent and draws a value inside [-1, 1]', async ({ page }) => {
    const requested = encoderRequests(page);
    await open(page);
    await turnBarOn(page);

    expect(requested.filter((url) => url.endsWith('toy-encoder.onnx'))).toHaveLength(1);
    expect(requested.filter((url) => url.endsWith('toy-decoder.onnx'))).toHaveLength(0);

    const value = await reading(page);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
    // Signed on purpose: the sign is never only a colour.
    await expect(page.getByTestId('eval-value')).toHaveText(/^[+-]?\d\.\d\d$/);
    await expect(page.getByTestId('eval-track')).toHaveAttribute(
      'aria-label',
      /Evaluación del encoder: [+-]?\d\.\d\d · (igualada|ventaja de las (blancas|negras))/,
    );
    await expect(page.getByTestId('model-error')).toHaveCount(0);
    await expect(page.getByTestId('encoder-error')).toHaveCount(0);
  });

  test('updates after every move and after the capture', async ({ page, hasTouch }) => {
    await open(page);
    await turnBarOn(page);

    const readings = [await reading(page)];
    for (let move = 0; move < HUMAN.length; move += 1) {
      await playMove(page, move, hasTouch);
      // The bar belongs to the position on the board: wait for it to stop being the old one.
      await expect
        .poll(async () => reading(page), { timeout: LOAD_TIMEOUT })
        .not.toBe(readings[readings.length - 1]);
      readings.push(await reading(page));
    }

    // With random weights the numbers are arbitrary, so what is asserted is that the bar moves
    // and that it never leaves the range `tanh` can produce.
    expect(new Set(readings).size).toBe(readings.length);
    for (const value of readings) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
    // The capture (4.dxc6) is the move the fixture was calibrated to move the bar on.
    expect(Math.abs(readings[4] - readings[3])).toBeGreaterThan(0.1);
    await expect(page.getByTestId('encoder-error')).toHaveCount(0);
  });

  test('raises the blunder alert when the probability crosses 0.5, naming the move', async ({
    page,
    hasTouch,
  }) => {
    await open(page);
    await turnBarOn(page);

    // Nothing to accuse in the starting position: there is no move to name.
    await expect(page.getByTestId('blunder-alert')).toHaveCount(0);
    await expect(page.getByTestId('evalbar')).toHaveAttribute('data-blunder', 'false');

    for (let move = 0; move < 3; move += 1) {
      await playMove(page, move, hasTouch);
      await expect(page.getByTestId('blunder-alert')).toHaveCount(0);
    }

    await playMove(page, 3, hasTouch);
    const alert = page.getByTestId('blunder-alert');
    await expect(alert).toBeVisible({ timeout: LOAD_TIMEOUT });
    // Readable without telling any colours apart: it says what it is and which move it is about.
    await expect(alert).toContainText('Posible error');
    await expect(alert).toContainText(REPLIES[3]);
    await expect(alert).toContainText('%');
    await expect(page.getByTestId('evalbar')).toHaveAttribute('data-blunder', 'true');
  });

  test('keeps the single screen: no horizontal scroll, board still square', async ({ page }) => {
    await open(page);
    const before = await page.getByTestId('board').boundingBox();
    await turnBarOn(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const board = await page.getByTestId('board').boundingBox();
    const bar = await page.getByTestId('evalbar').boundingBox();
    const panel = await page.getByTestId('panel').boundingBox();
    if (!board || !bar || !panel || !before) throw new Error('board, bar or panel not rendered');
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('viewport unknown');

    expect(Math.abs(board.width - board.height)).toBeLessThanOrEqual(1);
    expect(board.x + board.width).toBeLessThanOrEqual(viewport.width);
    expect(bar.x + bar.width).toBeLessThanOrEqual(viewport.width);
    if (viewport.width >= 900) {
      // Vertical, between the board and the panel, as tall as the board.
      expect(bar.x).toBeGreaterThanOrEqual(board.x + board.width - 1);
      expect(bar.height).toBeGreaterThan(bar.width);
      expect(panel.x).toBeGreaterThanOrEqual(bar.x + bar.width - 1);
      // The board gave the bar its column instead of pushing the page wider.
      expect(board.width).toBeLessThanOrEqual(before.width);
    } else {
      // Horizontal, under the board and above the panel.
      expect(bar.y).toBeGreaterThanOrEqual(board.y + board.height - 1);
      expect(bar.width).toBeGreaterThan(bar.height);
      expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
      expect(board.width).toBe(before.width);
    }
  });

  test('animates the fill in under 150 ms and not at all with reduced motion', async ({ page }) => {
    await open(page);
    await turnBarOn(page);
    const duration = () =>
      page
        .locator('.evalbar__fill')
        .evaluate((element) => getComputedStyle(element).transitionDuration);

    expect(await duration()).toBe('0.14s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await duration()).toBe('0s');
  });

  test('axe reports no serious or critical violations with the bar and the alert up', async ({
    page,
    hasTouch,
  }) => {
    await open(page);
    await turnBarOn(page);
    for (let move = 0; move < HUMAN.length; move += 1) await playMove(page, move, hasTouch);
    await expect(page.getByTestId('blunder-alert')).toBeVisible({ timeout: LOAD_TIMEOUT });

    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  test('adds the two downloads up when the decoder is loaded too', async ({ page, hasTouch }) => {
    // Both toys at once: two workers, two ORT sessions, two consents.
    await page.goto('/?stage=test&encoder=test');
    await expect(square(page, 'e2')).toBeVisible();
    await expect(page.locator('[data-testid="board"] .pieces-layer use').first()).toBeVisible();
    await waitIdle(page);

    await expect(page.getByTestId('total-size')).toHaveCount(0);
    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
    // The model is loaded and the bar has still not been downloaded.
    await expect(page.getByTestId('total-size')).toHaveCount(0);
    await expect(page.getByTestId('evalbar')).toHaveCount(0);

    await turnBarOn(page);
    const total = page.getByTestId('total-size');
    await expect(total).toBeVisible();
    await expect(total).toContainText('0.3 MB');

    // And the game still runs with both models in the browser.
    await tapMove(page, HUMAN[0], hasTouch);
    await expect(page.locator('[data-ply="2"]')).toHaveText(/\S/, { timeout: LOAD_TIMEOUT });
    await waitIdle(page);
    await expect(page.getByTestId('evalbar')).toBeVisible();
    await expect(page.getByTestId('encoder-error')).toHaveCount(0);
    await expect(page.getByTestId('model-error')).toHaveCount(0);
  });
});
