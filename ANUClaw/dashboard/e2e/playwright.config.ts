import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';
import { requireNexArchQaEnv } from './env';
import { AUTH_STATE_PATH } from './global-setup';

// Evaluated at config-load time, before any test (or even global-setup) runs — an
// unconfigured environment fails the whole `playwright test` invocation immediately with a
// clear message, rather than reporting a false-green "0 tests ran".
const env = requireNexArchQaEnv();

const VIEWPORTS = {
  '1440x900': { width: 1440, height: 900 },
  '1280x800': { width: 1280, height: 800 },
  '1024x768': { width: 1024, height: 768 },
  '768x1024': { width: 768, height: 1024 },
} as const;

export default defineConfig({
  testDir: __dirname,
  // AlphaFold has a dedicated serial config because its disposable provider fixture is
  // mutable across UI states. Keep it out of this general regression project matrix.
  testIgnore: '**/alphafold/**',
  // Playwright's own generated artifacts — screenshots on failure, traces, the HTML report —
  // are routine test output, not deliberately-selected evidence; keep them out of the repo
  // entirely via .gitignore rather than treating them as anything to preserve.
  outputDir: path.join(__dirname, '.test-results'),
  reporter: [['list'], ['html', { outputFolder: path.join(__dirname, '.playwright-report'), open: 'never' }]],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  globalSetup: require.resolve('./global-setup'),
  use: {
    baseURL: env.BASE_URL,
    storageState: AUTH_STATE_PATH,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: Object.entries(VIEWPORTS).map(([name, viewport]) => ({
    name,
    use: { ...devices['Desktop Chrome'], viewport },
  })),
});
