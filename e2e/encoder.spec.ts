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
 * The toy's weights are random, so the numbers themselves are arbitrary; what its two heads are
 * calibrated for is the boundary this file asserts (see `README.md`). Both are centred between
 * the position before the capture on move 4 and the position after it, so along this one game the
 * value changes **sign** on the capture and the blunder probability crosses 0.5 on it and nowhere
 * else. Everything else — the range, the movement, the wording — holds for any weights at all.
 *
 * The bar follows the player's own move, not the position on the board: the opponent answers in
 * milliseconds and a bar that always drew the newest answer could only ever accuse the opponent
 * (`supersedes` in `src/islands/EvalBar.tsx`). So every reading below belongs to the position
 * right after the human moved, and the alert names the human's move.
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

/** The move the bar is about after each human move: the human's own, never the reply. */
const ABOUT = HUMAN.map((move) => move.san);

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

/**
 * The value the bar is drawing right now, read from `data-raw` (4 decimals) rather than from the
 * printed text: the text is rounded to 2 decimals, so two different evaluations can print the
 * same string and a test that compares readings would call that "the bar did not move".
 */
async function reading(page: Page): Promise<number> {
  const raw = await page.getByTestId('eval-value').getAttribute('data-raw');
  if (raw === null) throw new Error('the bar is not drawing a value');
  return Number(raw);
}

/** Plays the `index`-th human move and waits for the opponent's known reply. */
async function playMove(page: Page, index: number, touch: boolean): Promise<void> {
  await tapMove(page, HUMAN[index], touch);
  await expect(page.locator(`[data-ply="${2 * index + 2}"]`)).toHaveText(REPLIES[index]);
  await waitIdle(page);
}

/**
 * Plays a move and waits for the encoder to answer about it. Waiting only for the reply in the
 * move list is a race: the board is idle long before the evaluation comes back, so an assertion
 * made there passes against the *previous* position and would keep passing if the bar never
 * updated again. The bar names the move it is about, so that is what is waited for.
 */
async function playAndEvaluate(page: Page, index: number, touch: boolean): Promise<number> {
  await playMove(page, index, touch);
  await expect(page.getByTestId('eval-announce')).toContainText(`tras ${ABOUT[index]}`, {
    timeout: LOAD_TIMEOUT,
  });
  return reading(page);
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
      readings.push(await playAndEvaluate(page, move, hasTouch));
    }

    // With random weights the numbers are arbitrary, so what is asserted is that the bar moves
    // and that it never leaves the range `tanh` can produce.
    expect(new Set(readings).size).toBe(readings.length);
    for (const value of readings) {
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
    // The capture (4.dxc6) is what the value head is calibrated on: it does not merely move the
    // bar, it changes its **sign** — the advantage changes hands, which is the thing the bar
    // exists to show. Asserting a magnitude instead would pass on a bar that swung from +0.3 to
    // +0.9 and never said anything about who is winning.
    expect(readings[3]).toBeGreaterThan(0);
    expect(readings[4]).toBeLessThan(0);
    await expect(page.getByTestId('eval-value')).toHaveText(/^-\d\.\d\d$/);
    await expect(page.getByTestId('eval-track')).toHaveAttribute(
      'aria-label',
      /ventaja de las negras tras dxc6$/,
    );
    await expect(page.getByTestId('encoder-error')).toHaveCount(0);
  });

  test('raises the blunder alert when the probability crosses 0.5, naming the move', async ({
    page,
    hasTouch,
  }) => {
    await open(page);
    await turnBarOn(page);

    // Nothing to accuse in the starting position: there is no move to name. The live region is
    // there all the same — one created together with its text is routinely never announced.
    const alert = page.getByTestId('blunder-alert');
    await expect(alert).toHaveAttribute('data-alert', 'false');
    await expect(alert).toHaveText('');
    await expect(page.getByTestId('evalbar')).toHaveAttribute('data-blunder', 'false');

    // Each assertion is made only once the encoder has answered about the move just played.
    for (let move = 0; move < 3; move += 1) {
      await playAndEvaluate(page, move, hasTouch);
      await expect(alert).toHaveAttribute('data-alert', 'false');
      await expect(alert).toHaveText('');
    }

    await playAndEvaluate(page, 3, hasTouch);
    await expect(alert).toHaveAttribute('data-alert', 'true');
    // Readable without telling any colours apart: it says what it is and which move it is about,
    // and the move it is about is the player's own capture, not the opponent's reply to it.
    await expect(alert).toContainText('Posible error');
    await expect(alert).toContainText(ABOUT[3]);
    await expect(alert).not.toContainText(REPLIES[3]);
    await expect(alert).toContainText('%');
    await expect(page.getByTestId('evalbar')).toHaveAttribute('data-blunder', 'true');
  });

  test('gives the bar back: the off switch releases the session and hides it', async ({ page }) => {
    await open(page);
    await turnBarOn(page);
    await expect(page.getByTestId('evalbar')).toBeVisible();

    await page.getByTestId('encoder-off').click();
    await expect(page.getByTestId('evalbar')).toHaveCount(0);
    await expect(page.getByTestId('blunder-alert')).toHaveCount(0);
    await expect(page.getByTestId('encoder-consent')).toBeVisible();
    await expect(page.getByTestId('board-area')).toHaveAttribute('data-eval', 'off');
    await expect(page.getByTestId('encoder-error')).toHaveCount(0);

    // And it can be turned on again; the weights are in the cache, so nothing is downloaded.
    await turnBarOn(page);
    expect(Number.isFinite(await reading(page))).toBe(true);
  });

  test('keeps the single screen: no horizontal scroll, board still square', async ({ page }) => {
    await open(page);
    const before = await page.getByTestId('board').boundingBox();
    await expect(page.getByTestId('board-area')).toHaveAttribute('data-eval', 'off');
    await turnBarOn(page);
    // The column belongs to the encoder being ready, not to there being an evaluation to draw:
    // otherwise every new game and every undo took it away and the board jumped by its width.
    await expect(page.getByTestId('board-area')).toHaveAttribute('data-eval', 'on');

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
    for (let move = 0; move < HUMAN.length; move += 1) await playAndEvaluate(page, move, hasTouch);
    await expect(page.getByTestId('blunder-alert')).toHaveAttribute('data-alert', 'true');

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

    // The bar's consent adds the two downloads up *before* it is accepted: the decoder's MB are
    // pending, and a consent step that only names its own half of the bill is not one.
    await expect(page.getByTestId('total-size')).toHaveCount(0);
    const combined = page.getByTestId('encoder-consent-total');
    await expect(combined).toContainText('0.3 MB');
    await expect(combined).toContainText('pendientes');

    await page.getByTestId('play').click();
    await expect(page.getByTestId('backend')).toBeVisible({ timeout: LOAD_TIMEOUT });
    // The model is loaded and the bar has still not been downloaded; the total now says so.
    await expect(page.getByTestId('total-size')).toHaveCount(0);
    await expect(combined).toContainText('0.3 MB');
    await expect(combined).toContainText('ya descargados');
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
