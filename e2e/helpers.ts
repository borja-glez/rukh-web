import { Chess } from 'chess.js';
import { expect, type Locator, type Page } from '@playwright/test';

export interface Uci {
  from: string;
  to: string;
  san: string;
}

/** Human openings tried in order; the first legal one is played, else the first legal move. */
const PREFERRED = [
  'e2e4',
  'd2d4',
  'g1f3',
  'b1c3',
  'f1c4',
  'c1e3',
  'd1d2',
  'e1g1',
  'a1e1',
  'f3e5',
  'e3f4',
  'c4d5',
];

/**
 * Plans `count` human moves against the deterministic "first legal move" opponent, returning
 * the full ply sequence (human, opponent, human, ...) with SAN for the move-list assertions.
 */
export function planGame(count: number): Uci[] {
  const chess = new Chess();
  const plies: Uci[] = [];
  for (let i = 0; i < count; i += 1) {
    const legal = chess.moves({ verbose: true });
    const chosen =
      PREFERRED.map((uci) =>
        legal.find((move) => `${move.from}${move.to}` === uci && !move.promotion),
      ).find((move) => move !== undefined) ?? legal[0];
    const played = chess.move({ from: chosen.from, to: chosen.to, promotion: chosen.promotion });
    plies.push({ from: played.from, to: played.to, san: played.san });
    const reply = chess.moves({ verbose: true })[0];
    const replied = chess.move({ from: reply.from, to: reply.to, promotion: reply.promotion });
    plies.push({ from: replied.from, to: replied.to, san: replied.san });
  }
  return plies;
}

export function square(page: Page, name: string): Locator {
  return page.locator(`[data-testid="board"] rect[data-square="${name}"]`);
}

export async function openBoard(page: Page, path = '/?mock=1'): Promise<void> {
  await page.goto(path);
  await expect(square(page, 'e2')).toBeVisible();
  // The pieces sprite is fetched asynchronously; wait for the white king to be drawn.
  await expect(page.locator('[data-testid="board"] .pieces-layer use').first()).toBeVisible();
  await expect(page.getByTestId('status')).toHaveText('Te toca mover');
  await waitIdle(page);
}

export function ply(page: Page, index: number): Locator {
  return page.locator(`[data-ply="${index}"]`);
}

/** cm-chessboard ignores input while a move animation runs; the board flags it with data-busy. */
export async function waitIdle(page: Page): Promise<void> {
  await expect(page.getByTestId('board')).toHaveAttribute('data-busy', 'false');
}

export async function tapMove(page: Page, move: Uci, touch: boolean): Promise<void> {
  await waitIdle(page);
  const from = square(page, move.from);
  const to = square(page, move.to);
  if (touch) {
    await from.tap();
    await to.tap();
  } else {
    await from.click();
    await to.click();
  }
}

export async function dragMove(page: Page, move: Uci): Promise<void> {
  await waitIdle(page);
  const from = await square(page, move.from).boundingBox();
  const to = await square(page, move.to).boundingBox();
  if (!from || !to) throw new Error('square not visible');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}
