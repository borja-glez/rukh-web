import { expect, test } from '@playwright/test';
import { openBoard } from './helpers';

test.describe('single-screen layout', () => {
  test('fits the viewport without horizontal scroll', async ({ page }, testInfo) => {
    await openBoard(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const board = await page.getByTestId('board').boundingBox();
    const panel = await page.getByTestId('panel').boundingBox();
    expect(board).not.toBeNull();
    expect(panel).not.toBeNull();
    if (!board || !panel) return;

    expect(Math.abs(board.width - board.height)).toBeLessThanOrEqual(1);
    expect(board.width).toBeLessThanOrEqual(640);
    expect(board.width).toBeGreaterThan(200);

    const viewport = page.viewportSize();
    if (!viewport) throw new Error('viewport unknown');
    if (viewport.width >= 900) {
      expect(panel.x).toBeGreaterThanOrEqual(board.x + board.width);
    } else {
      expect(panel.y).toBeGreaterThanOrEqual(board.y + board.height);
    }

    // Every interactive control is a real tap target.
    const controls = page.locator('button, a, select');
    const count = await controls.count();
    const small: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      if (!box) continue;
      if (box.width < 44 || box.height < 44) {
        small.push(
          `${await control.evaluate((el) => el.outerHTML.slice(0, 60))} ${box.width}x${box.height}`,
        );
      }
    }
    expect(small).toEqual([]);

    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}.png`,
      fullPage: true,
    });
  });
});
