import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * The puzzles in mock mode: the first-legal-move opponent answers every puzzle, and solves
 * next to none of them, which is exactly what the progress table has to report. The fifty
 * puzzles of a band are the exporter's, so their count is the contract with `puzzles.json`.
 */
const PUZZLES = '/?mock=1&mode=puzzles';

test.describe('puzzle mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  test('runs a band, counts every attempt and scores the whole line', async ({ page }) => {
    await page.goto(PUZZLES);
    await expect(page.getByTestId('board')).toHaveAttribute('data-locked', 'true');
    await expect(page.getByTestId('puzzles-status')).toHaveText('Sin intentos');
    await expect(page.getByTestId('puzzles-consent')).toHaveCount(0);
    await page.getByTestId('puzzles-band').selectOption('1500-2000');
    await page.getByTestId('puzzles-start').click();
    await expect(page.getByTestId('puzzles-status')).toContainText(/Puzle/);
    await expect(page.getByTestId('puzzles-attempted-1500-2000')).toHaveText('50', {
      timeout: 120_000,
    });
    await expect(page.getByTestId('puzzles-rate-1500-2000')).toContainText(/%/);
    await expect(page.getByTestId('puzzles-attempted-1000-1500')).toHaveText('0');
    await expect(page.getByTestId('puzzles-status')).toContainText(/de 50 resueltos/);
    // The first legal move fails almost every line, and the miss says what it played.
    await expect(page.getByTestId('puzzles-miss')).toContainText(/propuso/);
    await expect(page.getByTestId('puzzles-start')).toBeDisabled();
    await page.getByTestId('puzzles-reset').click();
    await expect(page.getByTestId('puzzles-status')).toHaveText('Sin intentos');
  });

  test('stop halts the run', async ({ page }) => {
    await page.goto(PUZZLES);
    await page.getByTestId('puzzles-start').click();
    await expect(page.getByTestId('puzzles-status')).toContainText(/Puzle/);
    await page.getByTestId('puzzles-stop').click();
    await expect(page.getByTestId('puzzles-start')).toBeVisible();
    await expect(page.getByTestId('puzzles-status')).toContainText(/resueltos|Sin intentos/);
  });

  test('no serious or critical accessibility violations', async ({ page }) => {
    await page.goto(PUZZLES);
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
