import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { dragMove, openBoard, planGame, ply, tapMove } from './helpers';

test.describe('game against the first-legal-move opponent', () => {
  test('plays 10 human moves by tapping origin and destination', async ({ page, hasTouch }) => {
    await openBoard(page);
    const plies = planGame(10);

    for (let i = 0; i < plies.length; i += 2) {
      await tapMove(page, plies[i], hasTouch);
      await expect(ply(page, i + 1)).toHaveText(plies[i].san);
      await expect(ply(page, i + 2)).toHaveText(plies[i + 1].san);
    }

    const list = page.getByTestId('move-list');
    await expect(list.locator('[data-ply]')).toHaveCount(20);
    await expect(ply(page, 20)).toHaveAttribute('aria-current', 'step');
    await expect(page.getByTestId('last-move')).toContainText(plies[19].san);

    // Undo removes one pair (human + opponent).
    await page.getByRole('button', { name: 'Deshacer' }).click();
    await expect(list.locator('[data-ply]')).toHaveCount(18);

    // Export produces a PGN download that starts with the played opening.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Exportar PGN' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^rukh-\d{4}-\d{2}-\d{2}\.pgn$/);
    const path = await download.path();
    const pgn = readFileSync(path, 'utf8');
    expect(pgn).toContain('[Event "Rukh demo"]');
    expect(pgn).toContain('[White "Humano"]');
    expect(pgn).toContain('1. e4');

    // New game clears the list and the board.
    await page.getByRole('button', { name: 'Nueva partida' }).first().click();
    await expect(list.locator('[data-ply]')).toHaveCount(0);
    await expect(list).toContainText('Sin jugadas');
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  });

  test('rejects an illegal move and keeps the list empty', async ({ page, hasTouch }) => {
    await openBoard(page);
    await tapMove(page, { from: 'e2', to: 'e5', san: '' }, hasTouch);
    await expect(page.getByTestId('move-list').locator('[data-ply]')).toHaveCount(0);
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  });

  test('playing black makes the opponent move first', async ({ page }) => {
    await page.goto('/?mock=1&color=b');
    await expect(ply(page, 1)).toHaveText('a3');
    await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  });

  test('moves a piece by dragging', async ({ page, hasTouch }) => {
    test.skip(hasTouch, 'drag is exercised with the mouse on desktop');
    await openBoard(page);
    const plies = planGame(2);
    await dragMove(page, plies[0]);
    await expect(ply(page, 1)).toHaveText(plies[0].san);
    await expect(ply(page, 2)).toHaveText(plies[1].san);
    await dragMove(page, plies[2]);
    await expect(ply(page, 3)).toHaveText(plies[2].san);
    await expect(ply(page, 4)).toHaveText(plies[3].san);
  });
});
