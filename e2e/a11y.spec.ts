import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openBoard, planGame, ply, tapMove } from './helpers';

test.describe('accessibility and CSP', () => {
  test('axe reports no serious or critical violations', async ({ page }) => {
    await openBoard(page);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    );
    expect(
      blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });

  test('CSP meta has no unsafe-inline scripts and the game runs without CSP errors', async ({
    page,
    hasTouch,
  }) => {
    const cspErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && /content security policy/i.test(message.text())) {
        cspErrors.push(message.text());
      }
    });
    page.on('pageerror', (error) => cspErrors.push(`pageerror: ${error.message}`));

    await openBoard(page);

    const content = await page
      .locator('meta[http-equiv="content-security-policy"]')
      .getAttribute('content');
    expect(content).not.toBeNull();
    const scriptSrc = content
      ?.split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    const plies = planGame(4);
    for (let i = 0; i < plies.length; i += 2) {
      await tapMove(page, plies[i], hasTouch);
      await expect(ply(page, i + 2)).toHaveText(plies[i + 1].san);
    }
    await page.getByRole('button', { name: 'Tema oscuro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Tema claro' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    expect(cspErrors).toEqual([]);
  });
});
