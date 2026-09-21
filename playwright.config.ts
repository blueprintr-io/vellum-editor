import { defineConfig, devices } from '@playwright/test';

/** Browser interaction and layout checks, also required by release preflight.
 * Install Chromium once with `npx playwright install chromium`. The dedicated
 * server exposes test helpers from the mounted application's module graph. */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    // Keep browser requests and server detection on the same address.
    // `localhost` can also reach a separate IPv6 development server.
    baseURL: 'http://127.0.0.1:5174',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run dev:web -- --mode e2e --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
