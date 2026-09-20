import { expect, test, type Page } from '@playwright/test';
import { openBoard } from './helpers';

/** Layout invariants shared by every viewport: no horizontal scroll, square board that fits. */
async function expectBoardFits(page: Page, minBoard: number) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

  const board = await page.getByTestId('board').boundingBox();
  const panel = await page.getByTestId('panel').boundingBox();
  expect(board).not.toBeNull();
  expect(panel).not.toBeNull();
  if (!board || !panel) throw new Error('board or panel not rendered');

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport unknown');

  expect(Math.abs(board.width - board.height)).toBeLessThanOrEqual(1);
  // Real Chrome at DPR 1.5 reports 640.00003 for a 640 px board.
  expect(board.width).toBeLessThanOrEqual(641);
  expect(board.width).toBeGreaterThanOrEqual(minBoard);
  expect(board.x).toBeGreaterThanOrEqual(0);
  expect(board.x + board.width).toBeLessThanOrEqual(viewport.width);

  if (viewport.width >= 900) {
    expect(panel.x).toBeGreaterThanOrEqual(board.x + board.width);
    expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width);
  } else {
    expect(panel.y).toBeGreaterThanOrEqual(board.y + board.height);
  }
}

test.describe('single-screen layout', () => {
  test('fits the viewport without horizontal scroll', async ({ page }, testInfo) => {
    await openBoard(page);
    await expectBoardFits(page, 200);

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

  test('two columns fit at the narrow end of the desktop breakpoint', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport override only makes sense on desktop');
    await page.setViewportSize({ width: 960, height: 900 });
    await openBoard(page);
    await expectBoardFits(page, 300);
  });

  test('a landscape phone keeps a usable single-column board', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport override only makes sense on desktop');
    await page.setViewportSize({ width: 844, height: 390 });
    await openBoard(page);
    await expectBoardFits(page, 300);
  });
});

test.describe('the "Más" drawer', () => {
  test('is never covered by the panel column', async ({ page }, testInfo) => {
    // The panel used to be `position: sticky` while being taller than the viewport, so scrolling
    // slid it down over the drawer and hid its third column ("Qué ve el modelo") completely. A
    // grid item's sticky containing block is the grid container, not its own cell, so nothing
    // stopped it. This measures in page coordinates, after a scroll, which is the only way the
    // old bug shows up at all.
    test.skip(testInfo.project.name === 'mobile', 'one column: the drawer has no panel beside it');
    await openBoard(page);
    await page.locator('.drawer__summary').click();
    await page.locator('.drawer').scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    const boxes = await page.evaluate(() => {
      const rect = (q: string) => {
        const r = document.querySelector(q)!.getBoundingClientRect();
        return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right };
      };
      return { panel: rect('[data-testid="panel"]'), drawer: rect('.drawer') };
    });

    const overlapsVertically = boxes.panel.bottom > boxes.drawer.top;
    const overlapsHorizontally = boxes.drawer.right > boxes.panel.left;
    expect(overlapsVertically && overlapsHorizontally).toBe(false);
  });
});
