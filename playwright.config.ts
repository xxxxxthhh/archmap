import { defineConfig, devices } from '@playwright/test';

/**
 * Isolated browser-test config for the loopback viewer (Issue #30).
 *
 * Specs live in `e2e/` and each starts the real `archmap serve` CLI on an ephemeral loopback port,
 * so there is no shared/fixed port and no long-lived web server here. Chromium only — the viewer is
 * a single local page, not a cross-browser matrix. Kept separate from the Vitest unit/integration
 * suite so `npm test` never depends on a downloaded browser binary.
 */
export default defineConfig({
  testDir: 'e2e',
  // `.e2e.ts`, not `.spec.ts`, so Vitest's default `{test,spec}` glob never runs these under the
  // unit suite (they need a browser); Playwright owns them exclusively.
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { trace: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
