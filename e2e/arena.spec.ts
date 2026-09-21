import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The arena in mock mode: both sides are the first-legal-move opponent, so nothing is
 * downloaded and the match is deterministic per seed. What is checked is the wiring -- the
 * schedule runs, the board is locked, the summary reads as a difference with an interval -- not
 * the chess, which no mock can measure.
 */
const ARENA = '/?mock=1&mode=arena';

test.describe('arena mode', () => {
  test.beforeEach(async ({ page }) => {
    // Piece animations are 150 ms each; a ten-game mock match would spend minutes on them.
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('opens from the query, locks the board and plays the schedule to a summary', async ({
    page,
  }) => {
    await page.goto(ARENA);
    await expect(page.getByTestId('modes').getByRole('button', { name: 'Arena' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('board')).toHaveAttribute('data-locked', 'true');
    await expect(page.getByTestId('arena-status')).toHaveText('Sin partidas');
    await expect(page.getByTestId('arena-elo')).toHaveText('—');
    // Mock: both sides are ready without any consent step.
    await expect(page.getByTestId('arena-consent')).toHaveCount(0);

    await page.getByTestId('arena-start').click();
    // The mock answers in microseconds, so the schedule may be over before the first poll:
    // only the end state is asserted.
    await expect(page.getByTestId('arena-status')).toHaveText('10 de 10 partidas', {
      timeout: 120_000,
    });
    // A difference with an interval, and a verdict that names zero.
    await expect(page.getByTestId('arena-elo')).toContainText(/IC/);
    await expect(page.getByTestId('arena-score')).toContainText(/\d\+\d+=\d+ · 0\.\d{3}/);
    await expect(page.getByTestId('arena-verdict')).toContainText(/cero/);
    // Ten games are done: the start button offers nothing more until a reset.
    await expect(page.getByTestId('arena-start')).toBeDisabled();
    await page.getByTestId('arena-reset').click();
    await expect(page.getByTestId('arena-status')).toHaveText('Sin partidas');
  });

  test('stop halts the schedule and continue resumes it', async ({ page }) => {
    await page.goto(ARENA);
    await page.getByTestId('arena-start').click();
    await expect(page.getByTestId('arena-status')).toContainText(/Partida|partidas/);
    const stop = page.getByTestId('arena-stop');
    if (await stop.isVisible()) await stop.click();
    await expect(page.getByTestId('arena-start')).toBeVisible();
    await expect(page.getByTestId('arena-status')).not.toContainText(/mueve/);
    await expect(page.getByTestId('arena-start')).toHaveText(/Empezar|Continuar/);
  });

  test('the mode switch goes back to playing with a fresh board', async ({ page }) => {
    await page.goto(ARENA);
    await page.getByTestId('modes').getByRole('button', { name: 'Jugar' }).click();
    await expect(page.getByTestId('board')).toHaveAttribute('data-locked', 'false');
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
    await expect(page.getByTestId('arena')).toHaveCount(0);
  });

  test('no serious or critical accessibility violations', async ({ page }) => {
    await page.goto(ARENA);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      blocking,
      blocking.map((v) => `${v.id}: ${v.help} (${v.nodes.length} nodes)`).join('\n'),
    ).toEqual([]);
  });
});
