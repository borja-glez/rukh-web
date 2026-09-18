import { defineConfig } from '@playwright/test';

const port = 4322;
const baseURL = `http://127.0.0.1:${port}`;

// Second server: the same `dist/`, but served with the production cross-origin isolation headers
// (see `e2e/fixtures/coi-server.mjs`). `pnpm preview` sets no COOP/COEP, so without this the
// suite never runs the code path the container takes.
const isolatedPort = 4323;
const isolatedURL = `http://127.0.0.1:${isolatedPort}`;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
    {
      name: 'tablet',
      use: { viewport: { width: 820, height: 1180 }, hasTouch: true },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
    {
      // Cross-origin isolated: the real worker path under the headers nginx sends. Only the
      // model spec runs here; the rest of the suite is layout and a11y and gains nothing.
      name: 'isolated',
      testMatch: /model\.spec\.ts$/,
      use: { baseURL: isolatedURL, viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: [
    {
      // --ignore-lock keeps Astro 7 preview in the foreground (without a TTY it backgrounds itself).
      command: `pnpm preview --host 127.0.0.1 --port ${port} --ignore-lock`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node e2e/fixtures/coi-server.mjs ${isolatedPort}`,
      url: isolatedURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
